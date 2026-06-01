import test from 'node:test';
import { ok } from 'node:assert/strict';
import type { Cache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

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
  openAiTimeoutMs: 30_000,
  embeddingDimensions: 1536,
  openAiEmbeddingModel: 'text-embedding-3-small',
  contextCacheTtlSeconds: 60,
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
  persistReplay: false,
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
  llmCriticEnabled: false,
  archivalEnabled: false,
  graphInferenceEnabled: false,
  archivalIntervalHours: 24,
};

test('searchContext succeeds when the cache throws on read and write', async () => {
  const throwingCache: Cache = {
    getJson: async () => { throw new Error('redis down'); },
    setJson: async () => { throw new Error('redis down'); },
    del: async () => {},
    close: async () => {},
  };

  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, throwingCache, models, config);

  await ingestion.ingestKnowledge({
    project: 'tuberosa',
    sourceType: 'file',
    sourceUri: 'src/storage/migrations.ts',
    itemType: 'bugfix',
    title: 'Migration startup race guard',
    summary: 'The migration runner serializes schema setup with a Postgres advisory lock.',
    content: 'Use pg_advisory_lock around schema_migrations before app and worker startup continue.',
    trustLevel: 90,
    labels: [
      { type: 'technology', value: 'postgres', weight: 1 },
      { type: 'symbol', value: 'pg_advisory_lock', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'src/storage/migrations.ts' }],
  });

  const pack = await retrieval.searchContext({
    project: 'tuberosa',
    prompt: 'How do we avoid the migration startup concurrency issue?',
  });

  ok(pack.id, 'searchContext should resolve a pack despite the cache throwing');
});
