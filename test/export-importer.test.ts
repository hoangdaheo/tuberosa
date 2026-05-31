import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { exportPack } from '../src/export/exporter.js';
import { importPack } from '../src/export/importer.js';

test('importPack: round-trips export → import on a fresh store with no conflicts', async () => {
  const source = new MemoryKnowledgeStore();
  await source.createAtom({
    project: 'tuberosa',
    claim: 'Use HNSW for ANN search.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'm.sql' }],
    trigger: { symbols: ['hnsw'] },
    producedBy: 'agent_session',
  });
  const out = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(source, { project: 'tuberosa', out });

  const dest = new MemoryKnowledgeStore();
  const report = await importPack(dest, { from: out });
  assert.equal(report.atomsInserted, 1);
  assert.equal(report.conflictsQueued, 0);
  const atoms = await dest.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0]!.tier, 'draft', 'imported atoms always start at draft locally');
});

test('importPack: dry-run reports counts without mutating dest', async () => {
  const source = new MemoryKnowledgeStore();
  await source.createAtom({
    project: 'tuberosa',
    claim: 'Use HNSW for ANN search.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'm.sql' }],
    trigger: { symbols: ['hnsw'] },
    producedBy: 'agent_session',
  });
  const out = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(source, { project: 'tuberosa', out });

  const dest = new MemoryKnowledgeStore();
  const report = await importPack(dest, { from: out, dryRun: true });
  assert.equal(report.atomsInserted, 1);
  const atoms = await dest.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 0);
});
