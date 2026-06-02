import { z } from 'zod';
import type {
  KnowledgeInput,
  KnowledgePatchInput,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  KnowledgeConflictPatchInput,
  KnowledgeGapPatchInput,
  LearningProposalPatchInput,
} from '../types.js';
import {
  KNOWLEDGE_ITEM_TYPES,
  KNOWLEDGE_STATUSES,
  KNOWLEDGE_RELATION_TYPES,
  KNOWLEDGE_RELATION_TARGET_KINDS,
  KNOWLEDGE_CONFLICT_STATUSES,
  LEARNING_REVIEW_STATUSES,
} from './enums.js';
import {
  zRequiredString,
  zOptionalString,
  zNullableString,
  zFiniteNumber,
  zConfidence,
  zRecord,
} from './primitives.js';
import { optionalLabelsSchema, optionalReferencesSchema } from './common.js';

export const knowledgeSchema = z.object({
  project: zRequiredString,
  sourceType: zRequiredString,
  sourceUri: zRequiredString,
  sourceTitle: zOptionalString,
  itemType: z.enum(KNOWLEDGE_ITEM_TYPES),
  title: zRequiredString,
  summary: zOptionalString,
  content: zRequiredString,
  trustLevel: zFiniteNumber.optional(),
  labels: optionalLabelsSchema,
  references: optionalReferencesSchema,
  metadata: zRecord.optional(),
  freshnessAt: zOptionalString,
}) as z.ZodType<KnowledgeInput>;

export const knowledgePatchSchema = z.object({
  status: z.enum(KNOWLEDGE_STATUSES).optional(),
  title: zOptionalString,
  summary: zOptionalString,
  trustLevel: zFiniteNumber.optional(),
  freshnessAt: zNullableString,
  metadata: zRecord.optional(),
  labels: optionalLabelsSchema,
  references: optionalReferencesSchema,
}) as z.ZodType<KnowledgePatchInput>;

export const knowledgeRelationSchema = z
  .object({
    project: zOptionalString,
    fromKnowledgeId: zRequiredString,
    relationType: z.enum(KNOWLEDGE_RELATION_TYPES),
    targetKind: z.enum(KNOWLEDGE_RELATION_TARGET_KINDS),
    targetKnowledgeId: zOptionalString,
    targetValue: zOptionalString,
    confidence: zConfidence.optional(),
    inferred: z.boolean().optional(),
    metadata: zRecord.optional(),
  })
  .refine((r) => Boolean(r.targetKnowledgeId) || Boolean(r.targetValue), {
    message: 'must be provided when targetKnowledgeId is not provided.',
    path: ['targetValue'],
  }) as z.ZodType<KnowledgeRelationInput>;

export const knowledgeRelationPatchSchema = z
  .object({
    relationType: z.enum(KNOWLEDGE_RELATION_TYPES).optional(),
    targetKind: z.enum(KNOWLEDGE_RELATION_TARGET_KINDS).optional(),
    targetKnowledgeId: zNullableString,
    targetValue: zNullableString,
    confidence: zConfidence.optional(),
    inferred: z.boolean().optional(),
    metadata: zRecord.optional(),
  })
  .refine((r) => !(r.targetKnowledgeId === null && r.targetValue === null), {
    message: 'must leave at least one target identifier.',
    path: ['targetValue'],
  }) as z.ZodType<KnowledgeRelationPatchInput>;

export const knowledgeConflictPatchSchema = z.object({
  status: z.enum(KNOWLEDGE_CONFLICT_STATUSES).optional(),
  metadata: zRecord.optional(),
}) as z.ZodType<KnowledgeConflictPatchInput>;

export const knowledgeGapPatchSchema = z.object({
  status: z.enum(LEARNING_REVIEW_STATUSES).optional(),
  metadata: zRecord.optional(),
}) as z.ZodType<KnowledgeGapPatchInput>;

export const learningProposalPatchSchema = z.object({
  status: z.enum(LEARNING_REVIEW_STATUSES).optional(),
  metadata: zRecord.optional(),
}) as z.ZodType<LearningProposalPatchInput>;
