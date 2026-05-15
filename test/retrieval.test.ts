import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { ReflectionService } from '../src/reflection/service.js';
import { classifyQuery } from '../src/retrieval/classifier.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

const config: AppConfig = {
  env: 'test',
  port: 3027,
  databaseUrl: '',
  redisUrl: '',
  store: 'memory',
  cache: 'memory',
  modelProvider: 'hash',
  embeddingDimensions: 1536,
  openAiEmbeddingModel: 'text-embedding-3-small',
  contextCacheTtlSeconds: 60,
};

test('classifier extracts concrete repo context from prompt', () => {
  const classified = classifyQuery({
    prompt: 'Fix TS-999 in src/paywall-selection-modal.tsx around PaywallSelectionModal for React newsletter paywall',
    cwd: '/home/nash/projects/tuberosa',
  });

  equal(classified.project, 'tuberosa');
  equal(classified.taskType, 'debugging');
  deepEqual(classified.files, ['src/paywall-selection-modal.tsx']);
  ok(classified.symbols.includes('PaywallSelectionModal'));
  ok(classified.errors.includes('TS-999'));
  ok(classified.technologies.includes('react'));
  ok(classified.businessAreas.includes('paywall'));
});

test('retrieval returns context pack with matched references', async () => {
  const { ingestion, retrieval } = createTestServices();

  await ingestion.ingestKnowledge({
    project: 'newsletter-app',
    sourceType: 'file',
    sourceUri: 'src/components/paywall-selection-modal.tsx',
    itemType: 'code_ref',
    title: 'Paywall selection modal',
    summary: 'React modal used by newsletter composer to choose a paywall.',
    content: 'PaywallSelectionModal renders options for newsletter paywall configuration and must keep selected product ids stable.',
    trustLevel: 80,
    labels: [
      { type: 'business_area', value: 'paywall', weight: 1 },
      { type: 'technology', value: 'react', weight: 0.8 },
      { type: 'symbol', value: 'PaywallSelectionModal', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'src/components/paywall-selection-modal.tsx' }],
  });

  const pack = await retrieval.searchContext({
    project: 'newsletter-app',
    prompt: 'Update PaywallSelectionModal for the newsletter paywall flow',
  });

  equal(pack.project, 'newsletter-app');
  ok(pack.confidence > 0.3);
  equal(pack.sections[0].name, 'essential');
  equal(pack.sections[0].items[0].title, 'Paywall selection modal');
  equal(pack.sections[0].items[0].references[0].uri, 'src/components/paywall-selection-modal.tsx');
});

test('feedback rejection retries without rejected knowledge', async () => {
  const { ingestion, retrieval } = createTestServices();

  const first = await ingestion.ingestKnowledge({
    project: 'agent-memory',
    sourceType: 'wiki',
    sourceUri: 'docs/old.md',
    itemType: 'wiki',
    title: 'Old auth flow',
    summary: 'Outdated auth flow.',
    content: 'Auth flow uses legacy session cookies.',
    trustLevel: 30,
    labels: [{ type: 'business_area', value: 'auth', weight: 1 }],
  });

  await ingestion.ingestKnowledge({
    project: 'agent-memory',
    sourceType: 'wiki',
    sourceUri: 'docs/new.md',
    itemType: 'wiki',
    title: 'Current auth flow',
    summary: 'Current auth flow.',
    content: 'Auth flow uses OAuth bearer tokens and refresh token rotation.',
    trustLevel: 90,
    labels: [{ type: 'business_area', value: 'auth', weight: 1 }],
  });

  const pack = await retrieval.searchContext({
    project: 'agent-memory',
    prompt: 'Explain the auth flow',
  });

  const retry = await retrieval.recordFeedback({
    contextPackId: pack.id,
    project: 'agent-memory',
    feedbackType: 'rejected',
    rejectedKnowledgeIds: [first.id],
    reason: 'Old flow',
  });

  ok(retry.retry);
  const retryIds = retry.retry.sections.flatMap((section) => section.items.map((item) => item.knowledgeId));
  ok(!retryIds.includes(first.id));
});

test('reflection drafts are reviewable and approval creates searchable memory', async () => {
  const { retrieval, reflection } = createTestServices();

  const draft = await reflection.createDraft({
    project: 'agent-memory',
    title: 'Prefer review before saving memory',
    summary: 'Reflection memories should be approved before they become searchable.',
    content: 'When an agent learns a new workflow, it should draft a memory and wait for approval before adding it to retrieval.',
    triggerType: 'user_correction',
  });

  equal(draft.status, 'pending');

  await reflection.approveDraft(draft.id);
  const pack = await retrieval.searchContext({
    project: 'agent-memory',
    prompt: 'How should reflection memories be saved?',
  });

  equal(pack.sections[0].items[0].itemType, 'memory');
});

function createTestServices() {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, config);
  const reflection = new ReflectionService(store, ingestion);

  return { store, cache, models, ingestion, retrieval, reflection };
}
