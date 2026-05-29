import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { SourceSyncService } from '../source-sync/service.js';
import type { AtlasService } from '../atlas/service.js';
import type { MaintenanceService } from '../maintenance/service.js';
import type { ApplyResult } from '../source-sync/types.js';
import { assertSafeBundlePath } from '../security/safe-paths.js';
import { buildBootstrapHealthSummary } from './health.js';
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

    // 4. Atlas regeneration (non-fatal after sync succeeds).
    let atlas: BootstrapReport['atlas'];
    try {
      const result = await this.deps.atlas.regenerate({
        project: args.project,
        repoPath: args.repoPath,
        generatedAt: args.generatedAt,
        write: true,
      });
      atlas = { inputHash: result.inputHash, files: result.files };
    } catch (err) {
      warnings.push(`atlas regeneration failed (non-fatal): ${(err as Error).message}`);
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

    const nextActions = this.buildNextActions(args, applied, health);

    return {
      project: args.project,
      repoPath: args.repoPath,
      sync: { planId, summary: plan.summary, applied },
      atlas,
      health,
      warnings,
      nextActions,
    };
  }

  private buildNextActions(args: BootstrapRunArgs, applied: ApplyResult, health: BootstrapHealth): string[] {
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
