import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_TRIVIALITY_RULES, evaluateTriviality, contentWords } from '../src/atoms/triviality-rules.js';
import type { KnowledgeAtomInput } from '../src/types/atoms.js';

function input(claim: string, trigger: KnowledgeAtomInput['trigger'] = { errors: ['foo'] }): KnowledgeAtomInput {
  return {
    project: 'tuberosa',
    claim,
    type: 'fact',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger,
    producedBy: 'agent_session',
  };
}

test('triviality: rejects "ran X, passed" claim', () => {
  const r = evaluateTriviality(input('ran pnpm test, all 247 tests passed'));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('test_result'));
});

test('triviality: rejects "updated docs/foo.md" claim', () => {
  const r = evaluateTriviality(input('updated docs/foo.md'));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('doc_update_announcement'));
});

test('triviality: rejects "committed changes" claim', () => {
  const r = evaluateTriviality(input('committed changes to retrieval'));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('commit_status'));
});

test('triviality: rejects bare rename announcement', () => {
  const r = evaluateTriviality(input('renamed fooBar.'));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('rename_announcement'));
});

test('triviality: rejects atom whose trigger has only taskTypes', () => {
  const r = evaluateTriviality(input('Some claim with enough words here.', { taskTypes: ['refactor'] }));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('no_concrete_trigger'));
});

test('triviality: rejects sparse claim under 5 content words', () => {
  const r = evaluateTriviality(input('Be careful.'));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('sparse_claim'));
});

test('triviality: accepts a real gotcha claim', () => {
  const r = evaluateTriviality(input('pgvector column dim must equal EMBEDDING_DIMENSIONS in config.'));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('contentWords: filters short and stop words', () => {
  assert.deepEqual(contentWords('The quick brown fox is on the mat.'), ['quick', 'brown', 'fox', 'mat']);
});

test('DEFAULT_TRIVIALITY_RULES is the exported rule set', () => {
  assert.ok(DEFAULT_TRIVIALITY_RULES.length >= 6);
});
