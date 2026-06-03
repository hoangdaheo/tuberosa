import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { ReflectionService } from '../src/reflection/service.js';
import { IngestionService } from '../src/ingest/service.js';
import { AgentSessionService } from '../src/agent-session/service.js';
import { makeTestConfig } from './support/test-config.js';

test('startSession: reports handbook.exists when a matching convention surfaces', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const config = makeTestConfig({ teamId: 'team-acme' });

  const claim = 'Refactors in this project must keep public exports backward-compatible.';
  await store.createAtom({
    project: 'payments-service',
    claim,
    type: 'convention',
    evidence: [],
    trigger: { taskTypes: ['refactor'] },
    producedBy: 'user',
    scope: 'project',
  });

  const retrieval = new RetrievalService(store, cache, models, config);
  const ingestion = new IngestionService(store, models);
  const reflection = new ReflectionService(store, ingestion);
  const service = new AgentSessionService(store, retrieval, reflection, models, undefined, config, cache);

  const result = await service.startSession({
    project: 'payments-service',
    prompt: 'refactor of the settlement module',
    taskType: 'refactor',
  });

  assert.equal(result.handbook.exists, true);
  assert.ok(result.handbook.conventionCount >= 1, 'expected at least one convention counted');
});

test('startSession: reports handbook absence with a bootstrap suggestion when no conventions surface', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const config = makeTestConfig({ teamId: 'team-acme' });

  const retrieval = new RetrievalService(store, cache, models, config);
  const ingestion = new IngestionService(store, models);
  const reflection = new ReflectionService(store, ingestion);
  const service = new AgentSessionService(store, retrieval, reflection, models, undefined, config, cache);

  const result = await service.startSession({
    project: 'payments-service',
    prompt: 'refactor of the settlement module',
    taskType: 'refactor',
  });

  assert.equal(result.handbook.exists, false);
  assert.equal(result.handbook.conventionCount, 0);
  assert.ok(
    typeof result.handbook.suggestion === 'string' && result.handbook.suggestion.length > 0,
    'expected a non-empty bootstrap suggestion',
  );
});
