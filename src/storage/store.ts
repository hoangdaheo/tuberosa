import type {
  ClassifiedQuery,
  ContextPack,
  FeedbackInput,
  KnowledgeInput,
  ReflectionDraft,
  ReflectionDraftInput,
  SearchCandidate,
  SearchOptions,
  StoredKnowledge,
} from '../types.js';

export interface ChunkInput {
  index: number;
  content: string;
  contextualContent: string;
  tokenEstimate: number;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface StaleFileAtomCleanupInput {
  project: string;
  sourcePath: string;
  keepSourceUris: string[];
}

export interface KnowledgeStore {
  upsertKnowledge(input: KnowledgeInput, chunks: ChunkInput[]): Promise<StoredKnowledge>;
  deleteStaleFileAtoms(input: StaleFileAtomCleanupInput): Promise<number>;
  listKnowledge(options: { project?: string; query?: string; limit: number }): Promise<StoredKnowledge[]>;
  getKnowledge(id: string): Promise<StoredKnowledge | undefined>;
  searchLexical(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]>;
  searchVector(embedding: number[], options: SearchOptions): Promise<SearchCandidate[]>;
  searchMetadata(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]>;
  searchMemories(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]>;
  createContextQuery(input: {
    project?: string;
    prompt: string;
    fingerprint: string;
    classified: ClassifiedQuery;
    tokenBudget: number;
  }): Promise<string>;
  saveContextPack(pack: ContextPack): Promise<void>;
  getContextPack(id: string): Promise<ContextPack | undefined>;
  recordFeedback(input: FeedbackInput): Promise<void>;
  createReflectionDraft(input: ReflectionDraftInput, duplicateCandidates: unknown[]): Promise<ReflectionDraft>;
  approveReflectionDraft(id: string): Promise<ReflectionDraft | undefined>;
  close(): Promise<void>;
}
