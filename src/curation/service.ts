import type { KnowledgeStore } from '../storage/store.js';
import { clusterUncuratedAtoms, type AtomCluster } from './cluster.js';

export interface ProposeCurationInput {
  project: string;
  /** Max active atoms to pull for clustering. Defaults to 500. */
  limit?: number;
}

export interface ProposeCurationResult {
  clusters: AtomCluster[];
  /**
   * Agent-facing guidance. The distillation reasoning belongs to the calling
   * agent — Tuberosa only clusters the raw material and gates the result.
   */
  instruction: string;
}

const DEFAULT_LIMIT = 500;

/**
 * Proposes curation work by clustering a project's un-curated knowledge atoms.
 *
 * Fully deterministic: clustering is pure (no model calls, no I/O beyond the
 * store read), so this service can participate in eval without nondeterminism.
 * Filtering of conventions / already-distilled / non-active atoms is handled
 * inside {@link clusterUncuratedAtoms}; this service just supplies the raw set.
 */
export class CurationService {
  constructor(private readonly store: KnowledgeStore) {}

  async proposeCuration(input: ProposeCurationInput): Promise<ProposeCurationResult> {
    const atoms = await this.store.listAtoms({
      project: input.project,
      status: 'active',
      limit: input.limit ?? DEFAULT_LIMIT,
    });

    const clusters = clusterUncuratedAtoms(atoms).filter((c) => c.atoms.length >= 2);

    const instruction = clusters.length === 0
      ? 'No un-curated atom clusters found. Nothing to distill right now.'
      : `Found ${clusters.length} cluster(s) of related un-curated atoms. For each cluster, distill a single reusable convention and record it via tuberosa_reflect with metadata: { convention: true, scope, category, steps, trigger, evidenceAtomIds: [<the cluster's atom ids>] }. The distillation reasoning is yours — Tuberosa only clusters and gates. Each cluster has ≥2 atoms; a convention needs ≥2 source atoms (evidenceAtomIds) to pass the distillation-evidence gate.`;

    return { clusters, instruction };
  }
}
