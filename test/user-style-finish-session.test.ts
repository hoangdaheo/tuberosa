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

test('finishSession: user_preference learning signal becomes a draft user-style atom', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const config = makeTestConfig({ userStyle: { userId: 'alice@example.com', enabled: true } });
  const retrieval = new RetrievalService(store, cache, models, config);
  const ingestion = new IngestionService(store, models);
  const reflection = new ReflectionService(store, ingestion);
  const service = new AgentSessionService(store, retrieval, reflection, models, undefined, config, cache);

  const session = await store.createAgentSession({
    prompt: 'commit message style',
    project: 'tuberosa',
  });

  await service.finishSession({
    sessionId: session.id,
    outcome: 'completed',
    summary: 'set up commits',
    learningSignals: [{
      kind: 'user_preference',
      text: 'I commit with Conventional Commits and no Claude co-author trailer.',
      source: 'agent',
    }],
  });

  const atoms = await store.listAtoms({ project: undefined, scope: 'user', userId: 'alice@example.com', limit: 10 });
  const userAtom = atoms.find((a) => a.scope === 'user' && a.userId === 'alice@example.com');
  assert.ok(userAtom, 'expected a user-style atom to be created');
  assert.equal(userAtom!.tier, 'draft');
  assert.equal(userAtom!.priority, 'coding_preference');
});

test('finishSession: skips routing when TUBEROSA_USER_ID is unset', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const config = makeTestConfig({ userStyle: { userId: undefined, enabled: true } });
  const retrieval = new RetrievalService(store, cache, models, config);
  const ingestion = new IngestionService(store, models);
  const reflection = new ReflectionService(store, ingestion);
  const service = new AgentSessionService(store, retrieval, reflection, models, undefined, config, cache);

  const session = await store.createAgentSession({
    prompt: 'commit message style',
    project: 'tuberosa',
  });

  await service.finishSession({
    sessionId: session.id,
    outcome: 'completed',
    summary: 'set up commits',
    learningSignals: [{
      kind: 'user_preference',
      text: 'I commit with Conventional Commits.',
      source: 'agent',
    }],
  });

  const atoms = await store.listAtoms({ project: undefined, scope: 'user', limit: 10 });
  assert.equal(atoms.length, 0, 'no user-style atom should exist when userId is unset');
});
