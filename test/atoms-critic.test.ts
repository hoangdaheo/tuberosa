import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { AtomCritic } from '../src/atoms/critic.js';
import { MemoryCache } from '../src/cache.js';
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
  // Stage 1 (triviality) now rejects sparse claims, so to reach the floor's
  // verbatim-restatement rule the claim/trigger token must be content-rich.
  const phrase = 'retrieval fusion stage must always normalize candidate scores';
  const result = await critic.evaluate({
    ...GOOD,
    claim: phrase,
    trigger: { errors: [phrase] },
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes('restate')));
});

test('AtomCritic.evaluate: rejects atom whose claim is longer than 240 chars', async () => {
  const critic = makeCritic();
  // Content-rich (not sparse) so it passes stage 1 and is rejected by the floor's
  // length rule rather than triviality.
  const result = await critic.evaluate({ ...GOOD, claim: 'alpha beta gamma delta epsilon '.repeat(9) });
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

test('AtomCritic.evaluate: triviality stage rejects "ran tests" claim before floor runs', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const critic = new AtomCritic(store, new HashModelProvider(), { cache });
  const result = await critic.evaluate({
    project: 'tuberosa',
    claim: 'ran pnpm test, all tests passed',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['none'] },
    producedBy: 'agent_session',
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'rejected');
  assert.ok(result.reasons.some((r) => r.startsWith('triviality:')));
});

test('AtomCritic.evaluate: writes one telemetry row per evaluation', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const critic = new AtomCritic(store, new HashModelProvider(), { cache });
  await critic.evaluate(GOOD);
  const events = await store.listAtomGateEvents({ project: 'tuberosa', windowDays: 30, limit: 100 });
  assert.ok(events.length >= 1);
  assert.equal(events[0].outcome, 'accepted');
});

test('AtomCritic.evaluate: cross-type dedup detects legacy memory and returns queue_legacy_migration', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const critic = new AtomCritic(store, new HashModelProvider(), { cache, legacyDedupThreshold: 0.0 });
  await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u', itemType: 'memory',
    title: 'legacy', summary: '', content: GOOD.claim, labels: [], references: [], metadata: {},
  }, []);
  const result = await critic.evaluate(GOOD);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'queue_legacy_migration');
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes('legacy')));
});
