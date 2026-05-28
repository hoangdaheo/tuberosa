import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { exportPack } from '../src/export/exporter.js';
import { importPack } from '../src/export/importer.js';

test('importPack: differing local atom queues a conflict; local stays unchanged', async () => {
  const source = new MemoryKnowledgeStore();
  const a = await source.createAtom({
    project: 'tuberosa',
    claim: 'Use HNSW for ANN search.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'm.sql' }],
    trigger: { symbols: ['hnsw'] },
    producedBy: 'agent_session',
  });
  const out = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(source, { project: 'tuberosa', out });

  // Edit the exported atom file so its claim diverges from the source's.
  const atomsDir = join(out, 'atoms');
  const file = (await readdir(atomsDir)).find((f) => f.endsWith('.md'));
  assert.ok(file, 'export should produce an atom file');
  const content = await readFile(join(atomsDir, file!), 'utf8');
  await writeFile(
    join(atomsDir, file!),
    content.replace('Use HNSW for ANN search.', 'Use IVFFlat for ANN search.'),
    'utf8',
  );

  // Receiver has the same atom (same id) with the original claim.
  const dest = new MemoryKnowledgeStore();
  await dest.createAtom({
    id: a.id,
    project: a.project,
    claim: a.claim,
    type: a.type,
    evidence: a.evidence,
    trigger: a.trigger,
    producedBy: 'agent_session',
  });

  const report = await importPack(dest, { from: out });
  assert.equal(report.conflictsQueued, 1, JSON.stringify(report));
  const conflicts = await dest.listAtomImportConflicts({
    project: 'tuberosa',
    status: 'open',
    limit: 10,
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].atomId, a.id);

  // Local atom claim stays unchanged until the conflict is resolved.
  const local = await dest.getAtom(a.id);
  assert.equal(local?.claim, 'Use HNSW for ANN search.');
});

test('importPack: onConflict=skip leaves no queued conflicts', async () => {
  const source = new MemoryKnowledgeStore();
  const a = await source.createAtom({
    project: 'tuberosa',
    claim: 'X.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'm.sql' }],
    trigger: { symbols: ['x'] },
    producedBy: 'agent_session',
  });
  const out = await mkdtemp(join(tmpdir(), 'tpack-'));
  await exportPack(source, { project: 'tuberosa', out });
  const atomsDir = join(out, 'atoms');
  const file = (await readdir(atomsDir)).find((f) => f.endsWith('.md'))!;
  const content = await readFile(join(atomsDir, file), 'utf8');
  await writeFile(join(atomsDir, file), content.replace('X.', 'Y.'), 'utf8');

  const dest = new MemoryKnowledgeStore();
  await dest.createAtom({
    id: a.id,
    project: a.project,
    claim: a.claim,
    type: a.type,
    evidence: a.evidence,
    trigger: a.trigger,
    producedBy: 'agent_session',
  });

  const report = await importPack(dest, { from: out, onConflict: 'skip' });
  assert.equal(report.conflictsQueued, 0);
  const conflicts = await dest.listAtomImportConflicts({ project: 'tuberosa', limit: 10 });
  assert.equal(conflicts.length, 0);
});
