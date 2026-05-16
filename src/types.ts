export type KnowledgeItemType =
  | 'spec'
  | 'workflow'
  | 'memory'
  | 'bugfix'
  | 'code_ref'
  | 'rule'
  | 'wiki'
  | 'conversation';

export type TriggerType =
  | 'complex_task_success'
  | 'error_recovery'
  | 'user_correction'
  | 'non_trivial_workflow'
  | 'manual';

export type TaskType =
  | 'debugging'
  | 'implementation'
  | 'refactor'
  | 'review'
  | 'planning'
  | 'exploration'
  | 'testing'
  | 'unknown';

export type LabelType =
  | 'project'
  | 'repo'
  | 'domain'
  | 'business_area'
  | 'task_type'
  | 'technology'
  | 'workflow_stage'
  | 'severity'
  | 'file'
  | 'symbol'
  | 'error'
  | 'user_preference';

export type KnowledgeTaxonomy =
  | 'project_fact'
  | 'domain_rule'
  | 'workflow'
  | 'user_preference'
  | 'incident_lesson'
  | 'code_reference';

export interface LabelInput {
  type: LabelType;
  value: string;
  weight?: number;
}

export interface ReferenceInput {
  type: 'file' | 'url' | 'commit' | 'tool' | 'conversation' | 'external';
  uri: string;
  lineStart?: number;
  lineEnd?: number;
  commitSha?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeInput {
  project: string;
  sourceType: string;
  sourceUri: string;
  sourceTitle?: string;
  itemType: KnowledgeItemType;
  title: string;
  summary?: string;
  content: string;
  trustLevel?: number;
  labels?: LabelInput[];
  references?: ReferenceInput[];
  metadata?: Record<string, unknown>;
  freshnessAt?: string;
}

export interface StoredKnowledge {
  id: string;
  projectId?: string;
  project: string;
  sourceType?: string;
  sourceUri?: string;
  status?: KnowledgeStatus;
  itemType: KnowledgeItemType;
  title: string;
  summary: string;
  content: string;
  trustLevel: number;
  metadata: Record<string, unknown>;
  labels: LabelInput[];
  references: ReferenceInput[];
  freshnessAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export type KnowledgeStatus = 'approved' | 'needs_review' | 'archived' | 'blocked';

export type KnowledgeReviewFilter =
  | 'questionable'
  | 'unsafe'
  | 'low_trust'
  | 'stale'
  | 'rejected'
  | 'irrelevant'
  | 'orphaned';

export interface ListKnowledgeOptions {
  project?: string;
  query?: string;
  status?: KnowledgeStatus;
  review?: KnowledgeReviewFilter;
  limit: number;
}

export interface KnowledgePatchInput {
  status?: KnowledgeStatus;
  title?: string;
  summary?: string;
  trustLevel?: number;
  freshnessAt?: string | null;
  metadata?: Record<string, unknown>;
  labels?: LabelInput[];
  references?: ReferenceInput[];
}

export interface LabelRecord extends LabelInput {
  knowledgeCount: number;
}

export interface ContextSearchInput {
  prompt: string;
  project?: string;
  repoHint?: string;
  cwd?: string;
  taskType?: TaskType;
  files?: string[];
  symbols?: string[];
  errors?: string[];
  tokenBudget?: number;
  rejectedKnowledgeIds?: string[];
  bypassCache?: boolean;
  debug?: boolean;
}

export interface ClassifiedQuery {
  project?: string;
  taskType: TaskType;
  confidence: number;
  files: string[];
  symbols: string[];
  errors: string[];
  technologies: string[];
  businessAreas: string[];
  exactTerms: string[];
  lexicalQuery: string;
}

export type CandidateSource = 'lexical' | 'vector' | 'metadata' | 'memory' | 'reference';

export interface SearchCandidate {
  knowledgeId: string;
  chunkId?: string;
  title: string;
  summary: string;
  content: string;
  contextualContent: string;
  itemType: KnowledgeItemType;
  project: string;
  labels: LabelInput[];
  references: ReferenceInput[];
  tokenEstimate: number;
  trustLevel: number;
  source: CandidateSource;
  rawScore: number;
  rank: number;
  createdAt?: string;
  freshnessAt?: string;
  metadata?: Record<string, unknown>;
}

export interface RankedCandidate extends SearchCandidate {
  fusedScore: number;
  rerankScore: number;
  finalScore: number;
  matchReasons: string[];
  fitScore?: number;
  fitReasons?: string[];
  fitMissingSignals?: string[];
}

export type ContextFitStatus = 'ready' | 'needs_confirmation' | 'insufficient';

export interface ContextFit {
  fitStatus: ContextFitStatus;
  fitScore: number;
  fitReasons: string[];
  missingSignals: string[];
}

export interface ContextPackSection {
  name: 'essential' | 'supporting' | 'optional';
  items: RankedCandidate[];
  tokenEstimate: number;
}

export interface ContextPack {
  id: string;
  queryId?: string;
  project?: string;
  prompt: string;
  confidence: number;
  status: 'proposed' | 'selected' | 'rejected';
  classified: ClassifiedQuery;
  contextFit?: ContextFit;
  sections: ContextPackSection[];
  rejectedKnowledgeIds: string[];
  createdAt: string;
  debug?: RetrievalDebugTrace;
}

export interface ReflectionDraftInput {
  project?: string;
  title: string;
  summary: string;
  content: string;
  itemType?: KnowledgeItemType;
  triggerType: TriggerType;
  labels?: LabelInput[];
  references?: ReferenceInput[];
  metadata?: Record<string, unknown>;
}

export interface ReflectionDraft {
  id: string;
  project?: string;
  title: string;
  summary: string;
  content: string;
  itemType: KnowledgeItemType;
  triggerType: TriggerType;
  status: 'pending' | 'approved' | 'rejected';
  suggestedLabels: LabelInput[];
  references: ReferenceInput[];
  metadata: Record<string, unknown>;
  duplicateCandidates: RankedCandidate[];
  createdAt: string;
}

export interface ReflectionDraftPatchInput {
  status?: ReflectionDraft['status'];
  metadata?: Record<string, unknown>;
}

export interface FeedbackInput {
  contextPackId?: string;
  project?: string;
  feedbackType: 'selected' | 'rejected' | 'irrelevant' | 'stale' | 'missing_context';
  reason?: string;
  rejectedKnowledgeIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface FeedbackEvent extends FeedbackInput {
  id: string;
  createdAt: string;
}

export interface KnowledgeFeedbackSummary {
  knowledgeId: string;
  selectedCount: number;
  rejectedCount: number;
  irrelevantCount: number;
  staleCount: number;
  latestFeedbackType?: FeedbackInput['feedbackType'];
  latestFeedbackAt?: string;
}

export type AgentSessionStatus = 'active' | 'finished';

export type AgentSessionOutcome = 'completed' | 'failed' | 'blocked' | 'cancelled';

export type AgentContextDecisionType = FeedbackInput['feedbackType'];

export interface AgentSession {
  id: string;
  project?: string;
  cwd?: string;
  prompt: string;
  agentName?: string;
  agentTool?: string;
  status: AgentSessionStatus;
  initialContextPackId?: string;
  outcome?: AgentSessionOutcome;
  summary?: string;
  reflectionDraftIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string;
}

export interface AgentContextDecision {
  id: string;
  sessionId: string;
  contextPackId?: string;
  decision: AgentContextDecisionType;
  reason?: string;
  rejectedKnowledgeIds: string[];
  retryContextPackId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ListRecordsOptions {
  project?: string;
  status?: string;
  limit: number;
}

export interface CleanupOperationsInput {
  olderThanDays?: number;
  dryRun?: boolean;
}

export interface CleanupOperationsResult {
  dryRun: boolean;
  olderThanDays: number;
  deleted: {
    contextQueries: number;
    contextPacks: number;
    feedbackEvents: number;
    knowledgeSources: number;
  };
}

export interface StartAgentSessionInput extends ContextSearchInput {
  agentName?: string;
  agentTool?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordAgentContextDecisionInput {
  sessionId: string;
  contextPackId?: string;
  feedbackType: AgentContextDecisionType;
  reason?: string;
  rejectedKnowledgeIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface FinishAgentSessionInput {
  sessionId: string;
  outcome: AgentSessionOutcome;
  summary?: string;
  metadata?: Record<string, unknown>;
  reflectionDraft?: ReflectionDraftInput;
}

export interface AgentSessionStartResult {
  session: AgentSession;
  contextPack: ContextPack;
  policy: AgentSessionPolicy;
}

export interface AgentSessionDecisionResult {
  session: AgentSession;
  decision: AgentContextDecision;
  retry?: ContextPack;
  policy?: AgentSessionPolicy;
}

export interface AgentSessionFinishResult {
  session: AgentSession;
  reflectionDraft?: ReflectionDraft;
}

export interface AgentSessionPolicy {
  action: 'proceed' | 'confirm' | 'clarify';
  instruction: string;
}

export interface SearchOptions {
  project?: string;
  limit: number;
  rejectedKnowledgeIds?: string[];
}

export interface KnowledgeSearchResult {
  lexical: SearchCandidate[];
  vector: SearchCandidate[];
  metadata: SearchCandidate[];
  memory: SearchCandidate[];
}

export type RetrievalDebugStageName = 'metadata' | 'lexical' | 'memory' | 'vector' | 'fusion' | 'rerank' | 'fit';

export type RetrievalDebugTimingName =
  | RetrievalDebugStageName
  | 'classification'
  | 'embedding'
  | 'contextQuery'
  | 'assembly'
  | 'save'
  | 'total';

export interface RetrievalDebugCandidate {
  knowledgeId: string;
  chunkId?: string;
  title: string;
  itemType: KnowledgeItemType;
  project: string;
  source: CandidateSource;
  rank: number;
  rawScore: number;
  fusedScore?: number;
  rerankScore?: number;
  finalScore?: number;
  fitScore?: number;
  trustLevel: number;
  tokenEstimate: number;
  matchReasons: string[];
  fitReasons?: string[];
  fitMissingSignals?: string[];
  references: ReferenceInput[];
}

export interface RetrievalDebugStage {
  name: RetrievalDebugStageName;
  candidateCount: number;
  candidates: RetrievalDebugCandidate[];
}

export interface RetrievalFilterDecision {
  type: 'rejected_knowledge' | 'stale_feedback_retry';
  action: 'excluded_before_search' | 'retry_exclusion';
  knowledgeId?: string;
  reason: string;
}

export interface RetrievalDebugTrace {
  fingerprint: string;
  cache: {
    key: string;
    hit: boolean;
    bypassed: boolean;
  };
  limits: {
    searchLimit: number;
    rerankLimit: number;
    tokenBudget: number;
  };
  filters: {
    rejectedKnowledgeIds: string[];
    decisions: RetrievalFilterDecision[];
  };
  timingsMs: Partial<Record<RetrievalDebugTimingName, number>>;
  stages: RetrievalDebugStage[];
  selected: Record<ContextPackSection['name'], RetrievalDebugCandidate[]>;
}
