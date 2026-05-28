import type { LabelType, ReferenceInput, KnowledgeRelationType } from './knowledge.js';
import type { ReflectionDraft } from './session.js';

export type LearningReviewStatus = 'open' | 'approved' | 'dismissed' | 'needs_changes';

export type LearningProposalType =
  | 'missing_label'
  | 'missing_reference'
  | 'missing_relation'
  | 'supersedes'
  | 'auto_memory_cleanup'
  // Concern F — proposals from clustered correction/rejection feedback per user.
  | 'user_style_candidate';

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

/**
 * Phase 10 — Preview-first maintenance.
 * Categories of curation work the local-heuristic maintenance scanner can
 * propose. Apply is always reviewer-gated; no kind ever auto-mutates.
 */
export type MaintenanceItemKind =
  | 'duplicate_memory'
  | 'stale_relation'
  | 'superseded_reflection'
  | 'weak_label';

export interface MaintenanceItemLabel {
  type: LabelType;
  value: string;
}

/**
 * Risk class derived from the item's kind, exposed so the workbench and any
 * auto-apply opt-in flag can gate destructive vs. reversible work.
 *
 * - `low`: rejects a pending draft or removes a low-confidence inferred label.
 * - `medium`: deletes a stored relation.
 * - `high`: archives durable approved knowledge.
 */
export type MaintenanceRisk = 'low' | 'medium' | 'high';

/**
 * Detector that produced a maintenance item. Surfaced on each evidence entry so
 * the reviewer can tell which scan flagged the target and trace it back to the
 * relevant code path in `MaintenanceService`.
 */
export type MaintenanceEvidenceSource =
  | 'write_gate'
  | 'relation_expiry'
  | 'label_provenance';

export interface MaintenanceEvidence {
  source: MaintenanceEvidenceSource;
  reference: string;
}

/**
 * A snapshot of the target at propose time. The reviewer sees this in the
 * workbench without needing a second round-trip — the apply step still
 * re-reads the live target for the precondition check.
 */
export interface MaintenanceBefore {
  title?: string;
  summary?: string;
  labels?: Array<{ type: string; value: string }>;
  status?: string;
}

export interface MaintenanceItem {
  /** Stable id within the batch. Used by apply to pick which items to mutate. */
  id: string;
  kind: MaintenanceItemKind;
  /** Derived from `kind`; reviewer-visible gate for autoApplyLowRisk. */
  risk: MaintenanceRisk;
  reason: string;
  project?: string;
  /** Target identifiers, populated per kind. */
  knowledgeId?: string;
  relationId?: string;
  reflectionDraftId?: string;
  label?: MaintenanceItemLabel;
  /** Closest related knowledge (e.g. write-gate's closestKnowledgeId for supersedes). */
  closestKnowledgeId?: string;
  /** Structured evidence with detector attribution. */
  evidence?: MaintenanceEvidence[];
  /** Snapshot of the target at propose time so the reviewer can see what will change. */
  before?: MaintenanceBefore;
}

export type MaintenanceCounts = Record<MaintenanceItemKind, number>;

export interface MaintenanceBatch {
  id: string;
  generatedAt: string;
  project?: string;
  items: MaintenanceItem[];
  counts: MaintenanceCounts;
  /** True when item count was clamped to the requested limit (more remain). */
  truncated: boolean;
  /** Total items observed before the limit clamp. */
  totalDetected: number;
}

export interface MaintenanceProposeInput {
  project?: string;
  kinds?: MaintenanceItemKind[];
  limit?: number;
}

export interface MaintenanceApplyInput {
  batchId?: string;
  items?: MaintenanceItem[];
  approvedItemIds?: string[];
  reviewer?: string;
  reviewerNote?: string;
  /**
   * When true AND `approvedItemIds` is omitted, only items with `risk: 'low'`
   * are applied. Items with medium/high risk are skipped. Has no effect when
   * `approvedItemIds` is provided — explicit reviewer approval always wins.
   */
  autoApplyLowRisk?: boolean;
}

/**
 * Outcome of a single apply step.
 *
 * - `applied`: mutation occurred.
 * - `expired`: re-check found the target already in the desired state
 *   (idempotent self-replay or an externally applied change since propose).
 * - `skipped`: not in `approvedItemIds`, or filtered out by `autoApplyLowRisk`.
 * - `failed`: re-check or mutation threw.
 * - `noop`: reserved for future kinds with no-op semantics; current paths emit
 *   `expired` for precondition-changed cases.
 */
export type MaintenanceApplyOutcome = 'applied' | 'expired' | 'noop' | 'skipped' | 'failed';

export interface MaintenanceApplyResultItem {
  itemId: string;
  kind: MaintenanceItemKind;
  status: MaintenanceApplyOutcome;
  message?: string;
}

export interface MaintenanceApplyResult {
  batchId?: string;
  appliedAt: string;
  appliedCount: number;
  /** Includes `expired` and `noop` outcomes as well as explicit skips. */
  skippedCount: number;
  /** Subset of `skippedCount`: items whose preconditions changed since propose. */
  expiredCount: number;
  failedCount: number;
  results: MaintenanceApplyResultItem[];
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
