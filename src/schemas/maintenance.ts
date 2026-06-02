import { z } from 'zod';
import type {
  MaintenanceItem,
  MaintenanceProposeInput,
  MaintenanceApplyInput,
} from '../types.js';
import {
  LABEL_TYPES,
  MAINTENANCE_ITEM_KINDS,
  MAINTENANCE_RISKS,
  MAINTENANCE_EVIDENCE_SOURCES,
  MAINTENANCE_RISK_DEFAULTS,
} from './enums.js';
import {
  zRequiredString,
  zOptionalString,
  zStringArray,
  zPositiveNumber,
} from './primitives.js';

const labelSubSchema = z
  .object({
    type: z.enum(LABEL_TYPES),
    value: zRequiredString,
  })
  .nullish()
  .transform((v) => v ?? undefined);

const evidenceSchema = z
  .array(
    z.object({
      source: z.enum(MAINTENANCE_EVIDENCE_SOURCES),
      reference: zRequiredString,
    }),
  )
  .nullish()
  .transform((v) => v ?? undefined);

const beforeSchema = z
  .object({
    title: zOptionalString,
    summary: zOptionalString,
    status: zOptionalString,
    labels: z
      .array(z.object({ type: zRequiredString, value: zRequiredString }))
      .nullish()
      .transform((v) => v ?? undefined),
  })
  .nullish()
  .transform((v) => v ?? undefined);

/**
 * Single maintenance item (matches readMaintenanceItem). `risk` is derived from
 * `kind` by default; an explicit `risk` must be a valid enum member.
 */
export const maintenanceItemSchema = z
  .object({
    id: zRequiredString,
    kind: z.enum(MAINTENANCE_ITEM_KINDS),
    risk: z.enum(MAINTENANCE_RISKS).optional(),
    reason: zOptionalString,
    project: zOptionalString,
    knowledgeId: zOptionalString,
    relationId: zOptionalString,
    reflectionDraftId: zOptionalString,
    label: labelSubSchema,
    closestKnowledgeId: zOptionalString,
    evidence: evidenceSchema,
    before: beforeSchema,
  })
  .transform((r) => ({
    id: r.id,
    kind: r.kind,
    risk: r.risk ?? MAINTENANCE_RISK_DEFAULTS[r.kind],
    reason: r.reason ?? '',
    project: r.project,
    knowledgeId: r.knowledgeId,
    relationId: r.relationId,
    reflectionDraftId: r.reflectionDraftId,
    label: r.label,
    closestKnowledgeId: r.closestKnowledgeId,
    evidence: r.evidence,
    before: r.before,
  })) as unknown as z.ZodType<MaintenanceItem>;

export const maintenanceProposeSchema = z.object({
  project: zOptionalString,
  kinds: z.array(z.enum(MAINTENANCE_ITEM_KINDS)).optional(),
  limit: zPositiveNumber.optional(),
}) as z.ZodType<MaintenanceProposeInput>;

export const maintenanceApplySchema = z.object({
  batchId: zOptionalString,
  items: z.array(maintenanceItemSchema).optional(),
  approvedItemIds: zStringArray.optional(),
  reviewer: zOptionalString,
  reviewerNote: zOptionalString,
  autoApplyLowRisk: z.boolean().optional(),
}) as z.ZodType<MaintenanceApplyInput>;
