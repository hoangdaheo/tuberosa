import type { KnowledgeStore } from '../storage/store.js';
import type { GraphWalkConfig } from './policy.js';
import type { ImpactPrediction, ImpactPredictionHit } from '../types/retrieval.js';

export interface PredictImpactInput {
  project: string;
  files: string[];
  symbols: string[];
  policy: GraphWalkConfig;
  /** Override `policy.walkDepth` when set. */
  depth?: number;
  /** Override `policy.impactPredictionLimit` when set. */
  limit?: number;
}

/**
 * Concern C2 — predict which atoms are likely affected by editing the
 * given files/symbols.
 *
 * 1. Seed: find atoms whose `trigger.files` or `trigger.symbols` reference
 *    any of the inputs (via `searchAtomsByTrigger`).
 * 2. Walk: traverse the atom graph depth ≤ `policy.walkDepth` with
 *    `policy.edgeWeights` and `policy.decayPerHop` (via `walkAtomGraph`).
 * 3. Aggregate: collapse duplicate atom targets, sum `pathScore`,
 *    truncate to `policy.impactPredictionLimit`.
 *
 * Empty seeds short-circuit to an empty prediction.
 */
export async function predictImpact(
  store: KnowledgeStore,
  input: PredictImpactInput,
): Promise<ImpactPrediction> {
  const result: ImpactPrediction = {
    triggeredBy: {
      files: input.files.length > 0 ? input.files : undefined,
      symbols: input.symbols.length > 0 ? input.symbols : undefined,
    },
    predictedAffected: [],
    truncated: false,
  };

  if (input.files.length === 0 && input.symbols.length === 0) {
    return result;
  }

  const limit = input.limit ?? input.policy.impactPredictionLimit;
  const depth = input.depth ?? input.policy.walkDepth;

  const seeds = await store.searchAtomsByTrigger(
    { files: input.files, symbols: input.symbols },
    { project: input.project, limit: 50 },
  );
  if (seeds.length === 0) return result;
  const seedAtomIds = seeds.map((a) => a.id);
  const seedIdSet = new Set(seedAtomIds);

  const hits = await store.walkAtomGraph({
    project: input.project,
    seedAtomIds,
    depth,
    edgeWeights: input.policy.edgeWeights,
    decayPerHop: input.policy.decayPerHop,
    // Probe one beyond the limit so we can set `truncated` honestly.
    limit: limit + 1,
  });

  if (hits.length === 0) return result;

  interface Aggregate {
    confidenceSum: number;
    via: ImpactPredictionHit['via'];
    hops: number;
    bestKindPath: string;
  }

  const byAtom = new Map<string, Aggregate>();
  for (const hit of hits) {
    if (seedIdSet.has(hit.atomId)) continue; // never recommend the seed itself
    const existing = byAtom.get(hit.atomId) ?? {
      confidenceSum: 0,
      via: [],
      hops: hit.path.length,
      bestKindPath: hit.path.map((s) => s.edgeKind).join(' → '),
    };
    existing.confidenceSum += hit.pathScore;
    for (const step of hit.path) {
      existing.via.push({ atomId: step.atomId, edgeKind: step.edgeKind });
    }
    byAtom.set(hit.atomId, existing);
  }

  const ordered = [...byAtom.entries()].sort((a, b) => b[1].confidenceSum - a[1].confidenceSum);
  result.truncated = ordered.length > limit;

  for (const [atomId, entry] of ordered.slice(0, limit)) {
    const atom = await store.getAtom(atomId);
    if (!atom) continue;
    result.predictedAffected.push({
      target: { kind: 'atom', value: atom.claim },
      confidence: Math.min(1, entry.confidenceSum),
      via: entry.via,
      why: `${entry.hops} hop(s) from a seed atom; path: ${entry.bestKindPath}`,
    });
  }

  return result;
}
