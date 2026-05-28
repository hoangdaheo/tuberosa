import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';

test('searchKnowledgeByEmbedding: filters by itemTypes and threshold', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const content = 'pgvector ivfflat tuning uses lists = rowcount / 1000';
  await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u1', itemType: 'memory',
    title: 'pgvector tuning', summary: '', content, labels: [], references: [], metadata: {},
  }, []);
  await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u2', itemType: 'wiki',
    title: 'pgvector wiki', summary: '', content, labels: [], references: [], metadata: {},
  }, []);

  const embedding = await models.embed(content);
  const matchesMemoryOnly = await store.searchKnowledgeByEmbedding(embedding, {
    project: 'tuberosa', limit: 10, threshold: 0.0, itemTypes: ['memory'],
  });
  assert.ok(matchesMemoryOnly.every((m) => m.knowledge.itemType === 'memory'));
  assert.ok(matchesMemoryOnly.length >= 1);
});

test('searchKnowledgeByEmbedding: excludes legacy statuses when asked', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const item = await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u3', itemType: 'memory',
    title: 't', summary: '', content: 'legacy duplicate content', labels: [], references: [], metadata: {},
  }, []);
  await store.updateKnowledge(item.id, { metadata: { ...item.metadata, legacyStatus: 'legacy_replaced' } });

  const embedding = await models.embed('legacy duplicate content');
  const matches = await store.searchKnowledgeByEmbedding(embedding, {
    project: 'tuberosa', limit: 10, threshold: 0.0,
    itemTypes: ['memory'],
    excludeLegacyStatuses: ['legacy_replaced', 'legacy_archived'],
  });
  assert.equal(matches.length, 0);
});

test('countNegativeFeedback: counts within window only', async () => {
  const store = new MemoryKnowledgeStore();
  const item = await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u4', itemType: 'memory',
    title: 't', summary: '', content: 'content', labels: [], references: [], metadata: {},
  }, []);
  await store.recordFeedback({
    project: 'tuberosa', feedbackType: 'rejected',
    rejectedKnowledgeIds: [item.id], reason: 'bad',
  });
  await store.recordFeedback({
    project: 'tuberosa', feedbackType: 'stale',
    rejectedKnowledgeIds: [item.id], reason: 'stale',
  });
  await store.recordFeedback({
    project: 'tuberosa', feedbackType: 'selected', rejectedKnowledgeIds: [],
  });

  const count = await store.countNegativeFeedback(item.id, 90);
  assert.equal(count, 2);
});
