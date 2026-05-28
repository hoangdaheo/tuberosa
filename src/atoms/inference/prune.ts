import type { KnowledgeStore } from '../../storage/store.js';
import { getRetrievalPolicy } from '../../retrieval/policy.js';

/**
 * Concern C1 — weekly stale-edge prune. Confidence drifts as files are
 * refactored and atoms churn; edges that fall below the policy floor stop
 * helping retrieval and start adding noise. The job is idempotent.
 */
export async function pruneStaleEdges(
  store: KnowledgeStore,
  options: { project?: string; floorConfidence?: number; dryRun?: boolean } = {},
): Promise<{ removed: number }> {
  const policy = getRetrievalPolicy().graphInference.edgePrune;
  return store.pruneStaleAtomRelations({
    project: options.project,
    floorConfidence: options.floorConfidence ?? policy.floorConfidence,
    dryRun: options.dryRun,
  });
}
