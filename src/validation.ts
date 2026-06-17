import type { IngestFileInput, IngestionMode } from './ingest/service.js';
import type { ExtractedAtomCandidate } from './model/provider.js';
import type {
  AppendAgentSessionNoteInput,
  BackupRetentionInput,
  CollectErrorLogsOptions,
  CaptureAgentLearningSignalInput,
  CreateBackupInput,
  CreateErrorLogReflectionDraftInput,
  FinishAgentSessionInput,
  ContextSearchInput,
  ContextQualityReportInput,
  FeedbackInput,
  CleanupOperationsInput,
  ErrorLogCategory,
  ErrorLogInput,
  ErrorLogPatchInput,
  ErrorLogSeverity,
  ErrorLogStatus,
  KnowledgeConflictPatchInput,
  KnowledgeGapPatchInput,
  KnowledgePatchInput,
  LearningProposalPatchInput,
  LearningProposalType,
  LearningReviewStatus,
  MaintenanceApplyInput,
  MaintenanceProposeInput,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  KnowledgeReviewFilter,
  KnowledgeStatus,
  KnowledgeInput,
  RecordAgentContextDecisionInput,
  ReflectionDraftInput,
  ReflectionDraftPatchInput,
  ReflectionDraftReviewInput,
  ReflectionDraftStatus,
  ResolveErrorLogInput,
  RestoreBackupInput,
  StartAgentSessionInput,
} from './types.js';
import { ValidationError } from './errors.js';
import {
  contextSearchSchema,
  feedbackSchema,
  contextQualityReportSchema,
  contextPackIdArgumentsSchema,
} from './schemas/context.js';
import { parseOrThrow } from './schemas/primitives.js';
export {
  TASK_TYPES,
  CONTEXT_MODES,
  CONTEXT_NOISE_TOLERANCES,
  KNOWLEDGE_ITEM_TYPES,
  TRIGGER_TYPES,
  FEEDBACK_TYPES,
  CONTEXT_QUALITY_FEEDBACK_TYPES,
  AGENT_SESSION_OUTCOMES,
  AGENT_LEARNING_MODES,
  REFLECTION_DRAFT_STATUSES,
  AGENT_LEARNING_SIGNAL_KINDS,
  MAINTENANCE_ITEM_KINDS,
} from './schemas/enums.js';
import {
  KNOWLEDGE_REVIEW_FILTERS,
  KNOWLEDGE_STATUSES,
  LEARNING_REVIEW_STATUSES,
  LEARNING_PROPOSAL_TYPES,
} from './schemas/enums.js';
import {
  knowledgeSchema,
  knowledgePatchSchema,
  knowledgeRelationSchema,
  knowledgeRelationPatchSchema,
  knowledgeConflictPatchSchema,
  knowledgeGapPatchSchema,
  learningProposalPatchSchema,
} from './schemas/knowledge.js';
import { ingestFilesSchema } from './schemas/ingest.js';
import {
  startAgentSessionSchema,
  recordContextDecisionSchema,
  finishAgentSessionSchema,
  captureLearningSignalSchema,
  appendSessionNoteSchema,
} from './schemas/agent-session.js';
import {
  reflectionDraftSchema,
  reflectionDraftPatchSchema,
  reflectionDraftIdArgumentsSchema,
  reflectionDraftListSchema,
  reflectionDraftReviewSchema,
} from './schemas/reflection.js';
import {
  errorLogSchema,
  errorLogPatchSchema,
  errorLogListSchema,
  collectErrorLogsSchema,
  createErrorLogReflectionDraftSchema,
  resolveErrorLogSchema,
  errorLogIdArgumentsSchema,
} from './schemas/error-log.js';
import {
  maintenanceProposeSchema,
  maintenanceApplySchema,
} from './schemas/maintenance.js';
import {
  cleanupOperationsSchema,
  createBackupSchema,
  backupRetentionSchema,
  restoreBackupSchema,
} from './schemas/backup.js';

export interface IngestFilesRequest {
  project: string;
  files: IngestFileInput[];
  mode?: IngestionMode;
}

export function validateKnowledgeInput(value: unknown): KnowledgeInput {
  return parseOrThrow(knowledgeSchema, value, 'knowledge input');
}

export function validateKnowledgePatchInput(value: unknown): KnowledgePatchInput {
  return parseOrThrow(knowledgePatchSchema, value, 'knowledge patch input');
}

export function validateKnowledgeRelationInput(value: unknown): KnowledgeRelationInput {
  return parseOrThrow(knowledgeRelationSchema, value, 'knowledge relation input');
}

export function validateKnowledgeRelationPatchInput(value: unknown): KnowledgeRelationPatchInput {
  return parseOrThrow(knowledgeRelationPatchSchema, value, 'knowledge relation patch input');
}

export function validateKnowledgeConflictPatchInput(value: unknown): KnowledgeConflictPatchInput {
  return parseOrThrow(knowledgeConflictPatchSchema, value, 'knowledge conflict patch input');
}

export function validateKnowledgeGapPatchInput(value: unknown): KnowledgeGapPatchInput {
  return parseOrThrow(knowledgeGapPatchSchema, value, 'knowledge gap patch input');
}

export function validateLearningProposalPatchInput(value: unknown): LearningProposalPatchInput {
  return parseOrThrow(learningProposalPatchSchema, value, 'learning proposal patch input');
}

export function validateMaintenanceProposeInput(value: unknown): MaintenanceProposeInput {
  return parseOrThrow(maintenanceProposeSchema, value, 'maintenance propose input');
}

export function validateMaintenanceApplyInput(value: unknown): MaintenanceApplyInput {
  return parseOrThrow(maintenanceApplySchema, value, 'maintenance apply input');
}

export function validateIngestFilesRequest(value: unknown): IngestFilesRequest {
  return parseOrThrow(ingestFilesSchema, value, 'file ingestion input') as IngestFilesRequest;
}

export function validateContextSearchInput(value: unknown): ContextSearchInput {
  return parseOrThrow(contextSearchSchema, value, 'context search input') as ContextSearchInput;
}

export function validateStartAgentSessionInput(value: unknown): StartAgentSessionInput {
  return parseOrThrow(startAgentSessionSchema, value, 'agent session input') as StartAgentSessionInput;
}

export function validateFeedbackInput(value: unknown): FeedbackInput {
  return parseOrThrow(feedbackSchema, value, 'feedback input');
}

export function validateContextQualityReportInput(value: unknown): ContextQualityReportInput {
  return parseOrThrow(contextQualityReportSchema, value, 'context quality report input');
}

export function validateRecordAgentContextDecisionInput(
  value: unknown,
  sessionId?: string,
): RecordAgentContextDecisionInput {
  const parsed = parseOrThrow(
    recordContextDecisionSchema,
    withSessionId(value, sessionId),
    'agent context decision input',
  ) as RecordAgentContextDecisionInput;
  return sessionId ? { ...parsed, sessionId } : parsed;
}

export function validateFinishAgentSessionInput(value: unknown, sessionId?: string): FinishAgentSessionInput {
  const parsed = parseOrThrow(
    finishAgentSessionSchema,
    withSessionId(value, sessionId),
    'finish agent session input',
  ) as FinishAgentSessionInput;
  return sessionId ? { ...parsed, sessionId } : parsed;
}

export function validateCaptureAgentLearningSignalInput(
  value: unknown,
  sessionId?: string,
): CaptureAgentLearningSignalInput {
  const parsed = parseOrThrow(
    captureLearningSignalSchema,
    withSessionId(value, sessionId),
    'agent learning signal input',
  ) as unknown as CaptureAgentLearningSignalInput;
  return sessionId ? { ...parsed, sessionId } : parsed;
}

export function validateReflectionDraftInput(value: unknown): ReflectionDraftInput {
  return parseOrThrow(reflectionDraftSchema, value, 'reflection draft input');
}

export function validateReflectionDraftPatchInput(value: unknown): ReflectionDraftPatchInput {
  return parseOrThrow(reflectionDraftPatchSchema, value, 'reflection draft patch input');
}

export function validateAppendAgentSessionNoteInput(
  value: unknown,
  sessionId?: string,
): AppendAgentSessionNoteInput {
  const parsed = parseOrThrow(
    appendSessionNoteSchema,
    withSessionId(value, sessionId),
    'agent session note input',
  ) as AppendAgentSessionNoteInput;
  return sessionId ? { ...parsed, sessionId } : parsed;
}

export function validateReflectionDraftIdArguments(value: unknown): { id: string } {
  return parseOrThrow(reflectionDraftIdArgumentsSchema, value, 'reflection draft arguments');
}

export function validateReflectionDraftListInput(value: unknown): {
  project?: string;
  status?: ReflectionDraftStatus;
  limit: number;
} {
  return parseOrThrow(reflectionDraftListSchema, value, 'reflection draft list input');
}

export function validateReflectionDraftReviewInput(value: unknown): ReflectionDraftReviewInput {
  return parseOrThrow(reflectionDraftReviewSchema, value, 'reflection draft review input');
}

export function validateCleanupOperationsInput(value: unknown): CleanupOperationsInput {
  return parseOrThrow(cleanupOperationsSchema, value, 'cleanup input');
}

export function validateCreateBackupInput(value: unknown): CreateBackupInput {
  return parseOrThrow(createBackupSchema, value, 'backup input');
}

export function validateBackupRetentionInput(value: unknown): BackupRetentionInput {
  return parseOrThrow(backupRetentionSchema, value, 'backup retention input');
}

export function validateRestoreBackupInput(value: unknown, backupIdOrPath?: string): RestoreBackupInput {
  const parsed = parseOrThrow(restoreBackupSchema, value, 'restore backup input');
  return backupIdOrPath ? { ...parsed, backupIdOrPath } : parsed;
}

export function validateErrorLogInput(value: unknown): ErrorLogInput {
  return parseOrThrow(errorLogSchema, value, 'error log input');
}

export function validateErrorLogPatchInput(value: unknown): ErrorLogPatchInput {
  return parseOrThrow(errorLogPatchSchema, value, 'error log patch input');
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
  return parseOrThrow(errorLogListSchema, value, 'error log list input');
}

export function validateCollectErrorLogsInput(value: unknown): CollectErrorLogsOptions {
  return parseOrThrow(collectErrorLogsSchema, value, 'error log collection input');
}

export function validateCreateErrorLogReflectionDraftInput(value: unknown): CreateErrorLogReflectionDraftInput {
  return parseOrThrow(createErrorLogReflectionDraftSchema, value, 'error log reflection draft input');
}

export function validateResolveErrorLogInput(value: unknown, id?: string): ResolveErrorLogInput {
  const parsed = parseOrThrow(
    resolveErrorLogSchema,
    withId(value, id),
    'error log resolution input',
  ) as ResolveErrorLogInput;
  return id ? { ...parsed, id } : parsed;
}

export function validateErrorLogIdArguments(value: unknown): { id: string } {
  return parseOrThrow(errorLogIdArgumentsSchema, value, 'error log arguments');
}

/**
 * Query-param enum parser (matches the old validate*Query helpers): a `null`
 * value (param absent) yields `undefined`; a non-member throws ValidationError
 * with the same `query.<field>: must be one of …` message shape.
 */
function parseEnumQuery<T extends string>(
  value: string | null,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === null) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    const path = `query.${field}`;
    const message = `${path} must be one of: ${allowed.join(', ')}.`;
    throw new ValidationError(message, [{ path, message }]);
  }
  return value as T;
}

export function validateKnowledgeReviewFilter(value: string | null): KnowledgeReviewFilter | undefined {
  return parseEnumQuery(value, KNOWLEDGE_REVIEW_FILTERS, 'review');
}

export function validateKnowledgeStatusQuery(value: string | null): KnowledgeStatus | undefined {
  return parseEnumQuery(value, KNOWLEDGE_STATUSES, 'status');
}

export function validateLearningReviewStatusQuery(value: string | null): LearningReviewStatus | undefined {
  return parseEnumQuery(value, LEARNING_REVIEW_STATUSES, 'status');
}

export function validateLearningProposalTypeQuery(value: string | null): LearningProposalType | undefined {
  return parseEnumQuery(value, LEARNING_PROPOSAL_TYPES, 'proposalType');
}

export function validateContextPackIdArguments(value: unknown): { contextPackId: string } {
  return parseOrThrow(contextPackIdArgumentsSchema, value, 'context pack arguments');
}

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  return expectObject(value, path);
}

/**
 * When a sessionId is supplied out-of-band (e.g. from a path param), inject it
 * into the payload so a schema that requires `sessionId` parses; the caller
 * overrides the field with the param value after parse. Non-object payloads are
 * returned untouched so the schema still rejects them with the right message.
 */
function withSessionId(value: unknown, sessionId?: string): unknown {
  if (sessionId && value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), sessionId };
  }
  return value;
}

/** Same as withSessionId for an out-of-band `id` (e.g. error-log resolve path param). */
function withId(value: unknown, id?: string): unknown {
  if (id && value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), id };
  }
  return value;
}


function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const message = `${path}: must be an object.`;
    throw new ValidationError(message, [{ path, message }]);
  }

  return value as Record<string, unknown>;
}

const ATOM_TYPES = ['fact', 'procedure', 'decision', 'gotcha', 'convention'] as const;
const EVIDENCE_KINDS = ['file', 'commit', 'test', 'url', 'prior_session'] as const;

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    const message = `${path}: must be a non-empty string.`;
    throw new ValidationError(message, [{ path, message }]);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function validateSubmitSessionAtomsInput(args: unknown): {
  sessionId: string;
  project?: string;
  atoms: ExtractedAtomCandidate[];
} {
  const record = expectRecord(args, 'tuberosa_submit_session_atoms arguments');
  const sessionId = requireString(record.sessionId, 'arguments.sessionId');
  const project = optionalString(record.project);
  if (!Array.isArray(record.atoms) || record.atoms.length === 0) {
    throw new ValidationError('tuberosa_submit_session_atoms arguments.atoms must be a non-empty array');
  }
  const atoms = record.atoms.map((raw, i) => {
    const a = expectRecord(raw, `arguments.atoms[${i}]`);
    const claim = requireString(a.claim, `arguments.atoms[${i}].claim`);
    const type = requireString(a.type, `arguments.atoms[${i}].type`);
    if (!ATOM_TYPES.includes(type as (typeof ATOM_TYPES)[number])) {
      throw new ValidationError(`arguments.atoms[${i}].type must be one of ${ATOM_TYPES.join(', ')}`);
    }
    const evidence = Array.isArray(a.evidence) ? a.evidence.map((e, j) => {
      const ev = expectRecord(e, `arguments.atoms[${i}].evidence[${j}]`);
      const kind = requireString(ev.kind, `arguments.atoms[${i}].evidence[${j}].kind`);
      if (!EVIDENCE_KINDS.includes(kind as (typeof EVIDENCE_KINDS)[number])) {
        throw new ValidationError(`evidence[${j}].kind must be one of ${EVIDENCE_KINDS.join(', ')}`);
      }
      return { ...ev, kind } as ExtractedAtomCandidate['evidence'][number];
    }) : [];
    const trigger = (a.trigger && typeof a.trigger === 'object') ? a.trigger as ExtractedAtomCandidate['trigger'] : {};
    // Coerce trigger array fields: only keep arrays of strings
    const cleanTrigger: ExtractedAtomCandidate['trigger'] = {};
    if (Array.isArray(trigger.errors)) {
      cleanTrigger.errors = trigger.errors.filter((e) => typeof e === 'string') as string[];
      if (cleanTrigger.errors.length === 0) delete cleanTrigger.errors;
    }
    if (Array.isArray(trigger.files)) {
      cleanTrigger.files = trigger.files.filter((f) => typeof f === 'string') as string[];
      if (cleanTrigger.files.length === 0) delete cleanTrigger.files;
    }
    if (Array.isArray(trigger.symbols)) {
      cleanTrigger.symbols = trigger.symbols.filter((s) => typeof s === 'string') as string[];
      if (cleanTrigger.symbols.length === 0) delete cleanTrigger.symbols;
    }
    if (Array.isArray(trigger.taskTypes)) {
      cleanTrigger.taskTypes = trigger.taskTypes.filter((t) => typeof t === 'string') as string[];
      if (cleanTrigger.taskTypes.length === 0) delete cleanTrigger.taskTypes;
    }
    if (Array.isArray(trigger.intentTags)) {
      cleanTrigger.intentTags = trigger.intentTags.filter((tag) => typeof tag === 'string') as string[];
      if (cleanTrigger.intentTags.length === 0) delete cleanTrigger.intentTags;
    }
    // Clean verification: only keep string command/assertion and valid testRef
    let verification: ExtractedAtomCandidate['verification'] | undefined;
    if (a.verification && typeof a.verification === 'object' && !Array.isArray(a.verification)) {
      verification = {};
      const v = a.verification as Record<string, unknown>;
      if (typeof v.command === 'string') {
        verification.command = v.command;
      }
      if (typeof v.assertion === 'string') {
        verification.assertion = v.assertion;
      }
      if (v.testRef && typeof v.testRef === 'object' && !Array.isArray(v.testRef)) {
        const testRef = v.testRef as Record<string, unknown>;
        if (typeof testRef.path === 'string' && typeof testRef.testName === 'string') {
          verification.testRef = { path: testRef.path, testName: testRef.testName };
        }
      }
      // If verification is now empty, omit it
      if (Object.keys(verification).length === 0) {
        verification = undefined;
      }
    }
    return {
      claim,
      type: type as ExtractedAtomCandidate['type'],
      evidence,
      trigger: cleanTrigger,
      verification,
      pitfalls: Array.isArray(a.pitfalls) ? a.pitfalls.map(String) : undefined,
    } satisfies ExtractedAtomCandidate;
  });
  return { sessionId, project, atoms };
}
