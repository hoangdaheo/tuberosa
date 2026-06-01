import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('searchAtomsByTrigger filters team atoms by teamId', async () => {
  const store = new MemoryKnowledgeStore();
  await store.createAtom({
    project: 'demo', claim: 'Team A uses tabs', type: 'convention',
    evidence: [], trigger: { taskTypes: ['implementation'] }, producedBy: 'user',
    scope: 'team', teamId: 'team-a',
  });
  await store.createAtom({
    project: 'demo', claim: 'Team B uses spaces', type: 'convention',
    evidence: [], trigger: { taskTypes: ['implementation'] }, producedBy: 'user',
    scope: 'team', teamId: 'team-b',
  });
  const a = await store.searchAtomsByTrigger(
    { taskTypes: ['implementation'] },
    { project: undefined, scope: 'team', teamId: 'team-a', limit: 10 },
  );
  assert.equal(a.length, 1);
  assert.equal(a[0].teamId, 'team-a');
});
