import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('atlas_runs: create + getLatest round-trips, newest first', async () => {
  const store = new MemoryKnowledgeStore();
  await store.createAtlasRun({ project: 'p', inputHash: 'h1', files: [{ name: 'project-map.md', bytes: 10 }], generatedAt: '2026-01-01T00:00:00.000Z' });
  const second = await store.createAtlasRun({ project: 'p', inputHash: 'h2', files: [], generatedAt: '2026-01-02T00:00:00.000Z' });
  const latest = await store.getLatestAtlasRun('p');
  assert.equal(latest?.id, second.id);
  assert.equal(latest?.inputHash, 'h2');
});

test('atlas_runs: getLatest returns undefined for unknown project', async () => {
  const store = new MemoryKnowledgeStore();
  assert.equal(await store.getLatestAtlasRun('nope'), undefined);
});
