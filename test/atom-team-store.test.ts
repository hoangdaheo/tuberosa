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
