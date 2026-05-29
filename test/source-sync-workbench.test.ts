import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { buildSourceHealth } from '../src/operations/workbench-summary.js';

test('buildSourceHealth: counts ledger statuses and lists tombstones', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'a.ts', contentHash: 'h', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'gone.ts', contentHash: null, status: 'archived' });
  const health = await buildSourceHealth(store, { project: 'p', limit: 100 });
  assert.equal(health.counts.tracked, 1);
  assert.equal(health.counts.archived, 1);
  assert.deepEqual(health.tombstones.map((t) => t.path), ['gone.ts']);
});
