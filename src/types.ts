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

export type KnowledgeRelationType =
  | 'contains'
  | 'references'
  | 'mentions_file'
  | 'mentions_symbol'
  | 'resolves_error'
  | 'supersedes'
  | 'depends_on'
  | 'related_to'
  | 'derived_from_session';

export type KnowledgeRelationTargetKind =
  | 'knowledge'
  | 'file'
  | 'symbol'
  | 'error'
  | 'session'
  | 'reference';

export interface KnowledgeRelationInput {
  project?: string;
  fromKnowledgeId: string;
  relationType: KnowledgeRelationType;
  targetKind: KnowledgeRelationTargetKind;
  targetKnowledgeId?: string;
  targetValue?: string;
  confidence?: number;
  inferred?: boolean;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeRelationPatchInput {
  relationType?: KnowledgeRelationType;
  targetKind?: KnowledgeRelationTargetKind;
  targetKnowledgeId?: string | null;
  targetValue?: string | null;
  confidence?: number;
  inferred?: boolean;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeRelation extends KnowledgeRelationInput {
  id: string;
  project?: string;
  confidence: number;
  inferred: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface ListKnowledgeRelationsOptions {
  project?: string;
  fromKnowledgeId?: string;
  targetKnowledgeId?: string;
  targetValue?: string;
  relationType?: KnowledgeRelationType;
  inferred?: boolean;
  limit: number;
}

export type KnowledgeConflictType = 'summary_contradiction' | 'freshness_conflict';

export type KnowledgeConflictStatus = 'open' | 'resolved' | 'dismissed';

export interface KnowledgeConflictInput {
  project?: string;
  leftKnowledgeId: string;
  rightKnowledgeId: string;
  conflictType: KnowledgeConflictType;
  sharedEvidence: string[];
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeConflictPatchInput {
  status?: KnowledgeConflictStatus;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeConflict extends KnowledgeConflictInput {
  id: string;
  project?: string;
  status: KnowledgeConflictStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
}

export interface ListKnowledgeConflictsOptions {
  project?: string;
  status?: KnowledgeConflictStatus;
  limit: number;
}

export type LearningReviewStatus = 'open' | 'approved' | 'dismissed' | 'needs_changes';

export type LearningProposalType =
  | 'missing_label'
  | 'missing_reference'
  | 'missing_relation'
  | 'supersedes'
  | 'auto_memory_cleanup';

export interface KnowledgeGapInput {
  project?: string;
  sourceFeedbackId?: string;
  sourceSessionId?: string;
  contextPackId?: string;
  prompt: string;
  classified?: ClassifiedQuery;
  missingSignals: string[];
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeGapPatchInput {
  status?: LearningReviewStatus;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeGap extends KnowledgeGapInput {
  id: string;
  status: LearningReviewStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  reviewedAt?: string;
}

export interface ListKnowledgeGapsOptions {
  project?: string;
  status?: LearningReviewStatus;
  sourceSessionId?: string;
  contextPackId?: string;
  limit: number;
}

export interface LearningProposalInput {
  project?: string;
  proposalType: LearningProposalType;
  sourceFeedbackId?: string;
  sourceSessionId?: string;
  contextPackId?: string;
  affectedKnowledgeId?: string;
  candidateKnowledgeId?: string;
  reason: string;
  evidence: string[];
  metadata?: Record<string, unknown>;
}

export interface LearningProposalPatchInput {
  status?: LearningReviewStatus;
  metadata?: Record<string, unknown>;
}

export interface LearningProposal extends LearningProposalInput {
  id: string;
  status: LearningReviewStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  reviewedAt?: string;
}

export interface ListLearningProposalsOptions {
  project?: string;
  status?: LearningReviewStatus;
  proposalType?: LearningProposalType;
  sourceSessionId?: string;
  contextPackId?: string;
  affectedKnowledgeId?: string;
  limit: number;
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
  | 'orphaned'
  | 'auto_memory'
  | 'risky_auto_memory';

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
  contextMode?: ContextMode;
  deepContextBudget?: number;
  includeDeepContext?: boolean;
  rejectedKnowledgeIds?: string[];
  bypassCache?: boolean;
  debug?: boolean;
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

export type CandidateSource = 'lexical' | 'vector' | 'metadata' | 'memory' | 'reference' | 'graph';

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

export interface ContextFit {
  fitStatus: ContextFitStatus;
  fitScore: number;
  fitReasons: string[];
  missingSignals: string[];
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

export type BackupTableName =
  | 'projects'
  | 'knowledge_sources'
  | 'knowledge_items'
  | 'labels'
  | 'knowledge_labels'
  | 'knowledge_references'
  | 'knowledge_relations'
  | 'knowledge_conflicts'
  | 'knowledge_gaps'
  | 'learning_proposals'
  | 'knowledge_chunks'
  | 'reflection_drafts'
  | 'context_queries'
  | 'context_packs'
  | 'feedback_events'
  | 'agent_sessions'
  | 'agent_context_decisions';

export interface BackupTableData {
  name: BackupTableName;
  rows: Array<Record<string, unknown>>;
}

export interface BackupExportData {
  tables: BackupTableData[];
}

export interface BackupManifest {
  id: string;
  version: 1;
  format: 'jsonl';
  createdAt: string;
  source: {
    service: 'tuberosa';
    store: 'postgres' | 'memory';
    appVersion?: string;
    appCommit?: string;
    schemaVersion?: number;
    embeddingDimensions?: number;
    modelProvider?: string;
    embeddingModel?: string;
    metadata?: Record<string, unknown>;
  };
  tables: Array<{
    name: BackupTableName;
    file: string;
    rows: number;
    checksumSha256?: string;
  }>;
}

export interface CreateBackupInput {
  id?: string;
  reason?: string;
  prune?: boolean;
}

export interface BackupSummary {
  id: string;
  path: string;
  createdAt: string;
  format: BackupManifest['format'];
  source: BackupManifest['source'];
  tables: BackupManifest['tables'];
  totalRows: number;
  ageSeconds: number;
  health?: BackupHealth;
}

export interface RestoreBackupInput {
  backupIdOrPath?: string;
  dryRun?: boolean;
  replace?: boolean;
}

export interface RestoreBackupResult {
  backupId: string;
  dryRun: boolean;
  replace: boolean;
  verification: BackupVerificationResult;
  restored: Record<BackupTableName, number>;
}

export type BackupHealth = 'healthy' | 'degraded' | 'unhealthy' | 'missing';

export interface BackupVerificationIssue {
  severity: 'error' | 'warning';
  message: string;
  table?: BackupTableName;
}

export interface BackupVerificationResult {
  backupId: string;
  path: string;
  ok: boolean;
  health: BackupHealth;
  checkedAt: string;
  manifestVersion?: number;
  source?: BackupManifest['source'];
  rowCounts: Partial<Record<BackupTableName, number>>;
  totalRows: number;
  issues: BackupVerificationIssue[];
}

export interface BackupStatus {
  backupDir: string;
  store: 'postgres' | 'memory';
  health: BackupHealth | 'no_backups';
  latestBackup?: BackupSummary;
  latestVerification?: BackupVerificationResult;
  backupCount: number;
  totalRows: number;
  scheduler: BackupSchedulerStatus;
}

export interface BackupRetentionInput {
  dryRun?: boolean;
  keepCount?: number;
  maxAgeDays?: number;
}

export interface BackupRetentionResult {
  dryRun: boolean;
  keepCount?: number;
  maxAgeDays?: number;
  kept: BackupSummary[];
  pruned: BackupSummary[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface BackupSchedulerStatus {
  enabled: boolean;
  running: boolean;
  intervalSeconds?: number;
  startupDelaySeconds?: number;
  retentionCount?: number;
  retentionMaxAgeDays?: number;
  writeThroughEnabled: boolean;
  writeThroughThrottleSeconds?: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastBackupId?: string;
  lastError?: string;
  nextRunAt?: string;
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
  contextBypassReason?: string;
  learningMode?: AgentLearningMode;
  metadata?: Record<string, unknown>;
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

export type ErrorLogCategory =
  | 'mcp'
  | 'http'
  | 'cli'
  | 'database'
  | 'cache'
  | 'model_provider'
  | 'retrieval'
  | 'ingestion'
  | 'reflection'
  | 'agent_session'
  | 'agent_tool'
  | 'test'
  | 'unknown';

export type ErrorLogSeverity =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

export type ErrorLogStatus = 'open' | 'triaged' | 'fixed' | 'wont_fix' | 'archived';

export interface ErrorLogInput {
  project?: string;
  category?: ErrorLogCategory;
  severity?: ErrorLogSeverity;
  status?: ErrorLogStatus;
  title: string;
  summary?: string;
  message?: string;
  stack?: string;
  toolName?: string;
  operation?: string;
  command?: string;
  cwd?: string;
  files?: string[];
  symbols?: string[];
  errors?: string[];
  tags?: string[];
  agentName?: string;
  agentTool?: string;
  sessionId?: string;
  contextPackId?: string;
  reflectionDraftId?: string;
  references?: ReferenceInput[];
  metadata?: Record<string, unknown>;
  fingerprint?: string;
}

export interface ErrorLog extends ErrorLogInput {
  id: string;
  category: ErrorLogCategory;
  severity: ErrorLogSeverity;
  status: ErrorLogStatus;
  summary: string;
  message: string;
  files: string[];
  symbols: string[];
  errors: string[];
  tags: string[];
  references: ReferenceInput[];
  metadata: Record<string, unknown>;
  fingerprint: string;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
  safety: {
    redactionCount: number;
    checkedAt: string;
  };
  truncated: boolean;
}

export interface ErrorLogPatchInput {
  status?: ErrorLogStatus;
  category?: ErrorLogCategory;
  severity?: ErrorLogSeverity;
  summary?: string;
  notes?: string;
  tags?: string[];
  references?: ReferenceInput[];
  reflectionDraftId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListErrorLogsOptions {
  project?: string;
  category?: ErrorLogCategory;
  severity?: ErrorLogSeverity;
  status?: ErrorLogStatus;
  query?: string;
  tag?: string;
  limit: number;
}

export interface CollectErrorLogsOptions {
  project?: string;
  categories?: ErrorLogCategory[];
  severities?: ErrorLogSeverity[];
  statuses?: ErrorLogStatus[];
  query?: string;
  tag?: string;
  since?: string;
  until?: string;
  limit: number;
  offset: number;
}

export interface ErrorLogSummary {
  id: string;
  project?: string;
  category: ErrorLogCategory;
  severity: ErrorLogSeverity;
  status: ErrorLogStatus;
  title: string;
  summary: string;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  files: string[];
  symbols: string[];
  errors: string[];
  tags: string[];
  fingerprint: string;
  reflectionDraftId?: string;
  references: ReferenceInput[];
}

export interface ErrorLogCluster {
  fingerprint: string;
  title: string;
  count: number;
  occurrenceCount: number;
  severity: ErrorLogSeverity;
  statuses: ErrorLogStatus[];
  categories: ErrorLogCategory[];
  firstSeenAt: string;
  lastSeenAt: string;
  logIds: string[];
  files: string[];
  symbols: string[];
  errors: string[];
  tags: string[];
}

export interface ErrorLogCollection {
  project?: string;
  generatedAt: string;
  totalMatched: number;
  returned: number;
  nextOffset?: number;
  filters: CollectErrorLogsOptions;
  rollups: {
    categories: Array<{ value: ErrorLogCategory; count: number }>;
    severities: Array<{ value: ErrorLogSeverity; count: number }>;
    statuses: Array<{ value: ErrorLogStatus; count: number }>;
    files: Array<{ value: string; count: number }>;
    symbols: Array<{ value: string; count: number }>;
    errors: Array<{ value: string; count: number }>;
    tags: Array<{ value: string; count: number }>;
  };
  clusters: ErrorLogCluster[];
  logs: ErrorLogSummary[];
  agentBrief: string;
}

export interface CreateErrorLogReflectionDraftInput {
  errorLogIds: string[];
  project?: string;
  title?: string;
  summary?: string;
  content?: string;
  linkLogs?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CreateErrorLogReflectionDraftResult {
  draft: ReflectionDraft;
  linkedErrorLogIds: string[];
}

export interface ResolveErrorLogInput {
  id: string;
  status?: Extract<ErrorLogStatus, 'fixed' | 'wont_fix'>;
  rootCause: string;
  resolutionSummary: string;
  changedFiles?: string[];
  verificationCommands?: string[];
  reflectionDraftId?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolveErrorLogResult {
  log: ErrorLog;
  instruction: string;
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

export interface ProjectMapExport {
  project?: string;
  generatedAt: string;
  knowledgeCount: number;
  relationCount: number;
  labelCount: number;
  sources: Array<{
    uri?: string;
    title: string;
    itemCount: number;
  }>;
  relationTypes: Array<{
    type: KnowledgeRelationType;
    count: number;
  }>;
}

export interface KnowledgeGraphJsonlExport {
  project?: string;
  generatedAt: string;
  content: string;
}

export interface ReadableSummaryExport {
  project?: string;
  generatedAt: string;
  content: string;
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
}

export type RetrievalDebugStageName = 'metadata' | 'lexical' | 'memory' | 'vector' | 'graph' | 'fusion' | 'rerank' | 'fit';

export type RetrievalDebugTimingName =
  | RetrievalDebugStageName
  | 'classification'
  | 'rewrite'
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
}
