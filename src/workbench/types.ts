// Workbench-local mirror types. These mirror the backend API response shapes,
// kept in this file so the bundler does not pull node-only modules into the browser.

export type RecommendationVerdict = 'approve' | 'needs_changes' | 'reject';
export type RecommendationConfidence = 'high' | 'medium' | 'low';
export type GateKey =
  | 'learning_mode' | 'session_outcome' | 'compliance' | 'context_fit'
  | 'negative_decisions' | 'noisy_feedback' | 'signal_confidence' | 'duplicates'
  | 'grounded_references' | 'concrete_labels' | 'draft_maturity';

export type GateStatus = 'pass' | 'fail' | 'unknown';
export type GateSeverity = 'soft' | 'hard';

export interface GateResult {
  key: GateKey;
  status: GateStatus;
  severity: GateSeverity;
  label: string;
  message: string;
  detail?: string;
}

export interface RecommendationPoint { key: GateKey; label: string; detail: string }

export interface DraftRecommendation {
  draftId: string;
  verdict: RecommendationVerdict;
  confidence: RecommendationConfidence;
  oneLineRationale: string;
  pros: RecommendationPoint[];
  cons: RecommendationPoint[];
  blockers: RecommendationPoint[];
  unknowns: RecommendationPoint[];
  gates: GateResult[];
  canAutoApprove: boolean;
}

export type ReflectionDraftStatus = 'pending' | 'approved' | 'rejected' | 'needs_changes';
export type KnowledgeItemType = 'spec' | 'workflow' | 'memory' | 'bugfix' | 'code_ref' | 'rule' | 'wiki' | 'conversation';
export type TriggerType =
  | 'complex_task_success'
  | 'error_recovery'
  | 'user_correction'
  | 'non_trivial_workflow'
  | 'manual';

export interface LabelInput { type: string; value: string; weight?: number }
export interface ReferenceInput { type: string; uri: string; lineStart?: number; lineEnd?: number }

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
  duplicateCandidates: Array<{ knowledgeId: string; title: string; score: number }>;
  createdAt: string;
}

export interface ContextFit {
  fitStatus: 'ready' | 'needs_confirmation' | 'insufficient';
  fitScore: number;
  fitReasons: string[];
  missingSignals: string[];
}

export interface ContextPackOrientation {
  inferredTask: string;
  recommendedFiles: Array<{ path: string; reason: string }>;
  likelySurfaces: string[];
  verificationCommands: string[];
  missingSignals: { files: string[]; symbols: string[]; errors: string[]; docs: string[]; intent: string[]; other: string[] };
  notes: string[];
}

export interface ContextPackActionItem {
  priority: number;
  action: string;
  label: string;
  targetKind?: string;
  targetTitle?: string;
  reason?: string;
  command?: string;
  targetPath?: string;
}

export interface ContextPackTaskBrief {
  goal: string;
  actionItems: ContextPackActionItem[];
  directEvidenceKnowledgeIds: string[];
  adjacentKnowledgeIds: string[];
}

export interface RankedCandidate {
  knowledgeId: string;
  title: string;
  summary: string;
  itemType: KnowledgeItemType;
  finalScore: number;
  matchReasons: string[];
  evidenceCategory?: 'directTaskEvidence' | 'priorLessons' | 'workflowGuidance' | 'adjacentContext';
  evidenceStrength?: 'strong' | 'moderate' | 'weak';
  usefulnessReason?: string;
  references?: ReferenceInput[];
}

export interface ContextPackSection {
  name: 'essential' | 'supporting' | 'optional';
  items: RankedCandidate[];
  tokenEstimate: number;
}

export interface StartupBrief {
  verdict: 'proceed' | 'confirm' | 'clarify';
  readFirst: Array<{ path: string; reason: string; source: 'worktree' | 'memory' }>;
  directEvidence: Array<{ knowledgeId?: string; path?: string; reason: string }>;
  adjacentEvidence: Array<{ knowledgeId: string; reason: string }>;
  missingSignals: string[];
  riskyAreas: string[];
  verificationCommands: string[];
  requiredContextDecision: string;
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

export interface ResearchTraceSummary {
  steps: ResearchTraceStep[];
  outcome: string;
  derived: boolean;
  bytes: number;
}

export interface ContextPack {
  id: string;
  prompt: string;
  status: 'proposed' | 'selected' | 'rejected';
  confidence: number;
  contextFit?: ContextFit;
  orientation?: ContextPackOrientation;
  taskBrief?: ContextPackTaskBrief;
  startupBrief?: StartupBrief;
  sections: ContextPackSection[];
}

export type MaintenanceItemKind =
  | 'duplicate_memory'
  | 'stale_relation'
  | 'superseded_reflection'
  | 'weak_label';

export type MaintenanceRisk = 'low' | 'medium' | 'high';

export type MaintenanceEvidenceSource = 'write_gate' | 'relation_expiry' | 'label_provenance';

export interface MaintenanceEvidence {
  source: MaintenanceEvidenceSource;
  reference: string;
}

export interface MaintenanceBefore {
  title?: string;
  summary?: string;
  labels?: Array<{ type: string; value: string }>;
  status?: string;
}

export interface MaintenanceItem {
  id: string;
  kind: MaintenanceItemKind;
  risk: MaintenanceRisk;
  reason: string;
  project?: string;
  knowledgeId?: string;
  relationId?: string;
  reflectionDraftId?: string;
  label?: { type: string; value: string };
  closestKnowledgeId?: string;
  evidence?: MaintenanceEvidence[];
  before?: MaintenanceBefore;
}

export type MaintenanceCounts = Record<MaintenanceItemKind, number>;

export interface MaintenanceBatch {
  id: string;
  generatedAt: string;
  project?: string;
  items: MaintenanceItem[];
  counts: MaintenanceCounts;
  truncated: boolean;
  totalDetected: number;
}

export type MaintenanceApplyOutcome = 'applied' | 'expired' | 'noop' | 'skipped' | 'failed';

export interface MaintenanceApplyResult {
  batchId?: string;
  appliedAt: string;
  appliedCount: number;
  skippedCount: number;
  expiredCount: number;
  failedCount: number;
  results: Array<{ itemId: string; kind: MaintenanceItemKind; status: MaintenanceApplyOutcome; message?: string }>;
}

export interface AgentSession {
  id: string;
  project?: string;
  status: 'active' | 'finished';
  prompt: string;
  outcome?: 'completed' | 'failed' | 'blocked' | 'cancelled';
  reflectionDraftIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentSessionStartResult {
  session: AgentSession;
  contextPack: ContextPack;
  policy: { action: 'proceed' | 'confirm' | 'clarify'; instruction: string };
}

export interface ContextDecisionResult {
  session: AgentSession;
  decision: { id: string; decision: string; reason?: string };
  retry?: ContextPack;
}

export interface FinishSessionResult {
  session: AgentSession;
  reflectionDraft?: ReflectionDraft;
  learningCandidate?: ReflectionDraft;
  autoApprovedMemory?: ReflectionDraft;
  learningDecision?: { status: string; reasons: string[]; draftId?: string };
  compliance: { status: string; instruction: string };
}

export interface KnowledgeItem {
  id: string;
  project: string;
  title: string;
  summary: string;
  content: string;
  itemType: KnowledgeItemType;
  status: string;
  trustLevel: number;
  labels: LabelInput[];
  references: ReferenceInput[];
  freshnessAt?: string;
  updatedAt?: string;
  createdAt: string;
}

export interface CatchupKnownIssue {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'done' | string;
}

export interface CatchupMcpTool {
  name: string;
  purpose?: string;
  minArgs: string[];
}

export interface CatchupDocSnippet {
  path: string;
  exists: boolean;
  content?: string;
}

export interface CatchupSandboxHeadline {
  hitRate?: number;
  mrr?: number;
  noiseRate?: number;
  staleSuppression?: number;
  duplicateSuppression?: number;
  adversarialBlock?: number;
  latencyP50?: number;
  latencyP95?: number;
  latencyMax?: number;
}

export interface CatchupSandboxReport {
  headline: CatchupSandboxHeadline;
  status: 'pass' | 'fail' | 'unknown';
  generatedAt?: string;
  path: string;
}

export interface CatchupRetrievalEval {
  status: 'pass' | 'fail';
  generatedAt: string;
  totalCases: number;
  passedCases: number;
  fixtureName?: string;
  project?: string;
  metrics: {
    hitRate?: number;
    meanReciprocalRank?: number;
    selectedCoverageRate?: number;
    staleRejectionRate?: number;
    exactFileMatchRate?: number;
    exactSymbolMatchRate?: number;
    exactErrorMatchRate?: number;
  };
}

export interface CatchupMetadata {
  configPath: string;
  configExists: boolean;
  currentPhase?: string;
  projectGoal: CatchupDocSnippet;
  roadmap: CatchupDocSnippet;
  knownIssues: CatchupKnownIssue[];
  keyMcpTools: CatchupMcpTool[];
  sandbox: CatchupSandboxReport | null;
  retrievalEval: CatchupRetrievalEval | null;
}

export interface CatchupResponse {
  catchup: CatchupMetadata;
  summary: import('../types.js').WorkbenchSummary;
}

export type SessionVerdictStatus = 'ready' | 'needs_confirmation' | 'insufficient' | 'unknown';

export interface SessionVerdictView {
  status: SessionVerdictStatus;
  headline: string;
  detail: string;
  score?: number;
  policyAction: 'proceed' | 'confirm' | 'clarify';
  policyInstruction: string;
}

export interface PipelineStageView {
  key: 'prompt' | 'classify' | 'retrieve' | 'rank' | 'fit' | 'decision' | 'memory';
  label: string;
  status: 'done' | 'attention' | 'waiting';
  detail: string;
  count?: number;
}

export type EvidenceGraphNodeKind = 'task' | 'pack' | 'knowledge' | 'file' | 'symbol' | 'memory' | 'feedback' | 'gap' | 'proposal';
export type EvidenceGraphTone = 'good' | 'warn' | 'bad' | 'muted' | 'accent';

export interface EvidenceGraphNode {
  id: string;
  kind: EvidenceGraphNodeKind;
  label: string;
  detail?: string;
  tone: EvidenceGraphTone;
}

export interface EvidenceGraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  tone: EvidenceGraphTone;
}

export interface EvidenceGraphView {
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
}

export interface ContextStackItemView {
  knowledgeId: string;
  title: string;
  summary: string;
  itemType: string;
  evidenceStrength: string;
  evidenceCategory: string;
  score: number;
  why?: string;
  references: ReferenceInput[];
}

export interface ContextStackView {
  essential: ContextStackItemView[];
  supporting: ContextStackItemView[];
  optional: ContextStackItemView[];
}

export interface MissingSignalGroups {
  files: string[];
  symbols: string[];
  errors: string[];
  docs: string[];
  intent: string[];
  other: string[];
}

export interface AgentHandoffView {
  title: string;
  text: string;
  commands: string[];
  files: Array<{ path: string; reason: string }>;
  warnings: string[];
}

export type SessionNextActionKind =
  | 'record_decision'
  | 'copy_handoff'
  | 'finish_session'
  | 'ingest_missing_context'
  | 'retry_same_task';

export interface SessionNextActionView {
  kind: SessionNextActionKind;
  label: string;
  tone: EvidenceGraphTone;
}

export interface SessionResultViewModel {
  sessionId: string;
  prompt: string;
  project?: string;
  verdict: SessionVerdictView;
  pipeline: PipelineStageView[];
  graph: EvidenceGraphView;
  contextStack: ContextStackView;
  handoff: AgentHandoffView;
  missingSignals: MissingSignalGroups;
  nextActions: SessionNextActionView[];
}

export interface WorkbenchStartForm {
  prompt: string;
  project: string;
  cwd: string;
  taskType: string;
  files: string;
  symbols: string;
  errors: string;
  contextMode: 'compact' | 'layered';
}

export interface WorkbenchIngestFileInput {
  project?: string;
  path: string;
  content: string;
  itemType?: KnowledgeItemType;
  mode?: 'document' | 'atomic';
  labels?: LabelInput[];
  metadata?: Record<string, unknown>;
}

export interface WorkbenchIngestFilesRequest {
  project: string;
  files: WorkbenchIngestFileInput[];
  mode?: 'document' | 'atomic';
}

export type ReviewQueueFilter = 'all' | 'drafts' | 'quality' | 'gaps' | 'proposals' | 'conflicts' | 'risky' | 'errors' | 'maintenance';
export type ReviewQueueItemType = 'draft' | 'quality' | 'gap' | 'proposal' | 'conflict' | 'risky_memory' | 'error_log' | 'maintenance';

export interface ReviewQueueFilterView {
  key: ReviewQueueFilter;
  label: string;
  count: number;
}

export interface ReviewQueueItemView {
  id: string;
  type: ReviewQueueItemType;
  priority: number;
  tone: EvidenceGraphTone;
  title: string;
  summary: string;
  whyItMatters: string;
  evidence: string[];
  primaryAction: string;
  secondaryActions: string[];
  createdAt?: string;
}

export interface ReviewQueueViewModel {
  activeFilter: ReviewQueueFilter;
  filters: ReviewQueueFilterView[];
  items: ReviewQueueItemView[];
  emptyTitle: string;
  emptyHint: string;
}

export type WorkbenchSummary = import('../types.js').WorkbenchSummary;
export type WorkbenchCounts = import('../types.js').WorkbenchSummaryCounts;
export type WorkbenchRecommendedActionTarget = import('../types.js').WorkbenchRecommendedActionTarget;
export type WorkbenchKnowledgeGapSummary = import('../types.js').WorkbenchKnowledgeGapSummary;
export type WorkbenchLearningProposalSummary = import('../types.js').WorkbenchLearningProposalSummary;
export type WorkbenchKnowledgeConflictSummary = import('../types.js').WorkbenchKnowledgeConflictSummary;
export type WorkbenchKnowledgeSummary = import('../types.js').WorkbenchKnowledgeSummary;
export type WorkbenchErrorLogSummary = import('../types.js').ErrorLogSummary;
