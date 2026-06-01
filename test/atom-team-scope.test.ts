import test from 'node:test';
import assert from 'node:assert/strict';
import type { AtomScope, KnowledgeAtom, KnowledgeAtomInput, ListAtomsOptions } from '../src/types/atoms.ts';

test('AtomScope accepts team and atom carries teamId', () => {
  const scope: AtomScope = 'team';
  const input: KnowledgeAtomInput = {
    project: 'demo', claim: 'Use Conventional Commits', type: 'convention',
    evidence: [], trigger: {}, producedBy: 'user', scope, teamId: 'default',
  };
  assert.equal(input.scope, 'team');
  assert.equal(input.teamId, 'default');
  const atom = { scope, teamId: 'default' } as Pick<KnowledgeAtom, 'scope' | 'teamId'>;
  assert.equal(atom.teamId, 'default');
  const opts: ListAtomsOptions = { limit: 10, scope: 'team', teamId: 'default' };
  assert.equal(opts.teamId, 'default');
});
