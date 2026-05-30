import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('withTransaction commits on success', async () => {
  const store = new MemoryKnowledgeStore();
  const gap = await store.withTransaction(async (tx) =>
    tx.createKnowledgeGap({ project: 'p', prompt: 'x', missingSignals: [] }));
  assert.ok(gap.id);
  assert.ok(await store.getKnowledgeGap(gap.id));
});

test('withTransaction rolls back all writes on throw', async () => {
  const store = new MemoryKnowledgeStore();
  const before = await store.listKnowledgeGaps({ project: 'p', limit: 100 });
  await assert.rejects(
    store.withTransaction(async (tx) => {
      await tx.createKnowledgeGap({ project: 'p', prompt: 'a', missingSignals: [] });
      await tx.createKnowledgeGap({ project: 'p', prompt: 'b', missingSignals: [] });
      throw new Error('boom');
    }),
    /boom/,
  );
  const after = await store.listKnowledgeGaps({ project: 'p', limit: 100 });
  assert.equal(after.length, before.length, 'no gaps should persist after rollback');
});

test('withTransaction rollback restores a pre-existing mutated collection', async () => {
  const store = new MemoryKnowledgeStore();
  // Seed a gap outside the transaction; it must survive a later rollback intact.
  const seed = await store.createKnowledgeGap({ project: 'p', prompt: 'seed', missingSignals: [] });
  await assert.rejects(
    store.withTransaction(async (tx) => {
      await tx.createKnowledgeGap({ project: 'p', prompt: 'extra', missingSignals: [] });
      await tx.createLearningProposal({
        project: 'p',
        proposalType: 'missing_label',
        reason: 'r',
        evidence: [],
      });
      throw new Error('boom');
    }),
    /boom/,
  );
  const gaps = await store.listKnowledgeGaps({ project: 'p', limit: 100 });
  assert.equal(gaps.length, 1, 'only the pre-transaction seed gap should remain');
  assert.equal(gaps[0]?.id, seed.id);
  const proposals = await store.listLearningProposals({ project: 'p', limit: 100 });
  assert.equal(proposals.length, 0, 'no proposals should persist after rollback');
});
