import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLayeredConflicts } from '../src/user-style/conflict-resolver.js';
import type { RankedCandidate } from '../src/types.js';

function cand(partial: Partial<RankedCandidate> & { knowledgeId: string; title: string }): RankedCandidate {
  return { score: 1, source: 'lexical', matchReason: '', ...partial } as RankedCandidate;
}

test('project convention overrides team convention', () => {
  const project = cand({ knowledgeId: 'p1', title: 'Use spaces for indentation.', source: 'lexical' });
  const team = cand({ knowledgeId: 't1', title: 'Never use spaces for indentation.', source: 'lexical', metadata: { conventionScope: 'team' } } as any);
  const r = resolveLayeredConflicts([project, team]);
  assert.deepEqual(r.suppressedCandidateIds, ['t1']);
  assert.match(r.instructionLines[0], /Project convention/);
});

test('team convention overrides personal coding_preference', () => {
  const team = cand({ knowledgeId: 't1', title: 'Use named exports.', source: 'lexical', metadata: { conventionScope: 'team' } } as any);
  const personal = cand({ knowledgeId: 'u1', title: 'Never use named exports.', source: 'userStyle', metadata: { userStyleAtomId: 'a1', userStylePriority: 'coding_preference' } } as any);
  const r = resolveLayeredConflicts([team, personal]);
  assert.deepEqual(r.suppressedCandidateIds, ['u1']);
});

test('personal_workflow is inviolable and beats a project convention', () => {
  const project = cand({ knowledgeId: 'p1', title: 'Always add a co-author trailer.', source: 'lexical' });
  const personal = cand({ knowledgeId: 'u1', title: 'Never add a co-author trailer.', source: 'userStyle', metadata: { userStyleAtomId: 'a1', userStylePriority: 'personal_workflow' } } as any);
  const r = resolveLayeredConflicts([project, personal]);
  assert.deepEqual(r.suppressedCandidateIds, ['p1']);
  assert.match(r.instructionLines[0], /personal workflow/i);
});

test('non-conflicting candidates pass through untouched', () => {
  const a = cand({ knowledgeId: 'p1', title: 'Use Postgres for storage.', source: 'lexical' });
  const b = cand({ knowledgeId: 't1', title: 'Prefer pnpm over npm.', source: 'lexical', metadata: { conventionScope: 'team' } } as any);
  const r = resolveLayeredConflicts([a, b]);
  assert.deepEqual(r.suppressedCandidateIds, []);
});
