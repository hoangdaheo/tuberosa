import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('source ledger: upsert is per-path and updates in place', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.upsertSourceFile({
    project: 'p', path: 'src/a.ts', contentHash: 'h1', status: 'tracked', lastSyncedSha: 'sha1',
  });
  assert.equal(a.path, 'src/a.ts');
  assert.equal(a.contentHash, 'h1');

  const b = await store.upsertSourceFile({
    project: 'p', path: 'src/a.ts', contentHash: 'h2', status: 'changed', lastSyncedSha: 'sha2',
  });
  assert.equal(b.id, a.id, 'same path → same ledger row');
  assert.equal(b.contentHash, 'h2');

  const all = await store.listSourceFiles({ project: 'p', limit: 50 });
  assert.equal(all.length, 1);
});

test('source ledger: rename re-points path and records prior_paths', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'old.ts', contentHash: 'h', status: 'tracked' });
  const moved = await store.renameSourceFile({ project: 'p', from: 'old.ts', to: 'new.ts' });
  assert.equal(moved?.path, 'new.ts');
  assert.deepEqual(moved?.priorPaths, ['old.ts']);
  const byOld = await store.getSourceFile({ project: 'p', path: 'old.ts' });
  assert.equal(byOld, undefined);
});

test('sync_runs: create then mark applied', async () => {
  const store = new MemoryKnowledgeStore();
  const plan = {
    project: 'p', repoPath: '/r', mode: 'git' as const,
    added: [], changed: [], renamed: [], deleted: [], ignored: [],
    summary: { added: 0, changed: 0, renamed: 0, deleted: 0, ignored: 0 }, destructive: false,
  };
  const run = await store.createSyncRun({ project: 'p', mode: 'git', plan, trigger: 'cli' });
  assert.equal(run.applied, false);
  const fetched = await store.getSyncRun(run.id);
  assert.equal(fetched?.id, run.id);
  const applied = await store.markSyncRunApplied(run.id);
  assert.equal(applied?.applied, true);
  assert.ok(applied?.appliedAt);
});
