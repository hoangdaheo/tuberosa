import type { IngestFileInput, IngestionMode } from './ingest/service.js';
import type {
  AgentSessionOutcome,
  AgentLearningMode,
  AgentLearningSignal,
  AgentLearningSignalKind,
  AppendAgentSessionNoteInput,
  BackupRetentionInput,
  CollectErrorLogsOptions,
  CaptureAgentLearningSignalInput,
  CreateBackupInput,
  CreateErrorLogReflectionDraftInput,
  FinishAgentSessionInput,
  ContextNoiseTolerance,
  ContextSearchInput,
  ContextQualityReportInput,
  FeedbackInput,
  FeedbackQualityType,
  CleanupOperationsInput,
  ErrorLogCategory,
  ErrorLogInput,
  ErrorLogPatchInput,
  ErrorLogSeverity,
  ErrorLogStatus,
  KnowledgeConflictPatchInput,
  KnowledgeConflictStatus,
  KnowledgeGapPatchInput,
  KnowledgePatchInput,
  LearningProposalPatchInput,
  LearningProposalType,
  LearningReviewStatus,
  MaintenanceApplyInput,
  MaintenanceItem,
  MaintenanceBefore,
  MaintenanceEvidence,
  MaintenanceItemKind,
  MaintenanceItemLabel,
  MaintenanceProposeInput,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  KnowledgeRelationTargetKind,
  KnowledgeRelationType,
  KnowledgeReviewFilter,
  KnowledgeStatus,
  KnowledgeInput,
  KnowledgeItemType,
  LabelInput,
  LabelType,
  RecordAgentContextDecisionInput,
  ReferenceInput,
  ReflectionDraftInput,
  ReflectionDraftPatchInput,
  ReflectionDraftReviewInput,
  ReflectionDraftStatus,
  ResearchTraceInput,
  ResearchTraceReference,
  ResearchTraceStep,
  ResolveErrorLogInput,
  RestoreBackupInput,
  StartAgentSessionInput,
  TaskType,
  TriggerType,
} from './types.js';
import { ValidationError } from './errors.js';
import {
  MAX_RESEARCH_TRACE_OUTCOME,
  MAX_RESEARCH_TRACE_STEP_TEXT,
  MAX_RESEARCH_TRACE_STEPS,
} from './agent-session/research-trace.js';

export interface IngestFilesRequest {
  project: string;
  files: IngestFileInput[];
  mode?: IngestionMode;
}

interface ValidationIssue {
  path: string;
  message: string;
}

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

const TASK_TYPE_ALIASES = new Map<string, TaskType>([
  ['bug', 'debugging'],
  ['bug_fix', 'debugging'],
  ['bugfix', 'debugging'],
  ['coding', 'implementation'],
  ['development', 'implementation'],
  ['investigation', 'debugging'],
]);

const LABEL_TYPES = [
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

const REFERENCE_TYPES = ['file', 'url', 'commit', 'tool', 'conversation', 'external'] as const;
const KNOWLEDGE_RELATION_TYPES = [
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
const KNOWLEDGE_RELATION_TARGET_KINDS = [
  'knowledge',
  'file',
  'symbol',
  'error',
  'session',
  'reference',
] as const satisfies readonly KnowledgeRelationTargetKind[];
const INGESTION_MODES = ['document', 'atomic'] as const satisfies readonly IngestionMode[];
export const CONTEXT_MODES = ['compact', 'layered'] as const;
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
const KNOWLEDGE_STATUSES = ['approved', 'needs_review', 'archived', 'blocked'] as const satisfies readonly KnowledgeStatus[];
const KNOWLEDGE_REVIEW_FILTERS = [
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
const KNOWLEDGE_CONFLICT_STATUSES = ['open', 'resolved', 'dismissed'] as const satisfies readonly KnowledgeConflictStatus[];
const LEARNING_REVIEW_STATUSES = ['open', 'approved', 'dismissed', 'needs_changes'] as const satisfies readonly LearningReviewStatus[];
const LEARNING_PROPOSAL_TYPES = [
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
const REFLECTION_REVIEW_DECISIONS = ['approve', 'reject', 'needs_changes'] as const;
const REFLECTION_REVIEW_GRADES = ['pass', 'concern', 'fail'] as const;
const REFLECTION_DUPLICATE_RISKS = ['low', 'medium', 'high'] as const;
const ERROR_LOG_CATEGORIES = [
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
const ERROR_LOG_SEVERITIES = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const satisfies readonly ErrorLogSeverity[];
const ERROR_LOG_STATUSES = ['open', 'triaged', 'fixed', 'wont_fix', 'archived'] as const satisfies readonly ErrorLogStatus[];
export const CONTEXT_NOISE_TOLERANCES = ['balanced', 'strict'] as const satisfies readonly ContextNoiseTolerance[];
export const AGENT_LEARNING_SIGNAL_KINDS = [
  'tip',
  'decision',
  'mistake',
  'verification',
  'file_change',
  'user_preference',
  'follow_up',
] as const satisfies readonly AgentLearningSignalKind[];
const AGENT_LEARNING_SIGNAL_SOURCES = ['user', 'agent', 'tool', 'system', 'reviewer'] as const;

export function validateKnowledgeInput(value: unknown): KnowledgeInput {
  const record = expectObject(value, 'knowledge input');

  return {
    project: readRequiredString(record, 'project', 'knowledge input'),
    sourceType: readRequiredString(record, 'sourceType', 'knowledge input'),
    sourceUri: readRequiredString(record, 'sourceUri', 'knowledge input'),
    sourceTitle: readOptionalString(record, 'sourceTitle', 'knowledge input'),
    itemType: readRequiredEnum(record, 'itemType', KNOWLEDGE_ITEM_TYPES, 'knowledge input'),
    title: readRequiredString(record, 'title', 'knowledge input'),
    summary: readOptionalString(record, 'summary', 'knowledge input'),
    content: readRequiredString(record, 'content', 'knowledge input'),
    trustLevel: readOptionalNumber(record, 'trustLevel', 'knowledge input'),
    labels: readOptionalLabels(record.labels, 'knowledge input.labels'),
    references: readOptionalReferences(record.references, 'knowledge input.references'),
    metadata: readOptionalObject(record, 'metadata', 'knowledge input'),
    freshnessAt: readOptionalString(record, 'freshnessAt', 'knowledge input'),
  };
}

export function validateKnowledgePatchInput(value: unknown): KnowledgePatchInput {
  const record = expectObject(value, 'knowledge patch input');

  return {
    status: readOptionalEnum(record, 'status', KNOWLEDGE_STATUSES, 'knowledge patch input'),
    title: readOptionalString(record, 'title', 'knowledge patch input'),
    summary: readOptionalString(record, 'summary', 'knowledge patch input'),
    trustLevel: readOptionalNumber(record, 'trustLevel', 'knowledge patch input'),
    freshnessAt: readOptionalNullableString(record, 'freshnessAt', 'knowledge patch input'),
    metadata: readOptionalObject(record, 'metadata', 'knowledge patch input'),
    labels: readOptionalLabels(record.labels, 'knowledge patch input.labels'),
    references: readOptionalReferences(record.references, 'knowledge patch input.references'),
  };
}

export function validateKnowledgeRelationInput(value: unknown): KnowledgeRelationInput {
  const record = expectObject(value, 'knowledge relation input');
  const input: KnowledgeRelationInput = {
    project: readOptionalString(record, 'project', 'knowledge relation input'),
    fromKnowledgeId: readRequiredString(record, 'fromKnowledgeId', 'knowledge relation input'),
    relationType: readRequiredEnum(record, 'relationType', KNOWLEDGE_RELATION_TYPES, 'knowledge relation input'),
    targetKind: readRequiredEnum(record, 'targetKind', KNOWLEDGE_RELATION_TARGET_KINDS, 'knowledge relation input'),
    targetKnowledgeId: readOptionalString(record, 'targetKnowledgeId', 'knowledge relation input'),
    targetValue: readOptionalString(record, 'targetValue', 'knowledge relation input'),
    confidence: readOptionalRelationConfidence(record, 'confidence', 'knowledge relation input'),
    inferred: readOptionalBoolean(record, 'inferred', 'knowledge relation input'),
    metadata: readOptionalObject(record, 'metadata', 'knowledge relation input'),
  };
  ensureRelationTarget(input.targetKnowledgeId, input.targetValue, 'knowledge relation input');
  return input;
}

export function validateKnowledgeRelationPatchInput(value: unknown): KnowledgeRelationPatchInput {
  const record = expectObject(value, 'knowledge relation patch input');
  const patch: KnowledgeRelationPatchInput = {
    relationType: readOptionalEnum(record, 'relationType', KNOWLEDGE_RELATION_TYPES, 'knowledge relation patch input'),
    targetKind: readOptionalEnum(record, 'targetKind', KNOWLEDGE_RELATION_TARGET_KINDS, 'knowledge relation patch input'),
    targetKnowledgeId: readOptionalNullableString(record, 'targetKnowledgeId', 'knowledge relation patch input'),
    targetValue: readOptionalNullableString(record, 'targetValue', 'knowledge relation patch input'),
    confidence: readOptionalRelationConfidence(record, 'confidence', 'knowledge relation patch input'),
    inferred: readOptionalBoolean(record, 'inferred', 'knowledge relation patch input'),
    metadata: readOptionalObject(record, 'metadata', 'knowledge relation patch input'),
  };
  if (patch.targetKnowledgeId === null && patch.targetValue === null) {
    throw validationIssue('knowledge relation patch input.targetValue', 'must leave at least one target identifier.');
  }

  return patch;
}

export function validateKnowledgeConflictPatchInput(value: unknown): KnowledgeConflictPatchInput {
  const record = expectObject(value, 'knowledge conflict patch input');
  return {
    status: readOptionalEnum(record, 'status', KNOWLEDGE_CONFLICT_STATUSES, 'knowledge conflict patch input'),
    metadata: readOptionalObject(record, 'metadata', 'knowledge conflict patch input'),
  };
}

export function validateKnowledgeGapPatchInput(value: unknown): KnowledgeGapPatchInput {
  const record = expectObject(value, 'knowledge gap patch input');
  return {
    status: readOptionalEnum(record, 'status', LEARNING_REVIEW_STATUSES, 'knowledge gap patch input'),
    metadata: readOptionalObject(record, 'metadata', 'knowledge gap patch input'),
  };
}

export function validateLearningProposalPatchInput(value: unknown): LearningProposalPatchInput {
  const record = expectObject(value, 'learning proposal patch input');
  return {
    status: readOptionalEnum(record, 'status', LEARNING_REVIEW_STATUSES, 'learning proposal patch input'),
    metadata: readOptionalObject(record, 'metadata', 'learning proposal patch input'),
  };
}

export const MAINTENANCE_ITEM_KINDS = [
  'duplicate_memory',
  'stale_relation',
  'superseded_reflection',
  'weak_label',
] as const satisfies readonly MaintenanceItemKind[];

export function validateMaintenanceProposeInput(value: unknown): MaintenanceProposeInput {
  const record = expectObject(value, 'maintenance propose input');
  const kindsRaw = record.kinds;
  const kinds = kindsRaw === undefined
    ? undefined
    : readMaintenanceKinds(kindsRaw, 'maintenance propose input.kinds');
  return {
    project: readOptionalString(record, 'project', 'maintenance propose input'),
    kinds,
    limit: readOptionalPositiveNumber(record, 'limit', 'maintenance propose input'),
  };
}

export function validateMaintenanceApplyInput(value: unknown): MaintenanceApplyInput {
  const record = expectObject(value, 'maintenance apply input');
  const items = record.items === undefined
    ? undefined
    : readMaintenanceItems(record.items, 'maintenance apply input.items');
  return {
    batchId: readOptionalString(record, 'batchId', 'maintenance apply input'),
    items,
    approvedItemIds: readOptionalStringArray(record, 'approvedItemIds', 'maintenance apply input'),
    reviewer: readOptionalString(record, 'reviewer', 'maintenance apply input'),
    reviewerNote: readOptionalString(record, 'reviewerNote', 'maintenance apply input'),
    autoApplyLowRisk: readOptionalBoolean(record, 'autoApplyLowRisk', 'maintenance apply input'),
  };
}

function readMaintenanceKinds(value: unknown, path: string): MaintenanceItemKind[] {
  if (!Array.isArray(value)) {
    throw validationIssue(path, 'must be an array.');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !MAINTENANCE_ITEM_KINDS.includes(entry as MaintenanceItemKind)) {
      throw validationIssue(`${path}[${index}]`, `must be one of: ${MAINTENANCE_ITEM_KINDS.join(', ')}.`);
    }
    return entry as MaintenanceItemKind;
  });
}

function readMaintenanceItems(value: unknown, path: string): MaintenanceItem[] {
  if (!Array.isArray(value)) {
    throw validationIssue(path, 'must be an array.');
  }
  return value.map((entry, index) => readMaintenanceItem(entry, `${path}[${index}]`));
}

const MAINTENANCE_RISKS = ['low', 'medium', 'high'] as const;
const MAINTENANCE_EVIDENCE_SOURCES = ['write_gate', 'relation_expiry', 'label_provenance'] as const;
const MAINTENANCE_RISK_DEFAULTS: Record<MaintenanceItemKind, 'low' | 'medium' | 'high'> = {
  duplicate_memory: 'low',
  weak_label: 'low',
  stale_relation: 'medium',
  superseded_reflection: 'high',
};

function readMaintenanceItem(value: unknown, path: string): MaintenanceItem {
  const record = expectObject(value, path);
  const kindRaw = record.kind;
  if (typeof kindRaw !== 'string' || !MAINTENANCE_ITEM_KINDS.includes(kindRaw as MaintenanceItemKind)) {
    throw validationIssue(`${path}.kind`, `must be one of: ${MAINTENANCE_ITEM_KINDS.join(', ')}.`);
  }
  const kind = kindRaw as MaintenanceItemKind;
  const labelValue = record.label;
  let label: MaintenanceItemLabel | undefined;
  if (labelValue !== undefined && labelValue !== null) {
    const labelRecord = expectObject(labelValue, `${path}.label`);
    label = {
      type: readRequiredEnum(labelRecord, 'type', LABEL_TYPES, `${path}.label`),
      value: readRequiredString(labelRecord, 'value', `${path}.label`),
    };
  }
  const evidenceRaw = record.evidence;
  let evidence: MaintenanceEvidence[] | undefined;
  if (evidenceRaw !== undefined && evidenceRaw !== null) {
    if (!Array.isArray(evidenceRaw)) {
      throw validationIssue(`${path}.evidence`, 'must be an array.');
    }
    evidence = evidenceRaw.map((entry, i) => {
      const entryRecord = expectObject(entry, `${path}.evidence[${i}]`);
      const source = readRequiredString(entryRecord, 'source', `${path}.evidence[${i}]`);
      if (!MAINTENANCE_EVIDENCE_SOURCES.includes(source as typeof MAINTENANCE_EVIDENCE_SOURCES[number])) {
        throw validationIssue(
          `${path}.evidence[${i}].source`,
          `must be one of: ${MAINTENANCE_EVIDENCE_SOURCES.join(', ')}.`,
        );
      }
      return {
        source: source as MaintenanceEvidence['source'],
        reference: readRequiredString(entryRecord, 'reference', `${path}.evidence[${i}]`),
      };
    });
  }
  const beforeRaw = record.before;
  let before: MaintenanceBefore | undefined;
  if (beforeRaw !== undefined && beforeRaw !== null) {
    const beforeRecord = expectObject(beforeRaw, `${path}.before`);
    const labelsRaw = beforeRecord.labels;
    let labels: Array<{ type: string; value: string }> | undefined;
    if (labelsRaw !== undefined && labelsRaw !== null) {
      if (!Array.isArray(labelsRaw)) {
        throw validationIssue(`${path}.before.labels`, 'must be an array.');
      }
      labels = labelsRaw.map((entry, i) => {
        const entryRecord = expectObject(entry, `${path}.before.labels[${i}]`);
        return {
          type: readRequiredString(entryRecord, 'type', `${path}.before.labels[${i}]`),
          value: readRequiredString(entryRecord, 'value', `${path}.before.labels[${i}]`),
        };
      });
    }
    before = {
      title: readOptionalString(beforeRecord, 'title', `${path}.before`),
      summary: readOptionalString(beforeRecord, 'summary', `${path}.before`),
      status: readOptionalString(beforeRecord, 'status', `${path}.before`),
      labels,
    };
  }
  // Risk is derived from `kind` by default. Inline payloads from older callers
  // may omit it; explicit values are validated against the literal union.
  const riskRaw = record.risk;
  let risk = MAINTENANCE_RISK_DEFAULTS[kind];
  if (riskRaw !== undefined) {
    if (typeof riskRaw !== 'string' || !MAINTENANCE_RISKS.includes(riskRaw as typeof MAINTENANCE_RISKS[number])) {
      throw validationIssue(`${path}.risk`, `must be one of: ${MAINTENANCE_RISKS.join(', ')}.`);
    }
    risk = riskRaw as typeof MAINTENANCE_RISKS[number];
  }
  return {
    id: readRequiredString(record, 'id', path),
    kind,
    risk,
    reason: readOptionalString(record, 'reason', path) ?? '',
    project: readOptionalString(record, 'project', path),
    knowledgeId: readOptionalString(record, 'knowledgeId', path),
    relationId: readOptionalString(record, 'relationId', path),
    reflectionDraftId: readOptionalString(record, 'reflectionDraftId', path),
    label,
    closestKnowledgeId: readOptionalString(record, 'closestKnowledgeId', path),
    evidence,
    before,
  };
}

export function validateIngestFilesRequest(value: unknown): IngestFilesRequest {
  const record = expectObject(value, 'file ingestion input');
  const project = readRequiredString(record, 'project', 'file ingestion input');
  const filesValue = record.files;

  if (!Array.isArray(filesValue)) {
    throw validationIssue('file ingestion input.files', 'must be an array.');
  }

  return {
    project,
    files: filesValue.map((file, index) => validateIngestFileInput(file, project, `file ingestion input.files[${index}]`)),
    mode: readOptionalEnum(record, 'mode', INGESTION_MODES, 'file ingestion input'),
  };
}

export function validateContextSearchInput(value: unknown): ContextSearchInput {
  const record = expectObject(value, 'context search input');

  return {
    prompt: readRequiredString(record, 'prompt', 'context search input'),
    project: readOptionalString(record, 'project', 'context search input'),
    repoHint: readOptionalString(record, 'repoHint', 'context search input'),
    cwd: readOptionalString(record, 'cwd', 'context search input'),
    taskType: readOptionalTaskType(record, 'taskType', 'context search input'),
    files: readOptionalStringArray(record, 'files', 'context search input'),
    symbols: readOptionalStringArray(record, 'symbols', 'context search input'),
    errors: readOptionalStringArray(record, 'errors', 'context search input'),
    tokenBudget: readOptionalPositiveNumber(record, 'tokenBudget', 'context search input'),
    contextMode: readOptionalEnum(record, 'contextMode', CONTEXT_MODES, 'context search input'),
    noiseTolerance: readOptionalEnum(record, 'noiseTolerance', CONTEXT_NOISE_TOLERANCES, 'context search input'),
    deepContextBudget: readOptionalPositiveNumber(record, 'deepContextBudget', 'context search input'),
    includeDeepContext: readOptionalBoolean(record, 'includeDeepContext', 'context search input'),
    rejectedKnowledgeIds: readOptionalStringArray(record, 'rejectedKnowledgeIds', 'context search input'),
    bypassCache: readOptionalBoolean(record, 'bypassCache', 'context search input'),
    debug: readOptionalBoolean(record, 'debug', 'context search input'),
    namespace: readOptionalNamespace(record, 'namespace', 'context search input'),
  };
}

function readOptionalNamespace(
  record: Record<string, unknown>,
  key: string,
  label: string,
): ContextSearchInput['namespace'] {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  const obj = expectObject(value, `${label}.${key}`);
  const project = readOptionalString(obj, 'project', `${label}.${key}.project`);
  const kind = readOptionalString(obj, 'kind', `${label}.${key}.kind`);
  const agent = readOptionalString(obj, 'agent', `${label}.${key}.agent`);
  const namespace: ContextSearchInput['namespace'] = {};
  if (project) namespace.project = project;
  if (kind) namespace.kind = kind;
  if (agent) namespace.agent = agent;
  return Object.keys(namespace).length > 0 ? namespace : undefined;
}

export function validateStartAgentSessionInput(value: unknown): StartAgentSessionInput {
  const record = expectObject(value, 'agent session input');
  const search = validateContextSearchInput(record);

  return {
    ...search,
    agentName: readOptionalString(record, 'agentName', 'agent session input'),
    agentTool: readOptionalString(record, 'agentTool', 'agent session input'),
    metadata: readOptionalObject(record, 'metadata', 'agent session input'),
  };
}

export function validateFeedbackInput(value: unknown): FeedbackInput {
  const record = expectObject(value, 'feedback input');

  return {
    contextPackId: readOptionalString(record, 'contextPackId', 'feedback input'),
    project: readOptionalString(record, 'project', 'feedback input'),
    feedbackType: readRequiredEnum(record, 'feedbackType', FEEDBACK_TYPES, 'feedback input'),
    reason: readOptionalString(record, 'reason', 'feedback input'),
    rejectedKnowledgeIds: readOptionalStringArray(record, 'rejectedKnowledgeIds', 'feedback input'),
    metadata: readOptionalObject(record, 'metadata', 'feedback input'),
  };
}

export function validateContextQualityReportInput(value: unknown): ContextQualityReportInput {
  const record = expectObject(value, 'context quality report input');
  const limit = readOptionalPositiveInteger(record, 'limit', 'context quality report input') ?? 25;

  return {
    project: readOptionalString(record, 'project', 'context quality report input'),
    feedbackType: readOptionalEnum(
      record,
      'feedbackType',
      CONTEXT_QUALITY_FEEDBACK_TYPES,
      'context quality report input',
    ),
    limit: Math.min(limit, 100),
  };
}

export function validateRecordAgentContextDecisionInput(
  value: unknown,
  sessionId?: string,
): RecordAgentContextDecisionInput {
  const record = expectObject(value, 'agent context decision input');

  return {
    sessionId: sessionId ?? readRequiredString(record, 'sessionId', 'agent context decision input'),
    contextPackId: readOptionalString(record, 'contextPackId', 'agent context decision input'),
    feedbackType: readRequiredEnum(record, 'feedbackType', FEEDBACK_TYPES, 'agent context decision input'),
    reason: readOptionalString(record, 'reason', 'agent context decision input'),
    rejectedKnowledgeIds: readOptionalStringArray(record, 'rejectedKnowledgeIds', 'agent context decision input'),
    metadata: readOptionalObject(record, 'metadata', 'agent context decision input'),
  };
}

export function validateFinishAgentSessionInput(value: unknown, sessionId?: string): FinishAgentSessionInput {
  const record = expectObject(value, 'finish agent session input');
  const reflectionDraft = record.reflectionDraft === undefined
    ? undefined
    : validateReflectionDraftInput(record.reflectionDraft);

  return {
    sessionId: sessionId ?? readRequiredString(record, 'sessionId', 'finish agent session input'),
    outcome: readRequiredEnum(record, 'outcome', AGENT_SESSION_OUTCOMES, 'finish agent session input'),
    summary: readOptionalString(record, 'summary', 'finish agent session input'),
    agentOutputSummary: readOptionalString(record, 'agentOutputSummary', 'finish agent session input'),
    changedFiles: readOptionalStringArray(record, 'changedFiles', 'finish agent session input'),
    verificationCommands: readOptionalStringArray(record, 'verificationCommands', 'finish agent session input'),
    learningSignals: readOptionalLearningSignals(record.learningSignals, 'finish agent session input.learningSignals'),
    contextBypassReason: readOptionalString(record, 'contextBypassReason', 'finish agent session input'),
    learningMode: readOptionalEnum(record, 'learningMode', AGENT_LEARNING_MODES, 'finish agent session input'),
    metadata: readOptionalObject(record, 'metadata', 'finish agent session input'),
    researchTrace: readOptionalResearchTrace(record.researchTrace, 'finish agent session input.researchTrace'),
    reflectionDraft,
  };
}

export function validateCaptureAgentLearningSignalInput(
  value: unknown,
  sessionId?: string,
): CaptureAgentLearningSignalInput {
  const record = expectObject(value, 'agent learning signal input');
  const signal = readLearningSignal(record, 'agent learning signal input');

  return {
    ...signal,
    sessionId: sessionId ?? readRequiredString(record, 'sessionId', 'agent learning signal input'),
    author: readOptionalString(record, 'author', 'agent learning signal input'),
    contextPackId: readOptionalString(record, 'contextPackId', 'agent learning signal input'),
  };
}

export function validateReflectionDraftInput(value: unknown): ReflectionDraftInput {
  const record = expectObject(value, 'reflection draft input');

  return {
    project: readOptionalString(record, 'project', 'reflection draft input'),
    title: readRequiredString(record, 'title', 'reflection draft input'),
    summary: readRequiredString(record, 'summary', 'reflection draft input'),
    content: readRequiredString(record, 'content', 'reflection draft input'),
    itemType: readOptionalEnum(record, 'itemType', KNOWLEDGE_ITEM_TYPES, 'reflection draft input'),
    triggerType: readRequiredEnum(record, 'triggerType', TRIGGER_TYPES, 'reflection draft input'),
    labels: readOptionalLabels(record.labels, 'reflection draft input.labels'),
    references: readOptionalReferences(record.references, 'reflection draft input.references'),
    metadata: readOptionalObject(record, 'metadata', 'reflection draft input'),
  };
}

export function validateReflectionDraftPatchInput(value: unknown): ReflectionDraftPatchInput {
  const record = expectObject(value, 'reflection draft patch input');

  return {
    status: readOptionalEnum(record, 'status', REFLECTION_DRAFT_STATUSES, 'reflection draft patch input'),
    metadata: readOptionalObject(record, 'metadata', 'reflection draft patch input'),
    suggestedLabels: readOptionalLabels(record.suggestedLabels, 'reflection draft patch input.suggestedLabels'),
    references: readOptionalReferences(record.references, 'reflection draft patch input.references'),
  };
}

export function validateAppendAgentSessionNoteInput(
  value: unknown,
  sessionId?: string,
): AppendAgentSessionNoteInput {
  const record = expectObject(value, 'agent session note input');
  return {
    sessionId: sessionId ?? readRequiredString(record, 'sessionId', 'agent session note input'),
    note: readRequiredString(record, 'note', 'agent session note input'),
    author: readOptionalString(record, 'author', 'agent session note input'),
    feedbackType: readOptionalEnum(record, 'feedbackType', FEEDBACK_TYPES, 'agent session note input'),
    contextPackId: readOptionalString(record, 'contextPackId', 'agent session note input'),
    reason: readOptionalString(record, 'reason', 'agent session note input'),
    rejectedKnowledgeIds: readOptionalStringArray(record, 'rejectedKnowledgeIds', 'agent session note input'),
    metadata: readOptionalObject(record, 'metadata', 'agent session note input'),
  };
}

export function validateReflectionDraftIdArguments(value: unknown): { id: string } {
  const record = expectObject(value, 'reflection draft arguments');
  return {
    id: readRequiredStringWithAliases(record, ['id', 'reflectionDraftId'], 'reflection draft arguments'),
  };
}

export function validateReflectionDraftListInput(value: unknown): {
  project?: string;
  status?: ReflectionDraftStatus;
  limit: number;
} {
  const record = expectObject(value, 'reflection draft list input');
  const limit = readOptionalPositiveInteger(record, 'limit', 'reflection draft list input') ?? 25;

  return {
    project: readOptionalString(record, 'project', 'reflection draft list input'),
    status: readOptionalEnum(record, 'status', REFLECTION_DRAFT_STATUSES, 'reflection draft list input') ?? 'pending',
    limit: Math.min(limit, 100),
  };
}

export function validateReflectionDraftReviewInput(value: unknown): ReflectionDraftReviewInput {
  const record = expectObject(value, 'reflection draft review input');
  const evaluation = readOptionalReviewEvaluation(record.evaluation);

  return {
    id: readRequiredStringWithAliases(record, ['id', 'reflectionDraftId'], 'reflection draft review input'),
    decision: readRequiredEnum(record, 'decision', REFLECTION_REVIEW_DECISIONS, 'reflection draft review input'),
    reviewer: readOptionalString(record, 'reviewer', 'reflection draft review input'),
    reviewerNote: readOptionalString(record, 'reviewerNote', 'reflection draft review input'),
    evaluation,
    metadata: readOptionalObject(record, 'metadata', 'reflection draft review input'),
  };
}

export function validateCleanupOperationsInput(value: unknown): CleanupOperationsInput {
  const record = expectObject(value, 'cleanup input');

  return {
    olderThanDays: readOptionalPositiveInteger(record, 'olderThanDays', 'cleanup input'),
    dryRun: readOptionalBoolean(record, 'dryRun', 'cleanup input'),
  };
}

export function validateCreateBackupInput(value: unknown): CreateBackupInput {
  const record = expectObject(value, 'backup input');

  return {
    id: readOptionalString(record, 'id', 'backup input'),
    reason: readOptionalString(record, 'reason', 'backup input'),
    prune: readOptionalBoolean(record, 'prune', 'backup input'),
  };
}

export function validateBackupRetentionInput(value: unknown): BackupRetentionInput {
  const record = expectObject(value, 'backup retention input');

  return {
    dryRun: readOptionalBoolean(record, 'dryRun', 'backup retention input'),
    keepCount: readOptionalPositiveInteger(record, 'keepCount', 'backup retention input'),
    maxAgeDays: readOptionalPositiveInteger(record, 'maxAgeDays', 'backup retention input'),
  };
}

export function validateRestoreBackupInput(value: unknown, backupIdOrPath?: string): RestoreBackupInput {
  const record = expectObject(value, 'restore backup input');

  return {
    backupIdOrPath: backupIdOrPath ?? readOptionalString(record, 'backupIdOrPath', 'restore backup input'),
    dryRun: readOptionalBoolean(record, 'dryRun', 'restore backup input'),
    replace: readOptionalBoolean(record, 'replace', 'restore backup input'),
  };
}

export function validateErrorLogInput(value: unknown): ErrorLogInput {
  const record = expectObject(value, 'error log input');

  return {
    project: readOptionalString(record, 'project', 'error log input'),
    category: readOptionalEnum(record, 'category', ERROR_LOG_CATEGORIES, 'error log input'),
    severity: readOptionalEnum(record, 'severity', ERROR_LOG_SEVERITIES, 'error log input'),
    status: readOptionalEnum(record, 'status', ERROR_LOG_STATUSES, 'error log input'),
    title: readRequiredString(record, 'title', 'error log input'),
    summary: readOptionalString(record, 'summary', 'error log input'),
    message: readOptionalString(record, 'message', 'error log input'),
    stack: readOptionalString(record, 'stack', 'error log input'),
    toolName: readOptionalString(record, 'toolName', 'error log input'),
    operation: readOptionalString(record, 'operation', 'error log input'),
    command: readOptionalString(record, 'command', 'error log input'),
    cwd: readOptionalString(record, 'cwd', 'error log input'),
    files: readOptionalStringArray(record, 'files', 'error log input'),
    symbols: readOptionalStringArray(record, 'symbols', 'error log input'),
    errors: readOptionalStringArray(record, 'errors', 'error log input'),
    tags: readOptionalStringArray(record, 'tags', 'error log input'),
    agentName: readOptionalString(record, 'agentName', 'error log input'),
    agentTool: readOptionalString(record, 'agentTool', 'error log input'),
    sessionId: readOptionalString(record, 'sessionId', 'error log input'),
    contextPackId: readOptionalString(record, 'contextPackId', 'error log input'),
    reflectionDraftId: readOptionalString(record, 'reflectionDraftId', 'error log input'),
    references: readOptionalReferences(record.references, 'error log input.references'),
    metadata: readOptionalObject(record, 'metadata', 'error log input'),
    fingerprint: readOptionalString(record, 'fingerprint', 'error log input'),
  };
}

export function validateErrorLogPatchInput(value: unknown): ErrorLogPatchInput {
  const record = expectObject(value, 'error log patch input');

  return {
    status: readOptionalEnum(record, 'status', ERROR_LOG_STATUSES, 'error log patch input'),
    category: readOptionalEnum(record, 'category', ERROR_LOG_CATEGORIES, 'error log patch input'),
    severity: readOptionalEnum(record, 'severity', ERROR_LOG_SEVERITIES, 'error log patch input'),
    summary: readOptionalString(record, 'summary', 'error log patch input'),
    notes: readOptionalString(record, 'notes', 'error log patch input'),
    tags: readOptionalStringArray(record, 'tags', 'error log patch input'),
    references: readOptionalReferences(record.references, 'error log patch input.references'),
    reflectionDraftId: readOptionalNullableString(record, 'reflectionDraftId', 'error log patch input'),
    metadata: readOptionalObject(record, 'metadata', 'error log patch input'),
  };
}

export function validateErrorLogListInput(value: unknown): {
  project?: string;
  category?: ErrorLogCategory;
  severity?: ErrorLogSeverity;
  status?: ErrorLogStatus;
  query?: string;
  tag?: string;
  limit: number;
} {
  const record = expectObject(value, 'error log list input');
  const limit = readOptionalPositiveInteger(record, 'limit', 'error log list input') ?? 25;

  return {
    project: readOptionalString(record, 'project', 'error log list input'),
    category: readOptionalEnum(record, 'category', ERROR_LOG_CATEGORIES, 'error log list input'),
    severity: readOptionalEnum(record, 'severity', ERROR_LOG_SEVERITIES, 'error log list input'),
    status: readOptionalEnum(record, 'status', ERROR_LOG_STATUSES, 'error log list input'),
    query: readOptionalString(record, 'query', 'error log list input'),
    tag: readOptionalString(record, 'tag', 'error log list input'),
    limit: Math.min(limit, 100),
  };
}

export function validateCollectErrorLogsInput(value: unknown): CollectErrorLogsOptions {
  const record = expectObject(value, 'error log collection input');
  const limit = readOptionalPositiveInteger(record, 'limit', 'error log collection input') ?? 250;
  const offset = readOptionalNonNegativeInteger(record, 'offset', 'error log collection input') ?? 0;

  return {
    project: readOptionalString(record, 'project', 'error log collection input'),
    categories: readOptionalEnumArray(record.categories, ERROR_LOG_CATEGORIES, 'error log collection input.categories'),
    severities: readOptionalEnumArray(record.severities, ERROR_LOG_SEVERITIES, 'error log collection input.severities'),
    statuses: readOptionalEnumArray(record.statuses, ERROR_LOG_STATUSES, 'error log collection input.statuses'),
    query: readOptionalString(record, 'query', 'error log collection input'),
    tag: readOptionalString(record, 'tag', 'error log collection input'),
    since: readOptionalIsoDate(record, 'since', 'error log collection input'),
    until: readOptionalIsoDate(record, 'until', 'error log collection input'),
    limit: Math.min(limit, 500),
    offset,
  };
}

export function validateCreateErrorLogReflectionDraftInput(value: unknown): CreateErrorLogReflectionDraftInput {
  const record = expectObject(value, 'error log reflection draft input');
  const errorLogIds = readRequiredStringArray(record, 'errorLogIds', 'error log reflection draft input');

  if (errorLogIds.length === 0) {
    throw validationIssue('error log reflection draft input.errorLogIds', 'must include at least one id.');
  }

  return {
    errorLogIds,
    project: readOptionalString(record, 'project', 'error log reflection draft input'),
    title: readOptionalString(record, 'title', 'error log reflection draft input'),
    summary: readOptionalString(record, 'summary', 'error log reflection draft input'),
    content: readOptionalString(record, 'content', 'error log reflection draft input'),
    linkLogs: readOptionalBoolean(record, 'linkLogs', 'error log reflection draft input'),
    metadata: readOptionalObject(record, 'metadata', 'error log reflection draft input'),
  };
}

export function validateResolveErrorLogInput(value: unknown, id?: string): ResolveErrorLogInput {
  const record = expectObject(value, 'error log resolution input');
  const status = readOptionalEnum(record, 'status', ['fixed', 'wont_fix'], 'error log resolution input');

  return {
    id: id ?? readRequiredStringWithAliases(record, ['id', 'errorLogId'], 'error log resolution input'),
    status,
    rootCause: readRequiredString(record, 'rootCause', 'error log resolution input'),
    resolutionSummary: readRequiredString(record, 'resolutionSummary', 'error log resolution input'),
    changedFiles: readOptionalStringArray(record, 'changedFiles', 'error log resolution input'),
    verificationCommands: readOptionalStringArray(record, 'verificationCommands', 'error log resolution input'),
    reflectionDraftId: readOptionalString(record, 'reflectionDraftId', 'error log resolution input'),
    notes: readOptionalString(record, 'notes', 'error log resolution input'),
    metadata: readOptionalObject(record, 'metadata', 'error log resolution input'),
  };
}

export function validateErrorLogIdArguments(value: unknown): { id: string } {
  const record = expectObject(value, 'error log arguments');
  return {
    id: readRequiredStringWithAliases(record, ['id', 'errorLogId'], 'error log arguments'),
  };
}

export function validateKnowledgeReviewFilter(value: string | null): KnowledgeReviewFilter | undefined {
  if (value === null) {
    return undefined;
  }

  if (!KNOWLEDGE_REVIEW_FILTERS.includes(value as KnowledgeReviewFilter)) {
    throw validationIssue('query.review', `must be one of: ${KNOWLEDGE_REVIEW_FILTERS.join(', ')}.`);
  }

  return value as KnowledgeReviewFilter;
}

export function validateKnowledgeStatusQuery(value: string | null): KnowledgeStatus | undefined {
  if (value === null) {
    return undefined;
  }

  if (!KNOWLEDGE_STATUSES.includes(value as KnowledgeStatus)) {
    throw validationIssue('query.status', `must be one of: ${KNOWLEDGE_STATUSES.join(', ')}.`);
  }

  return value as KnowledgeStatus;
}

export function validateLearningReviewStatusQuery(value: string | null): LearningReviewStatus | undefined {
  if (value === null) {
    return undefined;
  }

  if (!LEARNING_REVIEW_STATUSES.includes(value as LearningReviewStatus)) {
    throw validationIssue('query.status', `must be one of: ${LEARNING_REVIEW_STATUSES.join(', ')}.`);
  }

  return value as LearningReviewStatus;
}

export function validateLearningProposalTypeQuery(value: string | null): LearningProposalType | undefined {
  if (value === null) {
    return undefined;
  }

  if (!LEARNING_PROPOSAL_TYPES.includes(value as LearningProposalType)) {
    throw validationIssue('query.proposalType', `must be one of: ${LEARNING_PROPOSAL_TYPES.join(', ')}.`);
  }

  return value as LearningProposalType;
}

export function validateContextPackIdArguments(value: unknown): { contextPackId: string } {
  const record = expectObject(value, 'context pack arguments');
  return {
    contextPackId: readRequiredStringWithAliases(record, ['contextPackId', 'id'], 'context pack arguments'),
  };
}

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  return expectObject(value, path);
}

function validateIngestFileInput(value: unknown, defaultProject: string, path: string): IngestFileInput {
  const record = expectObject(value, path);

  return {
    project: readOptionalString(record, 'project', path) ?? defaultProject,
    path: readRequiredString(record, 'path', path),
    content: readRequiredString(record, 'content', path),
    itemType: readOptionalEnum(record, 'itemType', KNOWLEDGE_ITEM_TYPES, path),
    mode: readOptionalEnum(record, 'mode', INGESTION_MODES, path),
    labels: readOptionalLabels(record.labels, `${path}.labels`),
    metadata: readOptionalObject(record, 'metadata', path),
  };
}

function readOptionalLearningSignals(value: unknown, path: string): AgentLearningSignal[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw validationIssue(path, 'must be an array.');
  }

  return value.map((signal, index) => readLearningSignal(expectObject(signal, `${path}[${index}]`), `${path}[${index}]`));
}

function readOptionalResearchTrace(value: unknown, path: string): ResearchTraceInput | undefined {
  if (value === undefined) {
    return undefined;
  }

  const record = expectObject(value, path);
  const outcome = readRequiredString(record, 'outcome', path);
  if (outcome.length > MAX_RESEARCH_TRACE_OUTCOME) {
    throw validationIssue(`${path}.outcome`, `must be ${MAX_RESEARCH_TRACE_OUTCOME} characters or fewer.`);
  }

  const rawSteps = record.steps;
  if (!Array.isArray(rawSteps)) {
    throw validationIssue(`${path}.steps`, 'must be an array.');
  }
  if (rawSteps.length > MAX_RESEARCH_TRACE_STEPS) {
    throw validationIssue(`${path}.steps`, `must contain ${MAX_RESEARCH_TRACE_STEPS} or fewer steps.`);
  }

  return {
    outcome,
    steps: rawSteps.map((step, index) => readResearchTraceStep(step, `${path}.steps[${index}]`)),
  };
}

function readResearchTraceStep(value: unknown, path: string): ResearchTraceStep {
  const record = expectObject(value, path);
  const text = readRequiredString(record, 'text', path);
  if (text.length > MAX_RESEARCH_TRACE_STEP_TEXT) {
    throw validationIssue(`${path}.text`, `must be ${MAX_RESEARCH_TRACE_STEP_TEXT} characters or fewer.`);
  }

  return {
    kind: readRequiredEnum(record, 'kind', ['thought', 'action', 'observation', 'decision'], path),
    text,
    references: readOptionalResearchTraceReferences(record.references, `${path}.references`),
  };
}

function readOptionalResearchTraceReferences(value: unknown, path: string): ResearchTraceReference[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw validationIssue(path, 'must be an array.');
  }

  return value.map((reference, index) => {
    const itemPath = `${path}[${index}]`;
    const record = expectObject(reference, itemPath);
    const parsed: ResearchTraceReference = {
      file: readOptionalString(record, 'file', itemPath),
      symbol: readOptionalString(record, 'symbol', itemPath),
      command: readOptionalString(record, 'command', itemPath),
      knowledgeId: readOptionalString(record, 'knowledgeId', itemPath),
    };
    if (!parsed.file && !parsed.symbol && !parsed.command && !parsed.knowledgeId) {
      throw validationIssue(itemPath, 'must include file, symbol, command, or knowledgeId.');
    }
    return parsed;
  });
}

function readLearningSignal(record: Record<string, unknown>, path: string): AgentLearningSignal {
  return {
    kind: readRequiredEnum(record, 'kind', AGENT_LEARNING_SIGNAL_KINDS, path),
    text: readRequiredString(record, 'text', path),
    source: readOptionalEnum(record, 'source', AGENT_LEARNING_SIGNAL_SOURCES, path),
    files: readOptionalStringArray(record, 'files', path),
    symbols: readOptionalStringArray(record, 'symbols', path),
    errors: readOptionalStringArray(record, 'errors', path),
    references: readOptionalReferences(record.references, `${path}.references`),
    confidence: readOptionalSignalConfidence(record, 'confidence', path),
    metadata: readOptionalObject(record, 'metadata', path),
  };
}

function readOptionalLabels(value: unknown, path: string): LabelInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw validationIssue(path, 'must be an array.');
  }

  return value.map((label, index) => {
    const record = expectObject(label, `${path}[${index}]`);
    return {
      type: readRequiredEnum(record, 'type', LABEL_TYPES, `${path}[${index}]`),
      value: readRequiredString(record, 'value', `${path}[${index}]`),
      weight: readOptionalNumber(record, 'weight', `${path}[${index}]`),
    };
  });
}

function readOptionalReferences(value: unknown, path: string): ReferenceInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw validationIssue(path, 'must be an array.');
  }

  return value.map((reference, index) => {
    const itemPath = `${path}[${index}]`;
    const record = expectObject(reference, itemPath);
    const lineStart = readOptionalPositiveInteger(record, 'lineStart', itemPath);
    const lineEnd = readOptionalPositiveInteger(record, 'lineEnd', itemPath);

    if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
      throw validationIssue(`${itemPath}.lineEnd`, 'must be greater than or equal to lineStart.');
    }

    return {
      type: readRequiredEnum(record, 'type', REFERENCE_TYPES, itemPath),
      uri: readRequiredString(record, 'uri', itemPath),
      lineStart,
      lineEnd,
      commitSha: readOptionalString(record, 'commitSha', itemPath),
      metadata: readOptionalObject(record, 'metadata', itemPath),
    };
  });
}

function readOptionalReviewEvaluation(value: unknown): ReflectionDraftReviewInput['evaluation'] {
  if (value === undefined) {
    return undefined;
  }

  const record = expectObject(value, 'reflection draft review input.evaluation');
  return compactObject({
    accuracy: readOptionalEnum(record, 'accuracy', REFLECTION_REVIEW_GRADES, 'reflection draft review input.evaluation'),
    usefulness: readOptionalEnum(record, 'usefulness', REFLECTION_REVIEW_GRADES, 'reflection draft review input.evaluation'),
    scope: readOptionalEnum(record, 'scope', REFLECTION_REVIEW_GRADES, 'reflection draft review input.evaluation'),
    privacySafety: readOptionalEnum(
      record,
      'privacySafety',
      REFLECTION_REVIEW_GRADES,
      'reflection draft review input.evaluation',
    ),
    labels: readOptionalEnum(record, 'labels', REFLECTION_REVIEW_GRADES, 'reflection draft review input.evaluation'),
    references: readOptionalEnum(record, 'references', REFLECTION_REVIEW_GRADES, 'reflection draft review input.evaluation'),
    duplicateRisk: readOptionalEnum(
      record,
      'duplicateRisk',
      REFLECTION_DUPLICATE_RISKS,
      'reflection draft review input.evaluation',
    ),
  }) as ReflectionDraftReviewInput['evaluation'];
}

// Per-field hard caps to prevent DoS via giant inputs (ReDoS / OOM) at the MCP & HTTP boundary.
// Generous for legitimate use (reflection content, embeddings prompts) but bounded.
const MAX_STRING_LENGTH = 2_000_000; // 2M chars (~4 MB UTF-16)
const MAX_STRING_ARRAY_LENGTH = 4096;

function enforceStringLength(value: string, path: string): string {
  if (value.length > MAX_STRING_LENGTH) {
    throw validationIssue(path, `must be ${MAX_STRING_LENGTH} characters or fewer.`);
  }
  return value;
}

function readRequiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationIssue(`${path}.${key}`, 'must be a non-empty string.');
  }

  return enforceStringLength(value, `${path}.${key}`);
}

function readRequiredStringWithAliases(record: Record<string, unknown>, keys: string[], path: string): string {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return readRequiredString(record, key, path);
    }
  }

  throw validationIssue(`${path}.${keys[0]}`, 'must be a non-empty string.');
}

function readOptionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationIssue(`${path}.${key}`, 'must be a non-empty string when provided.');
  }

  return enforceStringLength(value, `${path}.${key}`);
}

function readOptionalNullableString(record: Record<string, unknown>, key: string, path: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationIssue(`${path}.${key}`, 'must be a non-empty string or null when provided.');
  }

  return enforceStringLength(value, `${path}.${key}`);
}

function readOptionalStringArray(record: Record<string, unknown>, key: string, path: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw validationIssue(`${path}.${key}`, 'must be an array.');
  }

  if (value.length > MAX_STRING_ARRAY_LENGTH) {
    throw validationIssue(`${path}.${key}`, `must contain ${MAX_STRING_ARRAY_LENGTH} or fewer entries.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw validationIssue(`${path}.${key}[${index}]`, 'must be a non-empty string.');
    }

    return enforceStringLength(entry, `${path}.${key}[${index}]`);
  });
}

function readRequiredStringArray(record: Record<string, unknown>, key: string, path: string): string[] {
  const values = readOptionalStringArray(record, key, path);
  if (!values) {
    throw validationIssue(`${path}.${key}`, 'must be an array.');
  }
  return values;
}

function readOptionalNumber(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validationIssue(`${path}.${key}`, 'must be a finite number.');
  }

  return value;
}

function readOptionalPositiveNumber(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = readOptionalNumber(record, key, path);
  if (value !== undefined && value <= 0) {
    throw validationIssue(`${path}.${key}`, 'must be greater than 0.');
  }

  return value;
}

function readOptionalRelationConfidence(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = readOptionalNumber(record, key, path);
  if (value !== undefined && (value < 0 || value > 1)) {
    throw validationIssue(`${path}.${key}`, 'must be between 0 and 1.');
  }

  return value;
}

function readOptionalSignalConfidence(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = readOptionalNumber(record, key, path);
  if (value !== undefined && (value < 0 || value > 1)) {
    throw validationIssue(`${path}.${key}`, 'must be between 0 and 1.');
  }

  return value;
}

function readOptionalPositiveInteger(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = readOptionalNumber(record, key, path);
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw validationIssue(`${path}.${key}`, 'must be a positive integer.');
  }

  return value;
}

function readOptionalNonNegativeInteger(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = readOptionalNumber(record, key, path);
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw validationIssue(`${path}.${key}`, 'must be a non-negative integer.');
  }

  return value;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw validationIssue(`${path}.${key}`, 'must be a boolean.');
  }

  return value;
}

function readRequiredEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
): T {
  const value = record[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw validationIssue(`${path}.${key}`, `must be one of: ${allowed.join(', ')}.`);
  }

  return value as T;
}

function readOptionalEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
): T | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw validationIssue(`${path}.${key}`, `must be one of: ${allowed.join(', ')}.`);
  }

  return value as T;
}

function readOptionalTaskType(
  record: Record<string, unknown>,
  key: string,
  path: string,
): TaskType | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw validationIssue(`${path}.${key}`, `must be one of: ${TASK_TYPES.join(', ')}.`);
  }

  const normalized = taskTypeToken(value);
  if (TASK_TYPES.includes(normalized as TaskType)) {
    return normalized as TaskType;
  }

  const alias = TASK_TYPE_ALIASES.get(normalized);
  if (alias) {
    return alias;
  }

  throw validationIssue(`${path}.${key}`, `must be one of: ${TASK_TYPES.join(', ')}.`);
}

function taskTypeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function readOptionalEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw validationIssue(path, 'must be an array.');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !allowed.includes(entry as T)) {
      throw validationIssue(`${path}[${index}]`, `must be one of: ${allowed.join(', ')}.`);
    }
    return entry as T;
  });
}

function readOptionalIsoDate(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = readOptionalString(record, key, path);
  if (value === undefined) {
    return undefined;
  }

  if (Number.isNaN(Date.parse(value))) {
    throw validationIssue(`${path}.${key}`, 'must be an ISO date string.');
  }

  return value;
}

function readOptionalObject(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  return expectObject(value, `${path}.${key}`);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationIssue(path, 'must be an object.');
  }

  return value as Record<string, unknown>;
}

function compactObject(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function ensureRelationTarget(targetKnowledgeId: string | undefined, targetValue: string | undefined, path: string): void {
  if (!targetKnowledgeId && !targetValue) {
    throw validationIssue(`${path}.targetValue`, 'must be provided when targetKnowledgeId is not provided.');
  }
}

function validationIssue(path: string, message: string): ValidationError {
  const issue: ValidationIssue = { path, message: `${path} ${message}` };
  return new ValidationError(issue.message, [issue]);
}
