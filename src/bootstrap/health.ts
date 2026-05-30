import type { KnowledgeStore } from '../storage/store.js';
import type { MaintenanceService } from '../maintenance/service.js';
import { buildSourceHealth } from '../source-sync/source-health.js';
import type { BootstrapHealth } from './types.js';

export interface HealthDeps {
  store: KnowledgeStore;
  /** Optional — when omitted, maintenanceItems is 0 (matches workbench behavior). */
  maintenance?: Pick<MaintenanceService, 'propose'>;
}

export async function buildBootstrapHealthSummary(
  deps: HealthDeps,
  options: { project: string },
): Promise<BootstrapHealth> {
  const sourceHealth = await buildSourceHealth(deps.store, { project: options.project, limit: 100_000 });
  const conflicts = await deps.store.listAtomImportConflicts({
    project: options.project,
    status: 'open',
    limit: 1000,
  });
  const gaps = await deps.store.listKnowledgeGaps({ project: options.project, limit: 1000 });

  let maintenanceItems = 0;
  if (deps.maintenance) {
    const batch = await deps.maintenance.propose({ project: options.project });
    maintenanceItems = batch.items.length;
  }

  return {
    sourceCounts: sourceHealth.counts,
    tombstones: sourceHealth.tombstones.length,
    openImportConflicts: conflicts.length,
    maintenanceItems,
    gaps: gaps.length,
  };
}
