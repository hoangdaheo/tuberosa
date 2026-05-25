export * from './types/knowledge.js';
export * from './types/operations.js';
export * from './types/retrieval.js';

import type {
  KnowledgeItemType,
  TriggerType,
  LabelInput,
  ReferenceInput,
  KnowledgeConflictType,
  KnowledgeConflictStatus,
  KnowledgeStatus,
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
import type {
  ContextEvidenceCategory,
  ContextEvidenceStrength,
  ContextFitStatus,
  ContextPack,
  ContextSearchInput,
  RankedCandidate,
} from './types/retrieval.js';

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

