import type { IngestFileInput, IngestionMode } from './ingest/service.js';
import type {
  AgentSessionOutcome,
  FinishAgentSessionInput,
  ContextSearchInput,
  FeedbackInput,
  KnowledgeInput,
  KnowledgeItemType,
  LabelInput,
  LabelType,
  RecordAgentContextDecisionInput,
  ReferenceInput,
  ReflectionDraftInput,
  StartAgentSessionInput,
  TaskType,
  TriggerType,
} from './types.js';
import { ValidationError } from './errors.js';

export interface IngestFilesRequest {
  project: string;
  files: IngestFileInput[];
  mode?: IngestionMode;
}

interface ValidationIssue {
  path: string;
  message: string;
}

const KNOWLEDGE_ITEM_TYPES = [
  'spec',
  'workflow',
  'memory',
  'bugfix',
  'code_ref',
  'rule',
  'wiki',
  'conversation',
] as const satisfies readonly KnowledgeItemType[];

const TRIGGER_TYPES = [
  'complex_task_success',
  'error_recovery',
  'user_correction',
  'non_trivial_workflow',
  'manual',
] as const satisfies readonly TriggerType[];

const TASK_TYPES = [
  'debugging',
  'implementation',
  'refactor',
  'review',
  'planning',
  'exploration',
  'testing',
  'unknown',
] as const satisfies readonly TaskType[];

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
const INGESTION_MODES = ['document', 'atomic'] as const satisfies readonly IngestionMode[];
const FEEDBACK_TYPES = ['selected', 'rejected', 'irrelevant', 'stale', 'missing_context'] as const;
const AGENT_SESSION_OUTCOMES = ['completed', 'failed', 'blocked', 'cancelled'] as const satisfies readonly AgentSessionOutcome[];

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
    taskType: readOptionalEnum(record, 'taskType', TASK_TYPES, 'context search input'),
    files: readOptionalStringArray(record, 'files', 'context search input'),
    symbols: readOptionalStringArray(record, 'symbols', 'context search input'),
    errors: readOptionalStringArray(record, 'errors', 'context search input'),
    tokenBudget: readOptionalPositiveNumber(record, 'tokenBudget', 'context search input'),
    rejectedKnowledgeIds: readOptionalStringArray(record, 'rejectedKnowledgeIds', 'context search input'),
    bypassCache: readOptionalBoolean(record, 'bypassCache', 'context search input'),
    debug: readOptionalBoolean(record, 'debug', 'context search input'),
  };
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
    metadata: readOptionalObject(record, 'metadata', 'finish agent session input'),
    reflectionDraft,
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
    metadata: readOptionalObject(record, 'metadata', 'reflection draft input'),
  };
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

function readRequiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationIssue(`${path}.${key}`, 'must be a non-empty string.');
  }

  return value;
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

  return value;
}

function readOptionalStringArray(record: Record<string, unknown>, key: string, path: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw validationIssue(`${path}.${key}`, 'must be an array.');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw validationIssue(`${path}.${key}[${index}]`, 'must be a non-empty string.');
    }

    return entry;
  });
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

function readOptionalPositiveInteger(record: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = readOptionalNumber(record, key, path);
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw validationIssue(`${path}.${key}`, 'must be a positive integer.');
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

function validationIssue(path: string, message: string): ValidationError {
  const issue: ValidationIssue = { path, message: `${path} ${message}` };
  return new ValidationError(issue.message, [issue]);
}
