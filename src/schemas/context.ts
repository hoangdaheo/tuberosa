import { z } from 'zod';
import type { ContextSearchInput } from '../types.js';
import {
  TASK_TYPES,
  TASK_TYPE_ALIASES,
  taskTypeToken,
  isTaskType,
  CONTEXT_MODES,
  CONTEXT_NOISE_TOLERANCES,
} from './enums.js';
import { zRequiredString, zStringArray } from './primitives.js';

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
