import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';

export interface StreamAtomGraphJsonlOptions {
  project: string;
  /** Soft cap on atoms iterated. Defaults to 10_000 — enough for any single project today. */
  atomLimit?: number;
  /** Per-atom edge limit. Defaults to 100 — outbound edges per atom should never approach this in practice. */
  edgeLimit?: number;
}

/**
 * Concern C2 — stream the project's atom graph as JSONL. One line per atom,
 * each carrying the atom record plus its outbound edges. The output is the
 * input format for concern E (cross-project / cross-repo graph fusion).
 *
 * Yields strings without trailing newlines so the caller controls framing.
 */
export async function* streamAtomGraphJsonl(
  store: KnowledgeStore,
  options: StreamAtomGraphJsonlOptions,
): AsyncIterable<string> {
  const atomLimit = options.atomLimit ?? 10_000;
  const edgeLimit = options.edgeLimit ?? 100;
  const atoms = await store.listAtoms({ project: options.project, limit: atomLimit });
  for (const atom of atoms) {
    const edges = await store.listAtomRelations({ fromAtomId: atom.id, limit: edgeLimit });
    const record = {
      atom: serializeAtom(atom),
      outboundEdges: edges.map((edge) => ({
        toAtomId: edge.targetAtomId,
        targetKind: edge.targetKind,
        kind: edge.relationType,
        confidence: edge.confidence,
        inferenceSource: edge.inferenceSource,
      })),
    };
    yield JSON.stringify(record);
  }
}

function serializeAtom(atom: KnowledgeAtom) {
  return {
    id: atom.id,
    project: atom.project,
    claim: atom.claim,
    type: atom.type,
    tier: atom.tier,
    status: atom.status,
    trigger: atom.trigger,
    evidence: atom.evidence,
    reuseCount: atom.reuseCount,
    lastReusedAt: atom.lastReusedAt,
    createdAt: atom.audit.createdAt,
    updatedAt: atom.audit.updatedAt,
  };
}
