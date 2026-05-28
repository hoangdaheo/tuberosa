import type { KnowledgeStore } from '../storage/store.js';
import type {
  AtomImportConflict,
  AtomImportConflictAction,
} from '../types/export-bundle.js';

export async function listConflicts(
  store: KnowledgeStore,
  options: { project?: string; status?: string; limit?: number },
): Promise<AtomImportConflict[]> {
  return store.listAtomImportConflicts({
    project: options.project,
    status: options.status,
    limit: options.limit ?? 50,
  });
}

export async function resolveConflict(
  store: KnowledgeStore,
  id: string,
  action: AtomImportConflictAction,
  mergedSnapshot?: unknown,
  notes?: string,
): Promise<AtomImportConflict | undefined> {
  return store.resolveAtomImportConflict(id, action, mergedSnapshot, notes);
}
