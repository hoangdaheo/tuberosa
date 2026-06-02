import type {
  TaskType,
  ContextNoiseTolerance,
  KnowledgeItemType,
  TriggerType,
  LabelType,
  KnowledgeRelationType,
  KnowledgeRelationTargetKind,
  KnowledgeStatus,
  KnowledgeReviewFilter,
  KnowledgeConflictStatus,
  LearningReviewStatus,
  LearningProposalType,
  ReflectionDraftStatus,
  AgentSessionOutcome,
  AgentLearningMode,
  AgentLearningSignalKind,
  MaintenanceItemKind,
  ErrorLogCategory,
  ErrorLogSeverity,
  ErrorLogStatus,
  FeedbackQualityType,
} from '../types.js';
import type { IngestionMode } from '../ingest/service.js';

export const TASK_TYPES = [
  'debugging',
  'implementation',
  'refactor',
  'review',
  'planning',
  'exploration',
  'testing',
  'unknown',
] as const satisfies readonly TaskType[];

export const TASK_TYPE_ALIASES = new Map<string, TaskType>([
  ['bug', 'debugging'],
  ['bug_fix', 'debugging'],
  ['bugfix', 'debugging'],
  ['coding', 'implementation'],
  ['development', 'implementation'],
  ['investigation', 'debugging'],
]);

/** Normalize a raw taskType string: trim, lowercase, collapse spaces/hyphens to underscore. */
export function taskTypeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** Type guard: is `t` a canonical TaskType (not just an alias)? */
export const isTaskType = (t: string): t is TaskType => (TASK_TYPES as readonly string[]).includes(t);

export const CONTEXT_MODES = ['compact', 'layered'] as const;
export const CONTEXT_NOISE_TOLERANCES = ['balanced', 'strict'] as const satisfies readonly ContextNoiseTolerance[];

export const KNOWLEDGE_ITEM_TYPES = [
  'spec',
  'workflow',
  'memory',
  'bugfix',
  'code_ref',
  'rule',
  'wiki',
  'conversation',
] as const satisfies readonly KnowledgeItemType[];

export const TRIGGER_TYPES = [
  'complex_task_success',
  'error_recovery',
  'user_correction',
  'non_trivial_workflow',
  'manual',
] as const satisfies readonly TriggerType[];

export const LABEL_TYPES = [
  'project',
  'repo',
  'domain',
  'business_area',
  'task_type',
  'technology',
  'workflow_stage',
  'severity',
  'file',
  'symbol',
  'error',
  'user_preference',
] as const satisfies readonly LabelType[];

export const REFERENCE_TYPES = ['file', 'url', 'commit', 'tool', 'conversation', 'external'] as const;

export const KNOWLEDGE_RELATION_TYPES = [
  'contains',
  'references',
  'mentions_file',
  'mentions_symbol',
  'resolves_error',
  'supersedes',
  'depends_on',
  'related_to',
  'derived_from_session',
] as const satisfies readonly KnowledgeRelationType[];

export const KNOWLEDGE_RELATION_TARGET_KINDS = [
  'knowledge',
  'file',
  'symbol',
  'error',
  'session',
  'reference',
] as const satisfies readonly KnowledgeRelationTargetKind[];

export const INGESTION_MODES = ['document', 'atomic'] as const satisfies readonly IngestionMode[];

export const FEEDBACK_TYPES = [
  'selected',
  'rejected',
  'irrelevant',
  'stale',
  'missing_context',
  'selected_but_noisy',
  'too_much_adjacent_context',
  'missing_orientation',
  'missing_current_handoff',
  'missing_verification_commands',
] as const;

export const CONTEXT_QUALITY_FEEDBACK_TYPES = [
  'selected_but_noisy',
  'too_much_adjacent_context',
  'missing_orientation',
  'missing_current_handoff',
  'missing_verification_commands',
] as const satisfies readonly FeedbackQualityType[];

export const AGENT_SESSION_OUTCOMES = ['completed', 'failed', 'blocked', 'cancelled'] as const satisfies readonly AgentSessionOutcome[];

export const AGENT_LEARNING_MODES = ['auto', 'draft_only', 'off'] as const satisfies readonly AgentLearningMode[];

export const KNOWLEDGE_STATUSES = ['approved', 'needs_review', 'archived', 'blocked'] as const satisfies readonly KnowledgeStatus[];

export const KNOWLEDGE_REVIEW_FILTERS = [
  'questionable',
  'unsafe',
  'low_trust',
  'stale',
  'rejected',
  'irrelevant',
  'orphaned',
  'auto_memory',
  'risky_auto_memory',
] as const satisfies readonly KnowledgeReviewFilter[];

export const KNOWLEDGE_CONFLICT_STATUSES = ['open', 'resolved', 'dismissed'] as const satisfies readonly KnowledgeConflictStatus[];

export const LEARNING_REVIEW_STATUSES = ['open', 'approved', 'dismissed', 'needs_changes'] as const satisfies readonly LearningReviewStatus[];

export const LEARNING_PROPOSAL_TYPES = [
  'missing_label',
  'missing_reference',
  'missing_relation',
  'supersedes',
  'auto_memory_cleanup',
  'user_style_candidate',
] as const satisfies readonly LearningProposalType[];

export const REFLECTION_DRAFT_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'needs_changes',
] as const satisfies readonly ReflectionDraftStatus[];

export const REFLECTION_REVIEW_DECISIONS = ['approve', 'reject', 'needs_changes'] as const;
export const REFLECTION_REVIEW_GRADES = ['pass', 'concern', 'fail'] as const;
export const REFLECTION_DUPLICATE_RISKS = ['low', 'medium', 'high'] as const;

export const ERROR_LOG_CATEGORIES = [
  'mcp',
  'http',
  'cli',
  'database',
  'cache',
  'model_provider',
  'retrieval',
  'ingestion',
  'reflection',
  'agent_session',
  'agent_tool',
  'test',
  'unknown',
] as const satisfies readonly ErrorLogCategory[];

export const ERROR_LOG_SEVERITIES = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const satisfies readonly ErrorLogSeverity[];

export const ERROR_LOG_STATUSES = ['open', 'triaged', 'fixed', 'wont_fix', 'archived'] as const satisfies readonly ErrorLogStatus[];

export const AGENT_LEARNING_SIGNAL_KINDS = [
  'tip',
  'decision',
  'mistake',
  'verification',
  'file_change',
  'user_preference',
  'follow_up',
] as const satisfies readonly AgentLearningSignalKind[];

export const AGENT_LEARNING_SIGNAL_SOURCES = ['user', 'agent', 'tool', 'system', 'reviewer'] as const;

export const RESEARCH_TRACE_STEP_KINDS = ['thought', 'action', 'observation', 'decision'] as const;

export const MAINTENANCE_ITEM_KINDS = [
  'duplicate_memory',
  'stale_relation',
  'superseded_reflection',
  'weak_label',
] as const satisfies readonly MaintenanceItemKind[];

export const MAINTENANCE_RISKS = ['low', 'medium', 'high'] as const;
export const MAINTENANCE_EVIDENCE_SOURCES = ['write_gate', 'relation_expiry', 'label_provenance'] as const;
export const MAINTENANCE_RISK_DEFAULTS: Record<MaintenanceItemKind, 'low' | 'medium' | 'high'> = {
  duplicate_memory: 'low',
  weak_label: 'low',
  stale_relation: 'medium',
  superseded_reflection: 'high',
};

export const RESOLVE_ERROR_LOG_STATUSES = ['fixed', 'wont_fix'] as const;
