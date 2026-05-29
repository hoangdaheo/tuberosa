import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { gatherAtlasInputs } from '../src/atlas/inputs.js';

test('gatherAtlasInputs: builds area-dependency edges from cross-area depends_on', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/a/x.ts', contentHash: 'h', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'src/b/y.ts', contentHash: 'h', status: 'tracked' });
  const a = await store.createAtom({
    project: 'p', claim: 'A', type: 'fact', evidence: [{ kind: 'file', path: 'src/a/x.ts' }],
    trigger: { files: ['src/a/x.ts'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'p', claim: 'B', type: 'fact', evidence: [{ kind: 'file', path: 'src/b/y.ts' }],
    trigger: { files: ['src/b/y.ts'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(
    a.id,
    [{ fromAtomId: a.id, targetAtomId: b.id, relationType: 'depends_on', confidence: 0.9, inferenceSource: 'semantic' }],
    { source: 'semantic' },
  );

  const inputs = await gatherAtlasInputs(store, { project: 'p', repoPath: process.cwd(), generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(inputs.areaDeps, [{ from: 'src/a', to: 'src/b', weight: 1 }]);
  assert.equal(inputs.generatedAt, '2026-01-01T00:00:00.000Z');
  assert.ok(inputs.areas.length >= 2);
});

test('gatherAtlasInputs: intra-area relations produce no area edge', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'p', claim: 'A', type: 'fact', evidence: [{ kind: 'file', path: 'src/a/x.ts' }],
    trigger: { files: ['src/a/x.ts'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'p', claim: 'B', type: 'fact', evidence: [{ kind: 'file', path: 'src/a/z.ts' }],
    trigger: { files: ['src/a/z.ts'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(
    a.id,
    [{ fromAtomId: a.id, targetAtomId: b.id, relationType: 'refines', confidence: 0.5, inferenceSource: 'semantic' }],
    { source: 'semantic' },
  );
  const inputs = await gatherAtlasInputs(store, { project: 'p', repoPath: process.cwd(), generatedAt: 't' });
  assert.deepEqual(inputs.areaDeps, []);
});
