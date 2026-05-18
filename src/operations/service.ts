import type { IngestFileInput, IngestionMode } from '../ingest/service.js';
import type { IngestionService } from '../ingest/service.js';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  BackupRetentionInput,
  CreateBackupInput,
  CleanupOperationsInput,
  KnowledgeConflict,
  KnowledgeConflictInput,
  KnowledgeConflictPatchInput,
  KnowledgeGapPatchInput,
  KnowledgePatchInput,
  LearningProposalPatchInput,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  ListKnowledgeConflictsOptions,
  ListKnowledgeGapsOptions,
  ListLearningProposalsOptions,
  ListKnowledgeRelationsOptions,
  ListKnowledgeOptions,
  ListRecordsOptions,
  ReflectionDraftPatchInput,
  RestoreBackupInput,
} from '../types.js';
import type { StoredKnowledge } from '../types.js';
import { normalizeLabel } from '../util/text.js';
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
    const proposal = await this.store.updateLearningProposal(id, patch);
    if (proposal) {
      this.requestPhysicalMirror('learning-proposal-updated');
    }
    return proposal;
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

function detectConflicts(knowledge: StoredKnowledge[]): KnowledgeConflictInput[] {
  const conflicts: KnowledgeConflictInput[] = [];

  for (let leftIndex = 0; leftIndex < knowledge.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < knowledge.length; rightIndex += 1) {
      const left = knowledge[leftIndex];
      const right = knowledge[rightIndex];
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
