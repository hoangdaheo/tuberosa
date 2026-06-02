import { z } from 'zod';
import type {
  ContextSearchInput,
  FeedbackInput,
  ContextQualityReportInput,
} from '../types.js';
import {
  TASK_TYPES,
  TASK_TYPE_ALIASES,
  taskTypeToken,
  isTaskType,
  CONTEXT_MODES,
  CONTEXT_NOISE_TOLERANCES,
  FEEDBACK_TYPES,
  CONTEXT_QUALITY_FEEDBACK_TYPES,
} from './enums.js';
import { zRequiredString, zOptionalString, zStringArray, zRecord, zPositiveInteger } from './primitives.js';

const TASK_TYPE_LIST = TASK_TYPES.join(', ');

/**
 * Optional taskType: normalize the raw token, accept a canonical TaskType
 * directly, map a known alias to its canonical value, else reject.
 * A non-string input is rejected by `z.string()`.
 */
const taskTypeSchema = z
  .string()
  .transform((v) => taskTypeToken(v))
  .refine((t) => isTaskType(t) || TASK_TYPE_ALIASES.has(t), {
    message: `must be one of: ${TASK_TYPE_LIST}.`,
  })
  .transform((t) => (isTaskType(t) ? t : TASK_TYPE_ALIASES.get(t)!))
  .optional();

/**
 * Optional namespace filter. Drops blank optional strings and collapses to
 * `undefined` when no usable keys remain (matches readOptionalNamespace).
 */
const namespaceSchema = z
  .object({
    project: zRequiredString.optional(),
    kind: zRequiredString.optional(),
    agent: zRequiredString.optional(),
  })
  .transform((ns) => {
    const out: NonNullable<ContextSearchInput['namespace']> = {};
    if (ns.project) out.project = ns.project;
    if (ns.kind) out.kind = ns.kind;
    if (ns.agent) out.agent = ns.agent;
    return Object.keys(out).length > 0 ? out : undefined;
  })
  .nullish()
  .transform((v) => v ?? undefined);

export const contextSearchSchema = z.object({
  prompt: zRequiredString,
  project: zRequiredString.optional(),
  repoHint: zRequiredString.optional(),
  cwd: zRequiredString.optional(),
  taskType: taskTypeSchema,
  files: zStringArray.optional(),
  symbols: zStringArray.optional(),
  errors: zStringArray.optional(),
  tokenBudget: z
    .number()
    .finite()
    .positive()
    .transform((n) => Math.min(n, 200_000))
    .optional(),
  contextMode: z.enum(CONTEXT_MODES).optional(),
  noiseTolerance: z.enum(CONTEXT_NOISE_TOLERANCES).optional(),
  deepContextBudget: z.number().finite().positive().optional(),
  includeDeepContext: z.boolean().optional(),
  rejectedKnowledgeIds: zStringArray.optional(),
  bypassCache: z.boolean().optional(),
  debug: z.boolean().optional(),
  namespace: namespaceSchema,
});

export const feedbackSchema = z.object({
  contextPackId: zOptionalString,
  project: zOptionalString,
  feedbackType: z.enum(FEEDBACK_TYPES),
  reason: zOptionalString,
  rejectedKnowledgeIds: zStringArray.optional(),
  metadata: zRecord.optional(),
}) as z.ZodType<FeedbackInput>;

/** Context-quality report: optional filters; limit defaults to 25, capped at 100. */
export const contextQualityReportSchema = z
  .object({
    project: zOptionalString,
    feedbackType: z.enum(CONTEXT_QUALITY_FEEDBACK_TYPES).optional(),
    limit: zPositiveInteger.optional(),
  })
  .transform((r) => ({
    project: r.project,
    feedbackType: r.feedbackType,
    limit: Math.min(r.limit ?? 25, 100),
  })) as unknown as z.ZodType<ContextQualityReportInput>;

/** Required contextPackId honoring `contextPackId` then `id` aliases. */
export const contextPackIdArgumentsSchema = z
  .object({ contextPackId: zOptionalString, id: zOptionalString })
  .transform((r, ctx) => {
    const contextPackId = r.contextPackId ?? r.id;
    if (!contextPackId) {
      ctx.addIssue({ code: 'custom', message: 'must be a non-empty string.', path: ['contextPackId'] });
      return z.NEVER;
    }
    return { contextPackId };
  });
