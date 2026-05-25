import type {
  KnowledgeConflictStatus,
  KnowledgeConflictType,
  KnowledgeItemType,
  KnowledgeStatus,
  TriggerType,
} from './knowledge.js';
import type {
  BackupHealth,
  BackupSchedulerStatus,
  BackupStatus,
  BackupSummary,
  BackupVerificationIssue,
  ErrorLogCollection,
  LearningProposalType,
  LearningReviewStatus,
  MaintenanceCounts,
  MaintenanceItemKind,
  MaintenanceItemLabel,
  MaintenanceRisk,
} from './operations.js';
import type {
  ContextQualityItemSummary,
  ContextQualityKnowledgeGapSummary,
  ContextQualityLearningProposalSummary,
  ContextQualityPackSummary,
  ContextQualityReport,
  ContextQualityReportInput,
  ContextQualitySessionSummary,
  FeedbackType,
} from './feedback.js';
import type {
  AgentSessionOutcome,
  AgentSessionStatus,
  ReflectionDraftStatus,
} from './session.js';

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
