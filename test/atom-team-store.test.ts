import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('memory store persists team-scope atom and filters by teamId', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await store.createAtom({
    project: 'demo', claim: 'Use Conventional Commits', type: 'convention',
    evidence: [], trigger: {}, producedBy: 'user', scope: 'team', teamId: 'default',
  });
  assert.equal(atom.scope, 'team');
  assert.equal(atom.teamId, 'default');
  assert.equal(atom.userId, undefined);

  const hit = await store.listAtoms({ limit: 10, scope: 'team', teamId: 'default' });
  assert.equal(hit.length, 1);
  const miss = await store.listAtoms({ limit: 10, scope: 'team', teamId: 'other' });
  assert.equal(miss.length, 0);
});

test('memory store isolates atoms across two different teams', async () => {
  const store = new MemoryKnowledgeStore();
  await store.createAtom({
    project: 'demo', claim: 'Team A: squash merges only', type: 'convention',
    evidence: [], trigger: {}, producedBy: 'user', scope: 'team', teamId: 'team-a',
  });
  await store.createAtom({
    project: 'demo', claim: 'Team B: rebase and merge', type: 'convention',
    evidence: [], trigger: {}, producedBy: 'user', scope: 'team', teamId: 'team-b',
  });

  const a = await store.listAtoms({ limit: 10, scope: 'team', teamId: 'team-a' });
  const b = await store.listAtoms({ limit: 10, scope: 'team', teamId: 'team-b' });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0]!.teamId, 'team-a');
  assert.equal(b[0]!.teamId, 'team-b');
  assert.notEqual(a[0]!.id, b[0]!.id);
});
