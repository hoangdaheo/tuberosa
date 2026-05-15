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
  itemType: KnowledgeItemType;
  title: string;
  summary: string;
  content: string;
  trustLevel: number;
  metadata: Record<string, unknown>;
  labels: LabelInput[];
  references: ReferenceInput[];
  createdAt: string;
  updatedAt?: string;
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
  metadata?: Record<string, unknown>;
}

export interface RankedCandidate extends SearchCandidate {
  fusedScore: number;
  rerankScore: number;
  finalScore: number;
  matchReasons: string[];
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
  sections: ContextPackSection[];
  rejectedKnowledgeIds: string[];
  createdAt: string;
}

export interface ReflectionDraftInput {
  project?: string;
  title: string;
  summary: string;
  content: string;
  itemType?: KnowledgeItemType;
  triggerType: TriggerType;
  labels?: LabelInput[];
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
  duplicateCandidates: RankedCandidate[];
  createdAt: string;
}

export interface FeedbackInput {
  contextPackId?: string;
  project?: string;
  feedbackType: 'selected' | 'rejected' | 'irrelevant' | 'stale' | 'missing_context';
  reason?: string;
  rejectedKnowledgeIds?: string[];
  metadata?: Record<string, unknown>;
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
