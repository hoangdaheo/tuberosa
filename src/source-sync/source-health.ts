import type { KnowledgeStore } from '../storage/store.js';
import type { SourceFileStatus } from './types.js';

/** Aggregated source-ledger health: per-status counts plus archived-file tombstones. */
export interface SourceHealth {
  counts: {
    tracked: number;
    changed: number;
    missing: number;
    archived: number;
    ignored: number;
  };
  tombstones: Array<{ path: string; archivedAt: string | null }>;
}

export async function buildSourceHealth(
  store: Pick<KnowledgeStore, 'listSourceFiles'>,
  options: { project?: string; limit: number },
): Promise<SourceHealth> {
  const files = await store.listSourceFiles({ project: options.project, limit: options.limit });
  const counts: Record<SourceFileStatus, number> = { tracked: 0, changed: 0, missing: 0, archived: 0, ignored: 0 };
  const tombstones: SourceHealth['tombstones'] = [];
  for (const file of files) {
    counts[file.status] += 1;
    if (file.status === 'archived') {
      tombstones.push({ path: file.path, archivedAt: file.archivedAt });
    }
  }
  return { counts, tombstones };
}
