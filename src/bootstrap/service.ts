import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { SourceSyncService } from '../source-sync/service.js';
import type { AtlasService } from '../atlas/service.js';
import type { MaintenanceService } from '../maintenance/service.js';
import type { ApplyResult } from '../source-sync/types.js';
import { assertSafeBundlePath } from '../security/safe-paths.js';
import { exportBootstrapPack } from '../export/bootstrap-pack.js';
import { inferCoChangeLinks } from '../atoms/inference/co-change.js';
import { computeAtomGraphDensity } from '../operations/atom-graph-density.js';
import { buildBootstrapHealthSummary } from './health.js';
import { gatherAtlasInputs } from '../atlas/inputs.js';
import { assembleExtractionInputs } from '../curation/bootstrap-extract.js';
import type { BootstrapHealth, BootstrapReport, BootstrapRunArgs } from './types.js';

export interface BootstrapServiceDeps {
  store: KnowledgeStore;
  sync: Pick<SourceSyncService, 'sync' | 'apply'>;
  atlas: Pick<AtlasService, 'regenerate'>;
  maintenance?: Pick<MaintenanceService, 'propose'>;
  /** Base dir for `--export` output; default `.tuberosa/exports`. */
  exportBaseDir: string;
}

const EMPTY_HEALTH: BootstrapHealth = {
  sourceCounts: { tracked: 0, changed: 0, missing: 0, archived: 0, ignored: 0 },
  tombstones: 0,
  openImportConflicts: 0,
  maintenanceItems: 0,
  gaps: 0,
};

export class BootstrapService {
  constructor(private readonly deps: BootstrapServiceDeps) {}

  async run(args: BootstrapRunArgs): Promise<BootstrapReport> {
    const warnings: string[] = [];

    // 1–3. Source sync, then apply additive ops only. Deletions are deferred —
    // bootstrap NEVER archives silently (allowDestructive:false).
    const { planId, plan } = await this.deps.sync.sync({
      project: args.project,
      repoPath: args.repoPath,
      trigger: 'cli',
    });
    const applied = await this.deps.sync.apply({ planId, allowDestructive: false });

    // Deep graph enrichment runs before atlas so density is reflected in generated docs.
    let deep: BootstrapReport['deep'];
    if (args.deep) {
      deep = await this.runDeep(args);
    }

    // 4. Atlas regeneration (non-fatal after sync succeeds).
    let atlas: BootstrapReport['atlas'];
    let atlasContents: { name: string; content: string }[] = [];
    let atlasInputHash: string | undefined;
    try {
      const result = await this.deps.atlas.regenerate({
        project: args.project,
        repoPath: args.repoPath,
        generatedAt: args.generatedAt,
        write: true,
      });
      atlas = { inputHash: result.inputHash, files: result.files };
      atlasContents = result.contents;
      atlasInputHash = result.inputHash;
    } catch (err) {
      warnings.push(`atlas regeneration failed (non-fatal): ${(err as Error).message}`);
    }

    // 4.5 Convention extraction signals (non-fatal). The CLI runs without an
    //     agent, so it can only PREPARE: gather deterministic extraction inputs
    //     and count candidate signals. Actual distillation happens later via the
    //     `tuberosa_bootstrap_handbook` agent tool (surfaced in nextActions).
    let conventions: BootstrapReport['conventions'];
    if (args.conventions !== false) {
      try {
        const atlasInputs = await gatherAtlasInputs(this.deps.store, {
          project: args.project,
          repoPath: args.repoPath,
          generatedAt: args.generatedAt,
        });
        const extraction = assembleExtractionInputs(atlasInputs);
        conventions = {
          candidateSignalCount: extraction.detectedTech.length + extraction.recurringHints.length,
        };
      } catch (err) {
        warnings.push(`convention extraction failed (non-fatal): ${(err as Error).message}`);
      }
    }

    // 5. Health summary (non-fatal).
    let health: BootstrapHealth = EMPTY_HEALTH;
    try {
      health = await buildBootstrapHealthSummary(
        { store: this.deps.store, maintenance: this.deps.maintenance },
        { project: args.project },
      );
    } catch (err) {
      warnings.push(`health summary failed (non-fatal): ${(err as Error).message}`);
    }

    // 6. Optional Export V2. Unlike atlas/health, a requested export that fails
    //    FAILS the bootstrap (the user explicitly asked for it).
    let exportResult: BootstrapReport['export'];
    if (args.export) {
      const out = await this.resolveExportOut(args);
      const report = await exportBootstrapPack(this.deps.store, {
        project: args.project,
        out,
        atlasContents,
        atlasInputHash,
        health,
      });
      exportResult = {
        out: report.out,
        atoms: report.atoms,
        knowledge: report.knowledge,
        edges: report.edges,
        chunks: report.chunks,
        areas: report.areas,
      };
    }

    const nextActions = this.buildNextActions(args, applied, health, conventions);

    return {
      project: args.project,
      repoPath: args.repoPath,
      sync: { planId, summary: plan.summary, applied },
      atlas,
      conventions,
      health,
      deep,
      export: exportResult,
      warnings,
      nextActions,
    };
  }

  /**
   * Bounded graph enrichment for --deep: co-change inference + density snapshot.
   * Non-fatal — failures become warnings; standard bootstrap still completes.
   * Stale-edge pruning is intentionally deferred to the Graph RAG Deepening spec.
   */
  private async runDeep(args: BootstrapRunArgs): Promise<NonNullable<BootstrapReport['deep']>> {
    const warnings: string[] = ['stale-edge pruning skipped (deferred to Graph RAG Deepening)'];
    let coChangeEdgesEmitted: number | undefined;
    try {
      const report = await inferCoChangeLinks(this.deps.store, { project: args.project, cwd: args.repoPath });
      coChangeEdgesEmitted = report.edgesEmitted;
    } catch (err) {
      warnings.push(`co-change inference failed (non-fatal): ${(err as Error).message}`);
    }
    let graphDensity;
    try {
      graphDensity = await computeAtomGraphDensity(this.deps.store, { project: args.project });
    } catch (err) {
      warnings.push(`graph density failed (non-fatal): ${(err as Error).message}`);
    }
    return { coChangeEdgesEmitted, graphDensity, warnings };
  }

  private buildNextActions(
    args: BootstrapRunArgs,
    applied: ApplyResult,
    health: BootstrapHealth,
    conventions: BootstrapReport['conventions'],
  ): string[] {
    const actions: string[] = [];
    if (applied.deferredDeletions.length > 0) {
      actions.push(
        `Review ${applied.deferredDeletions.length} deferred deletion(s) in ${join(args.repoPath, '.tuberosa', 'pending-sync.json')}, then archive with \`tuberosa sync --apply --yes\`.`,
      );
    }
    if (health.openImportConflicts > 0) {
      actions.push(`Resolve ${health.openImportConflicts} open import conflict(s) before relying on imported knowledge.`);
    }
    if (health.gaps > 0) {
      actions.push('Fill knowledge gaps surfaced in .tuberosa/atlas/open-gaps.md.');
    }
    // The convention pointer is an agent hand-off, not a repo-health follow-up,
    // so it should appear whenever signals were assembled — independent of the
    // other actions and ahead of the empty-fallback line below.
    if (conventions) {
      const n = conventions.candidateSignalCount;
      actions.push(
        `Run \`tuberosa_bootstrap_handbook project=${args.project}\` (agent) to distill ${n} candidate signal(s) into reviewable convention drafts.`,
      );
    }
    if (actions.length === 0) {
      actions.push('Bootstrap complete. Use `tuberosa atlas` or start an agent session to consume project knowledge.');
    }
    return actions;
  }

  /** Resolve a safe export output dir against exportBaseDir (reused by Phase 2). */
  protected async resolveExportOut(args: BootstrapRunArgs): Promise<string> {
    const candidate = args.out ?? `${args.project}-bootstrap`;
    return assertSafeBundlePath(this.deps.exportBaseDir, candidate);
  }
}
