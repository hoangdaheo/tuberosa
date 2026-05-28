import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { DEFAULT_POLICY } from '../src/retrieval/policy.js';
import type { AtomRelationInput } from '../src/storage/store.js';
import type { AtomLinkKind } from '../src/types/atoms.js';

async function makeAtom(store: MemoryKnowledgeStore, claim: string) {
  return store.createAtom({
    project: 'tuberosa',
    claim,
    type: 'fact',
    evidence: [{ kind: 'file', path: `${claim}.ts` }],
    trigger: { errors: ['e'] },
    producedBy: 'agent_session',
  });
}

async function linkAtoms(
  store: MemoryKnowledgeStore,
  from: string,
  to: string,
  kind: AtomLinkKind,
  confidence = 0.9,
) {
  const input: AtomRelationInput = {
    fromAtomId: from,
    targetAtomId: to,
    relationType: kind,
    confidence,
    inferenceSource: 'manual',
  };
  await store.replaceAtomRelations(from, [input], { source: 'manual' });
}

test('walkAtomGraph: returns 1-hop neighbors for depth=1', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await makeAtom(store, 'A');
  const b = await makeAtom(store, 'B');
  const c = await makeAtom(store, 'C');
  await linkAtoms(store, a.id, b.id, 'related_to');
  await linkAtoms(store, b.id, c.id, 'related_to');

  const hits = await store.walkAtomGraph({
    project: 'tuberosa',
    seedAtomIds: [a.id],
    depth: 1,
    limit: 10,
    edgeWeights: DEFAULT_POLICY.graph.edgeWeights,
    decayPerHop: DEFAULT_POLICY.graph.decayPerHop,
  });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].atomId, b.id);
});

test('walkAtomGraph: returns depth-2 hits with decayed pathScore', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await makeAtom(store, 'A');
  const b = await makeAtom(store, 'B');
  const c = await makeAtom(store, 'C');
  await linkAtoms(store, a.id, b.id, 'related_to', 0.9);
  await linkAtoms(store, b.id, c.id, 'related_to', 0.9);

  const hits = await store.walkAtomGraph({
    project: 'tuberosa',
    seedAtomIds: [a.id],
    depth: 2,
    limit: 10,
    edgeWeights: { ...DEFAULT_POLICY.graph.edgeWeights, related_to: 0.4 },
    decayPerHop: 0.6,
  });

  const hopC = hits.find((h) => h.atomId === c.id);
  assert.ok(hopC, 'expected C at depth 2');
  // A→B (0.4) then B→C (0.4 × 0.6) → pathScore ≈ 0.096
  assert.ok(hopC.pathScore > 0 && hopC.pathScore < 0.2);
  assert.equal(hopC.path.length, 2);
  assert.equal(hopC.path[0].atomId, b.id);
  assert.equal(hopC.path[1].atomId, c.id);
});

test('walkAtomGraph: excludes archived atoms by default', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await makeAtom(store, 'A');
  const b = await makeAtom(store, 'B');
  await store.updateAtom(b.id, { status: 'archived' });
  await linkAtoms(store, a.id, b.id, 'related_to');

  const hits = await store.walkAtomGraph({
    project: 'tuberosa',
    seedAtomIds: [a.id],
    depth: 1,
    limit: 10,
    edgeWeights: DEFAULT_POLICY.graph.edgeWeights,
    decayPerHop: DEFAULT_POLICY.graph.decayPerHop,
  });

  assert.equal(hits.length, 0);
});

test('walkAtomGraph: zero-weight edge kind drops the hop', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await makeAtom(store, 'A');
  const b = await makeAtom(store, 'B');
  await linkAtoms(store, a.id, b.id, 'supersedes');

  const hits = await store.walkAtomGraph({
    project: 'tuberosa',
    seedAtomIds: [a.id],
    depth: 2,
    limit: 10,
    edgeWeights: DEFAULT_POLICY.graph.edgeWeights, // supersedes: 0
    decayPerHop: DEFAULT_POLICY.graph.decayPerHop,
  });

  assert.equal(hits.length, 0);
});

test('walkAtomGraph: respects limit and sorts by pathScore desc', async () => {
  const store = new MemoryKnowledgeStore();
  const seed = await makeAtom(store, 'seed');
  const refines = await makeAtom(store, 'refines');
  const related = await makeAtom(store, 'related');
  // refines weight (0.7) > related_to weight (0.4) — refines should rank first.
  await store.replaceAtomRelations(
    seed.id,
    [
      {
        fromAtomId: seed.id,
        targetAtomId: refines.id,
        relationType: 'refines',
        confidence: 0.9,
        inferenceSource: 'manual',
      },
      {
        fromAtomId: seed.id,
        targetAtomId: related.id,
        relationType: 'related_to',
        confidence: 0.9,
        inferenceSource: 'manual',
      },
    ],
    { source: 'manual' },
  );

  const hits = await store.walkAtomGraph({
    project: 'tuberosa',
    seedAtomIds: [seed.id],
    depth: 1,
    limit: 1,
    edgeWeights: DEFAULT_POLICY.graph.edgeWeights,
    decayPerHop: DEFAULT_POLICY.graph.decayPerHop,
  });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].atomId, refines.id);
});
