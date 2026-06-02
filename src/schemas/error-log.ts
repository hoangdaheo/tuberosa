import { z } from 'zod';
import type {
  ErrorLogInput,
  ErrorLogPatchInput,
  CollectErrorLogsOptions,
  CreateErrorLogReflectionDraftInput,
  ResolveErrorLogInput,
  ErrorLogCategory,
  ErrorLogSeverity,
  ErrorLogStatus,
} from '../types.js';
import {
  ERROR_LOG_CATEGORIES,
  ERROR_LOG_SEVERITIES,
  ERROR_LOG_STATUSES,
  RESOLVE_ERROR_LOG_STATUSES,
} from './enums.js';
import {
  zRequiredString,
  zOptionalString,
  zNullableString,
  zStringArray,
  zRecord,
  zPositiveInteger,
  zNonNegativeInteger,
  zIsoDate,
} from './primitives.js';
import { optionalReferencesSchema } from './common.js';

export const errorLogSchema = z.object({
  project: zOptionalString,
  category: z.enum(ERROR_LOG_CATEGORIES).optional(),
  severity: z.enum(ERROR_LOG_SEVERITIES).optional(),
  status: z.enum(ERROR_LOG_STATUSES).optional(),
  title: zRequiredString,
  summary: zOptionalString,
  message: zOptionalString,
  stack: zOptionalString,
  toolName: zOptionalString,
  operation: zOptionalString,
  command: zOptionalString,
  cwd: zOptionalString,
  files: zStringArray.optional(),
  symbols: zStringArray.optional(),
  errors: zStringArray.optional(),
  tags: zStringArray.optional(),
  agentName: zOptionalString,
  agentTool: zOptionalString,
  sessionId: zOptionalString,
  contextPackId: zOptionalString,
  reflectionDraftId: zOptionalString,
  references: optionalReferencesSchema,
  metadata: zRecord.optional(),
  fingerprint: zOptionalString,
}) as z.ZodType<ErrorLogInput>;

export const errorLogPatchSchema = z.object({
  status: z.enum(ERROR_LOG_STATUSES).optional(),
  category: z.enum(ERROR_LOG_CATEGORIES).optional(),
  severity: z.enum(ERROR_LOG_SEVERITIES).optional(),
  summary: zOptionalString,
  notes: zOptionalString,
  tags: zStringArray.optional(),
  references: optionalReferencesSchema,
  reflectionDraftId: zNullableString,
  metadata: zRecord.optional(),
}) as z.ZodType<ErrorLogPatchInput>;

export const errorLogListSchema = z
  .object({
    project: zOptionalString,
    category: z.enum(ERROR_LOG_CATEGORIES).optional(),
    severity: z.enum(ERROR_LOG_SEVERITIES).optional(),
    status: z.enum(ERROR_LOG_STATUSES).optional(),
    query: zOptionalString,
    tag: zOptionalString,
    limit: zPositiveInteger.optional(),
  })
  .transform((r) => ({
    project: r.project,
    category: r.category,
    severity: r.severity,
    status: r.status,
    query: r.query,
    tag: r.tag,
    limit: Math.min(r.limit ?? 25, 100),
  }));

/** Optional array of enum members (matches readOptionalEnumArray). */
const enumArray = <T extends readonly [string, ...string[]]>(values: T) => z.array(z.enum(values)).optional();

export const collectErrorLogsSchema = z
  .object({
    project: zOptionalString,
    categories: enumArray(ERROR_LOG_CATEGORIES),
    severities: enumArray(ERROR_LOG_SEVERITIES),
    statuses: enumArray(ERROR_LOG_STATUSES),
    query: zOptionalString,
    tag: zOptionalString,
    since: zIsoDate.optional(),
    until: zIsoDate.optional(),
    limit: zPositiveInteger.optional(),
    offset: zNonNegativeInteger.optional(),
  })
  .transform((r) => ({
    project: r.project,
    categories: r.categories as ErrorLogCategory[] | undefined,
    severities: r.severities as ErrorLogSeverity[] | undefined,
    statuses: r.statuses as ErrorLogStatus[] | undefined,
    query: r.query,
    tag: r.tag,
    since: r.since,
    until: r.until,
    limit: Math.min(r.limit ?? 250, 500),
    offset: r.offset ?? 0,
  })) as unknown as z.ZodType<CollectErrorLogsOptions>;

export const createErrorLogReflectionDraftSchema = z.object({
  errorLogIds: zStringArray.min(1, { message: 'must include at least one id.' }),
  project: zOptionalString,
  title: zOptionalString,
  summary: zOptionalString,
  content: zOptionalString,
  linkLogs: z.boolean().optional(),
  metadata: zRecord.optional(),
}) as z.ZodType<CreateErrorLogReflectionDraftInput>;

/** Resolve: id (aliases id/errorLogId) required, status optional fixed|wont_fix. */
export const resolveErrorLogSchema = z
  .object({
    id: zOptionalString,
    errorLogId: zOptionalString,
    status: z.enum(RESOLVE_ERROR_LOG_STATUSES).optional(),
    rootCause: zRequiredString,
    resolutionSummary: zRequiredString,
    changedFiles: zStringArray.optional(),
    verificationCommands: zStringArray.optional(),
    reflectionDraftId: zOptionalString,
    notes: zOptionalString,
    metadata: zRecord.optional(),
  })
  .transform((r, ctx) => {
    const id = r.id ?? r.errorLogId;
    if (!id) {
      ctx.addIssue({ code: 'custom', message: 'must be a non-empty string.', path: ['id'] });
      return z.NEVER;
    }
    return {
      id,
      status: r.status,
      rootCause: r.rootCause,
      resolutionSummary: r.resolutionSummary,
      changedFiles: r.changedFiles,
      verificationCommands: r.verificationCommands,
      reflectionDraftId: r.reflectionDraftId,
      notes: r.notes,
      metadata: r.metadata,
    };
  }) as unknown as z.ZodType<ResolveErrorLogInput>;

/** Required id honoring `id` then `errorLogId` aliases. */
export const errorLogIdArgumentsSchema = z
  .object({ id: zOptionalString, errorLogId: zOptionalString })
  .transform((r, ctx) => {
    const id = r.id ?? r.errorLogId;
    if (!id) {
      ctx.addIssue({ code: 'custom', message: 'must be a non-empty string.', path: ['id'] });
      return z.NEVER;
    }
    return { id };
  });
