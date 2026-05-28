import type { AtomLinkKind } from '../types/atoms.js';
import type { KnowledgeStore } from '../storage/store.js';

/**
 * Concern C1 — per-project density snapshot. C2 (read-side) uses these counts
 * to decide whether graph features are worth turning on: a graph with fewer
 * than ~0.5 edges per atom won't move retrieval quality.
 */
export interface AtomGraphDensity {
  atoms: number;
  edges: number;
  edgesPerAtom: number;
  byKind: Partial<Record<AtomLinkKind, number>>;
  bySource: Partial<Record<'migration' | 'semantic' | 'co_change' | 'refines_detector' | 'manual', number>>;
}

export async function computeAtomGraphDensity(
  store: KnowledgeStore,
  options: { project: string },
): Promise<AtomGraphDensity> {
  const atoms = await store.listAtoms({ project: options.project, limit: 10000 });
  const projectAtomIds = new Set(atoms.map((a) => a.id));
  const edges = await store.listAtomRelations({ limit: 100000 });
  const projectEdges = edges.filter((e) => projectAtomIds.has(e.fromAtomId));

  const byKind: AtomGraphDensity['byKind'] = {};
  const bySource: AtomGraphDensity['bySource'] = {};
  for (const e of projectEdges) {
    byKind[e.relationType] = (byKind[e.relationType] ?? 0) + 1;
    bySource[e.inferenceSource] = (bySource[e.inferenceSource] ?? 0) + 1;
  }

  return {
    atoms: atoms.length,
    edges: projectEdges.length,
    edgesPerAtom: atoms.length === 0 ? 0 : projectEdges.length / atoms.length,
    byKind,
    bySource,
  };
}
