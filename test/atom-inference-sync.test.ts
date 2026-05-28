import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { syncAtomLinks } from '../src/atoms/inference/sync.js';
import type { KnowledgeAtom } from '../src/types/atoms.js';

async function makeAtom(store: MemoryKnowledgeStore, claim: string): Promise<KnowledgeAtom> {
  return store.createAtom({
    project: 'tuberosa',
    claim,
    type: 'fact',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['e'] },
    producedBy: 'agent_session',
  });
}

test('syncAtomLinks: writes both atom.links JSONB and knowledge_relations rows', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await makeAtom(store, 'A');
  const b = await makeAtom(store, 'B');

  await syncAtomLinks(
    a.id,
    [{ toAtomId: b.id, kind: 'related_to', confidence: 0.85 }],
    store,
    'semantic',
  );

  const refreshed = await store.getAtom(a.id);
  assert.equal(refreshed?.links?.length, 1);
  assert.equal(refreshed?.links?.[0].toAtomId, b.id);
  assert.equal(refreshed?.links?.[0].kind, 'related_to');

  const rels = await store.listAtomRelations({ fromAtomId: a.id, limit: 10 });
  assert.equal(rels.length, 1);
  assert.equal(rels[0].targetAtomId, b.id);
  assert.equal(rels[0].relationType, 'related_to');
  assert.equal(rels[0].inferenceSource, 'semantic');
});

test('syncAtomLinks: re-sync with same source replaces only that source\'s edges', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await makeAtom(store, 'A');
  const b = await makeAtom(store, 'B');
  const c = await makeAtom(store, 'C');

  await syncAtomLinks(a.id, [{ toAtomId: b.id, kind: 'related_to', confidence: 0.85 }], store, 'semantic');
  await syncAtomLinks(a.id, [{ toAtomId: c.id, kind: 'co_changes_with', confidence: 0.7 }], store, 'co_change');

  // Re-running semantic with a different target must NOT delete the co_change row.
  await syncAtomLinks(a.id, [{ toAtomId: c.id, kind: 'related_to', confidence: 0.8 }], store, 'semantic');

  const all = await store.listAtomRelations({ fromAtomId: a.id, limit: 10 });
  assert.equal(all.length, 2);
  assert.ok(all.some((r) => r.relationType === 'co_changes_with' && r.inferenceSource === 'co_change'));
  assert.ok(all.some((r) => r.relationType === 'related_to' && r.targetAtomId === c.id && r.inferenceSource === 'semantic'));

  const refreshed = await store.getAtom(a.id);
  assert.equal(refreshed?.links?.length, 2);
});

test('pruneStaleAtomRelations: removes edges below floor confidence', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await makeAtom(store, 'A');
  const b = await makeAtom(store, 'B');
  await store.replaceAtomRelations(
    a.id,
    [{ fromAtomId: a.id, targetAtomId: b.id, relationType: 'related_to', confidence: 0.1, inferenceSource: 'semantic' }],
    { source: 'semantic' },
  );
  const report = await store.pruneStaleAtomRelations({ floorConfidence: 0.25 });
  assert.equal(report.removed, 1);
  const rels = await store.listAtomRelations({ fromAtomId: a.id, limit: 10 });
  assert.equal(rels.length, 0);
});
