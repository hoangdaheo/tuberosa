import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { runArchivalSweep } from '../src/atoms/archival.js';

const NOW = new Date('2027-05-26T00:00:00Z');

async function makeAtom(
  store: MemoryKnowledgeStore,
  overrides: Partial<{ tier: 'draft' | 'verified' | 'canonical'; lastReusedAt?: string }> = {},
) {
  const atom = await store.createAtom({
    project: 'tuberosa', claim: 'something useful for tests',
    type: 'fact', evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });
  await store.updateAtom(atom.id, { tier: overrides.tier ?? 'draft', lastReusedAt: overrides.lastReusedAt });
  return atom;
}

test('archival: time-archives a draft atom with no reuse in >365 days', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await makeAtom(store, { tier: 'draft', lastReusedAt: '2026-01-01T00:00:00Z' });
  const report = await runArchivalSweep(store, NOW);
  assert.ok(report.archivedByTime.includes(atom.id));
  assert.equal((await store.getAtom(atom.id))?.status, 'archived');
});

test('archival: does NOT time-archive a verified atom', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await makeAtom(store, { tier: 'verified', lastReusedAt: '2025-01-01T00:00:00Z' });
  await runArchivalSweep(store, NOW);
  assert.equal((await store.getAtom(atom.id))?.status, 'active');
});

test('archival: signal-archives any tier atom with ≥3 negative feedback in 90 days', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await makeAtom(store, { tier: 'verified', lastReusedAt: NOW.toISOString() });
  for (let i = 0; i < 3; i += 1) {
    await store.recordFeedback({
      project: 'tuberosa', feedbackType: 'rejected',
      rejectedKnowledgeIds: [atom.id], reason: 'nope',
    });
  }
  const report = await runArchivalSweep(store, NOW);
  assert.ok(report.archivedBySignal.includes(atom.id));
});

test('archival: canonical atoms need ≥5 negative signals before signal-archive', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await makeAtom(store, { tier: 'canonical', lastReusedAt: NOW.toISOString() });
  for (let i = 0; i < 4; i += 1) {
    await store.recordFeedback({
      project: 'tuberosa', feedbackType: 'rejected',
      rejectedKnowledgeIds: [atom.id], reason: 'r',
    });
  }
  let report = await runArchivalSweep(store, NOW);
  assert.equal(report.archivedBySignal.length, 0);
  await store.recordFeedback({
    project: 'tuberosa', feedbackType: 'rejected',
    rejectedKnowledgeIds: [atom.id], reason: 'r',
  });
  report = await runArchivalSweep(store, NOW);
  assert.ok(report.archivedBySignal.includes(atom.id));
});

test('archival: dryRun reports candidates without mutating status', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await makeAtom(store, { tier: 'draft', lastReusedAt: '2026-01-01T00:00:00Z' });
  const report = await runArchivalSweep(store, NOW, { dryRun: true });
  assert.ok(report.archivedByTime.includes(atom.id));
  assert.equal((await store.getAtom(atom.id))?.status, 'active');
});

test('resurrection: flipping status back to active immediately resurfaces in retrieval', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await makeAtom(store, { tier: 'draft', lastReusedAt: '2026-01-01T00:00:00Z' });
  await runArchivalSweep(store, NOW);
  assert.equal((await store.getAtom(atom.id))?.status, 'archived');

  await store.updateAtom(atom.id, { status: 'active', lastReusedAt: NOW.toISOString() });
  const refreshed = await store.getAtom(atom.id);
  assert.equal(refreshed?.status, 'active');
  assert.equal(refreshed?.lastReusedAt, NOW.toISOString());
});
