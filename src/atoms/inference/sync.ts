import type {
  AtomRelationInput,
  AtomRelationTargetKind,
  InferenceSource,
  KnowledgeStore,
} from '../../storage/store.js';
import type { AtomLink, AtomLinkKind } from '../../types/atoms.js';

/**
 * Concern C1 — mirror an inferred slice of atom links into both
 * `knowledge_atoms.links` (JSONB) and `knowledge_relations` (indexed rows). The
 * `source` parameter is the dedup key: re-running the same source replaces only
 * that source's rows. Edges from other sources survive untouched, so semantic /
 * co_change / migration writers don't fight each other.
 */
export interface AtomLinkWithTarget extends AtomLink {
  /** When the link points at a legacy knowledge_item instead of an atom. */
  targetKind?: AtomRelationTargetKind;
}

export async function syncAtomLinks(
  fromAtomId: string,
  links: AtomLinkWithTarget[],
  store: KnowledgeStore,
  source: InferenceSource,
): Promise<void> {
  const inputs: AtomRelationInput[] = links.map((link) => ({
    fromAtomId,
    targetKind: link.targetKind ?? 'atom',
    targetAtomId: link.toAtomId,
    relationType: link.kind,
    confidence: link.confidence,
    inferenceSource: source,
  }));
  await store.replaceAtomRelations(fromAtomId, inputs, { source });

  // Merge into atom JSONB links: keep links from OTHER sources, replace this
  // source's slice. We re-read from listAtomRelations to ensure JSONB stays in
  // lockstep with the indexed rows.
  const atom = await store.getAtom(fromAtomId);
  if (!atom) return;
  const allRows = await store.listAtomRelations({ fromAtomId, limit: 200 });
  const merged: AtomLink[] = allRows.map((r) => ({
    toAtomId: r.targetAtomId,
    kind: r.relationType as AtomLinkKind,
    confidence: r.confidence,
  }));
  await store.updateAtom(fromAtomId, { links: merged });
}
