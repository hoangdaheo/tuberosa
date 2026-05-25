export * from './types/knowledge.js';
export * from './types/operations.js';

import type {
  KnowledgeItemType,
  TriggerType,
  LabelInput,
  ReferenceInput,
  KnowledgeConflictType,
  KnowledgeConflictStatus,
  KnowledgeStatus,
  KnowledgeNamespace,
} from './types/knowledge.js';
import type {
  LearningProposalType,
  LearningReviewStatus,
  MaintenanceItemKind,
  MaintenanceItemLabel,
  MaintenanceRisk,
  MaintenanceCounts,
  ErrorLogCollection,
  BackupStatus,
  BackupHealth,
  BackupSchedulerStatus,
  BackupSummary,
  BackupVerificationIssue,
} from './types/operations.js';

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

export type ReflectionDraftStatus = 'pending' | 'approved' | 'rejected' | 'needs_changes';

export interface ReflectionDraft {
  id: string;
  project?: string;
  title: string;
  summary: string;
  content: string;
  itemType: KnowledgeItemType;
  triggerType: TriggerType;
  status: ReflectionDraftStatus;
  suggestedLabels: LabelInput[];
  references: ReferenceInput[];
  metadata: Record<string, unknown>;
  duplicateCandidates: RankedCandidate[];
  createdAt: string;
}

export interface ReflectionDraftPatchInput {
  status?: ReflectionDraft['status'];
  metadata?: Record<string, unknown>;
  suggestedLabels?: LabelInput[];
  references?: ReferenceInput[];
}

export type ReflectionDraftReviewDecision = 'approve' | 'reject' | 'needs_changes';

export type ReflectionDraftReviewGrade = 'pass' | 'concern' | 'fail';

export type ReflectionDraftDuplicateRisk = 'low' | 'medium' | 'high';

export interface ReflectionDraftReviewEvaluation {
  accuracy?: ReflectionDraftReviewGrade;
  usefulness?: ReflectionDraftReviewGrade;
  scope?: ReflectionDraftReviewGrade;
  privacySafety?: ReflectionDraftReviewGrade;
  labels?: ReflectionDraftReviewGrade;
  references?: ReflectionDraftReviewGrade;
  duplicateRisk?: ReflectionDraftDuplicateRisk;
}

export interface ReflectionDraftReviewInput {
  id: string;
  decision: ReflectionDraftReviewDecision;
  reviewer?: string;
  reviewerNote?: string;
  evaluation?: ReflectionDraftReviewEvaluation;
  metadata?: Record<string, unknown>;
}

export type FeedbackQualityType =
  | 'selected_but_noisy'
  | 'too_much_adjacent_context'
  | 'missing_orientation'
  | 'missing_current_handoff'
  | 'missing_verification_commands';

export type FeedbackType =
  | 'selected'
  | 'rejected'
  | 'irrelevant'
  | 'stale'
  | 'missing_context'
  | FeedbackQualityType;

export interface FeedbackInput {
  contextPackId?: string;
  project?: string;
  feedbackType: FeedbackType;
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
  selectedNoisyCount: number;
  rejectedCount: number;
  irrelevantCount: number;
  staleCount: number;
  latestFeedbackType?: FeedbackInput['feedbackType'];
  latestFeedbackAt?: string;
}

export interface ContextQualityReportInput {
  project?: string;
  feedbackType?: FeedbackQualityType;
  limit: number;
}

export interface ContextQualityPackSummary {
  id: string;
  project?: string;
  status: ContextPack['status'];
  prompt: string;
  confidence: number;
  fitStatus?: ContextFitStatus;
  fitScore?: number;
  missingSignals: string[];
}

export interface ContextQualitySessionSummary {
  id: string;
  status: AgentSessionStatus;
  outcome?: AgentSessionOutcome;
  prompt: string;
  summary?: string;
}

export interface ContextQualityItemSummary {
  knowledgeId: string;
  title: string;
  evidenceCategory?: ContextEvidenceCategory;
  evidenceStrength?: ContextEvidenceStrength;
  score: number;
  reasons: string[];
  missingSignals: string[];
}

export interface ContextQualityKnowledgeGapSummary {
  id: string;
  status: LearningReviewStatus;
  missingSignals: string[];
  reason?: string;
}

export interface ContextQualityLearningProposalSummary {
  id: string;
  status: LearningReviewStatus;
  proposalType: LearningProposalType;
  affectedKnowledgeId?: string;
  reason: string;
  evidence: string[];
}

export interface ContextQualityFeedbackRecord {
  feedback: FeedbackEvent;
  contextPack?: ContextQualityPackSummary;
  session?: ContextQualitySessionSummary;
  adjacentItems: ContextQualityItemSummary[];
  missingSignals: string[];
  openKnowledgeGaps: ContextQualityKnowledgeGapSummary[];
  openLearningProposals: ContextQualityLearningProposalSummary[];
  suggestedReviewActions: string[];
}

export interface ContextQualityReport {
  generatedAt: string;
  filters: ContextQualityReportInput;
  totalMatched: number;
  records: ContextQualityFeedbackRecord[];
  rollups: {
    feedbackTypes: Array<{ value: FeedbackQualityType; count: number }>;
    projects: Array<{ value: string; count: number }>;
    suggestedReviewActions: Array<{ value: string; count: number }>;
    missingSignals: Array<{ value: string; count: number }>;
    adjacentItems: Array<{ knowledgeId: string; title: string; count: number }>;
  };
}

export type AgentSessionStatus = 'active' | 'finished';

export type AgentSessionOutcome = 'completed' | 'failed' | 'blocked' | 'cancelled';

export type AgentContextDecisionType = FeedbackInput['feedbackType'];

export type AgentLearningMode = 'auto' | 'draft_only' | 'off';

export type AgentLearningSignalKind =
  | 'tip'
  | 'decision'
  | 'mistake'
  | 'verification'
  | 'file_change'
  | 'user_preference'
  | 'follow_up';

export type AgentLearningSignalSource =
  | 'user'
  | 'agent'
  | 'tool'
  | 'system'
  | 'reviewer';

export interface AgentLearningSignal {
  kind: AgentLearningSignalKind;
  text: string;
  source?: AgentLearningSignalSource;
  files?: string[];
  symbols?: string[];
  errors?: string[];
  references?: ReferenceInput[];
  confidence?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface ResearchTraceReference {
  file?: string;
  symbol?: string;
  command?: string;
  knowledgeId?: string;
}

export interface ResearchTraceStep {
  kind: 'thought' | 'action' | 'observation' | 'decision';
  text: string;
  references?: ResearchTraceReference[];
}

export interface ResearchTraceInput {
  steps: ResearchTraceStep[];
  outcome: string;
}

export interface ResearchTraceSummary extends ResearchTraceInput {
  derived: boolean;
  bytes: number;
}

export interface CaptureAgentLearningSignalInput extends AgentLearningSignal {
  sessionId: string;
  author?: string;
  contextPackId?: string;
}

export type AgentLearningDecisionStatus =
  | 'skipped'
  | 'drafted'
  | 'auto_approved'
  | 'rejected';

export interface AgentSessionLearningDecision {
  mode: AgentLearningMode;
  status: AgentLearningDecisionStatus;
  reasons: string[];
  draftId?: string;
}

export interface AgentSessionNote {
  at: string;
  note: string;
  author?: string;
  feedbackType?: FeedbackType;
  feedbackId?: string;
  contextPackId?: string;
  metadata?: Record<string, unknown>;
}

export interface AppendAgentSessionNoteInput {
  sessionId: string;
  note: string;
  author?: string;
  feedbackType?: FeedbackType;
  contextPackId?: string;
  reason?: string;
  rejectedKnowledgeIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface AppendAgentSessionNoteResult {
  session: AgentSession;
  note: AgentSessionNote;
  feedback?: FeedbackEvent;
}

export interface CaptureAgentLearningSignalResult extends AppendAgentSessionNoteResult {
  signal: AgentLearningSignal;
}

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
  agentOutputSummary?: string;
  changedFiles?: string[];
  verificationCommands?: string[];
  learningSignals?: AgentLearningSignal[];
  contextBypassReason?: string;
  learningMode?: AgentLearningMode;
  metadata?: Record<string, unknown>;
  researchTrace?: ResearchTraceInput;
  reflectionDraft?: ReflectionDraftInput;
}

export type AgentContextComplianceStatus =
  | 'compliant'
  | 'needs_decision'
  | 'missing_context_recorded'
  | 'bypassed'
  | 'non_compliant';

export interface AgentContextCompliance {
  status: AgentContextComplianceStatus;
  checkedAt: string;
  instruction: string;
  decisionIds: string[];
  contextPackId?: string;
  bypassReason?: string;
}

export interface WorkbenchSummaryInput {
  project?: string;
  limit: number;
}

export interface WorkbenchSessionSummary {
  id: string;
  project?: string;
  cwd?: string;
  status: AgentSessionStatus;
  outcome?: AgentSessionOutcome;
  prompt: string;
  summary?: string;
  initialContextPackId?: string;
  reflectionDraftCount: number;
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string;
}

export interface WorkbenchFeedbackSummary {
  id: string;
  project?: string;
  contextPackId?: string;
  feedbackType: FeedbackType;
  reason?: string;
  rejectedKnowledgeCount: number;
  createdAt: string;
}

export interface WorkbenchContextQualityRecord {
  feedback: WorkbenchFeedbackSummary;
  contextPack?: ContextQualityPackSummary;
  session?: ContextQualitySessionSummary;
  adjacentItems: ContextQualityItemSummary[];
  missingSignals: string[];
  openKnowledgeGaps: ContextQualityKnowledgeGapSummary[];
  openLearningProposals: ContextQualityLearningProposalSummary[];
  suggestedReviewActions: string[];
}

export interface WorkbenchContextQualityReport {
  generatedAt: string;
  filters: ContextQualityReportInput;
  totalMatched: number;
  records: WorkbenchContextQualityRecord[];
  rollups: ContextQualityReport['rollups'];
}

export interface WorkbenchReflectionDraftSummary {
  id: string;
  project?: string;
  title: string;
  summary: string;
  itemType: KnowledgeItemType;
  triggerType: TriggerType;
  status: ReflectionDraftStatus;
  labelCount: number;
  referenceCount: number;
  duplicateCandidateCount: number;
  createdAt: string;
}

export interface WorkbenchKnowledgeGapSummary {
  id: string;
  project?: string;
  status: LearningReviewStatus;
  sourceSessionId?: string;
  contextPackId?: string;
  prompt: string;
  missingSignals: string[];
  missingSignalCount: number;
  reason?: string;
  createdAt: string;
  updatedAt?: string;
  reviewedAt?: string;
}

export interface WorkbenchLearningProposalSummary {
  id: string;
  project?: string;
  status: LearningReviewStatus;
  proposalType: LearningProposalType;
  sourceSessionId?: string;
  contextPackId?: string;
  affectedKnowledgeId?: string;
  candidateKnowledgeId?: string;
  reason: string;
  evidence: string[];
  evidenceCount: number;
  createdAt: string;
  updatedAt?: string;
  reviewedAt?: string;
}

export interface WorkbenchKnowledgeConflictSummary {
  id: string;
  project?: string;
  status: KnowledgeConflictStatus;
  conflictType: KnowledgeConflictType;
  leftKnowledgeId: string;
  rightKnowledgeId: string;
  sharedEvidence: string[];
  sharedEvidenceCount: number;
  reason: string;
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
}

export interface WorkbenchKnowledgeSummary {
  id: string;
  project: string;
  sourceType?: string;
  sourceUri?: string;
  status?: KnowledgeStatus;
  itemType: KnowledgeItemType;
  title: string;
  summary: string;
  trustLevel: number;
  freshnessAt?: string;
  labelCount: number;
  referenceCount: number;
  createdAt: string;
  updatedAt?: string;
}

export type WorkbenchErrorLogCollection = Omit<ErrorLogCollection, 'agentBrief'>;

export interface WorkbenchBackupSummary {
  id: string;
  path: string;
  createdAt: string;
  format: BackupSummary['format'];
  totalRows: number;
  ageSeconds: number;
  health?: BackupHealth;
  tableCount: number;
}

export interface WorkbenchBackupVerificationSummary {
  backupId: string;
  path: string;
  ok: boolean;
  health: BackupHealth;
  checkedAt: string;
  manifestVersion?: number;
  totalRows: number;
  issueCount: number;
  issues: BackupVerificationIssue[];
}

export interface WorkbenchBackupStatus {
  backupDir: string;
  store: BackupStatus['store'];
  health: BackupStatus['health'];
  latestBackup?: WorkbenchBackupSummary;
  latestVerification?: WorkbenchBackupVerificationSummary;
  backupCount: number;
  totalRows: number;
  scheduler: BackupSchedulerStatus;
}

export interface WorkbenchSummaryHealth {
  ok: true;
  service: 'tuberosa';
  store: BackupStatus['store'];
  durability: 'persistent' | 'ephemeral';
  cache: string;
  modelProvider: string;
  backupDir: string;
  backupStatus: WorkbenchBackupStatus;
}

export type WorkbenchRecommendedActionTarget =
  | 'backup_health'
  | 'context_quality'
  | 'pending_drafts'
  | 'risky_auto_memories'
  | 'knowledge_gaps'
  | 'learning_proposals'
  | 'knowledge_conflicts'
  | 'error_logs'
  | 'agent_sessions'
  | 'pending_maintenance'
  | 'none';

export interface WorkbenchRecommendedAction {
  priority: number;
  target: WorkbenchRecommendedActionTarget;
  label: string;
  count: number;
  href?: string;
  reason: string;
}

export type WorkbenchSummaryCounts = {
  recentSessions: number;
  activeSessions: number;
  pendingDrafts: number;
  contextQualityRecords: number;
  contextQualityMatched: number;
  openGaps: number;
  openProposals: number;
  openConflicts: number;
  autoMemories: number;
  riskyAutoMemories: number;
  openErrorLogs: number;
  backupCount: number;
  /** Phase 10 — total items the preview-first maintenance scanner currently surfaces. */
  pendingMaintenance: number;
};

export interface WorkbenchMaintenanceItemSummary {
  id: string;
  kind: MaintenanceItemKind;
  risk: MaintenanceRisk;
  reason: string;
  project?: string;
  knowledgeId?: string;
  relationId?: string;
  reflectionDraftId?: string;
  label?: MaintenanceItemLabel;
  closestKnowledgeId?: string;
}

export interface WorkbenchMaintenancePreview {
  batchId: string;
  generatedAt: string;
  counts: MaintenanceCounts;
  totalDetected: number;
  truncated: boolean;
  items: WorkbenchMaintenanceItemSummary[];
}

export type WorkbenchSummaryCountKey = keyof WorkbenchSummaryCounts;

export interface WorkbenchCountMetadata {
  scanLimit: number;
  capped: Partial<Record<WorkbenchSummaryCountKey, boolean>>;
}

export interface WorkbenchSummary {
  generatedAt: string;
  filters: WorkbenchSummaryInput;
  health: WorkbenchSummaryHealth;
  counts: WorkbenchSummaryCounts;
  countMetadata: WorkbenchCountMetadata;
  recentSessions: WorkbenchSessionSummary[];
  contextQuality: WorkbenchContextQualityReport;
  pendingDrafts: WorkbenchReflectionDraftSummary[];
  openGaps: WorkbenchKnowledgeGapSummary[];
  openProposals: WorkbenchLearningProposalSummary[];
  openConflicts: WorkbenchKnowledgeConflictSummary[];
  riskyAutoMemories: WorkbenchKnowledgeSummary[];
  openErrorLogs: WorkbenchErrorLogCollection;
  /** Phase 10 — preview of preview-first maintenance proposals. */
  pendingMaintenance: WorkbenchMaintenancePreview;
  recommendedActions: WorkbenchRecommendedAction[];
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
  learningCandidate?: ReflectionDraft;
  autoApprovedMemory?: ReflectionDraft;
  learningDecision?: AgentSessionLearningDecision;
  compliance: AgentContextCompliance;
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
