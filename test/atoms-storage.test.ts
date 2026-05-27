import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type { KnowledgeAtomInput } from '../src/types/atoms.js';

const BASE_INPUT: KnowledgeAtomInput = {
  project: 'tuberosa',
  claim: 'EMBEDDING_DIMENSIONS must equal the vector(N) column dim.',
  type: 'fact',
  evidence: [{ kind: 'file', path: 'migrations/001_init.sql', lineStart: 14 }],
  trigger: { errors: ['vector dimension mismatch'] },
  producedBy: 'agent_session',
  producedAtSessionId: undefined,
};

test('MemoryKnowledgeStore: createAtom returns an atom at draft tier with reuseCount=0', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await store.createAtom(BASE_INPUT);
  assert.equal(atom.tier, 'draft');
  assert.equal(atom.reuseCount, 0);
  assert.equal(atom.status, 'active');
  assert.equal(atom.project, 'tuberosa');
  assert.equal(atom.claim, BASE_INPUT.claim);
  assert.ok(atom.id);
  assert.ok(atom.audit.createdAt);
});

test('MemoryKnowledgeStore: getAtom returns the stored atom', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.createAtom(BASE_INPUT);
  const fetched = await store.getAtom(created.id);
  assert.deepEqual(fetched, created);
});

test('MemoryKnowledgeStore: listAtoms filters by project and tier', async () => {
  const store = new MemoryKnowledgeStore();
  await store.createAtom(BASE_INPUT);
  await store.createAtom({ ...BASE_INPUT, project: 'other-project' });
  const found = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(found.length, 1);
  assert.equal(found[0].project, 'tuberosa');
});

test('MemoryKnowledgeStore: updateAtom mutates tier and reuseCount', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.createAtom(BASE_INPUT);
  const updated = await store.updateAtom(created.id, { tier: 'verified', reuseCount: 2 });
  assert.equal(updated?.tier, 'verified');
  assert.equal(updated?.reuseCount, 2);
});

test('MemoryKnowledgeStore: incrementAtomReuse bumps the counter and sets lastReusedAt', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.createAtom(BASE_INPUT);
  const when = '2026-05-26T00:00:00.000Z';
  const updated = await store.incrementAtomReuse(created.id, when);
  assert.equal(updated?.reuseCount, 1);
  assert.equal(updated?.lastReusedAt, when);
});

test('MemoryKnowledgeStore: deleteAtom removes the atom', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.createAtom(BASE_INPUT);
  const removed = await store.deleteAtom(created.id);
  assert.equal(removed, true);
  assert.equal(await store.getAtom(created.id), undefined);
});

test('MemoryKnowledgeStore: searchAtomsByTrigger matches errors substrings case-insensitively', async () => {
  const store = new MemoryKnowledgeStore();
  await store.createAtom(BASE_INPUT);
  const found = await store.searchAtomsByTrigger(
    { errors: ['VECTOR DIMENSION MISMATCH'] },
    { project: 'tuberosa', limit: 10 },
  );
  assert.equal(found.length, 1);
});
