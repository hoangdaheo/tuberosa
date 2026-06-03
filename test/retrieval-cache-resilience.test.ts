import test from 'node:test';
import { ok } from 'node:assert/strict';
import type { Cache } from '../src/cache.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { makeTestConfig } from './support/test-config.js';

const config = makeTestConfig();

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
