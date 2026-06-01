import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import { gatherAtlasInputs } from '../atlas/inputs.js';
import { assembleExtractionInputs, type ExtractionInputs } from './bootstrap-extract.js';
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

export interface BootstrapHandbookInput {
  project: string;
  repoPath: string;
  /** ISO timestamp for the atlas snapshot. Defaults to `new Date().toISOString()`. */
  generatedAt?: string;
}

export interface BootstrapHandbookResult {
  /** Deterministic, structured material the calling agent distills into conventions. */
  extraction: ExtractionInputs;
  /** Agent-facing guidance for proposing review-gated convention drafts. */
  instruction: string;
}

const DEFAULT_LIMIT = 500;

/** Best-effort read of a doc file from the repo; returns undefined on any failure. */
async function readDoc(repoPath: string, fileName: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(repoPath, fileName), 'utf8');
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

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

  /**
   * Bootstrap a project handbook from deterministic repo evidence.
   *
   * Gathers an atlas snapshot (scripts, areas, README commands) plus raw
   * README/CONTRIBUTING docs, then hands them to the PURE
   * {@link assembleExtractionInputs} assembler. Tuberosa has no internal
   * text-generation seam, so the distillation reasoning belongs to the calling
   * agent: it proposes one convention per recurring hint / detected tech via
   * `tuberosa_reflect`. Bootstrap-proposed conventions are REVIEW-GATED — drafts
   * land pending for human confirmation, not auto-activated.
   *
   * Determinism: with a fixed `generatedAt` and a stable repo, output is
   * deep-equal across calls (the assembler is pure; the atlas snapshot is too).
   */
  async bootstrapHandbook(input: BootstrapHandbookInput): Promise<BootstrapHandbookResult> {
    const { project, repoPath } = input;
    const generatedAt = input.generatedAt ?? new Date().toISOString();

    const atlasInputs = await gatherAtlasInputs(this.store, { project, repoPath, generatedAt });

    const [readme, contributing] = await Promise.all([
      readDoc(repoPath, 'README.md'),
      readDoc(repoPath, 'CONTRIBUTING.md'),
    ]);

    const extraction = assembleExtractionInputs(atlasInputs, { readme, contributing });

    const instruction =
      'Bootstrap evidence assembled. Propose ONE convention per recurring hint (recurringHints) and per detected technology (detectedTech) that is worth a project rule. ' +
      'For each, call tuberosa_reflect with metadata: { convention: true, curationSource: \'bootstrap\', scope: \'project\' or \'team\', category, steps, trigger, evidenceAtomIds: [] }. ' +
      'The distillation reasoning is yours — Tuberosa only assembles deterministic evidence. ' +
      'These bootstrap drafts are REVIEW-GATED: they land pending human confirmation and are NOT auto-activated. ' +
      'Because bootstrap evidence is repo signals rather than existing atoms, these drafts pass evidenceAtomIds: [] and will trip the distillation-evidence gate (needs ≥2 source atoms) — that blocker is EXPECTED for bootstrap; a human reviewer can approve them on review.';

    return { extraction, instruction };
  }
}
