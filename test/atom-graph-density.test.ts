import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { computeAtomGraphDensity } from '../src/operations/atom-graph-density.js';

test('computeAtomGraphDensity: counts atoms + edges by kind and source', async () => {
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
    [{ fromAtomId: a.id, targetAtomId: b.id, relationType: 'related_to', confidence: 0.8, inferenceSource: 'semantic' }],
    { source: 'semantic' },
  );
  await store.replaceAtomRelations(
    a.id,
    [{ fromAtomId: a.id, targetAtomId: b.id, relationType: 'co_changes_with', confidence: 0.5, inferenceSource: 'co_change' }],
    { source: 'co_change' },
  );

  const density = await computeAtomGraphDensity(store, { project: 'tuberosa' });
  assert.equal(density.atoms, 2);
  assert.equal(density.edges, 2);
  assert.equal(density.byKind.related_to, 1);
  assert.equal(density.byKind.co_changes_with, 1);
  assert.equal(density.bySource.semantic, 1);
  assert.equal(density.bySource.co_change, 1);
  assert.equal(density.edgesPerAtom, 1);
});

test('computeAtomGraphDensity: scopes by project', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'tuberosa', claim: 'A', type: 'fact',
    evidence: [{ kind: 'file', path: 'x' }], trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });
  const other = await store.createAtom({
    project: 'other', claim: 'O', type: 'fact',
    evidence: [{ kind: 'file', path: 'y' }], trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(
    other.id,
    [{ fromAtomId: other.id, targetAtomId: a.id, relationType: 'related_to', confidence: 0.8, inferenceSource: 'semantic' }],
    { source: 'semantic' },
  );
  const density = await computeAtomGraphDensity(store, { project: 'tuberosa' });
  assert.equal(density.atoms, 1);
  assert.equal(density.edges, 0, 'edges from other-project atoms must not be counted');
});
