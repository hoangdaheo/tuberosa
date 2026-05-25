import { randomUUID } from 'crypto';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  LabelInput,
  LabelProvenanceSource,
  MaintenanceApplyInput,
  MaintenanceApplyOutcome,
  MaintenanceApplyResult,
  MaintenanceApplyResultItem,
  MaintenanceBatch,
  MaintenanceBefore,
  MaintenanceCounts,
  MaintenanceEvidence,
  MaintenanceItem,
  MaintenanceItemKind,
  MaintenanceProposeInput,
  MaintenanceRisk,
  ReflectionDraft,
  StoredKnowledge,
} from '../types.js';

/**
 * Phase 10 — Preview-first maintenance.
 *
 * Scans the local KnowledgeStore for curation work (duplicate memories, stale
 * relations, superseded reflections, weak/unreviewed labels) and returns a
 * batch the reviewer can inspect before applying. Apply is idempotent and
 * never auto-runs — the reviewer picks which items to mutate.
 *
 * Everything here is heuristic, deterministic, and offline; no LLM call.
 */
export const MAINTENANCE_ITEM_KINDS: readonly MaintenanceItemKind[] = [
  'duplicate_memory',
  'stale_relation',
  'superseded_reflection',
  'weak_label',
] as const;

/**
 * Risk classification per kind. The roadmap originally framed low-risk as
 * "additive enrichment only" (add_labels, add_references). This scanner ships
 * curation-only kinds, so "low" here means "subtractive but reversible and
 * scoped to a single pending draft or low-confidence label":
 *
 * - `duplicate_memory` rejects a *pending* draft — no durable knowledge is
 *   touched, and the draft can be re-created from the original session.
 * - `weak_label` removes a single inferred label (confidence < 0.5) from one
 *   knowledge item — re-ingestion or manual re-tagging restores it.
 *
 * Anything touching `approved` knowledge (`superseded_reflection`) or deleting
 * a stored relation (`stale_relation`) is *not* eligible for `autoApplyLowRisk`.
 *
 * Reviewers using `autoApplyLowRisk` should expect drafts to be rejected and
 * weak labels to be dropped without explicit approval — document this in any
 * client that exposes the flag.
 */
const MAINTENANCE_RISK_BY_KIND: Record<MaintenanceItemKind, MaintenanceRisk> = {
  duplicate_memory: 'low',
  weak_label: 'low',
  stale_relation: 'medium',
  superseded_reflection: 'high',
};

/** Stable risk classification per kind. Surfaced on every emitted item. */
export function maintenanceRiskFor(kind: MaintenanceItemKind): MaintenanceRisk {
  return MAINTENANCE_RISK_BY_KIND[kind];
}

const DEFAULT_PROPOSE_LIMIT = 50;
const DRAFT_SCAN_LIMIT = 200;
const RELATION_SCAN_LIMIT = 1000;
const KNOWLEDGE_SCAN_LIMIT = 500;
const MAX_BATCH_HISTORY = 16;

const INFERRED_PROVENANCE_SOURCES: ReadonlySet<LabelProvenanceSource> = new Set([
  'classifier',
  'llm',
  'ast',
  'heuristic',
]);

export class MaintenanceService {
  private readonly batches = new Map<string, MaintenanceBatch>();

  constructor(private readonly store: KnowledgeStore) {}

  async propose(input: MaintenanceProposeInput = {}): Promise<MaintenanceBatch> {
    const project = input.project;
    const wantKinds = new Set<MaintenanceItemKind>(
      input.kinds && input.kinds.length > 0 ? input.kinds : MAINTENANCE_ITEM_KINDS,
    );
    const itemLimit = clampLimit(input.limit, DEFAULT_PROPOSE_LIMIT);
    const counts: MaintenanceCounts = {
      duplicate_memory: 0,
      stale_relation: 0,
      superseded_reflection: 0,
      weak_label: 0,
    };
    const items: MaintenanceItem[] = [];

    if (wantKinds.has('duplicate_memory') || wantKinds.has('superseded_reflection')) {
      const drafts = await this.store.listReflectionDrafts({
        project,
        status: 'pending',
        limit: DRAFT_SCAN_LIMIT,
      });
      for (const draft of drafts) {
        const { decision, reason, closest } = readWriteGate(draft);
        if (decision === 'NOOP' && wantKinds.has('duplicate_memory')) {
          items.push({
            id: `mi-dup-${draft.id}`,
            kind: 'duplicate_memory',
            risk: maintenanceRiskFor('duplicate_memory'),
            reason: reason ?? `Reflection draft duplicates existing memory ${truncate(closest, 36)}.`,
            project: draft.project,
            reflectionDraftId: draft.id,
            closestKnowledgeId: closest,
            evidence: writeGateEvidence(draft.id, closest),
            before: draftBefore(draft),
          });
          counts.duplicate_memory += 1;
        } else if (decision === 'DELETE' && wantKinds.has('superseded_reflection')) {
          items.push({
            id: `mi-sup-${draft.id}`,
            kind: 'superseded_reflection',
            risk: maintenanceRiskFor('superseded_reflection'),
            reason: reason ?? `Reflection draft proposes superseding memory ${truncate(closest, 36)}.`,
            project: draft.project,
            reflectionDraftId: draft.id,
            closestKnowledgeId: closest,
            evidence: writeGateEvidence(draft.id, closest),
            before: draftBefore(draft),
          });
          counts.superseded_reflection += 1;
        }
      }
    }

    if (wantKinds.has('stale_relation')) {
      const now = Date.now();
      const relations = await this.store.listKnowledgeRelations({
        project,
        limit: RELATION_SCAN_LIMIT,
      });
      for (const relation of relations) {
        const validUntilRaw = relation.metadata?.validUntil;
        if (typeof validUntilRaw !== 'string') continue;
        const ts = Date.parse(validUntilRaw);
        if (Number.isNaN(ts) || ts > now) continue;
        const evidence: MaintenanceEvidence[] = [
          { source: 'relation_expiry', reference: `validUntil=${validUntilRaw}` },
          { source: 'relation_expiry', reference: `from=${relation.fromKnowledgeId}` },
        ];
        if (relation.targetKnowledgeId) {
          evidence.push({ source: 'relation_expiry', reference: `to=${relation.targetKnowledgeId}` });
        }
        if (relation.targetValue) {
          evidence.push({ source: 'relation_expiry', reference: `targetValue=${relation.targetValue}` });
        }
        items.push({
          id: `mi-rel-${relation.id}`,
          kind: 'stale_relation',
          risk: maintenanceRiskFor('stale_relation'),
          reason: `Relation ${relation.relationType} from ${relation.fromKnowledgeId} expired at ${validUntilRaw}.`,
          project: relation.project,
          relationId: relation.id,
          evidence,
          before: { title: relation.relationType, status: 'expired' },
        });
        counts.stale_relation += 1;
      }
    }

    if (wantKinds.has('weak_label')) {
      const knowledge = await this.store.listKnowledge({
        project,
        limit: KNOWLEDGE_SCAN_LIMIT,
      });
      for (const item of knowledge) {
        for (const label of item.labels ?? []) {
          if (!isWeakLabel(label)) continue;
          items.push({
            id: `mi-lbl-${item.id}-${normalizeKey(label.type)}-${normalizeKey(label.value)}`,
            kind: 'weak_label',
            risk: maintenanceRiskFor('weak_label'),
            reason: `Label ${label.type}=${label.value} carries inferred provenance ${label.provenance?.source} with confidence ${formatConfidence(label.provenance?.confidence)}.`,
            project: item.project,
            knowledgeId: item.id,
            label: { type: label.type, value: label.value },
            evidence: [
              { source: 'label_provenance', reference: `knowledge=${item.id}` },
              {
                source: 'label_provenance',
                reference: `provenance=${label.provenance?.source}@${formatConfidence(label.provenance?.confidence)}`,
              },
            ],
            before: knowledgeBefore(item),
          });
          counts.weak_label += 1;
        }
      }
    }

    const totalDetected = items.length;
    const truncated = items.length > itemLimit;
    const trimmed = truncated ? items.slice(0, itemLimit) : items;

    const batch: MaintenanceBatch = {
      id: randomUUID(),
      generatedAt: new Date().toISOString(),
      project,
      items: trimmed,
      counts,
      totalDetected,
      truncated,
    };
    this.rememberBatch(batch);
    return batch;
  }

  async apply(input: MaintenanceApplyInput): Promise<MaintenanceApplyResult> {
    const batch = input.batchId ? this.batches.get(input.batchId) : undefined;
    const candidateItems = batch ? batch.items : input.items ?? [];
    const approveSet = input.approvedItemIds && input.approvedItemIds.length > 0
      ? new Set(input.approvedItemIds)
      : undefined;
    // Explicit approval always wins; autoApplyLowRisk only fires when no
    // approvedItemIds list was supplied, so reviewers can't accidentally
    // re-include high-risk items via the flag.
    const autoLowRiskOnly = !approveSet && input.autoApplyLowRisk === true;
    const results: MaintenanceApplyResultItem[] = [];

    for (const item of candidateItems) {
      if (approveSet && !approveSet.has(item.id)) {
        results.push({
          itemId: item.id,
          kind: item.kind,
          status: 'skipped',
          message: 'Not in approvedItemIds.',
        });
        continue;
      }
      if (autoLowRiskOnly && item.risk !== 'low') {
        results.push({
          itemId: item.id,
          kind: item.kind,
          status: 'skipped',
          message: `autoApplyLowRisk skipped ${item.risk}-risk item.`,
        });
        continue;
      }
      try {
        const outcome = await this.applyItem(item, input);
        results.push({
          itemId: item.id,
          kind: item.kind,
          status: outcome.status,
          message: outcome.message,
        });
      } catch (error) {
        results.push({
          itemId: item.id,
          kind: item.kind,
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const appliedCount = results.filter((r) => r.status === 'applied').length;
    const skippedCount = results.filter(
      (r) => r.status === 'skipped' || r.status === 'noop' || r.status === 'expired',
    ).length;
    const expiredCount = results.filter((r) => r.status === 'expired').length;
    const failedCount = results.filter((r) => r.status === 'failed').length;

    return {
      batchId: input.batchId,
      appliedAt: new Date().toISOString(),
      appliedCount,
      skippedCount,
      expiredCount,
      failedCount,
      results,
    };
  }

  /** Lookup a remembered batch by id — handy for the workbench surface. */
  getBatch(id: string): MaintenanceBatch | undefined {
    return this.batches.get(id);
  }

  private rememberBatch(batch: MaintenanceBatch): void {
    this.batches.set(batch.id, batch);
    while (this.batches.size > MAX_BATCH_HISTORY) {
      const firstKey = this.batches.keys().next().value;
      if (!firstKey) break;
      this.batches.delete(firstKey);
    }
  }

  private async applyItem(
    item: MaintenanceItem,
    input: MaintenanceApplyInput,
  ): Promise<{ status: Exclude<MaintenanceApplyOutcome, 'skipped'>; message?: string }> {
    const reviewerMetadata = compactMetadata({
      decision: maintenanceDecisionKey(item.kind),
      reviewer: input.reviewer,
      reviewerNote: input.reviewerNote,
      appliedAt: new Date().toISOString(),
    });

    switch (item.kind) {
      case 'duplicate_memory': {
        if (!item.reflectionDraftId) {
          return { status: 'failed', message: 'duplicate_memory item requires reflectionDraftId.' };
        }
        const draft = await this.store.getReflectionDraft(item.reflectionDraftId);
        if (!draft) return { status: 'expired', message: 'Draft no longer exists.' };
        if (draft.status === 'rejected') return { status: 'expired', message: 'Draft already rejected.' };
        const updated = await this.store.updateReflectionDraft(item.reflectionDraftId, {
          status: 'rejected',
          metadata: {
            ...(draft.metadata ?? {}),
            maintenance: reviewerMetadata,
          },
        });
        return { status: updated ? 'applied' : 'expired' };
      }
      case 'superseded_reflection': {
        if (!item.reflectionDraftId) {
          return { status: 'failed', message: 'superseded_reflection item requires reflectionDraftId.' };
        }
        const draft = await this.store.getReflectionDraft(item.reflectionDraftId);
        if (!draft) return { status: 'expired', message: 'Draft no longer exists.' };

        if (item.closestKnowledgeId) {
          const existing = await this.store.getKnowledge(item.closestKnowledgeId);
          if (existing && existing.status !== 'archived') {
            await this.store.updateKnowledge(item.closestKnowledgeId, {
              status: 'archived',
              metadata: {
                ...(existing.metadata ?? {}),
                maintenance: {
                  ...reviewerMetadata,
                  supersededByDraft: item.reflectionDraftId,
                },
              },
            });
          }
        }

        if (draft.status === 'rejected') return { status: 'applied', message: 'Draft already rejected; closest archived.' };
        const updated = await this.store.updateReflectionDraft(item.reflectionDraftId, {
          status: 'rejected',
          metadata: {
            ...(draft.metadata ?? {}),
            maintenance: reviewerMetadata,
          },
        });
        return { status: updated ? 'applied' : 'expired' };
      }
      case 'stale_relation': {
        if (!item.relationId) {
          return { status: 'failed', message: 'stale_relation item requires relationId.' };
        }
        const existing = await this.store.getKnowledgeRelation(item.relationId);
        if (!existing) return { status: 'expired', message: 'Relation no longer exists.' };
        const deleted = await this.store.deleteKnowledgeRelation(item.relationId);
        return { status: deleted ? 'applied' : 'expired' };
      }
      case 'weak_label': {
        if (!item.knowledgeId || !item.label) {
          return { status: 'failed', message: 'weak_label item requires knowledgeId and label.' };
        }
        const existing = await this.store.getKnowledge(item.knowledgeId);
        if (!existing) return { status: 'expired', message: 'Knowledge item no longer exists.' };
        const targetType = item.label.type;
        const targetValue = item.label.value;
        const nextLabels = existing.labels.filter(
          (label) => !(label.type === targetType && label.value === targetValue),
        );
        if (nextLabels.length === existing.labels.length) {
          return { status: 'expired', message: 'Label already removed.' };
        }
        const updated = await this.store.updateKnowledge(item.knowledgeId, {
          labels: nextLabels,
          metadata: {
            ...(existing.metadata ?? {}),
            maintenance: {
              ...reviewerMetadata,
              removed: { type: targetType, value: targetValue },
            },
          },
        });
        return { status: updated ? 'applied' : 'expired' };
      }
      default: {
        return { status: 'failed', message: `Unknown maintenance kind: ${(item as MaintenanceItem).kind}` };
      }
    }
  }
}

interface WriteGatePreview {
  decision: string;
  reason?: string;
  closest?: string;
}

function readWriteGate(draft: ReflectionDraft): WriteGatePreview {
  const raw = (draft.metadata ?? {}).writeGate;
  if (!raw || typeof raw !== 'object') {
    return { decision: '' };
  }
  const record = raw as Record<string, unknown>;
  const decision = typeof record.decision === 'string' ? record.decision : '';
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  const closest = typeof record.closestKnowledgeId === 'string' ? record.closestKnowledgeId : undefined;
  return { decision, reason, closest };
}

function isWeakLabel(label: LabelInput): boolean {
  const provenance = label.provenance;
  if (!provenance) return false;
  if (typeof provenance.confidence !== 'number') return false;
  if (provenance.confidence >= 0.5) return false;
  return INFERRED_PROVENANCE_SOURCES.has(provenance.source);
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), 500);
}

function normalizeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

function formatConfidence(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'n/a';
  return value.toFixed(2);
}

function truncate(value: string | undefined, max: number): string {
  if (!value) return 'n/a';
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

function writeGateEvidence(draftId: string, closest: string | undefined): MaintenanceEvidence[] {
  const evidence: MaintenanceEvidence[] = [
    { source: 'write_gate', reference: `draft=${draftId}` },
  ];
  if (closest) evidence.push({ source: 'write_gate', reference: `closest=${closest}` });
  return evidence;
}

function draftBefore(draft: ReflectionDraft): MaintenanceBefore {
  return {
    title: draft.title,
    summary: draft.summary,
    labels: draft.suggestedLabels?.map((l) => ({ type: l.type, value: l.value })),
    status: draft.status,
  };
}

function knowledgeBefore(item: StoredKnowledge): MaintenanceBefore {
  return {
    title: item.title,
    summary: item.summary,
    labels: item.labels.map((l) => ({ type: l.type, value: l.value })),
    status: item.status,
  };
}

function maintenanceDecisionKey(kind: MaintenanceItemKind): string {
  switch (kind) {
    case 'duplicate_memory':
      return 'duplicate_dismissed';
    case 'superseded_reflection':
      return 'supersede_applied';
    case 'stale_relation':
      return 'stale_relation_removed';
    case 'weak_label':
      return 'weak_label_removed';
  }
}

function compactMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null),
  );
}

