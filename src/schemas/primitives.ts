import { z } from 'zod';
import { ValidationError } from '../errors.js';

/** Flattened zod issue shape stored in ValidationError.details. */
export interface SchemaIssue {
  path: string;
  message: string;
}

/**
 * Parse `value` with `schema`. On success returns the typed value.
 * On failure throws ValidationError(message, details) so src/errors.ts maps it
 * to HTTP 400 / JSON-RPC -32602 exactly as the old hand-rolled validators did.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const details: SchemaIssue[] = result.error.issues.map((issue) => ({
    path: [label, ...issue.path.map(String)].filter(Boolean).join('.'),
    message: issue.message,
  }));
  const first = details[0];
  const message = first ? `${first.path}: ${first.message}` : `${label}: invalid input.`;
  throw new ValidationError(message, details);
}

// Per-field hard caps to prevent DoS via giant inputs (ReDoS / OOM) at the MCP & HTTP boundary.
// Mirror the original hand-rolled enforceStringLength / readOptionalStringArray limits.
const MAX_STRING_LENGTH = 2_000_000;
const MAX_STRING_ARRAY_LENGTH = 4096;

/** Non-blank, length-capped string (rejects empty/whitespace-only); value is not mutated. */
export const zRequiredString = z
  .string()
  .max(MAX_STRING_LENGTH, { message: `must be ${MAX_STRING_LENGTH} characters or fewer.` })
  .refine((s) => s.trim().length > 0, {
    message: 'must be a non-empty string.',
  });

/** Optional string; absent stays absent (matches readOptionalString). */
export const zOptionalString = zRequiredString.optional();

/** Length-capped array of non-blank strings. */
export const zStringArray = z
  .array(zRequiredString)
  .max(MAX_STRING_ARRAY_LENGTH, { message: `must contain ${MAX_STRING_ARRAY_LENGTH} or fewer entries.` });

/** Strictly positive, finite number (matches readOptionalPositiveNumber). */
export const zPositiveNumber = z.number().finite().positive();
