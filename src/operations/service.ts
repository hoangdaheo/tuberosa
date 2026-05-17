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

  updateKnowledge(id: string, patch: KnowledgePatchInput) {
    return this.store.updateKnowledge(id, patch);
  }

  listKnowledgeRelations(options: ListKnowledgeRelationsOptions) {
    return this.store.listKnowledgeRelations(options);
  }

  getKnowledgeRelation(id: string) {
    return this.store.getKnowledgeRelation(id);
  }

  createKnowledgeRelation(input: KnowledgeRelationInput) {
    return this.store.createKnowledgeRelation(input);
  }

  updateKnowledgeRelation(id: string, patch: KnowledgeRelationPatchInput) {
    return this.store.updateKnowledgeRelation(id, patch);
  }

  deleteKnowledgeRelation(id: string) {
    return this.store.deleteKnowledgeRelation(id);
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

  updateReflectionDraft(id: string, patch: ReflectionDraftPatchInput) {
    return this.store.updateReflectionDraft(id, patch);
  }

  async importFiles(input: ImportFilesInput) {
    const result = await this.ingestion.ingestFiles(input.project, input.files, { mode: input.mode });
    this.requestWriteThroughBackup('import-files');
    return result;
  }

  cleanup(input: CleanupOperationsInput) {
    return this.store.cleanupOperations(input);
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

  restoreBackup(input: RestoreBackupInput = {}) {
    return this.backups.restoreBackup(input);
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

  close() {
    return this.backups.close();
  }
}
