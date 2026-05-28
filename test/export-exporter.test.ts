import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { exportPack } from '../src/export/exporter.js';

async function seed(store: MemoryKnowledgeStore) {
  const a = await store.createAtom({
    project: 'tuberosa',
    claim: 'EMBEDDING_DIMENSIONS must equal the vector(N) column dim.',
    type: 'gotcha',
    evidence: [{ kind: 'file', path: 'migrations/001_init.sql', lineStart: 14 }],
    trigger: { errors: ['vector dimension mismatch'] },
    producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'tuberosa',
    claim: 'Use HNSW for ANN search.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'm.sql' }],
    trigger: { symbols: ['hnsw'] },
    producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(
    a.id,
    [
      {
        fromAtomId: a.id,
        targetAtomId: b.id,
        relationType: 'related_to',
        confidence: 0.7,
        inferenceSource: 'semantic',
      },
    ],
    { source: 'semantic' },
  );
  await store.upsertKnowledge(
    {
      project: 'tuberosa',
      sourceType: 'manual',
      sourceUri: 'docs/pgvector.md',
      itemType: 'wiki',
      title: 'Pgvector tuning notes',
      summary: '',
      content: '# Pgvector tuning notes\n\nLong-form.',
      labels: [],
      references: [],
      metadata: {},
    },
    [],
  );
  return { a, b };
}

test('exportPack: writes manifest, atoms, knowledge, edges; counts match', async () => {
  const store = new MemoryKnowledgeStore();
  await seed(store);
  const out = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(store, { project: 'tuberosa', out });
  const dirs = await readdir(out);
  assert.ok(dirs.includes('manifest.json'));
  assert.ok(dirs.includes('atoms'));
  assert.ok(dirs.includes('knowledge'));
  assert.ok(dirs.includes('edges.jsonl'));
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.atoms, 2);
  assert.equal(manifest.counts.knowledge, 1);
  assert.equal(manifest.counts.edges, 1);
});

test('exportPack: archived atoms are excluded by default', async () => {
  const store = new MemoryKnowledgeStore();
  const { a } = await seed(store);
  await store.updateAtom(a.id, { status: 'archived' });
  const out = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(store, { project: 'tuberosa', out });
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.atoms, 1);
});

test('exportPack: re-exporting same data is byte-identical for edges.jsonl', async () => {
  const store = new MemoryKnowledgeStore();
  await seed(store);
  const out1 = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(store, { project: 'tuberosa', out: out1 });
  const out2 = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(store, { project: 'tuberosa', out: out2 });
  const edges1 = await readFile(join(out1, 'edges.jsonl'), 'utf8');
  const edges2 = await readFile(join(out2, 'edges.jsonl'), 'utf8');
  assert.equal(edges1, edges2);
});
