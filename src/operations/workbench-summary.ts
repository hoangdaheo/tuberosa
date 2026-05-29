import type { AppConfig } from '../config.js';
import type { ErrorLogInsightService } from '../error-log/insights.js';
import type { MaintenanceService } from '../maintenance/service.js';
import type {
  CollectErrorLogsOptions,
  BackupStatus,
  ContextQualityReport,
  ErrorLogCollection,
  ErrorLogSummary,
  MaintenanceBatch,
  MaintenanceItem,
  ReferenceInput,
  WorkbenchBackupStatus,
  WorkbenchContextQualityReport,
  WorkbenchCountMetadata,
  WorkbenchErrorLogCollection,
  WorkbenchFeedbackSummary,
  WorkbenchKnowledgeConflictSummary,
  WorkbenchKnowledgeGapSummary,
  WorkbenchKnowledgeSummary,
  WorkbenchLearningProposalSummary,
  WorkbenchMaintenanceItemSummary,
  WorkbenchMaintenancePreview,
  WorkbenchReflectionDraftSummary,
  WorkbenchRecommendedAction,
  WorkbenchSessionSummary,
  WorkbenchSourceHealth,
  WorkbenchSummary,
  WorkbenchSummaryCountKey,
  WorkbenchSummaryCounts,
  WorkbenchSummaryInput,
} from '../types.js';
import type { OperationsService } from './service.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { SourceFileStatus } from '../source-sync/types.js';

const COUNT_LIMIT = 100;
const SHORT_TEXT_LIMIT = 240;
const PROMPT_TEXT_LIMIT = 320;
const ARRAY_PREVIEW_LIMIT = 8;

export interface WorkbenchSummaryServices {
  config: Pick<AppConfig, 'store' | 'cache' | 'modelProvider' | 'backupDir'>;
  operations: Pick<
    OperationsService,
    | 'getBackupStatus'
    | 'listAgentSessions'
    | 'collectContextQualityFeedback'
    | 'listReflectionDrafts'
    | 'listKnowledgeGaps'
    | 'listLearningProposals'
    | 'listKnowledgeConflicts'
    | 'listKnowledge'
  >;
  errorLogInsights: Pick<ErrorLogInsightService, 'collect'>;
  /** Phase 10 — optional maintenance scanner. Workbench renders an empty preview when omitted. */
  maintenance?: Pick<MaintenanceService, 'propose'>;
  /** P0 source lifecycle sync — optional store for ledger health. Omitted → no sourceHealth in summary. */
  store?: Pick<KnowledgeStore, 'listSourceFiles'>;
}

export async function buildSourceHealth(
  store: Pick<KnowledgeStore, 'listSourceFiles'>,
  options: { project?: string; limit: number },
): Promise<WorkbenchSourceHealth> {
  const files = await store.listSourceFiles({ project: options.project, limit: options.limit });
  const counts: Record<SourceFileStatus, number> = { tracked: 0, changed: 0, missing: 0, archived: 0, ignored: 0 };
  const tombstones: WorkbenchSourceHealth['tombstones'] = [];
  for (const file of files) {
    counts[file.status] += 1;
    if (file.status === 'archived') {
      tombstones.push({ path: file.path, archivedAt: file.archivedAt });
    }
  }
  return { counts, tombstones };
}

export async function buildWorkbenchSummary(
  services: WorkbenchSummaryServices,
  input: WorkbenchSummaryInput,
): Promise<WorkbenchSummary> {
  const filters = {
    project: input.project,
    limit: clampLimit(input.limit),
  };
  const project = filters.project;
  const listLimit = Math.max(filters.limit, COUNT_LIMIT);

  const maintenancePromise: Promise<MaintenanceBatch | undefined> = services.maintenance
    ? services.maintenance.propose({ project, limit: filters.limit }).catch(() => undefined)
    : Promise.resolve(undefined);

  const [
    backupStatus,
    sessionCandidates,
    contextQuality,
    pendingDraftCandidates,
    openGapCandidates,
    openProposalCandidates,
    openConflictCandidates,
    autoMemoryCandidates,
    riskyAutoMemoryCandidates,
    openErrorLogs,
    maintenanceBatch,
  ] = await Promise.all([
    services.operations.getBackupStatus(),
    services.operations.listAgentSessions({ project, limit: listLimit }),
    services.operations.collectContextQualityFeedback({ project, limit: filters.limit }),
    services.operations.listReflectionDrafts({ project, status: 'pending', limit: listLimit }),
    services.operations.listKnowledgeGaps({ project, status: 'open', limit: listLimit }),
    services.operations.listLearningProposals({ project, status: 'open', limit: listLimit }),
    services.operations.listKnowledgeConflicts({ project, status: 'open', limit: listLimit }),
    services.operations.listKnowledge({ project, review: 'auto_memory', limit: listLimit }),
    services.operations.listKnowledge({ project, review: 'risky_auto_memory', limit: listLimit }),
    services.errorLogInsights.collect(openErrorLogOptions(project, filters.limit)),
    maintenancePromise,
  ]);

  const recentSessions = sessionCandidates.slice(0, filters.limit).map(compactSession);
  const contextQualitySummary = compactContextQuality(contextQuality);
  const pendingDrafts = pendingDraftCandidates.slice(0, filters.limit).map(compactDraft);
  const openGaps = openGapCandidates.slice(0, filters.limit).map(compactGap);
  const openProposals = openProposalCandidates.slice(0, filters.limit).map(compactProposal);
  const openConflicts = openConflictCandidates.slice(0, filters.limit).map(compactConflict);
  const riskyAutoMemories = riskyAutoMemoryCandidates.slice(0, filters.limit).map(compactKnowledge);
  const openErrorLogSummary = compactErrorLogs(openErrorLogs);
  const backupStatusSummary = compactBackupStatus(backupStatus);
  const pendingMaintenance = compactMaintenancePreview(maintenanceBatch, filters.limit);
  const activeSessions = sessionCandidates.filter((session) => session.status === 'active').length;
  const counts: WorkbenchSummaryCounts = {
    recentSessions: sessionCandidates.length,
    activeSessions,
    pendingDrafts: pendingDraftCandidates.length,
    contextQualityRecords: contextQuality.records.length,
    contextQualityMatched: contextQuality.totalMatched,
    openGaps: openGapCandidates.length,
    openProposals: openProposalCandidates.length,
    openConflicts: openConflictCandidates.length,
    autoMemories: autoMemoryCandidates.length,
    riskyAutoMemories: riskyAutoMemoryCandidates.length,
    openErrorLogs: openErrorLogs.totalMatched,
    backupCount: backupStatus.backupCount,
    pendingMaintenance: pendingMaintenance.totalDetected,
  };
  const countMetadata = buildCountMetadata({
    sessionCandidates,
    pendingDraftCandidates,
    openGapCandidates,
    openProposalCandidates,
    openConflictCandidates,
    autoMemoryCandidates,
    riskyAutoMemoryCandidates,
  });

  const sourceHealth = services.store
    ? await buildSourceHealth(services.store, { project, limit: listLimit }).catch(() => undefined)
    : undefined;

  return {
    generatedAt: new Date().toISOString(),
    filters,
    health: {
      ok: true,
      service: 'tuberosa',
      store: services.config.store,
      durability: services.config.store === 'postgres' ? 'persistent' : 'ephemeral',
      cache: services.config.cache,
      modelProvider: services.config.modelProvider,
      backupDir: services.config.backupDir,
      backupStatus: backupStatusSummary,
    },
    counts,
    countMetadata,
    recentSessions,
    contextQuality: contextQualitySummary,
    pendingDrafts,
    openGaps,
    openProposals,
    openConflicts,
    riskyAutoMemories,
    openErrorLogs: openErrorLogSummary,
    pendingMaintenance,
    recommendedActions: recommendedActions({
      counts,
      backupStatus,
      contextQuality: contextQualitySummary,
      recentSessions,
      pendingDrafts,
      openGaps,
      openProposals,
      openConflicts,
      riskyAutoMemories,
      project,
    }),
    ...(sourceHealth ? { sourceHealth } : {}),
  };
}

function compactMaintenancePreview(
  batch: MaintenanceBatch | undefined,
  limit: number,
): WorkbenchMaintenancePreview {
  if (!batch) {
    return {
      batchId: '',
      generatedAt: new Date().toISOString(),
      counts: { duplicate_memory: 0, stale_relation: 0, superseded_reflection: 0, weak_label: 0 },
      totalDetected: 0,
      truncated: false,
      items: [],
    };
  }
  return {
    batchId: batch.id,
    generatedAt: batch.generatedAt,
    counts: batch.counts,
    totalDetected: batch.totalDetected,
    truncated: batch.truncated,
    items: batch.items.slice(0, limit).map(compactMaintenanceItem),
  };
}

function compactMaintenanceItem(item: MaintenanceItem): WorkbenchMaintenanceItemSummary {
  return {
    id: item.id,
    kind: item.kind,
    risk: item.risk,
    reason: shortText(item.reason),
    project: item.project,
    knowledgeId: item.knowledgeId,
    relationId: item.relationId,
    reflectionDraftId: item.reflectionDraftId,
    label: item.label,
    closestKnowledgeId: item.closestKnowledgeId,
  };
}

function openErrorLogOptions(project: string | undefined, limit: number): CollectErrorLogsOptions {
  return {
    project,
    statuses: ['open', 'triaged'],
    limit,
    offset: 0,
  };
}

function recommendedActions(input: {
  counts: WorkbenchSummaryCounts;
  backupStatus: BackupStatus;
  contextQuality: WorkbenchContextQualityReport;
  recentSessions: WorkbenchSessionSummary[];
  pendingDrafts: WorkbenchReflectionDraftSummary[];
  openGaps: WorkbenchKnowledgeGapSummary[];
  openProposals: WorkbenchLearningProposalSummary[];
  openConflicts: WorkbenchKnowledgeConflictSummary[];
  riskyAutoMemories: WorkbenchKnowledgeSummary[];
  project?: string;
}): WorkbenchRecommendedAction[] {
  const actions: WorkbenchRecommendedAction[] = [];
  const projectQuery = input.project ? { project: input.project } : {};
  const backupIssue = backupHealthIssue(input.backupStatus);

  if (backupIssue) {
    actions.push({
      priority: 1,
      target: 'backup_health',
      label: 'Repair backup health',
      count: 1,
      href: '/operations/backups/status',
      reason: backupIssue,
    });
  }

  if (input.contextQuality.totalMatched > 0) {
    actions.push({
      priority: 1,
      target: 'context_quality',
      label: 'Review context-quality feedback',
      count: input.contextQuality.totalMatched,
      href: endpointWithQuery('/operations/context-quality', { ...projectQuery, limit: input.contextQuality.filters.limit }),
      reason: 'Noisy or missing context feedback directly affects startup trust.',
    });
  }

  if (input.pendingDrafts.length > 0) {
    actions.push({
      priority: 2,
      target: 'pending_drafts',
      label: 'Review pending reflection drafts',
      count: input.counts.pendingDrafts,
      href: endpointWithQuery('/reflection-drafts', { ...projectQuery, status: 'pending' }),
      reason: 'Unreviewed drafts stay out of retrieval until a reviewer decides.',
    });
  }

  if (input.riskyAutoMemories.length > 0) {
    actions.push({
      priority: 2,
      target: 'risky_auto_memories',
      label: 'Audit risky auto-approved memories',
      count: input.counts.riskyAutoMemories,
      href: endpointWithQuery('/knowledge', { ...projectQuery, review: 'risky_auto_memory' }),
      reason: 'Strict auto-learning stays enabled, but weak or disputed auto memories need visible review.',
    });
  }

  if (input.openConflicts.length > 0) {
    actions.push({
      priority: 3,
      target: 'knowledge_conflicts',
      label: 'Resolve open knowledge conflicts',
      count: input.counts.openConflicts,
      href: endpointWithQuery('/operations/conflicts', { ...projectQuery, status: 'open' }),
      reason: 'Conflicting guidance can make future context packs unreliable.',
    });
  }

  if (input.openGaps.length > 0) {
    actions.push({
      priority: 3,
      target: 'knowledge_gaps',
      label: 'Triage open knowledge gaps',
      count: input.counts.openGaps,
      href: endpointWithQuery('/operations/knowledge-gaps', { ...projectQuery, status: 'open' }),
      reason: 'Open gaps mark evidence agents could not find.',
    });
  }

  if (input.openProposals.length > 0) {
    actions.push({
      priority: 3,
      target: 'learning_proposals',
      label: 'Review open learning proposals',
      count: input.counts.openProposals,
      href: endpointWithQuery('/operations/learning-proposals', { ...projectQuery, status: 'open' }),
      reason: 'Learning proposals are the explicit path for label, relation, supersession, and cleanup changes.',
    });
  }

  if (input.counts.openErrorLogs > 0) {
    actions.push({
      priority: 4,
      target: 'error_logs',
      label: 'Review error-log learning candidates',
      count: input.counts.openErrorLogs,
      href: endpointWithQuery('/operations/error-logs/collection', {
        ...projectQuery,
        statuses: 'open,triaged',
      }),
      reason: 'Open incidents can become reviewed lessons after a real fix.',
    });
  }

  if (input.counts.activeSessions > 0) {
    actions.push({
      priority: 4,
      target: 'agent_sessions',
      label: 'Finish active sessions or record context decisions',
      count: input.counts.activeSessions,
      href: endpointWithQuery('/agent-sessions', { ...projectQuery, status: 'active' }),
      reason: 'Finished sessions with decisions provide the best audit trail for future agents.',
    });
  }

  if (input.counts.pendingMaintenance > 0) {
    actions.push({
      priority: 3,
      target: 'pending_maintenance',
      label: 'Apply or dismiss pending maintenance',
      count: input.counts.pendingMaintenance,
      href: endpointWithQuery('/operations/maintenance', { ...projectQuery }),
      reason: 'Duplicate memories, stale relations, supersedes, and weak labels are surfaced as a previewable batch.',
    });
  }

  if (actions.length === 0) {
    actions.push({
      priority: 5,
      target: 'none',
      label: 'No urgent review queues',
      count: 0,
      reason: 'The current filters did not surface context-quality, memory, conflict, session, or error-log work.',
    });
  }

  return actions.sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label));
}

function buildCountMetadata(input: {
  sessionCandidates: unknown[];
  pendingDraftCandidates: unknown[];
  openGapCandidates: unknown[];
  openProposalCandidates: unknown[];
  openConflictCandidates: unknown[];
  autoMemoryCandidates: unknown[];
  riskyAutoMemoryCandidates: unknown[];
}): WorkbenchCountMetadata {
  const capped: Partial<Record<WorkbenchSummaryCountKey, boolean>> = {};
  markCapped(capped, 'recentSessions', input.sessionCandidates);
  markCapped(capped, 'activeSessions', input.sessionCandidates);
  markCapped(capped, 'pendingDrafts', input.pendingDraftCandidates);
  markCapped(capped, 'openGaps', input.openGapCandidates);
  markCapped(capped, 'openProposals', input.openProposalCandidates);
  markCapped(capped, 'openConflicts', input.openConflictCandidates);
  markCapped(capped, 'autoMemories', input.autoMemoryCandidates);
  markCapped(capped, 'riskyAutoMemories', input.riskyAutoMemoryCandidates);

  return {
    scanLimit: COUNT_LIMIT,
    capped,
  };
}

function markCapped(
  capped: Partial<Record<WorkbenchSummaryCountKey, boolean>>,
  key: WorkbenchSummaryCountKey,
  candidates: unknown[],
): void {
  if (candidates.length >= COUNT_LIMIT) {
    capped[key] = true;
  }
}

function compactSession(session: {
  id: string;
  project?: string;
  cwd?: string;
  prompt: string;
  status: WorkbenchSessionSummary['status'];
  outcome?: WorkbenchSessionSummary['outcome'];
  summary?: string;
  initialContextPackId?: string;
  reflectionDraftIds: string[];
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string;
}): WorkbenchSessionSummary {
  return {
    id: session.id,
    project: session.project,
    cwd: session.cwd,
    status: session.status,
    outcome: session.outcome,
    prompt: shortText(session.prompt, PROMPT_TEXT_LIMIT),
    summary: optionalShortText(session.summary),
    initialContextPackId: session.initialContextPackId,
    reflectionDraftCount: session.reflectionDraftIds.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    finishedAt: session.finishedAt,
  };
}

function compactContextQuality(report: ContextQualityReport): WorkbenchContextQualityReport {
  return {
    generatedAt: report.generatedAt,
    filters: report.filters,
    totalMatched: report.totalMatched,
    records: report.records.map((record) => ({
      feedback: compactFeedback(record.feedback),
      contextPack: record.contextPack
        ? {
          ...record.contextPack,
          prompt: shortText(record.contextPack.prompt, PROMPT_TEXT_LIMIT),
          missingSignals: previewStrings(record.contextPack.missingSignals),
        }
        : undefined,
      session: record.session
        ? {
          ...record.session,
          prompt: shortText(record.session.prompt, PROMPT_TEXT_LIMIT),
          summary: optionalShortText(record.session.summary),
        }
        : undefined,
      adjacentItems: record.adjacentItems.map((item) => ({
        ...item,
        reasons: previewStrings(item.reasons),
        missingSignals: previewStrings(item.missingSignals),
      })),
      missingSignals: previewStrings(record.missingSignals),
      openKnowledgeGaps: record.openKnowledgeGaps.map((gap) => ({
        ...gap,
        missingSignals: previewStrings(gap.missingSignals),
        reason: optionalShortText(gap.reason),
      })),
      openLearningProposals: record.openLearningProposals.map((proposal) => ({
        ...proposal,
        reason: shortText(proposal.reason),
        evidence: previewStrings(proposal.evidence),
      })),
      suggestedReviewActions: previewStrings(record.suggestedReviewActions, 12),
    })),
    rollups: report.rollups,
  };
}

function compactFeedback(feedback: ContextQualityReport['records'][number]['feedback']): WorkbenchFeedbackSummary {
  return {
    id: feedback.id,
    project: feedback.project,
    contextPackId: feedback.contextPackId,
    feedbackType: feedback.feedbackType,
    reason: optionalShortText(feedback.reason),
    rejectedKnowledgeCount: feedback.rejectedKnowledgeIds?.length ?? 0,
    createdAt: feedback.createdAt,
  };
}

function compactDraft(draft: {
  id: string;
  project?: string;
  title: string;
  summary: string;
  itemType: WorkbenchReflectionDraftSummary['itemType'];
  triggerType: WorkbenchReflectionDraftSummary['triggerType'];
  status: WorkbenchReflectionDraftSummary['status'];
  suggestedLabels: unknown[];
  references: unknown[];
  duplicateCandidates: unknown[];
  createdAt: string;
}): WorkbenchReflectionDraftSummary {
  return {
    id: draft.id,
    project: draft.project,
    title: shortText(draft.title),
    summary: shortText(draft.summary),
    itemType: draft.itemType,
    triggerType: draft.triggerType,
    status: draft.status,
    labelCount: draft.suggestedLabels.length,
    referenceCount: draft.references.length,
    duplicateCandidateCount: draft.duplicateCandidates.length,
    createdAt: draft.createdAt,
  };
}

function compactGap(gap: {
  id: string;
  project?: string;
  sourceSessionId?: string;
  contextPackId?: string;
  prompt: string;
  missingSignals: string[];
  reason?: string;
  status: WorkbenchKnowledgeGapSummary['status'];
  createdAt: string;
  updatedAt?: string;
  reviewedAt?: string;
}): WorkbenchKnowledgeGapSummary {
  return {
    id: gap.id,
    project: gap.project,
    status: gap.status,
    sourceSessionId: gap.sourceSessionId,
    contextPackId: gap.contextPackId,
    prompt: shortText(gap.prompt, PROMPT_TEXT_LIMIT),
    missingSignals: previewStrings(gap.missingSignals),
    missingSignalCount: gap.missingSignals.length,
    reason: optionalShortText(gap.reason),
    createdAt: gap.createdAt,
    updatedAt: gap.updatedAt,
    reviewedAt: gap.reviewedAt,
  };
}

function compactProposal(proposal: {
  id: string;
  project?: string;
  sourceSessionId?: string;
  contextPackId?: string;
  affectedKnowledgeId?: string;
  candidateKnowledgeId?: string;
  reason: string;
  evidence: string[];
  status: WorkbenchLearningProposalSummary['status'];
  proposalType: WorkbenchLearningProposalSummary['proposalType'];
  createdAt: string;
  updatedAt?: string;
  reviewedAt?: string;
}): WorkbenchLearningProposalSummary {
  return {
    id: proposal.id,
    project: proposal.project,
    status: proposal.status,
    proposalType: proposal.proposalType,
    sourceSessionId: proposal.sourceSessionId,
    contextPackId: proposal.contextPackId,
    affectedKnowledgeId: proposal.affectedKnowledgeId,
    candidateKnowledgeId: proposal.candidateKnowledgeId,
    reason: shortText(proposal.reason),
    evidence: previewStrings(proposal.evidence),
    evidenceCount: proposal.evidence.length,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    reviewedAt: proposal.reviewedAt,
  };
}

function compactConflict(conflict: {
  id: string;
  project?: string;
  status: WorkbenchKnowledgeConflictSummary['status'];
  conflictType: WorkbenchKnowledgeConflictSummary['conflictType'];
  leftKnowledgeId: string;
  rightKnowledgeId: string;
  sharedEvidence: string[];
  reason: string;
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
}): WorkbenchKnowledgeConflictSummary {
  return {
    id: conflict.id,
    project: conflict.project,
    status: conflict.status,
    conflictType: conflict.conflictType,
    leftKnowledgeId: conflict.leftKnowledgeId,
    rightKnowledgeId: conflict.rightKnowledgeId,
    sharedEvidence: previewStrings(conflict.sharedEvidence),
    sharedEvidenceCount: conflict.sharedEvidence.length,
    reason: shortText(conflict.reason),
    createdAt: conflict.createdAt,
    updatedAt: conflict.updatedAt,
    resolvedAt: conflict.resolvedAt,
  };
}

function compactKnowledge(knowledge: {
  id: string;
  project: string;
  sourceType?: string;
  sourceUri?: string;
  status?: WorkbenchKnowledgeSummary['status'];
  itemType: WorkbenchKnowledgeSummary['itemType'];
  title: string;
  summary: string;
  trustLevel: number;
  freshnessAt?: string;
  labels: unknown[];
  references: unknown[];
  createdAt: string;
  updatedAt?: string;
}): WorkbenchKnowledgeSummary {
  return {
    id: knowledge.id,
    project: knowledge.project,
    sourceType: knowledge.sourceType,
    sourceUri: knowledge.sourceUri,
    status: knowledge.status,
    itemType: knowledge.itemType,
    title: shortText(knowledge.title),
    summary: shortText(knowledge.summary),
    trustLevel: knowledge.trustLevel,
    freshnessAt: knowledge.freshnessAt,
    labelCount: knowledge.labels.length,
    referenceCount: knowledge.references.length,
    createdAt: knowledge.createdAt,
    updatedAt: knowledge.updatedAt,
  };
}

function compactErrorLogs(collection: ErrorLogCollection): WorkbenchErrorLogCollection {
  return {
    generatedAt: collection.generatedAt,
    project: collection.project,
    totalMatched: collection.totalMatched,
    returned: collection.returned,
    nextOffset: collection.nextOffset,
    filters: collection.filters,
    rollups: collection.rollups,
    clusters: collection.clusters.map((cluster) => ({
      ...cluster,
      title: shortText(cluster.title),
      files: previewStrings(cluster.files),
      symbols: previewStrings(cluster.symbols),
      errors: previewStrings(cluster.errors),
      tags: previewStrings(cluster.tags),
      logIds: previewStrings(cluster.logIds),
    })),
    logs: collection.logs.map(compactErrorLog),
  };
}

function compactErrorLog(log: ErrorLogSummary): ErrorLogSummary {
  return {
    ...log,
    title: shortText(log.title),
    summary: shortText(log.summary),
    files: previewStrings(log.files),
    symbols: previewStrings(log.symbols),
    errors: previewStrings(log.errors),
    tags: previewStrings(log.tags),
    references: log.references.slice(0, ARRAY_PREVIEW_LIMIT).map(compactReference),
  };
}

function compactBackupStatus(status: BackupStatus): WorkbenchBackupStatus {
  return {
    backupDir: status.backupDir,
    store: status.store,
    health: status.health,
    latestBackup: status.latestBackup
      ? {
        id: status.latestBackup.id,
        path: status.latestBackup.path,
        createdAt: status.latestBackup.createdAt,
        format: status.latestBackup.format,
        totalRows: status.latestBackup.totalRows,
        ageSeconds: status.latestBackup.ageSeconds,
        health: status.latestBackup.health,
        tableCount: status.latestBackup.tables.length,
      }
      : undefined,
    latestVerification: status.latestVerification
      ? {
        backupId: status.latestVerification.backupId,
        path: status.latestVerification.path,
        ok: status.latestVerification.ok,
        health: status.latestVerification.health,
        checkedAt: status.latestVerification.checkedAt,
        manifestVersion: status.latestVerification.manifestVersion,
        totalRows: status.latestVerification.totalRows,
        issueCount: status.latestVerification.issues.length,
        issues: status.latestVerification.issues.slice(0, ARRAY_PREVIEW_LIMIT),
      }
      : undefined,
    backupCount: status.backupCount,
    totalRows: status.totalRows,
    scheduler: status.scheduler,
  };
}

function compactReference(reference: ReferenceInput): ReferenceInput {
  return {
    type: reference.type,
    uri: reference.uri,
    lineStart: reference.lineStart,
    lineEnd: reference.lineEnd,
    commitSha: reference.commitSha,
  };
}

function backupHealthIssue(status: BackupStatus): string | undefined {
  if (status.scheduler.lastError) {
    return `Backup scheduler last error: ${shortText(status.scheduler.lastError)}`;
  }

  if (status.health === 'unhealthy' || status.health === 'degraded') {
    return `Backup health is ${status.health}; inspect backup status before trusting recovery state.`;
  }

  return undefined;
}

function previewStrings(values: string[], limit = ARRAY_PREVIEW_LIMIT): string[] {
  return values.slice(0, limit).map((value) => shortText(value));
}

function optionalShortText(value: string | undefined, max = SHORT_TEXT_LIMIT): string | undefined {
  return value === undefined ? undefined : shortText(value, max);
}

function shortText(value: string, max = SHORT_TEXT_LIMIT): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function endpointWithQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      query.set(key, String(value));
    }
  }

  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}
