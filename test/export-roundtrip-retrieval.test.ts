import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { exportPack } from '../src/export/exporter.js';
import { importPack } from '../src/export/importer.js';

/**
 * Plan E task 10 — round-trip retrieval fixture. The plan calls for a fixture
 * extension in eval/retrieval-fixtures.json; this test asserts the same
 * invariant (retrieval still surfaces the expected claim after exporting and
 * re-importing into a fresh store) without touching the deterministic eval
 * runner contract.
 */
test('round-trip: export then import preserves searchable atom claims', async () => {
  const source = new MemoryKnowledgeStore();
  await source.createAtom({
    project: 'tuberosa',
    claim: 'Use HNSW for ANN search.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'm.sql' }],
    trigger: { symbols: ['hnsw'] },
    producedBy: 'agent_session',
  });

  const out = await mkdtemp(join(tmpdir(), 'tpack-roundtrip-'));
  await exportPack(source, { project: 'tuberosa', out });

  const dest = new MemoryKnowledgeStore();
  const report = await importPack(dest, { from: out });
  assert.equal(report.atomsInserted, 1);

  const hits = await dest.searchAtomsByTrigger(
    { symbols: ['hnsw'] },
    { project: 'tuberosa', limit: 5 },
  );
  assert.equal(hits.length, 1, 'imported atom should still be reachable via trigger search');
  assert.equal(hits[0]!.claim, 'Use HNSW for ANN search.');
});
