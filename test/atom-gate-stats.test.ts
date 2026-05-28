import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { computeAtomGateStats } from '../src/operations/atom-gate-stats.js';

async function record(
  store: MemoryKnowledgeStore,
  claim: string,
  stage: 'triviality' | 'floor' | 'dedup' | 'llm_critic',
  outcome: 'accepted' | 'rejected',
  reasons: string[] = [],
) {
  await store.recordAtomGateEvent({
    project: 'tuberosa', candidateClaim: claim, candidateType: 'fact',
    stage, outcome, reasons,
  });
}

test('computeAtomGateStats: aggregates totals, per-stage rejections, and top triviality patterns', async () => {
  const store = new MemoryKnowledgeStore();
  await record(store, 'a', 'triviality', 'rejected', ['triviality:test_result']);
  await record(store, 'b', 'triviality', 'rejected', ['triviality:test_result']);
  await record(store, 'c', 'triviality', 'rejected', ['triviality:commit_status']);
  await record(store, 'd', 'floor', 'accepted', []);
  await record(store, 'e', 'floor', 'rejected', ['claim is empty']);
  const stats = await computeAtomGateStats(store, { project: 'tuberosa', windowDays: 7 });
  assert.equal(stats.totalCandidates, 5);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.rejected.triviality, 3);
  assert.equal(stats.rejected.floor, 1);
  assert.deepEqual(stats.topTrivialityPatterns[0], { pattern: 'test_result', count: 2 });
});

test('computeAtomGateStats: emits "too strict" hint when acceptance < 30%', async () => {
  const store = new MemoryKnowledgeStore();
  for (let i = 0; i < 10; i += 1) await record(store, `x${i}`, 'triviality', 'rejected', ['triviality:sparse_claim']);
  await record(store, 'good', 'floor', 'accepted', []);
  const stats = await computeAtomGateStats(store, { project: 'tuberosa', windowDays: 7 });
  assert.ok(stats.alertHints.some((h) => h.text.toLowerCase().includes('too strict')));
});

test('computeAtomGateStats: counts queue_legacy_migration and pending separately', async () => {
  const store = new MemoryKnowledgeStore();
  await store.recordAtomGateEvent({
    project: 'tuberosa', candidateClaim: 'q', candidateType: 'fact',
    stage: 'dedup', outcome: 'queue_legacy_migration', reasons: ['near-duplicate of legacy'],
  });
  await store.recordAtomGateEvent({
    project: 'tuberosa', candidateClaim: 'p', candidateType: 'fact',
    stage: 'llm_critic', outcome: 'pending', reasons: ['provider_missing_judgeAtomUtility'],
  });
  const stats = await computeAtomGateStats(store, { project: 'tuberosa', windowDays: 7 });
  assert.equal(stats.queuedLegacyMigration, 1);
  assert.equal(stats.pendingLlmCritic, 1);
});
