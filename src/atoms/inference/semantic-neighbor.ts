import type { ModelProvider } from '../../model/provider.js';
import type { KnowledgeStore } from '../../storage/store.js';
import type { AtomLink, KnowledgeAtom } from '../../types/atoms.js';
import { getRetrievalPolicy } from '../../retrieval/policy.js';
import { atomEmbeddingText } from '../critic.js';

/**
 * Concern C1 — inline semantic-neighbor inference. Runs once at atom creation,
 * after the dedup stage has accepted the candidate. Emits up to
 * `policy.graphInference.semanticNeighbor.maxOutbound` outbound links:
 *   - `refines` when the neighbor is verified/canonical AND shares a trigger
 *     token (error/file/symbol), suggesting the candidate sharpens an existing
 *     claim.
 *   - `related_to` otherwise.
 *
 * Candidates whose cosine clears `duplicateCeiling` are intentionally dropped —
 * those are dedup targets, not neighbors. The candidate atom is also excluded
 * by id in case the embedding search returns it.
 */
export async function inferSemanticNeighbors(
  candidate: KnowledgeAtom,
  store: KnowledgeStore,
  models: ModelProvider,
): Promise<AtomLink[]> {
  const policy = getRetrievalPolicy().graphInference;
  if (!policy.enabled) return [];
  const { threshold, duplicateCeiling, maxOutbound } = policy.semanticNeighbor;

  const embedding = await models.embed(atomEmbeddingText(candidate));
  const matches = await store.searchAtomsByEmbedding(embedding, {
    project: candidate.project,
    // Pull a few extras so the duplicate/self filter still leaves room for maxOutbound survivors.
    limit: maxOutbound + 3,
    threshold,
  });

  return matches
    .filter((m) => m.atom.id !== candidate.id && m.cosine < duplicateCeiling)
    .slice(0, maxOutbound)
    .map((m) => ({
      toAtomId: m.atom.id,
      kind: shouldRefine(candidate, m.atom) ? 'refines' : 'related_to',
      confidence: m.cosine,
    }));
}

function shouldRefine(candidate: KnowledgeAtom, neighbor: KnowledgeAtom): boolean {
  if (neighbor.tier !== 'verified' && neighbor.tier !== 'canonical') return false;
  return intersects(candidate.trigger.errors, neighbor.trigger.errors)
    || intersects(candidate.trigger.files, neighbor.trigger.files)
    || intersects(candidate.trigger.symbols, neighbor.trigger.symbols);
}

function intersects(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b || a.length === 0 || b.length === 0) return false;
  return a.some((x) => b.includes(x));
}
