import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { Pool } from 'pg';
import { createCache, MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { ReflectionService } from '../src/reflection/service.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { PostgresKnowledgeStore } from '../src/storage/postgres-store.js';
import { runMigrations } from '../src/storage/migrations.js';

const POSTGRES_URL = process.env.TUBEROSA_INTEGRATION_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://tuberosa:tuberosa@localhost:5432/tuberosa';
const REDIS_URL = process.env.TUBEROSA_INTEGRATION_REDIS_URL
  ?? process.env.REDIS_URL
  ?? 'redis://localhost:6379';

test('Postgres store supports retrieval, pgvector search, and feedback when Docker is available', async (t) => {
  const available = await postgresAvailable();
  if (!available.ok) {
    t.skip(available.reason);
    return;
  }

  const migrationPool = new Pool({ connectionString: POSTGRES_URL, connectionTimeoutMillis: 1000 });
  await runMigrations(migrationPool);
  await migrationPool.end();

  const store = new PostgresKnowledgeStore(POSTGRES_URL);
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, testConfig());
  const reflection = new ReflectionService(store, ingestion);
  const project = `integration-${randomUUID()}`;

  try {
    const initialPaywall = await ingestion.ingestKnowledge({
      project,
      sourceType: 'file',
      sourceUri: 'src/components/paywall-selection-modal.tsx',
      itemType: 'code_ref',
      title: 'Paywall selection modal',
      summary: 'React modal for newsletter paywall product selection.',
      content: 'PaywallSelectionModal keeps selected product ids stable while editors configure newsletter paywalls.',
      trustLevel: 90,
      labels: [
        { type: 'business_area', value: 'paywall', weight: 1 },
        { type: 'technology', value: 'react', weight: 0.8 },
        { type: 'symbol', value: 'PaywallSelectionModal', weight: 1 },
      ],
      references: [{ type: 'file', uri: 'src/components/paywall-selection-modal.tsx' }],
    });
    const updatedPaywall = await ingestion.ingestKnowledge({
      project,
      sourceType: 'file',
      sourceUri: 'src/components/paywall-selection-modal.tsx',
      itemType: 'code_ref',
      title: 'Paywall selection modal',
      summary: 'React modal for current newsletter paywall product selection.',
      content: 'PaywallSelectionModal keeps selected product ids stable while editors configure current newsletter paywalls.',
      trustLevel: 90,
      labels: [
        { type: 'business_area', value: 'paywall', weight: 1 },
        { type: 'technology', value: 'react', weight: 0.8 },
        { type: 'symbol', value: 'PaywallSelectionModal', weight: 1 },
      ],
      references: [{ type: 'file', uri: 'src/components/paywall-selection-modal.tsx' }],
    });

    equal(updatedPaywall.id, initialPaywall.id);

    const unrelated = await ingestion.ingestKnowledge({
      project,
      sourceType: 'wiki',
      sourceUri: 'docs/auth.md',
      itemType: 'wiki',
      title: 'Auth flow',
      summary: 'OAuth bearer token flow.',
      content: 'The auth flow uses bearer tokens with rotating refresh tokens.',
      trustLevel: 70,
      labels: [{ type: 'business_area', value: 'auth', weight: 1 }],
      references: [{ type: 'file', uri: 'docs/auth.md' }],
    });

    await ingestion.ingestFiles(project, [{
      project,
      path: 'docs/postgres-auth.md',
      content: [
        '# Auth',
        '',
        'Auth documentation for integration replacement behavior.',
        '',
        '## Login flow',
        '',
        'Users sign in with OAuth.',
        '',
        '## Removed section',
        '',
        'This section should be deleted on the next import.',
      ].join('\n'),
    }], { mode: 'atomic' });
    await ingestion.ingestFiles(project, [{
      project,
      path: 'docs/postgres-auth.md',
      content: [
        '# Auth',
        '',
        'Auth documentation for integration replacement behavior.',
        '',
        '## Login flow',
        '',
        'Users sign in with OAuth and PKCE.',
      ].join('\n'),
    }], { mode: 'atomic' });
    const authAtoms = await store.listKnowledge({ project, limit: 20 });

    ok(!authAtoms.some((item) => item.title === 'Auth > Removed section'));
    equal(authAtoms.find((item) => item.title === 'Auth > Login flow')?.content.includes('PKCE'), true);

    const pack = await retrieval.searchContext({
      project,
      prompt: 'Update PaywallSelectionModal for the React newsletter paywall flow',
      bypassCache: true,
    });
    const first = pack.sections[0].items[0];

    equal(pack.project, project);
    equal(first.title, 'Paywall selection modal');
    equal(first.references[0].uri, 'src/components/paywall-selection-modal.tsx');

    const embedding = await models.embed('PaywallSelectionModal React newsletter paywall products');
    const vectorResults = await store.searchVector(embedding, { project, limit: 5 });
    ok(vectorResults.some((candidate) => candidate.title === 'Paywall selection modal'));
    ok(!vectorResults.some((candidate) => candidate.knowledgeId === unrelated.id && candidate.rank === 1));

    await retrieval.recordFeedback({
      contextPackId: pack.id,
      project,
      feedbackType: 'selected',
    });
    const storedPack = await retrieval.getContextPack(pack.id);

    equal(storedPack?.status, 'selected');

    const draft = await reflection.createDraft({
      project,
      title: 'Approve integration memories',
      summary: 'Integration memories should be approved before retrieval.',
      content: 'Postgres-backed reflection drafts should be reviewable and approval should ingest them as searchable memory.',
      triggerType: 'manual',
      labels: [{ type: 'business_area', value: 'paywall', weight: 1 }],
    });
    equal(draft.status, 'pending');

    const approved = await reflection.approveDraft(draft.id);
    equal(approved?.status, 'approved');

    const memoryPack = await retrieval.searchContext({
      project,
      prompt: 'How should integration memories be approved before retrieval?',
      bypassCache: true,
    });
    ok(memoryPack.sections[0].items.some((item) => item.itemType === 'memory'));
  } finally {
    await Promise.allSettled([store.close(), cache.close()]);
  }
});

test('Redis cache stores, reads, and deletes JSON when Docker is available', async (t) => {
  const available = await redisAvailable();
  if (!available.ok) {
    t.skip(available.reason);
    return;
  }

  const cache = await createCache({ ...testConfig(), cache: 'redis', redisUrl: REDIS_URL });
  const key = `integration:${randomUUID()}`;

  try {
    await cache.setJson(key, { value: 42, tags: ['redis', 'cache'] }, 30);
    deepEqual(await cache.getJson(key), { value: 42, tags: ['redis', 'cache'] });

    await cache.del(key);
    equal(await cache.getJson(key), undefined);
  } finally {
    await cache.close();
  }
});

function testConfig(): AppConfig {
  return {
    env: 'test',
    port: 3027,
    databaseUrl: POSTGRES_URL,
    redisUrl: REDIS_URL,
    store: 'postgres',
    cache: 'memory',
    modelProvider: 'hash',
    embeddingDimensions: 1536,
    openAiEmbeddingModel: 'text-embedding-3-small',
    contextCacheTtlSeconds: 0,
    maxRequestBytes: 10 * 1024 * 1024,
    maxIngestContentBytes: 2 * 1024 * 1024,
  };
}

async function postgresAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const tcp = await tcpAvailable(POSTGRES_URL, 5432, 'Postgres');
  if (!tcp.ok) {
    return tcp;
  }

  const pool = new Pool({
    connectionString: POSTGRES_URL,
    connectionTimeoutMillis: 750,
    max: 1,
  });

  try {
    await withTimeout(pool.query('SELECT 1'), 1000, 'Postgres probe timed out');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Postgres unavailable at ${POSTGRES_URL}: ${errorMessage(error)}` };
  } finally {
    await pool.end().catch(() => {});
  }
}

async function redisAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  return tcpAvailable(REDIS_URL, 6379, 'Redis');
}

async function tcpAvailable(
  connectionUrl: string,
  defaultPort: number,
  service: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = new URL(connectionUrl);
  const host = url.hostname || 'localhost';
  const port = url.port ? Number(url.port) : defaultPort;

  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    const finish = (result: { ok: true } | { ok: false; reason: string }) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(750);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: `${service} unavailable at ${connectionUrl}: connection timed out` }));
    socket.once('error', (error) => finish({
      ok: false,
      reason: `${service} unavailable at ${connectionUrl}: ${error.message}`,
    }));
    socket.connect(port, host);
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });

  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
