import type {
  KnowledgeItemType,
  KnowledgeNamespace,
  LabelInput,
  ReferenceInput,
} from './knowledge.js';
import type { AgentContextDecisionType } from './session.js';

export type TaskType =
  | 'debugging'
  | 'implementation'
  | 'refactor'
  | 'review'
  | 'planning'
  | 'exploration'
  | 'testing'
  | 'unknown';

export type ContextNoiseTolerance = 'balanced' | 'strict';

export type RetrievalWorkflowStage =
  | 'continuation'
  | 'planning'
  | 'implementation'
  | 'investigation'
  | 'review'
  | 'verification'
  | 'exploration'
  | 'unknown';

export type TaskBriefMode =
  | 'implementation'
  | 'debugging'
  | 'planning'
  | 'review'
  | 'handoff_cleanup'
  | 'reflection_review'
  | 'context_quality_review'
  | 'operations_review'
  | 'unknown';

export type RetrievalEvidenceType =
  | 'spec'
  | 'workflow'
  | 'code_reference'
  | 'bugfix'
  | 'incident_lesson'
  | 'reflection_memory'
  | 'session_history'
  | 'handoff'
  | 'docs'
  | 'tests';

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
  contextMode?: ContextMode;
  noiseTolerance?: ContextNoiseTolerance;
  deepContextBudget?: number;
  includeDeepContext?: boolean;
  rejectedKnowledgeIds?: string[];
  bypassCache?: boolean;
  debug?: boolean;
  /**
   * Sandbox / evaluation flag. When provided, zeroes the listed candidate sources before fusion
   * so per-source contribution can be measured. MUST NOT be exposed in production MCP/HTTP surfaces.
   */
  disabledSources?: CandidateSource[];
  /**
   * Phase 6a — optional namespace filter. When `kind` (and/or `agent`) is supplied,
   * candidates whose stored namespace mismatches are dropped post-fetch.
   * `project` is honored by the existing `project` field; supplying it here is
   * redundant but allowed for symmetry with the storage shape.
   */
  namespace?: Partial<KnowledgeNamespace>;
}

export type ContextMode = 'compact' | 'layered';

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
  domain?: string;
  lexicalQuery: string;
  intent: RetrievalIntent;
}

export interface RetrievalIntent {
  taskGoal: string;
  workflowStage: RetrievalWorkflowStage;
  taskBriefMode?: TaskBriefMode;
  impliedFiles: string[];
  impliedSymbols: string[];
  impliedDomains: string[];
  objectHints?: string[];
  recentSessionReferences: string[];
  requiredEvidenceTypes: RetrievalEvidenceType[];
  uncertaintyReasons: string[];
}

export interface QueryRewriteInput {
  prompt: string;
  classified: ClassifiedQuery;
  /**
   * Phase 7 — preferred rewrite mode. `paraphrase` is the legacy single-rewrite
   * default. `diverse_angle` asks the rewriter for multiple task-perspective
   * variants ("how does X work" / "where is X used" / "what depends on X") that
   * populate `exactTerms` for OR-style FTS expansion. Providers MAY ignore the
   * mode hint; the consumer treats it as advisory.
   */
  mode?: 'paraphrase' | 'diverse_angle';
}

export interface QueryRewriteResult {
  lexicalQuery: string;
  exactTerms?: string[];
  reasons?: string[];
  model?: string;
}

export interface RerankInput {
  prompt: string;
  classified: ClassifiedQuery;
  candidates: RankedCandidate[];
}

export interface RerankDecision {
  knowledgeId: string;
  score: number;
  reason?: string;
}

export interface RerankResult {
  candidates: RankedCandidate[];
  decisions?: RerankDecision[];
  model?: string;
}

export type CandidateSource = 'lexical' | 'vector' | 'metadata' | 'memory' | 'graph' | 'worktree';

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
  evidenceCategory?: ContextEvidenceCategory;
  evidenceStrength?: ContextEvidenceStrength;
  usefulnessReason?: string;
  actionableMissingSignals?: ActionableMissingSignals;
}

export type ContextEvidenceCategory =
  | 'directTaskEvidence'
  | 'priorLessons'
  | 'workflowGuidance'
  | 'adjacentContext';

export type ContextEvidenceStrength = 'strong' | 'moderate' | 'weak';

export type ContextFitStatus = 'ready' | 'needs_confirmation' | 'insufficient';

/**
 * Phase 3 — structured why-block for the workbench. Optional so older consumers of
 * ContextFit (snapshots, archived packs) keep deserializing; new packs always emit it.
 */
export interface FitDiagnostics {
  contributors: {
    top1: number;
    top3Avg: number;
    coverage: number;
    /** Phase 3 placeholder, populated by the Phase 5 worktree provider. Always 0 until then. */
    worktreeMatchScore: number;
  };
  weights: {
    top1: number;
    top3Avg: number;
    coverage: number;
    worktreeMatch: number;
  };
  thresholds: {
    ready: number;
    needsConfirmation: number;
  };
  /** False when the rerank stage threw and the service fell back to fused order. */
  rerankerAvailable: boolean;
  /** Non-fatal observations the workbench can surface verbatim. */
  notes: string[];
}

export interface ContextFit {
  fitStatus: ContextFitStatus;
  fitScore: number;
  fitReasons: string[];
  missingSignals: string[];
  /** Phase 3 — structured contributors / weights / thresholds. Optional for backward compat. */
  fitDiagnostics?: FitDiagnostics;
}

export interface ActionableMissingSignals {
  files: string[];
  symbols: string[];
  errors: string[];
  docs: string[];
  intent: string[];
  other: string[];
}

export interface ContextPackOrientation {
  inferredTask: string;
  workflowStage: RetrievalWorkflowStage;
  taskType: TaskType;
  confidence: number;
  recommendedFiles: Array<{
    path: string;
    reason: string;
  }>;
  likelySurfaces: string[];
  verificationCommands: string[];
  missingSignals: ActionableMissingSignals;
  notes: string[];
}

export type ContextReviewTargetKind =
  | 'reflection_draft'
  | 'knowledge_gap'
  | 'learning_proposal'
  | 'context_pack'
  | 'agent_session'
  | 'knowledge'
  | 'unknown';

export interface ContextReviewTarget {
  kind: ContextReviewTargetKind;
  id: string;
  status: string;
  title: string;
  recommendedAction: string;
  reason: string;
  /**
   * Phase 8 — knowledge IDs in the assembled pack that ground this review target.
   * When the target's `id` matches a `RankedCandidate.knowledgeId` in the pack, that
   * candidate id is recorded here. Empty when the target is self-grounded by its
   * `id` alone (workbench navigates via targetId).
   */
  evidenceIds?: string[];
}

export interface ContextPackActionItem {
  priority: number;
  action: string;
  label: string;
  targetKind?: ContextReviewTargetKind | 'file' | 'command' | 'clarification';
  targetId?: string;
  targetStatus?: string;
  targetTitle?: string;
  targetPath?: string;
  command?: string;
  reason?: string;
  /**
   * Phase 8 — knowledge IDs in the assembled pack that ground this action.
   * Populated for grounding-eligible actions (`read_file`, `review_target`,
   * `inspect_review_target`). Policy-only actions (`run_verification`,
   * `ask_clarification`, `inspect_shortlist`) leave this field absent — they are
   * system recommendations, not knowledge-grounded.
   */
  evidenceIds?: string[];
}

export interface ContextPackTaskBrief {
  mode: TaskBriefMode;
  goal: string;
  actionItems: ContextPackActionItem[];
  reviewTargets: ContextReviewTarget[];
  directEvidenceKnowledgeIds: string[];
  adjacentKnowledgeIds: string[];
  omittedReviewTargetCount: number;
}

export interface StartupBrief {
  verdict: 'proceed' | 'confirm' | 'clarify';
  readFirst: Array<{
    path: string;
    reason: string;
    source: 'worktree' | 'memory';
  }>;
  directEvidence: Array<{
    knowledgeId?: string;
    path?: string;
    reason: string;
  }>;
  adjacentEvidence: Array<{
    knowledgeId: string;
    reason: string;
  }>;
  missingSignals: string[];
  riskyAreas: string[];
  verificationCommands: string[];
  requiredContextDecision: AgentContextDecisionType;
}

export interface ContextPackSection {
  name: 'essential' | 'supporting' | 'optional';
  items: RankedCandidate[];
  tokenEstimate: number;
}

export interface KnowledgeChunkRecord {
  id: string;
  knowledgeId: string;
  chunkIndex: number;
  content: string;
  contextualContent: string;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
  createdAt?: string;
}

export interface DeepContextItem {
  knowledgeId: string;
  title: string;
  summary: string;
  itemType: KnowledgeItemType;
  project: string;
  labels: LabelInput[];
  references: ReferenceInput[];
  source: CandidateSource;
  rank: number;
  finalScore: number;
  matchReasons: string[];
  evidenceCategory?: ContextEvidenceCategory;
  evidenceStrength?: ContextEvidenceStrength;
  usefulnessReason?: string;
  actionableMissingSignals?: ActionableMissingSignals;
  chunkIds: string[];
  content: string;
  contextualContent: string;
  tokenEstimate: number;
}

export interface DeepContextSection {
  name: ContextPackSection['name'];
  items: DeepContextItem[];
  tokenEstimate: number;
}

export interface DeepContext {
  mode: 'layered';
  budget: number;
  tokenEstimate: number;
  sections: DeepContextSection[];
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
  orientation?: ContextPackOrientation;
  taskBrief?: ContextPackTaskBrief;
  startupBrief?: StartupBrief;
  actionableMissingSignals?: ActionableMissingSignals;
  sections: ContextPackSection[];
  deepContext?: DeepContext;
  rejectedKnowledgeIds: string[];
  createdAt: string;
  debug?: RetrievalDebugTrace;
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
  graph: SearchCandidate[];
  /** Phase 5 — live worktree evidence (changed files, prompt-named files, repo-root handoffs, recently-edited files). Read-through, never persisted. */
  worktree: SearchCandidate[];
}

export type RetrievalDebugStageName = 'metadata' | 'lexical' | 'memory' | 'vector' | 'graph' | 'worktree' | 'fusion' | 'rerank' | 'fit';

export type RetrievalDebugTimingName =
  | RetrievalDebugStageName
  | 'classification'
  | 'rewrite'
  | 'rewriteProbe'
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
  evidenceCategory?: ContextEvidenceCategory;
  evidenceStrength?: ContextEvidenceStrength;
  usefulnessReason?: string;
  references: ReferenceInput[];
  graphPaths?: Array<Record<string, unknown>>;
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

export type FusionContributionStage = 'metadata' | 'lexical' | 'memory' | 'vector' | 'graph' | 'worktree';

export interface FusionContribution {
  source: FusionContributionStage;
  rank: number;
  rawScore: number;
  sourceWeight: number;
  contribution: number;
}

export interface ScoreBreakdown {
  knowledgeId: string;
  contributions: FusionContribution[];
  fusedScoreBeforeNormalize: number;
  fusedScore: number;
  rerankScore: number;
  rerankDelta: number;
  fitScore?: number;
  suppressionDeltas: SuppressionEvent[];
}

export type SuppressionReason =
  | 'superseded'
  | 'stale_freshness'
  | 'evidence_mismatch'
  | 'domain_mismatch'
  | 'feedback_stale'
  | 'feedback_rejected'
  | 'feedback_irrelevant';

export interface SuppressionEvent {
  knowledgeId: string;
  reason: SuppressionReason;
  deltaScore: number;
  confidence: number;
  evidence?: string;
}

export type FilterEventKind =
  | 'safety_block_ingest'
  | 'safety_block_retrieval'
  | 'safety_redact_retrieval'
  | 'rejected_knowledge'
  | 'stale_feedback'
  | 'duplicate'
  | 'off_domain'
  | 'other';

export interface FilterEvent {
  filter: FilterEventKind;
  action: 'excluded' | 'redacted' | 'flagged' | 'penalized';
  knowledgeId?: string;
  reason: string;
  metadata?: Record<string, unknown>;
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
  queryRewrite?: {
    originalLexicalQuery: string;
    rewrittenLexicalQuery: string;
    addedExactTerms: string[];
    reasons: string[];
    model?: string;
    /** Phase 7 — true when the rewrite path ran through the gated probe. */
    gated?: boolean;
    /** Phase 7 — probe pass's top1 fused score (0..1). Undefined when gated=false. */
    probeConfidence?: number;
    /** Phase 7 — probe threshold the call was compared against. */
    probeThreshold?: number;
    /** Phase 7 — set when the rewrite call was skipped (e.g. `probe_confident`). */
    skipped?: 'probe_confident';
  };
  providerRerank?: {
    model?: string;
    candidateCount: number;
    inputKnowledgeIds: string[];
    decisions: RerankDecision[];
  };
  timingsMs: Partial<Record<RetrievalDebugTimingName, number>>;
  stages: RetrievalDebugStage[];
  selected: Record<ContextPackSection['name'], RetrievalDebugCandidate[]>;
  fusionBreakdown?: ScoreBreakdown[];
  filterEvents?: FilterEvent[];
  suppressionEvents?: SuppressionEvent[];
}
