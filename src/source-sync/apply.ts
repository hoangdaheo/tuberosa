import { isAbsolute } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { IngestionService } from '../ingest/service.js';
import type { ApplyResult, SyncPlan } from './types.js';
import { hashContent } from './fs-inventory.js';

export interface ApplyOptions {
  store: KnowledgeStore;
  ingestion: IngestionService;
  plan: SyncPlan;
  /** Reads a repo-relative path → file content. */
  readFile: (path: string) => Promise<string>;
  syncRunId?: string;
  /**
   * When false (default), deletions are NOT archived — they are collected into
   * `result.deferredDeletions` for review. Additive ops (add/change/rename) always apply.
   * Set true only after explicit human/agent confirmation.
   */
  allowDestructive?: boolean;
}

/**
 * A plan path is unsafe if it is absolute or escapes the repo root via a `..` segment.
 * Repo-relative paths from `git ls-files` / the FS walk never do; this guards a persisted,
 * later-replayed plan against path traversal outside the repo.
 */
function hasUnsafeSegment(path: string): boolean {
  if (isAbsolute(path)) return true;
  return path.split(/[\\/]/).some((segment) => segment === '..');
}

export async function applyPlan(opts: ApplyOptions): Promise<ApplyResult> {
  const { store, ingestion, plan, readFile } = opts;
  const allowDestructive = opts.allowDestructive ?? false;
  const result: ApplyResult = { ingested: 0, reingested: 0, repointed: 0, archived: 0, skipped: [], deferredDeletions: [] };

  // 1. added → ingest + ledger row
  for (const add of plan.added) {
    if (hasUnsafeSegment(add.path)) {
      result.skipped.push({ path: add.path, reason: 'unsafe_path' });
      continue;
    }
    let content: string;
    try {
      content = await readFile(add.path);
    } catch {
      result.skipped.push({ path: add.path, reason: 'missing_on_disk' });
      continue;
    }
    await ingestion.ingestFiles(plan.project, [{ project: plan.project, path: add.path, content }]);
    await store.upsertSourceFile({
      project: plan.project,
      path: add.path,
      contentHash: hashContent(content),
      status: 'tracked',
      lastSyncedSha: plan.toSha ?? null,
    });
    result.ingested += 1;
  }

  // 2. changed → re-validate hash, re-ingest, update ledger
  for (const change of plan.changed) {
    if (hasUnsafeSegment(change.path)) {
      result.skipped.push({ path: change.path, reason: 'unsafe_path' });
      continue;
    }
    let content: string;
    try {
      content = await readFile(change.path);
    } catch {
      result.skipped.push({ path: change.path, reason: 'missing_on_disk' });
      continue;
    }
    if (hashContent(content) !== change.newHash) {
      result.skipped.push({ path: change.path, reason: 'hash_mismatch' });
      continue;
    }
    await ingestion.ingestFiles(plan.project, [{ project: plan.project, path: change.path, content }]);
    await store.upsertSourceFile({
      project: plan.project,
      path: change.path,
      contentHash: change.newHash,
      status: 'tracked',
      lastSyncedSha: plan.toSha ?? null,
    });
    result.reingested += 1;
  }

  // 3. renamed → re-point ledger + knowledge metadata (preserve knowledge)
  for (const ren of plan.renamed) {
    if (hasUnsafeSegment(ren.from) || hasUnsafeSegment(ren.to)) {
      result.skipped.push({ path: ren.to, reason: 'unsafe_path' });
      continue;
    }
    await store.renameSourceFile({ project: plan.project, from: ren.from, to: ren.to });
    const linked = await store.listKnowledgeBySourcePath({ project: plan.project, path: ren.from });
    for (const knowledge of linked) {
      await store.updateKnowledge(knowledge.id, {
        metadata: { ...(knowledge.metadata as Record<string, unknown>), sourcePath: ren.to },
      });
    }
    result.repointed += 1;
  }

  // 4. deleted → archive knowledge + atoms, tombstone ledger row (never hard-delete).
  //    When not allowed to be destructive, DEFER (queue for review) instead of archiving;
  //    additive ops above have already been applied.
  for (const del of plan.deleted) {
    if (hasUnsafeSegment(del.path)) {
      result.skipped.push({ path: del.path, reason: 'unsafe_path' });
      continue;
    }
    const linkedIds = del.knowledgeIds.length
      ? del.knowledgeIds
      : (await store.listKnowledgeBySourcePath({ project: plan.project, path: del.path })).map((k) => k.id);
    if (!allowDestructive) {
      result.deferredDeletions.push({ path: del.path, knowledgeIds: linkedIds });
      continue;
    }
    for (const id of linkedIds) {
      const current = await store.getKnowledge(id);
      if (!current) {
        continue;
      }
      await store.updateKnowledge(id, {
        status: 'archived',
        metadata: {
          ...(current.metadata as Record<string, unknown>),
          archive: { reason: 'source_deleted', sourcePath: del.path, syncRunId: opts.syncRunId ?? null },
        },
      });
      result.archived += 1;
    }
    for (const atomId of del.atomIds) {
      await store.updateAtom(atomId, { status: 'archived' });
    }
    await store.upsertSourceFile({ project: plan.project, path: del.path, contentHash: null });
    await store.setSourceFileStatus({ project: plan.project, path: del.path, status: 'archived' });
  }

  return result;
}
