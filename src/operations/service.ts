import type { IngestFileInput, IngestionMode } from '../ingest/service.js';
import type { IngestionService } from '../ingest/service.js';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  BackupRetentionInput,
  CreateBackupInput,
  CleanupOperationsInput,
  ContextPack,
  ContextQualityFeedbackRecord,
  ContextQualityItemSummary,
  ContextQualityLearningProposalSummary,
  ContextQualityKnowledgeGapSummary,
  ContextQualityReport,
  ContextQualityReportInput,
  FeedbackEvent,
  FeedbackQualityType,
  KnowledgeConflict,
  KnowledgeConflictInput,
  KnowledgeConflictPatchInput,
  KnowledgeGapPatchInput,
  KnowledgePatchInput,
  LabelInput,
  LearningProposal,
  LearningProposalPatchInput,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  ListKnowledgeConflictsOptions,
  ListKnowledgeGapsOptions,
  ListLearningProposalsOptions,
  ListKnowledgeRelationsOptions,
  ListKnowledgeOptions,
  ListRecordsOptions,
  ReferenceInput,
  ReflectionDraftPatchInput,
  RestoreBackupInput,
} from '../types.js';
import type { StoredKnowledge } from '../types.js';
import { ValidationError } from '../errors.js';
import { normalizeLabel, uniqueStrings } from '../util/text.js';
import { validateKnowledgePatchInput } from '../validation.js';
import { BackupService, type BackupServiceOptions } from './backup-service.js';

export interface ImportFilesInput {
  project: string;
  files: IngestFileInput[];
  mode?: IngestionMode;
}

export class OperationsService {
  private readonly backups: BackupService;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly ingestion: IngestionService,
    options: BackupServiceOptions = {},
  ) {
    this.backups = new BackupService(store, options);
  }

  listKnowledge(options: ListKnowledgeOptions) {
    return this.store.listKnowledge(options);
  }

  getKnowledge(id: string) {
    return this.store.getKnowledge(id);
  }

  async updateKnowledge(id: string, patch: KnowledgePatchInput) {
    const knowledge = await this.store.updateKnowledge(id, patch);
    if (knowledge) {
      this.requestPhysicalMirror('knowledge-updated');
    }
    return knowledge;
  }

  listKnowledgeRelations(options: ListKnowledgeRelationsOptions) {
    return this.store.listKnowledgeRelations(options);
  }

  getKnowledgeRelation(id: string) {
    return this.store.getKnowledgeRelation(id);
  }

  async createKnowledgeRelation(input: KnowledgeRelationInput) {
    const relation = await this.store.createKnowledgeRelation(input);
    this.requestPhysicalMirror('relation-created');
    return relation;
  }

  async updateKnowledgeRelation(id: string, patch: KnowledgeRelationPatchInput) {
    const relation = await this.store.updateKnowledgeRelation(id, patch);
    if (relation) {
      this.requestPhysicalMirror('relation-updated');
    }
    return relation;
  }

  async deleteKnowledgeRelation(id: string) {
    const ok = await this.store.deleteKnowledgeRelation(id);
    if (ok) {
      this.requestPhysicalMirror('relation-deleted');
    }
    return ok;
  }

  listKnowledgeConflicts(options: ListKnowledgeConflictsOptions) {
    return this.store.listKnowledgeConflicts(options);
  }

  async detectKnowledgeConflicts(options: { project?: string; limit: number }) {
    const knowledge = await this.store.listKnowledge({
      project: options.project,
      status: 'approved',
      limit: options.limit,
    });
    const proposed = detectConflicts(knowledge);
    const created: KnowledgeConflict[] = [];

    for (const conflict of proposed) {
      created.push(await this.store.createKnowledgeConflict(conflict));
    }

    if (created.length > 0) {
      this.requestPhysicalMirror('conflicts-detected');
    }

    return created;
  }

  async updateKnowledgeConflict(id: string, patch: KnowledgeConflictPatchInput) {
    const conflict = await this.store.updateKnowledgeConflict(id, patch);
    if (conflict) {
      this.requestPhysicalMirror('conflict-updated');
    }
    return conflict;
  }

  listKnowledgeGaps(options: ListKnowledgeGapsOptions) {
    return this.store.listKnowledgeGaps(options);
  }

  async updateKnowledgeGap(id: string, patch: KnowledgeGapPatchInput) {
    const gap = await this.store.updateKnowledgeGap(id, patch);
    if (gap) {
      this.requestPhysicalMirror('knowledge-gap-updated');
    }
    return gap;
  }

  listLearningProposals(options: ListLearningProposalsOptions) {
    return this.store.listLearningProposals(options);
  }

  async updateLearningProposal(id: string, patch: LearningProposalPatchInput) {
    const proposal = await this.store.updateLearningProposal(id, sanitizeLearningProposalPatch(patch));
    if (!proposal) {
      return undefined;
    }

    if (patch.status === 'approved' && !proposal.metadata?.approvalAction) {
      const actionResult = await this.runProposalApprovalAction(proposal);
      const withAction = await this.store.updateLearningProposal(proposal.id, {
        metadata: { approvalAction: actionResult },
      });
      this.requestPhysicalMirror('learning-proposal-approved');
      return withAction ?? proposal;
    }

    this.requestPhysicalMirror('learning-proposal-updated');
    return proposal;
  }

  private async runProposalApprovalAction(proposal: LearningProposal): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {
      executedAt: new Date().toISOString(),
      proposalType: proposal.proposalType,
    };

    if (
      proposal.proposalType === 'supersedes' &&
      proposal.candidateKnowledgeId &&
      proposal.affectedKnowledgeId
    ) {
      const relation = await this.ensureSupersedesRelation(proposal);
      result.action = 'supersedes_relation_created';
      result.relationId = relation.id;
      await this.markKnowledgeNeedsReview(proposal.affectedKnowledgeId);
      result.markedNeedsReview = proposal.affectedKnowledgeId;
    } else if (proposal.proposalType === 'missing_label' && proposal.affectedKnowledgeId) {
      const suggestedLabels = readSuggestedLabels(proposal);
      if (suggestedLabels.length > 0) {
        await this.applySuggestedLabels(proposal.affectedKnowledgeId, suggestedLabels);
        result.action = 'labels_applied';
        result.knowledgeId = proposal.affectedKnowledgeId;
        result.appliedLabels = suggestedLabels;
      } else {
        await this.markKnowledgeNeedsReview(proposal.affectedKnowledgeId);
        result.action = 'knowledge_marked_needs_review';
        result.knowledgeId = proposal.affectedKnowledgeId;
      }
    } else if (proposal.proposalType === 'missing_reference' && proposal.affectedKnowledgeId) {
      const suggestedReferences = readSuggestedReferences(proposal);
      if (suggestedReferences.length > 0) {
        await this.applySuggestedReferences(proposal.affectedKnowledgeId, suggestedReferences);
        result.action = 'references_applied';
        result.knowledgeId = proposal.affectedKnowledgeId;
        result.appliedReferences = suggestedReferences;
      } else {
        await this.markKnowledgeNeedsReview(proposal.affectedKnowledgeId);
        result.action = 'knowledge_marked_needs_review';
        result.knowledgeId = proposal.affectedKnowledgeId;
      }
    } else if (proposal.proposalType === 'auto_memory_cleanup' && proposal.affectedKnowledgeId) {
      const cleanupAction = readAutoMemoryCleanupAction(proposal);
      if (cleanupAction.action === 'archive') {
        await this.markKnowledgeStatus(proposal.affectedKnowledgeId, 'archived');
        result.action = 'knowledge_archived';
        result.knowledgeId = proposal.affectedKnowledgeId;
      } else if (cleanupAction.action === 'supersede') {
        const relation = await this.ensureSupersedesRelation(proposal, cleanupAction.supersedingKnowledgeId);
        result.action = 'auto_memory_superseded';
        result.relationId = relation.id;
        result.supersedingKnowledgeId = cleanupAction.supersedingKnowledgeId;
        await this.markKnowledgeNeedsReview(proposal.affectedKnowledgeId);
        result.markedNeedsReview = proposal.affectedKnowledgeId;
      } else {
        await this.markKnowledgeNeedsReview(proposal.affectedKnowledgeId);
        result.action = 'knowledge_marked_needs_review';
        result.knowledgeId = proposal.affectedKnowledgeId;
      }
    } else if (proposal.affectedKnowledgeId) {
      await this.markKnowledgeNeedsReview(proposal.affectedKnowledgeId);
      result.action = 'knowledge_marked_needs_review';
      result.knowledgeId = proposal.affectedKnowledgeId;
    } else {
      result.action = 'no_op';
      result.reason = 'missing_target_knowledge_id';
    }

    return result;
  }

  private async ensureSupersedesRelation(
    proposal: LearningProposal,
    candidateKnowledgeId = proposal.candidateKnowledgeId,
  ) {
    if (!candidateKnowledgeId || !proposal.affectedKnowledgeId) {
      throw new Error(`Cannot approve learning proposal: supersedes action requires candidate and affected knowledge ids (${proposal.id}).`);
    }

    const existing = await this.store.listKnowledgeRelations({
      project: proposal.project,
      fromKnowledgeId: candidateKnowledgeId,
      relationType: 'supersedes',
      limit: 100,
    });
    const relation = existing.find((item) => item.targetKnowledgeId === proposal.affectedKnowledgeId);
    if (relation) {
      return relation;
    }

    return this.store.createKnowledgeRelation({
      project: proposal.project,
      fromKnowledgeId: candidateKnowledgeId,
      relationType: 'supersedes',
      targetKind: 'knowledge',
      targetKnowledgeId: proposal.affectedKnowledgeId,
      confidence: 0.8,
      inferred: false,
      metadata: { source: 'learning_proposal', proposalId: proposal.id },
    });
  }

  private async applySuggestedLabels(knowledgeId: string, suggestedLabels: LabelInput[]): Promise<void> {
    const knowledge = await this.getAffectedKnowledge(knowledgeId);
    const labels = mergeLabels([...knowledge.labels, ...suggestedLabels]);
    const updated = await this.store.updateKnowledge(knowledgeId, { labels });
    if (!updated) {
      throw new Error(`Cannot approve learning proposal: affected knowledge not found (${knowledgeId}).`);
    }
  }

  private async applySuggestedReferences(knowledgeId: string, suggestedReferences: ReferenceInput[]): Promise<void> {
    const knowledge = await this.getAffectedKnowledge(knowledgeId);
    const references = mergeReferences([...knowledge.references, ...suggestedReferences]);
    const updated = await this.store.updateKnowledge(knowledgeId, { references });
    if (!updated) {
      throw new Error(`Cannot approve learning proposal: affected knowledge not found (${knowledgeId}).`);
    }
  }

  private async markKnowledgeNeedsReview(knowledgeId: string): Promise<void> {
    await this.markKnowledgeStatus(knowledgeId, 'needs_review');
  }

  private async markKnowledgeStatus(knowledgeId: string, status: 'needs_review' | 'archived'): Promise<void> {
    const updated = await this.store.updateKnowledge(knowledgeId, { status });
    if (!updated) {
      throw new Error(`Cannot approve learning proposal: affected knowledge not found (${knowledgeId}).`);
    }
  }

  private async getAffectedKnowledge(knowledgeId: string): Promise<StoredKnowledge> {
    const knowledge = await this.store.getKnowledge(knowledgeId);
    if (!knowledge) {
      throw new Error(`Cannot approve learning proposal: affected knowledge not found (${knowledgeId}).`);
    }

    return knowledge;
  }

  listLabels(options: { project?: string; limit: number }) {
    return this.store.listLabels(options);
  }

  listContextPacks(options: ListRecordsOptions) {
    return this.store.listContextPacks(options);
  }

  listFeedbackEvents(options: ListRecordsOptions) {
    return this.store.listFeedbackEvents(options);
  }

  async collectContextQualityFeedback(input: ContextQualityReportInput): Promise<ContextQualityReport> {
    const lookupLimit = Math.min(500, Math.max(input.limit * 8, input.limit + 50));
    const feedbackEvents = await this.store.listFeedbackEvents({
      project: input.project,
      status: input.feedbackType,
      limit: lookupLimit,
    });
    const filteredFeedback = feedbackEvents
      .filter((event) => isContextQualityFeedback(event.feedbackType));
    const qualityFeedback = filteredFeedback.slice(0, input.limit);
    const records = await Promise.all(
      qualityFeedback.map((feedback) => this.buildContextQualityRecord(feedback, input.project)),
    );

    return {
      generatedAt: new Date().toISOString(),
      filters: input,
      totalMatched: filteredFeedback.length,
      records,
      rollups: contextQualityRollups(records),
    };
  }

  private async buildContextQualityRecord(
    feedback: FeedbackEvent,
    project?: string,
  ): Promise<ContextQualityFeedbackRecord> {
    const pack = feedback.contextPackId ? await this.store.getContextPack(feedback.contextPackId) : undefined;
    const sourceSessionId = metadataString(feedback.metadata, 'agentSessionId')
      ?? metadataString(feedback.metadata, 'sessionId');
    const [session, openKnowledgeGaps, openLearningProposals] = await Promise.all([
      sourceSessionId ? this.store.getAgentSession(sourceSessionId) : undefined,
      this.openKnowledgeGapsForFeedback(feedback, project, sourceSessionId),
      this.openLearningProposalsForFeedback(feedback, project, sourceSessionId),
    ]);
    const adjacentItems = adjacentItemSummaries(pack, feedback);

    return {
      feedback,
      contextPack: pack ? packSummary(pack) : undefined,
      session: session
        ? {
          id: session.id,
          status: session.status,
          outcome: session.outcome,
          prompt: session.prompt,
          summary: session.summary,
        }
        : undefined,
      adjacentItems,
      missingSignals: missingSignalsForFeedback(feedback, pack, openKnowledgeGaps),
      openKnowledgeGaps,
      openLearningProposals,
      suggestedReviewActions: suggestedReviewActionsFor(feedback.feedbackType, {
        adjacentItems,
        openKnowledgeGaps,
        openLearningProposals,
      }),
    };
  }

  private async openKnowledgeGapsForFeedback(
    feedback: FeedbackEvent,
    project?: string,
    sourceSessionId?: string,
  ): Promise<ContextQualityKnowledgeGapSummary[]> {
    const gaps = await this.store.listKnowledgeGaps({
      project: project ?? feedback.project,
      status: 'open',
      sourceSessionId,
      contextPackId: feedback.contextPackId,
      limit: 100,
    });

    return gaps
      .filter((gap) => gap.sourceFeedbackId === feedback.id || gap.metadata.feedbackType === feedback.feedbackType)
      .map((gap) => ({
        id: gap.id,
        status: gap.status,
        missingSignals: gap.missingSignals,
        reason: gap.reason,
      }))
      .slice(0, 8);
  }

  private async openLearningProposalsForFeedback(
    feedback: FeedbackEvent,
    project?: string,
    sourceSessionId?: string,
  ): Promise<ContextQualityLearningProposalSummary[]> {
    const proposals = await this.store.listLearningProposals({
      project: project ?? feedback.project,
      status: 'open',
      sourceSessionId,
      contextPackId: feedback.contextPackId,
      limit: 100,
    });

    return proposals
      .filter((proposal) => proposal.sourceFeedbackId === feedback.id || proposal.metadata.feedbackType === feedback.feedbackType)
      .map((proposal) => ({
        id: proposal.id,
        status: proposal.status,
        proposalType: proposal.proposalType,
        affectedKnowledgeId: proposal.affectedKnowledgeId,
        reason: proposal.reason,
        evidence: proposal.evidence,
      }))
      .slice(0, 8);
  }

  listAgentSessions(options: ListRecordsOptions) {
    return this.store.listAgentSessions(options);
  }

  getAgentSession(id: string) {
    return this.store.getAgentSession(id);
  }

  listAgentContextDecisions(options: { sessionId?: string; limit: number }) {
    return this.store.listAgentContextDecisions(options);
  }

  listReflectionDrafts(options: ListRecordsOptions) {
    return this.store.listReflectionDrafts(options);
  }

  getReflectionDraft(id: string) {
    return this.store.getReflectionDraft(id);
  }

  async updateReflectionDraft(id: string, patch: ReflectionDraftPatchInput) {
    const draft = await this.store.updateReflectionDraft(id, patch);
    if (draft) {
      this.requestPhysicalMirror('reflection-updated');
    }
    return draft;
  }

  async importFiles(input: ImportFilesInput) {
    const result = await this.ingestion.ingestFiles(input.project, input.files, { mode: input.mode });
    this.requestWriteThroughBackup('import-files');
    this.requestPhysicalMirror('import-files');
    return result;
  }

  async cleanup(input: CleanupOperationsInput) {
    const result = await this.store.cleanupOperations(input);
    const deletedCount = Object.values(result.deleted).reduce((sum, count) => sum + count, 0);
    if (!result.dryRun && deletedCount > 0) {
      this.requestPhysicalMirror('operations-cleanup');
    }
    return result;
  }

  exportProjectMap(options: { project?: string; limit: number }) {
    return this.store.exportProjectMap(options);
  }

  exportKnowledgeGraphJsonl(options: { project?: string; limit: number }) {
    return this.store.exportKnowledgeGraphJsonl(options);
  }

  exportReadableSummary(options: { project?: string; limit: number }) {
    return this.store.exportReadableSummary(options);
  }

  createBackup(input: CreateBackupInput = {}) {
    return this.backups.createBackup(input);
  }

  listBackups() {
    return this.backups.listBackups();
  }

  getBackupStatus() {
    return this.backups.getBackupStatus();
  }

  verifyBackup(input: { backupIdOrPath?: string } = {}) {
    return this.backups.verifyBackup(input);
  }

  async restoreBackup(input: RestoreBackupInput = {}) {
    const result = await this.backups.restoreBackup(input);
    if (!result.dryRun) {
      this.requestPhysicalMirror('backup-restored');
    }
    return result;
  }

  pruneBackups(input: BackupRetentionInput = {}) {
    return this.backups.pruneBackups(input);
  }

  startScheduledBackups() {
    this.backups.startScheduledBackups();
  }

  stopScheduledBackups() {
    this.backups.stopScheduledBackups();
  }

  requestWriteThroughBackup(reason: string) {
    this.backups.requestWriteThroughBackup(reason);
  }

  requestPhysicalMirror(reason: string) {
    this.backups.requestPhysicalMirror(reason);
  }

  syncPhysicalMirror(reason: string) {
    return this.backups.syncPhysicalMirror(reason);
  }

  close() {
    return this.backups.close();
  }
}

const CONTEXT_QUALITY_FEEDBACK_TYPES = new Set<FeedbackQualityType>([
  'selected_but_noisy',
  'too_much_adjacent_context',
  'missing_orientation',
  'missing_current_handoff',
  'missing_verification_commands',
]);

function isContextQualityFeedback(value: string): value is FeedbackQualityType {
  return CONTEXT_QUALITY_FEEDBACK_TYPES.has(value as FeedbackQualityType);
}

function packSummary(pack: ContextPack): ContextQualityFeedbackRecord['contextPack'] {
  return {
    id: pack.id,
    project: pack.project,
    status: pack.status,
    prompt: pack.prompt,
    confidence: pack.confidence,
    fitStatus: pack.contextFit?.fitStatus,
    fitScore: pack.contextFit?.fitScore,
    missingSignals: pack.contextFit?.missingSignals ?? [],
  };
}

function adjacentItemSummaries(
  pack: ContextPack | undefined,
  feedback: FeedbackEvent,
): ContextQualityItemSummary[] {
  if (!pack) {
    return [];
  }

  const rejectedIds = new Set(feedback.rejectedKnowledgeIds ?? []);
  const items = pack.sections.flatMap((section) => section.items);
  const explicitNoisyItems = items
    .filter((item) => (
      item.evidenceCategory === 'adjacentContext'
      || rejectedIds.has(item.knowledgeId)
      || (feedback.feedbackType === 'too_much_adjacent_context' && item.evidenceStrength === 'weak')
    ));
  const reviewItems = explicitNoisyItems.length > 0
    ? explicitNoisyItems
    : fallbackReviewItemsForNoisyFeedback(items, feedback);

  return reviewItems
    .map((item) => ({
      knowledgeId: item.knowledgeId,
      title: item.title,
      evidenceCategory: item.evidenceCategory,
      evidenceStrength: item.evidenceStrength,
      score: item.finalScore,
      reasons: item.matchReasons.slice(0, 8),
      missingSignals: item.fitMissingSignals?.slice(0, 8) ?? [],
    }))
    .slice(0, 12);
}

function fallbackReviewItemsForNoisyFeedback(
  items: ContextPack['sections'][number]['items'],
  feedback: FeedbackEvent,
): ContextPack['sections'][number]['items'] {
  if (feedback.feedbackType !== 'selected_but_noisy' && feedback.feedbackType !== 'too_much_adjacent_context') {
    return [];
  }

  const reviewCandidates = items.filter((item) => (
    item.evidenceCategory !== 'directTaskEvidence'
    || item.evidenceStrength !== 'strong'
    || (item.fitMissingSignals?.length ?? 0) > 0
  ));

  return (reviewCandidates.length > 0 ? reviewCandidates : items).slice(0, 6);
}

function missingSignalsForFeedback(
  feedback: FeedbackEvent,
  pack: ContextPack | undefined,
  gaps: ContextQualityKnowledgeGapSummary[],
): string[] {
  const signals = [
    ...qualitySignalForFeedbackType(feedback.feedbackType),
    ...metadataStringArray(feedback.metadata?.missingSignals),
    ...(pack?.contextFit?.missingSignals ?? []),
    ...flattenActionableSignals(pack?.actionableMissingSignals),
    ...gaps.flatMap((gap) => gap.missingSignals),
    feedback.reason,
  ];

  return uniqueStrings(signals.filter((signal): signal is string => Boolean(signal?.trim()))).slice(0, 20);
}

function flattenActionableSignals(signals: ContextPack['actionableMissingSignals']): string[] {
  if (!signals) {
    return [];
  }

  return [
    ...signals.files.map((value) => `file:${value}`),
    ...signals.symbols.map((value) => `symbol:${value}`),
    ...signals.errors.map((value) => `error:${value}`),
    ...signals.docs,
    ...signals.intent,
    ...signals.other,
  ];
}

function qualitySignalForFeedbackType(feedbackType: FeedbackEvent['feedbackType']): string[] {
  switch (feedbackType) {
    case 'missing_orientation':
      return ['orientation'];
    case 'missing_current_handoff':
      return ['current handoff'];
    case 'missing_verification_commands':
      return ['verification commands'];
    case 'too_much_adjacent_context':
      return ['adjacent context noise'];
    case 'selected_but_noisy':
      return ['selected but noisy'];
    default:
      return [];
  }
}

function suggestedReviewActionsFor(
  feedbackType: FeedbackEvent['feedbackType'],
  context: {
    adjacentItems: ContextQualityItemSummary[];
    openKnowledgeGaps: ContextQualityKnowledgeGapSummary[];
    openLearningProposals: ContextQualityLearningProposalSummary[];
  },
): string[] {
  const actions: string[] = [];

  switch (feedbackType) {
    case 'selected_but_noisy':
      actions.push('Review adjacent items and tighten labels or relations that made useful context noisy.');
      break;
    case 'too_much_adjacent_context':
      actions.push('Review open missing_relation proposals and demote or relabel adjacent context.');
      break;
    case 'missing_orientation':
      actions.push('Add or update startup orientation knowledge with first files, likely surfaces, and task intent.');
      break;
    case 'missing_current_handoff':
      actions.push('Refresh handoff.md knowledge and ensure current handoff references are labeled.');
      break;
    case 'missing_verification_commands':
      actions.push('Add verification command references to the relevant workflow or project docs.');
      break;
    default:
      break;
  }

  if (context.adjacentItems.length > 0) {
    actions.push('Inspect noisy adjacent item summaries before changing ranking weights.');
  }
  if (context.openKnowledgeGaps.length > 0) {
    actions.push('Triage linked open knowledge gaps before closing the feedback loop.');
  }
  if (context.openLearningProposals.length > 0) {
    actions.push('Review linked learning proposals instead of mutating knowledge directly.');
  }

  return uniqueStrings(actions);
}

function contextQualityRollups(records: ContextQualityFeedbackRecord[]): ContextQualityReport['rollups'] {
  return {
    feedbackTypes: countValues(records.map((record) => record.feedback.feedbackType).filter(isContextQualityFeedback)),
    projects: countValues(records.map((record) => (
      record.feedback.project
      ?? record.contextPack?.project
      ?? 'unknown'
    ))),
    suggestedReviewActions: countValues(records.flatMap((record) => record.suggestedReviewActions)),
    missingSignals: countValues(records.flatMap((record) => record.missingSignals)),
    adjacentItems: countAdjacentItems(records),
  };
}

function countValues<T extends string>(values: T[]): Array<{ value: T; count: number }> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function countAdjacentItems(records: ContextQualityFeedbackRecord[]): ContextQualityReport['rollups']['adjacentItems'] {
  const counts = new Map<string, { knowledgeId: string; title: string; count: number }>();
  for (const item of records.flatMap((record) => record.adjacentItems)) {
    const current = counts.get(item.knowledgeId) ?? {
      knowledgeId: item.knowledgeId,
      title: item.title,
      count: 0,
    };
    current.count += 1;
    counts.set(item.knowledgeId, current);
  }

  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title))
    .slice(0, 12);
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function sanitizeLearningProposalPatch(patch: LearningProposalPatchInput): LearningProposalPatchInput {
  if (patch.status !== 'approved' || !patch.metadata || !Object.hasOwn(patch.metadata, 'approvalAction')) {
    return patch;
  }

  const { approvalAction: _approvalAction, ...metadata } = patch.metadata;
  return {
    ...patch,
    metadata,
  };
}

function readSuggestedLabels(proposal: LearningProposal): LabelInput[] {
  const value = proposal.metadata.suggestedLabels;
  if (value === undefined) {
    return [];
  }

  return validateKnowledgePatchInput({ labels: value }).labels ?? [];
}

function readSuggestedReferences(proposal: LearningProposal): ReferenceInput[] {
  const value = proposal.metadata.suggestedReferences;
  if (value === undefined) {
    return [];
  }

  return validateKnowledgePatchInput({ references: value }).references ?? [];
}

type AutoMemoryCleanupAction =
  | { action: 'needs_review' }
  | { action: 'archive' }
  | { action: 'supersede'; supersedingKnowledgeId: string };

function readAutoMemoryCleanupAction(proposal: LearningProposal): AutoMemoryCleanupAction {
  const value = proposal.metadata.cleanupAction;
  if (value === undefined) {
    return { action: 'needs_review' };
  }

  if (value === 'needs_review') {
    return { action: 'needs_review' };
  }

  if (value === 'archive') {
    return { action: 'archive' };
  }

  if (value === 'supersede') {
    const supersedingKnowledgeId = metadataString(proposal.metadata, 'supersedingKnowledgeId')
      ?? proposal.candidateKnowledgeId;
    if (!supersedingKnowledgeId) {
      throw learningProposalMetadataIssue(
        'supersedingKnowledgeId',
        'must be a non-empty string when cleanupAction is "supersede".',
      );
    }

    return { action: 'supersede', supersedingKnowledgeId };
  }

  throw learningProposalMetadataIssue('cleanupAction', 'must be one of: needs_review, archive, supersede.');
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function learningProposalMetadataIssue(key: string, message: string): ValidationError {
  const path = `learning proposal patch input.metadata.${key}`;
  return new ValidationError(`${path} ${message}`, [{ path, message: `${path} ${message}` }]);
}

function mergeLabels(labels: LabelInput[]): LabelInput[] {
  const byKey = new Map<string, LabelInput>();
  for (const label of labels) {
    const normalized = normalizeLabel(label.value);
    const key = `${label.type}:${normalized}`;
    const value = label.value.trim();
    const existing = byKey.get(key);
    if (!existing) {
      const next = label.weight === undefined
        ? { type: label.type, value }
        : { type: label.type, value, weight: label.weight };
      byKey.set(key, next);
      continue;
    }

    byKey.set(key, {
      type: existing.type,
      value: existing.value,
      weight: Math.max(existing.weight ?? 1, label.weight ?? 1),
    });
  }

  return [...byKey.values()];
}

function mergeReferences(references: ReferenceInput[]): ReferenceInput[] {
  const byKey = new Map<string, ReferenceInput>();
  for (const reference of references) {
    const normalized: ReferenceInput = {
      ...reference,
      uri: reference.uri.trim(),
    };
    const key = referenceKey(normalized);
    byKey.set(key, byKey.get(key) ?? normalized);
  }

  return [...byKey.values()];
}

function referenceKey(reference: ReferenceInput): string {
  return JSON.stringify([
    reference.type,
    reference.uri,
    reference.lineStart ?? null,
    reference.lineEnd ?? null,
    reference.commitSha ?? null,
  ]);
}

function detectConflicts(knowledge: StoredKnowledge[]): KnowledgeConflictInput[] {
  const conflicts: KnowledgeConflictInput[] = [];

  for (let leftIndex = 0; leftIndex < knowledge.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < knowledge.length; rightIndex += 1) {
      const left = knowledge[leftIndex]!;
      const right = knowledge[rightIndex]!;
      if (left.project !== right.project) {
        continue;
      }

      const sharedEvidence = sharedConflictEvidence(left, right);
      if (sharedEvidence.length === 0) {
        continue;
      }

      const summaryConflict = hasOpposingSummaryLanguage(left, right);
      const freshnessConflict = hasFreshnessConflict(left, right);
      if (summaryConflict) {
        conflicts.push({
          project: left.project,
          leftKnowledgeId: left.id,
          rightKnowledgeId: right.id,
          conflictType: 'summary_contradiction' as const,
          sharedEvidence,
          reason: 'Shared evidence has opposing summary guidance.',
          metadata: conflictMetadata(left, right),
        });
      }

      if (freshnessConflict) {
        conflicts.push({
          project: left.project,
          leftKnowledgeId: left.id,
          rightKnowledgeId: right.id,
          conflictType: 'freshness_conflict' as const,
          sharedEvidence,
          reason: 'Shared evidence has competing freshness signals.',
          metadata: conflictMetadata(left, right),
        });
      }
    }
  }

  return conflicts;
}

function sharedConflictEvidence(left: StoredKnowledge, right: StoredKnowledge): string[] {
  const leftEvidence = evidenceMap(left);
  const rightEvidence = evidenceMap(right);
  return [...leftEvidence.entries()]
    .filter(([key]) => rightEvidence.has(key))
    .map(([, value]) => value)
    .slice(0, 12);
}

function evidenceMap(item: StoredKnowledge): Map<string, string> {
  const evidence = new Map<string, string>();
  for (const label of item.labels) {
    if (!['file', 'symbol', 'error', 'business_area', 'domain', 'technology', 'task_type', 'workflow_stage'].includes(label.type)) {
      continue;
    }
    evidence.set(`label:${label.type}:${normalizeLabel(label.value)}`, `${label.type}:${label.value}`);
  }

  for (const reference of item.references) {
    if (reference.type !== 'file' && reference.type !== 'url' && reference.type !== 'external') {
      continue;
    }
    evidence.set(`reference:${reference.type}:${normalizeLabel(reference.uri)}`, `${reference.type}:${reference.uri}`);
  }

  return evidence;
}

function hasOpposingSummaryLanguage(left: StoredKnowledge, right: StoredKnowledge): boolean {
  const leftPolarity = textPolarity(left);
  const rightPolarity = textPolarity(right);
  return (
    (leftPolarity.negative && rightPolarity.positive) ||
    (leftPolarity.positive && rightPolarity.negative)
  );
}

function hasFreshnessConflict(left: StoredKnowledge, right: StoredKnowledge): boolean {
  const leftTime = left.freshnessAt ? Date.parse(left.freshnessAt) : NaN;
  const rightTime = right.freshnessAt ? Date.parse(right.freshnessAt) : NaN;
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return false;
  }

  const daysApart = Math.abs(leftTime - rightTime) / (24 * 60 * 60 * 1000);
  if (daysApart < 30) {
    return false;
  }

  const leftPolarity = textPolarity(left);
  const rightPolarity = textPolarity(right);
  return leftPolarity.freshness !== rightPolarity.freshness && (
    leftPolarity.freshness !== 'neutral' ||
    rightPolarity.freshness !== 'neutral'
  );
}

function textPolarity(item: StoredKnowledge) {
  const text = `${item.title} ${item.summary} ${item.content.slice(0, 800)}`.toLowerCase();
  return {
    positive: /\b(use|prefer|should|must|required|enable|allow|current|latest|new)\b/.test(text),
    negative: /\b(do not|don't|avoid|never|must not|should not|no longer|stale|obsolete|deprecated|legacy)\b/.test(text),
    freshness: /\b(current|latest|new|now)\b/.test(text)
      ? 'current'
      : /\b(old|legacy|stale|obsolete|deprecated)\b/.test(text)
        ? 'stale'
        : 'neutral',
  };
}

function conflictMetadata(left: StoredKnowledge, right: StoredKnowledge): Record<string, unknown> {
  return {
    detector: 'deterministic-overlap-v1',
    leftTitle: left.title,
    rightTitle: right.title,
    leftFreshnessAt: left.freshnessAt,
    rightFreshnessAt: right.freshnessAt,
  };
}
