import type { IngestFileInput, IngestionMode } from '../ingest/service.js';
import type { IngestionService } from '../ingest/service.js';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  BackupRetentionInput,
  CreateBackupInput,
  CleanupOperationsInput,
  KnowledgePatchInput,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  ListKnowledgeRelationsOptions,
  ListKnowledgeOptions,
  ListRecordsOptions,
  ReflectionDraftPatchInput,
  RestoreBackupInput,
} from '../types.js';
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
