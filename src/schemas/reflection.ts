import { z } from 'zod';
import type {
  ReflectionDraftInput,
  ReflectionDraftPatchInput,
  ReflectionDraftReviewInput,
  ReflectionDraftStatus,
} from '../types.js';
import {
  KNOWLEDGE_ITEM_TYPES,
  TRIGGER_TYPES,
  REFLECTION_DRAFT_STATUSES,
  REFLECTION_REVIEW_DECISIONS,
  REFLECTION_REVIEW_GRADES,
  REFLECTION_DUPLICATE_RISKS,
} from './enums.js';
import { zRequiredString, zOptionalString, zRecord, zPositiveInteger } from './primitives.js';
import { optionalLabelsSchema, optionalReferencesSchema } from './common.js';

export const reflectionDraftSchema = z.object({
  project: zOptionalString,
  title: zRequiredString,
  summary: zRequiredString,
  content: zRequiredString,
  itemType: z.enum(KNOWLEDGE_ITEM_TYPES).optional(),
  triggerType: z.enum(TRIGGER_TYPES),
  labels: optionalLabelsSchema,
  references: optionalReferencesSchema,
  metadata: zRecord.optional(),
}) as z.ZodType<ReflectionDraftInput>;

export const reflectionDraftPatchSchema = z.object({
  status: z.enum(REFLECTION_DRAFT_STATUSES).optional(),
  metadata: zRecord.optional(),
  suggestedLabels: optionalLabelsSchema,
  references: optionalReferencesSchema,
}) as z.ZodType<ReflectionDraftPatchInput>;

/** Required string honoring `id` then `reflectionDraftId` aliases. */
const draftIdSchema = z
  .object({ id: zOptionalString, reflectionDraftId: zOptionalString })
  .transform((r, ctx) => {
    const id = r.id ?? r.reflectionDraftId;
    if (!id) {
      ctx.addIssue({ code: 'custom', message: 'must be a non-empty string.', path: ['id'] });
      return z.NEVER;
    }
    return { id };
  });

export const reflectionDraftIdArgumentsSchema = draftIdSchema;

/**
 * Drop undefined evaluation sub-keys so an empty/partial evaluation object stays
 * compact (matches readOptionalReviewEvaluation + compactObject).
 */
const reviewEvaluationSchema = z
  .object({
    accuracy: z.enum(REFLECTION_REVIEW_GRADES).optional(),
    usefulness: z.enum(REFLECTION_REVIEW_GRADES).optional(),
    scope: z.enum(REFLECTION_REVIEW_GRADES).optional(),
    privacySafety: z.enum(REFLECTION_REVIEW_GRADES).optional(),
    labels: z.enum(REFLECTION_REVIEW_GRADES).optional(),
    references: z.enum(REFLECTION_REVIEW_GRADES).optional(),
    duplicateRisk: z.enum(REFLECTION_DUPLICATE_RISKS).optional(),
  })
  .transform((evaluation) =>
    Object.fromEntries(Object.entries(evaluation).filter(([, v]) => v !== undefined)),
  );

export const reflectionDraftReviewSchema = z
  .object({
    id: zOptionalString,
    reflectionDraftId: zOptionalString,
    decision: z.enum(REFLECTION_REVIEW_DECISIONS),
    reviewer: zOptionalString,
    reviewerNote: zOptionalString,
    evaluation: reviewEvaluationSchema.optional(),
    metadata: zRecord.optional(),
  })
  .transform((r, ctx) => {
    const id = r.id ?? r.reflectionDraftId;
    if (!id) {
      ctx.addIssue({ code: 'custom', message: 'must be a non-empty string.', path: ['id'] });
      return z.NEVER;
    }
    return {
      id,
      decision: r.decision,
      reviewer: r.reviewer,
      reviewerNote: r.reviewerNote,
      evaluation: r.evaluation,
      metadata: r.metadata,
    };
  }) as unknown as z.ZodType<ReflectionDraftReviewInput>;

export const reflectionDraftListSchema = z
  .object({
    project: zOptionalString,
    status: z.enum(REFLECTION_DRAFT_STATUSES).optional(),
    limit: zPositiveInteger.optional(),
  })
  .transform((r) => ({
    project: r.project,
    status: (r.status ?? 'pending') as ReflectionDraftStatus,
    limit: Math.min(r.limit ?? 25, 100),
  }));
