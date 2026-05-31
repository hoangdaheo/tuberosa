import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { AgentSessionService } from '../src/agent-session/service.js';
import type { AppServices } from '../src/app.js';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { CurationService } from '../src/curation/service.js';
import { ErrorLogInsightService } from '../src/error-log/insights.js';
import { ErrorLogService } from '../src/error-log/service.js';
import { IngestionService } from '../src/ingest/service.js';
import { MaintenanceService } from '../src/maintenance/service.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { HashModelProvider } from '../src/model/provider.js';
import { OperationsService } from '../src/operations/service.js';
import { SessionReplayService } from '../src/operations/session-replay.js';
import { ReflectionService } from '../src/reflection/service.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { KnowledgeSafetyService } from '../src/security/knowledge-safety.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type { KnowledgeAtomInput } from '../src/types/atoms.js';

const config: AppConfig = {
  env: 'test',
  port: 3027,
  databaseUrl: '',
  redisUrl: '',
  httpHost: '127.0.0.1',
  requireApiKeyForNonLoopback: false,
  store: 'memory',
  cache: 'memory',
  autoMigrate: false,
  modelProvider: 'hash',
  embeddingDimensions: 1536,
  openAiEmbeddingModel: 'text-embedding-3-small',
  contextCacheTtlSeconds: 60,
  maxRequestBytes: 10 * 1024 * 1024,
  maxIngestContentBytes: 2 * 1024 * 1024,
  backupDir: '.tuberosa/test-backups',
  exportBaseDir: '.tuberosa/test-exports',
} as AppConfig;

function atomInput(overrides: Partial<KnowledgeAtomInput> & Pick<KnowledgeAtomInput, 'project' | 'claim'>): KnowledgeAtomInput {
  return {
    type: 'fact',
    evidence: [],
    trigger: {},
    producedBy: 'agent_session',
    ...overrides,
  };
}

test('proposeCuration clusters related un-curated atoms and excludes distilled/convention atoms', async () => {
  const store = new MemoryKnowledgeStore();
  const project = 'curation-svc';

  // Three atoms sharing the same trigger file/symbol — should cluster together.
  const a = await store.createAtom(atomInput({
    project,
    claim: 'Validate request body before parsing',
    trigger: { files: ['src/http/server.ts'], symbols: ['handleHttpRequest'] },
  }));
  const b = await store.createAtom(atomInput({
    project,
    claim: 'Return 413 when body exceeds maxRequestBytes',
    trigger: { files: ['src/http/server.ts'], symbols: ['handleHttpRequest'] },
  }));
  const c = await store.createAtom(atomInput({
    project,
    claim: 'Reject non-JSON content types early',
    trigger: { files: ['src/http/server.ts'], symbols: ['handleHttpRequest'] },
  }));

  // Unrelated atom — distinct trigger, should be its own singleton cluster.
  const unrelated = await store.createAtom(atomInput({
    project,
    claim: 'Embedding dimensions must match the vector column',
    trigger: { files: ['src/config.ts'], symbols: ['loadConfig'] },
  }));

  // Already distilled — must be excluded from every cluster.
  const distilled = await store.createAtom(atomInput({
    project,
    claim: 'Old raw atom already folded into a convention',
    trigger: { files: ['src/http/server.ts'], symbols: ['handleHttpRequest'] },
    metadata: { distilledIntoAtomId: 'some-convention-id' },
  }));

  // Existing convention — a curated output, not raw input; must be excluded.
  const convention = await store.createAtom(atomInput({
    project,
    type: 'convention',
    claim: 'HTTP handlers validate body, size, and content type up front',
    trigger: { files: ['src/http/server.ts'], symbols: ['handleHttpRequest'] },
  }));

  const result = await new CurationService(store).proposeCuration({ project, limit: 100 });

  ok(Array.isArray(result.clusters));
  equal(typeof result.instruction, 'string');
  ok(result.instruction.length > 0);
  ok(result.instruction.includes('tuberosa_reflect'));

  const allClustered = result.clusters.flatMap((cluster) => cluster.atoms.map((atom) => atom.id));

  // Distilled and convention atoms never appear in any cluster.
  ok(!allClustered.includes(distilled.id));
  ok(!allClustered.includes(convention.id));

  // The three related atoms land in a single cluster together.
  const sharedCluster = result.clusters.find((cluster) => cluster.atoms.some((atom) => atom.id === a.id));
  ok(sharedCluster);
  const sharedIds = sharedCluster.atoms.map((atom) => atom.id).sort();
  equal(sharedIds.length, 3);
  ok(sharedIds.includes(a.id) && sharedIds.includes(b.id) && sharedIds.includes(c.id));

  // The unrelated atom is not grouped with the shared cluster.
  ok(!sharedIds.includes(unrelated.id));
  ok(allClustered.includes(unrelated.id));
});

test('proposeCuration returns an empty-cluster instruction when there is nothing to distill', async () => {
  const store = new MemoryKnowledgeStore();
  const result = await new CurationService(store).proposeCuration({ project: 'empty-project' });
  equal(result.clusters.length, 0);
  ok(result.instruction.length > 0);
});

function createTestServices(): AppServices {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const safety = new KnowledgeSafetyService();
  const ingestion = new IngestionService(store, models, { safety });
  const retrieval = new RetrievalService(store, cache, models, config, safety);
  const reflection = new ReflectionService(store, ingestion, safety);
  const sessionReplay = new SessionReplayService(store);
  const agentSessions = new AgentSessionService(store, retrieval, reflection, models, sessionReplay, config);
  const operations = new OperationsService(store, ingestion);
  const errorLogs = new ErrorLogService({ rootDir: config.errorLogDir, safety });
  const errorLogInsights = new ErrorLogInsightService(errorLogs, reflection);
  const maintenance = new MaintenanceService(store);
  const curation = new CurationService(store);

  return {
    config,
    store,
    cache,
    models,
    safety,
    ingestion,
    retrieval,
    reflection,
    agentSessions,
    sessionReplay,
    operations,
    errorLogs,
    errorLogInsights,
    maintenance,
    curation,
    async close() {
      await Promise.allSettled([cache.close(), store.close()]);
    },
  };
}

test('tuberosa_propose_curation is registered and returns clusters + instruction', async () => {
  const services = createTestServices();
  try {
    const project = 'curation-mcp';
    await services.store.createAtom(atomInput({
      project,
      claim: 'Seed atom one',
      trigger: { files: ['src/foo.ts'], symbols: ['foo'] },
    }));
    await services.store.createAtom(atomInput({
      project,
      claim: 'Seed atom two',
      trigger: { files: ['src/foo.ts'], symbols: ['foo'] },
    }));

    const toolsList = await handleMcpRequest(services, { method: 'tools/list' }) as { tools: Array<{ name: string }> };
    const toolNames = toolsList.tools.map((tool) => tool.name);
    ok(toolNames.includes('tuberosa_propose_curation'));

    const response = await handleMcpRequest(services, {
      method: 'tools/call',
      params: { name: 'tuberosa_propose_curation', arguments: { project, limit: 100 } },
    }) as { structuredContent?: { clusters?: unknown[]; instruction?: string } };

    ok(Array.isArray(response.structuredContent?.clusters));
    equal(typeof response.structuredContent?.instruction, 'string');
    ok((response.structuredContent?.instruction ?? '').length > 0);
    ok((response.structuredContent?.clusters ?? []).length >= 1);
  } finally {
    await services.close();
  }
});
