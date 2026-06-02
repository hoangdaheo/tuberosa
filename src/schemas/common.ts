import { z } from 'zod';
import type { LabelInput, ReferenceInput } from '../types.js';
import { LABEL_TYPES, REFERENCE_TYPES } from './enums.js';
import { zRequiredString, zOptionalString, zFiniteNumber, zPositiveInteger, zRecord } from './primitives.js';

/**
 * Optional label array (matches readOptionalLabels): absent stays absent, else
 * each entry needs an enum `type`, a non-blank `value`, and an optional finite `weight`.
 */
export const optionalLabelsSchema = z
  .array(
    z.object({
      type: z.enum(LABEL_TYPES),
      value: zRequiredString,
      weight: zFiniteNumber.optional(),
    }),
  )
  .optional() as z.ZodType<LabelInput[] | undefined>;

/**
 * Optional reference array (matches readOptionalReferences): each entry needs an
 * enum `type`, a non-blank `uri`, optional positive-integer line bounds with
 * lineEnd >= lineStart, optional commitSha, optional metadata object.
 */
export const optionalReferencesSchema = z
  .array(
    z
      .object({
        type: z.enum(REFERENCE_TYPES),
        uri: zRequiredString,
        lineStart: zPositiveInteger.optional(),
        lineEnd: zPositiveInteger.optional(),
        commitSha: zOptionalString,
        metadata: zRecord.optional(),
      })
      .refine(
        (ref) => ref.lineStart === undefined || ref.lineEnd === undefined || ref.lineEnd >= ref.lineStart,
        { message: 'must be greater than or equal to lineStart.', path: ['lineEnd'] },
      ),
  )
  .optional() as z.ZodType<ReferenceInput[] | undefined>;
