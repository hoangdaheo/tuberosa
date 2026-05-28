import { deepEqual, equal, ok } from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { AgentSessionService } from '../../src/agent-session/service.js';
import type { AppServices } from '../../src/app.js';
import { MemoryCache } from '../../src/cache.js';
import type { AppConfig } from '../../src/config.js';
import { ErrorLogInsightService } from '../../src/error-log/insights.js';
import { ErrorLogService } from '../../src/error-log/service.js';
import { createHttpServer } from '../../src/http/server.js';
import { IngestionService } from '../../src/ingest/service.js';
import { MaintenanceService } from '../../src/maintenance/service.js';
import { HashModelProvider } from '../../src/model/provider.js';
import { OperationsService } from '../../src/operations/service.js';
import { ReflectionService } from '../../src/reflection/service.js';
import { RetrievalService } from '../../src/retrieval/service.js';
import { KnowledgeSafetyService } from '../../src/security/knowledge-safety.js';
import { MemoryKnowledgeStore } from '../../src/storage/memory-store.js';
import { SessionReplayService, type SessionReplayBundle } from '../../src/operations/session-replay.js';

function sampleReplay(sessionId = '00000000-0000-0000-0000-000000000001'): SessionReplayBundle {
  return {
    sessionId,
    classifier: {
      symbols: ['BillingContext'],
      errors: [],
      files: [],
      businessAreas: ['billing'],
      technologies: ['typescript'],
      taskType: 'implementation',
    },
    sourceCandidates: {
      metadata: [{ id: 'k1', score: 0.7 }],
      lexical: [{ id: 'k1', score: 0.8 }],
      vector: [],
      memory: [],
      graph: [],
      worktree: [],
    },
    fusionOrder: [{ id: 'k1', rank: 1, score: 0.8 }],
    rerankDeltas: [],
    adjustments: [],
    contextFit: {
      fitStatus: 'ready',
      fitScore: 0.91,
      fitReasons: ['direct billing evidence found'],
      missingSignals: [],
    },
    pack: { essential: [{ id: 'k1' }], supporting: [], optional: [] },
    timings: { totalMs: 42, stageMs: {} },
  };
}

test('writeReplay/readReplay round-trips through memory store', async () => {
  const store = new MemoryKnowledgeStore();
  const svc = new SessionReplayService(store);
  const bundle = sampleReplay();

  await svc.writeReplay(bundle);
  const read = await svc.readReplay(bundle.sessionId);

  ok(read);
  deepEqual(read.fusionOrder, bundle.fusionOrder);
  equal(read.timings.totalMs, 42);
});

test('readReplay returns null for unknown id', async () => {
  const store = new MemoryKnowledgeStore();
  const svc = new SessionReplayService(store);

  equal(await svc.readReplay('00000000-0000-0000-0000-000000000099'), null);
});

test('agent session start persists replay when opt-in flag is enabled', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const config = testConfig(true);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, config);
  const reflection = new ReflectionService(store, ingestion);
  const replay = new SessionReplayService(store);
  const agentSessions = new AgentSessionService(store, retrieval, reflection, models, replay, config);

  await ingestion.ingestKnowledge({
    project: 'replay-demo',
    sourceType: 'manual',
    sourceUri: 'manual://billing/replay',
    itemType: 'code_ref',
    title: 'BillingContext replay fixture',
    summary: 'BillingContext replay context.',
    content: 'BillingContext uses account ids and subscription state to explain replay persistence behavior.',
    trustLevel: 90,
    labels: [
      { type: 'symbol', value: 'BillingContext', weight: 1 },
      { type: 'business_area', value: 'billing', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'src/billing/context.ts' }],
  });

  const started = await agentSessions.startSession({
    project: 'replay-demo',
    prompt: 'Implement BillingContext replay persistence',
    symbols: ['BillingContext'],
    taskType: 'implementation',
  });

  equal(started.contextPack.debug, undefined);
  const storedReplay = await replay.readReplay(started.session.id);
  ok(storedReplay);
  equal(storedReplay.sessionId, started.session.id);
  ok(storedReplay.fusionOrder.length > 0);
});

test('GET /operations/workbench/session/:id/replay returns 404 for unknown, 200 for known', async () => {
  const services = buildTestServices();
  const sessionId = '00000000-0000-0000-0000-0000000000aa';
  await services.sessionReplay.writeReplay(sampleReplay(sessionId));
  const server = createHttpServer(services);

  try {
    const baseUrl = await listen(server);
    const missing = await fetch(`${baseUrl}/operations/workbench/session/00000000-0000-0000-0000-000000000099/replay`);
    equal(missing.status, 404);
    const missingBody = await missing.json() as { code?: string };
    equal(missingBody.code, 'not_found');

    const found = await fetch(`${baseUrl}/operations/workbench/session/${sessionId}/replay`);
    equal(found.status, 200);
    const body = await found.json() as SessionReplayBundle;
    equal(body.sessionId, sessionId);
    deepEqual(body.pack.essential, [{ id: 'k1' }]);
  } finally {
    await closeServer(server);
    await services.close();
  }
});

function testConfig(persistReplay: boolean): AppConfig {
  return {
    env: 'test',
    port: 0,
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
    contextCacheTtlSeconds: 0,
    maxRequestBytes: 10 * 1024 * 1024,
    maxIngestContentBytes: 2 * 1024 * 1024,
    backupDir: '.tuberosa/test-backups',
    exportBaseDir: '.tuberosa/test-exports',
    importBaseDir: '.tuberosa/test-imports',
    backupIntervalSeconds: 0,
    backupStartupDelaySeconds: 0,
    backupRetentionCount: 24,
    backupRetentionMaxAgeDays: 30,
    backupWriteThrough: false,
    backupWriteThroughThrottleSeconds: 600,
    physicalMirrorDebounceMs: 500,
    errorLogDir: '.tuberosa/test-error-logs',
    errorLogMaxBytes: 256 * 1024,
    errorLogAutoCapture: true,
    errorLogCaptureClientErrors: false,
    persistReplay,
    worktreeEnabled: false,
    worktreeMaxFiles: 50,
    worktreeMaxMtimeAgeHours: 72,
    llmCriticEnabled: false,
    archivalEnabled: false,
  graphInferenceEnabled: false,
    archivalIntervalHours: 24,
  };
}

function buildTestServices(): AppServices {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const config = testConfig(false);
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

  return {
    config,
    cache,
    store,
    models,
    safety,
    errorLogs,
    errorLogInsights,
    ingestion,
    retrieval,
    reflection,
    agentSessions,
    sessionReplay,
    operations,
    maintenance,
    async close() {
      await Promise.allSettled([operations.close(), cache.close(), store.close()]);
    },
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
