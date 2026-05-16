import type { IngestFileInput, IngestionMode } from '../ingest/service.js';
import type { IngestionService } from '../ingest/service.js';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  CleanupOperationsInput,
  KnowledgePatchInput,
  ListKnowledgeOptions,
  ListRecordsOptions,
  ReflectionDraftPatchInput,
} from '../types.js';

export interface ImportFilesInput {
  project: string;
  files: IngestFileInput[];
  mode?: IngestionMode;
}

export class OperationsService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly ingestion: IngestionService,
  ) {}

  listKnowledge(options: ListKnowledgeOptions) {
    return this.store.listKnowledge(options);
  }

  getKnowledge(id: string) {
    return this.store.getKnowledge(id);
  }

  updateKnowledge(id: string, patch: KnowledgePatchInput) {
    return this.store.updateKnowledge(id, patch);
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

  importFiles(input: ImportFilesInput) {
    return this.ingestion.ingestFiles(input.project, input.files, { mode: input.mode });
  }

  cleanup(input: CleanupOperationsInput) {
    return this.store.cleanupOperations(input);
  }
}
