import type {
  AgentContextDecision,
  AgentSession,
  ClassifiedQuery,
  CleanupOperationsInput,
  CleanupOperationsResult,
  ContextPack,
  FeedbackEvent,
  FeedbackInput,
  FinishAgentSessionInput,
  KnowledgePatchInput,
  KnowledgeFeedbackSummary,
  KnowledgeInput,
  LabelRecord,
  ListKnowledgeOptions,
  ListRecordsOptions,
  RecordAgentContextDecisionInput,
  ReflectionDraft,
  ReflectionDraftPatchInput,
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
  listKnowledge(options: ListKnowledgeOptions): Promise<StoredKnowledge[]>;
  getKnowledge(id: string): Promise<StoredKnowledge | undefined>;
  updateKnowledge(id: string, patch: KnowledgePatchInput): Promise<StoredKnowledge | undefined>;
  listLabels(options: { project?: string; limit: number }): Promise<LabelRecord[]>;
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
  listContextPacks(options: ListRecordsOptions): Promise<ContextPack[]>;
  getContextPack(id: string): Promise<ContextPack | undefined>;
  recordFeedback(input: FeedbackInput): Promise<void>;
  listFeedbackEvents(options: ListRecordsOptions): Promise<FeedbackEvent[]>;
  getFeedbackSummaries(knowledgeIds: string[], options?: { project?: string }): Promise<Map<string, KnowledgeFeedbackSummary>>;
  createAgentSession(input: {
    prompt: string;
    project?: string;
    cwd?: string;
    agentName?: string;
    agentTool?: string;
    initialContextPackId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentSession>;
  listAgentSessions(options: ListRecordsOptions): Promise<AgentSession[]>;
  getAgentSession(id: string): Promise<AgentSession | undefined>;
  recordAgentContextDecision(input: RecordAgentContextDecisionInput & {
    retryContextPackId?: string;
  }): Promise<AgentContextDecision>;
  listAgentContextDecisions(options: { sessionId?: string; limit: number }): Promise<AgentContextDecision[]>;
  finishAgentSession(input: FinishAgentSessionInput & {
    reflectionDraftIds?: string[];
  }): Promise<AgentSession | undefined>;
  listReflectionDrafts(options: ListRecordsOptions): Promise<ReflectionDraft[]>;
  getReflectionDraft(id: string): Promise<ReflectionDraft | undefined>;
  createReflectionDraft(input: ReflectionDraftInput, duplicateCandidates: unknown[]): Promise<ReflectionDraft>;
  updateReflectionDraft(id: string, patch: ReflectionDraftPatchInput): Promise<ReflectionDraft | undefined>;
  approveReflectionDraft(id: string): Promise<ReflectionDraft | undefined>;
  cleanupOperations(input: CleanupOperationsInput): Promise<CleanupOperationsResult>;
  close(): Promise<void>;
}
