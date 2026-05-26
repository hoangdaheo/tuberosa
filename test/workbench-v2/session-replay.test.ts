import { deepEqual, equal, ok } from 'node:assert/strict';
import test from 'node:test';
import { AgentSessionService } from '../../src/agent-session/service.js';
import { MemoryCache } from '../../src/cache.js';
import type { AppConfig } from '../../src/config.js';
import { IngestionService } from '../../src/ingest/service.js';
import { HashModelProvider } from '../../src/model/provider.js';
import { ReflectionService } from '../../src/reflection/service.js';
import { RetrievalService } from '../../src/retrieval/service.js';
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
  const agentSessions = new AgentSessionService(store, retrieval, reflection, replay, config);

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
  };
}
