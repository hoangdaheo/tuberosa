import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { loadConfig } from '../src/config.js';
import type { LearningProposal } from '../src/types.js';
import type { LearningProposalInput } from '../src/types/operations.js';

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

test('recordFeedback fan-out rolls back all learning writes when one proposal throws', async () => {
  // Store whose 2nd createLearningProposal throws — without a transaction the
  // 1st proposal would persist; withTransaction must discard it.
  class FlakyStore extends MemoryKnowledgeStore {
    public proposalCalls = 0;
    override async createLearningProposal(input: LearningProposalInput): Promise<LearningProposal> {
      this.proposalCalls += 1;
      if (this.proposalCalls === 2) {
        throw new Error('proposal-write-boom');
      }
      return super.createLearningProposal(input);
    }
  }

  const store = new FlakyStore();
  const cache = new MemoryCache();
  const provider = new HashModelProvider(loadConfig().model.embeddingDimensions);
  const retrieval = new RetrievalService(store, cache, provider, loadConfig());

  // 'rejected' feedback over two knowledge ids => two createLearningProposal calls.
  await assert.rejects(
    retrieval.recordFeedback({
      project: 'phase-tx',
      feedbackType: 'rejected',
      rejectedKnowledgeIds: ['k-one', 'k-two'],
      reason: 'both should be reviewed',
    }),
    /proposal-write-boom/,
  );

  assert.equal(store.proposalCalls, 2, 'fan-out should have attempted two proposal writes');
  const proposals = await store.listLearningProposals({ project: 'phase-tx', limit: 100 });
  assert.equal(proposals.length, 0, 'the first proposal must be rolled back, leaving zero partial writes');

  // The anchor FeedbackEvent (recorded OUTSIDE the tx) must still persist.
  const events = await store.listFeedbackEvents({ project: 'phase-tx', limit: 100 });
  assert.equal(events.length, 1, 'the anchor feedback event stays committed outside the transaction');
});
