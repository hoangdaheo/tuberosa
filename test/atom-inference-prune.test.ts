import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { pruneStaleEdges } from '../src/atoms/inference/prune.js';

test('pruneStaleEdges: removes edges below the policy floor confidence', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'tuberosa', claim: 'A', type: 'fact',
    evidence: [{ kind: 'file', path: 'x' }], trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'tuberosa', claim: 'B', type: 'fact',
    evidence: [{ kind: 'file', path: 'y' }], trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(
    a.id,
    [{ fromAtomId: a.id, targetAtomId: b.id, relationType: 'related_to', confidence: 0.1, inferenceSource: 'semantic' }],
    { source: 'semantic' },
  );
  const report = await pruneStaleEdges(store, { project: 'tuberosa' });
  assert.equal(report.removed, 1);
  assert.equal((await store.listAtomRelations({ fromAtomId: a.id, limit: 10 })).length, 0);
});

test('pruneStaleEdges: keeps edges above the floor and supports dryRun', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'tuberosa', claim: 'A', type: 'fact',
    evidence: [{ kind: 'file', path: 'x' }], trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'tuberosa', claim: 'B', type: 'fact',
    evidence: [{ kind: 'file', path: 'y' }], trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(
    a.id,
    [
      { fromAtomId: a.id, targetAtomId: b.id, relationType: 'related_to', confidence: 0.8, inferenceSource: 'semantic' },
      { fromAtomId: a.id, targetAtomId: b.id, relationType: 'co_changes_with', confidence: 0.1, inferenceSource: 'semantic' },
    ],
    { source: 'semantic' },
  );
  const dry = await pruneStaleEdges(store, { project: 'tuberosa', dryRun: true });
  assert.equal(dry.removed, 1);
  assert.equal((await store.listAtomRelations({ fromAtomId: a.id, limit: 10 })).length, 2, 'dry run must not delete');

  const real = await pruneStaleEdges(store, { project: 'tuberosa' });
  assert.equal(real.removed, 1);
  const remaining = await store.listAtomRelations({ fromAtomId: a.id, limit: 10 });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.relationType, 'related_to');
});
