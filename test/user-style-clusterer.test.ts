import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { clusterUserCorrections } from '../src/user-style/clusterer.js';

test('clusterUserCorrections: 3 similar correction events produce one user_style_candidate proposal', async () => {
  const store = new MemoryKnowledgeStore();
  for (let i = 0; i < 3; i += 1) {
    await store.recordFeedback({
      project: 'tuberosa',
      feedbackType: 'rejected',
      rejectedKnowledgeIds: [],
      reason: 'Stop adding JSDoc to trivial setters.',
      metadata: { userId: 'alice@example.com' },
    });
  }
  const report = await clusterUserCorrections(store, new HashModelProvider(), {
    userId: 'alice@example.com',
    windowDays: 30,
    minClusterEvents: 3,
  });
  assert.equal(report.proposalsCreated, 1);
  const proposals = await store.listLearningProposals({ project: undefined, status: 'open', limit: 10 });
  assert.ok(
    proposals.some((p) =>
      p.proposalType === 'user_style_candidate'
      || (p.metadata as { source?: string }).source === 'user_style_clusterer',
    ),
  );
});

test('clusterUserCorrections: below min cluster threshold produces no proposal', async () => {
  const store = new MemoryKnowledgeStore();
  for (let i = 0; i < 2; i += 1) {
    await store.recordFeedback({
      project: 'tuberosa',
      feedbackType: 'rejected',
      rejectedKnowledgeIds: [],
      reason: 'Avoid JSDoc.',
      metadata: { userId: 'alice@example.com' },
    });
  }
  const report = await clusterUserCorrections(store, new HashModelProvider(), {
    userId: 'alice@example.com',
    windowDays: 30,
    minClusterEvents: 3,
  });
  assert.equal(report.proposalsCreated, 0);
});

test('clusterUserCorrections: events for other users are ignored', async () => {
  const store = new MemoryKnowledgeStore();
  for (let i = 0; i < 3; i += 1) {
    await store.recordFeedback({
      project: 'tuberosa',
      feedbackType: 'rejected',
      rejectedKnowledgeIds: [],
      reason: 'Stop adding JSDoc.',
      metadata: { userId: 'bob@example.com' },
    });
  }
  const report = await clusterUserCorrections(store, new HashModelProvider(), {
    userId: 'alice@example.com',
    windowDays: 30,
    minClusterEvents: 3,
  });
  assert.equal(report.proposalsCreated, 0);
  assert.equal(report.scannedEvents, 0);
});
