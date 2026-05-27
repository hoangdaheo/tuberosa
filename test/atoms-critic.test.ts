import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { AtomCritic } from '../src/atoms/critic.js';
import type { KnowledgeAtomInput } from '../src/types/atoms.js';

const GOOD: KnowledgeAtomInput = {
  project: 'tuberosa',
  claim: 'EMBEDDING_DIMENSIONS must equal the vector(N) column dim.',
  type: 'fact',
  evidence: [{ kind: 'commit', sha: 'deadbeef', message: 'init schema' }],
  trigger: { errors: ['vector dimension mismatch'] },
  producedBy: 'agent_session',
};

function makeCritic() {
  return new AtomCritic(new MemoryKnowledgeStore(), new HashModelProvider());
}

test('AtomCritic.evaluate: accepts well-formed atom', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate(GOOD);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('AtomCritic.evaluate: rejects atom with empty claim', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate({ ...GOOD, claim: '' });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('claim')));
});

test('AtomCritic.evaluate: rejects atom with no evidence', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate({ ...GOOD, evidence: [] });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('evidence')));
});

test('AtomCritic.evaluate: rejects atom with empty trigger', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate({ ...GOOD, trigger: {} });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('trigger')));
});

test('AtomCritic.evaluate: rejects atom whose claim restates the trigger', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate({
    ...GOOD,
    claim: 'vector dimension mismatch',
    trigger: { errors: ['vector dimension mismatch'] },
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes('restate')));
});

test('AtomCritic.evaluate: rejects atom whose claim is longer than 240 chars', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate({ ...GOOD, claim: 'x'.repeat(241) });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('240')));
});

test('AtomCritic.evaluate: rejects a near-duplicate of an existing atom in the same project', async () => {
  const store = new MemoryKnowledgeStore();
  const critic = new AtomCritic(store, new HashModelProvider(), { dedupCosineThreshold: 0.0 });
  await store.createAtom(GOOD);
  const result = await critic.evaluate(GOOD);
  // With threshold 0, ANY existing atom in the project is treated as a duplicate.
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('duplicate')));
});
