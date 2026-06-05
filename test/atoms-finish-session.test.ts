import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { ReflectionService } from '../src/reflection/service.js';
import { IngestionService } from '../src/ingest/service.js';
import { AgentSessionService } from '../src/agent-session/service.js';
import { loadConfig } from '../src/config.js';
import { ProviderRegistry } from '../src/model/registry.js';

function buildService(store: MemoryKnowledgeStore, models: HashModelProvider) {
  const cache = new MemoryCache();
  const config = loadConfig();
  const retrieval = new RetrievalService(store, cache, models, config);
  const ingestion = new IngestionService(store, models);
  const reflection = new ReflectionService(store, ingestion);
  return new AgentSessionService(store, retrieval, reflection, models, undefined, config);
}

test('finishSession: extracts atoms via configured extractor and stores valid ones', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: 'Use pnpm run eval:retrieval before changing fusion weights.',
    type: 'convention',
    evidence: [{ kind: 'file', path: 'eval/retrieval-fixtures.json' }],
    trigger: { taskTypes: ['refactor'], files: ['src/retrieval/fusion.ts'] },
    verification: { command: 'pnpm run eval:retrieval' },
  }]);

  const session = await store.createAgentSession({
    prompt: 'refactor fusion weights',
    project: 'tuberosa',
  });
  const service = buildService(store, models);

  await service.finishSession({
    sessionId: session.id,
    outcome: 'completed',
    summary: 'tuned weights and ran eval to keep retrieval green',
  });

  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0]!.audit!.producedAtSessionId, session.id);
});

test('finishSession: rejected atom candidates are recorded as knowledge gaps', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  // Empty evidence -> rejected by the critic floor.
  models.setFixtureAtoms([{
    claim: 'This candidate has no evidence and should be rejected.',
    type: 'convention',
    evidence: [],
    trigger: { taskTypes: ['refactor'] },
  }]);

  const session = await store.createAgentSession({
    prompt: 'refactor fusion weights',
    project: 'tuberosa',
  });
  const service = buildService(store, models);

  await service.finishSession({
    sessionId: session.id,
    outcome: 'completed',
    summary: 'tuned weights and ran eval to keep retrieval green',
  });

  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 0);

  const gaps = await store.listKnowledgeGaps({ project: 'tuberosa', sourceSessionId: session.id, limit: 10 });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.metadata!.source, 'atom_critic');
});

test('finishSession: extraction works through a ProviderRegistry passthrough', async () => {
  const store = new MemoryKnowledgeStore();
  const hash = new HashModelProvider();
  const registry = new ProviderRegistry(hash);
  registry.registerExtraction('stub-extraction', {
    extractAtoms: async () => [{
      claim: 'Registry passthrough delivers atoms end-to-end.',
      type: 'fact' as const,
      evidence: [{ kind: 'file' as const, path: 'src/model/registry.ts' }],
      trigger: { files: ['src/model/registry.ts'] },
    }],
  });

  const session = await store.createAgentSession({
    prompt: 'verify registry extraction passthrough',
    project: 'tuberosa',
  });
  const cache = new MemoryCache();
  const config = loadConfig();
  const retrieval = new RetrievalService(store, cache, registry, config);
  const ingestion = new IngestionService(store, registry);
  const reflection = new ReflectionService(store, ingestion);
  const service = new AgentSessionService(store, retrieval, reflection, registry, undefined, config);

  await service.finishSession({ sessionId: session.id, outcome: 'completed', summary: 'done' });

  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0]!.claim, 'Registry passthrough delivers atoms end-to-end.');
});
