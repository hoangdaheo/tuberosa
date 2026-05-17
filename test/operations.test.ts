import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { AgentSessionService } from '../src/agent-session/service.js';
import type { AppServices } from '../src/app.js';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { handleHttpRequest } from '../src/http/server.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { OperationsService } from '../src/operations/service.js';
import { ReflectionService } from '../src/reflection/service.js';
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
  maxRequestBytes: 10 * 1024 * 1024,
  maxIngestContentBytes: 2 * 1024 * 1024,
  backupDir: '.tuberosa/test-backups',
  backupIntervalSeconds: 0,
  backupStartupDelaySeconds: 0,
  backupRetentionCount: 24,
  backupRetentionMaxAgeDays: 30,
  backupWriteThrough: false,
  backupWriteThroughThrottleSeconds: 600,
};

test('operations API reviews, updates, imports, and lists audit records', async () => {
  const services = createTestServices();
  const project = 'operations-review';

  try {
    const health = await get(services, '/health') as Record<string, unknown>;
    equal(health.durability, 'ephemeral');

    const imported = await post(services, '/operations/import-files', {
      project,
      mode: 'atomic',
      files: [{
        project,
        path: 'docs/ops.md',
        content: [
          '# Operations',
          '',
          'Review APIs expose questionable knowledge.',
          '',
          '## Cleanup',
          '',
          'Cleanup removes old proposed context packs and orphaned audit rows.',
        ].join('\n'),
      }],
    }) as Array<Record<string, unknown>>;

    ok(imported.length >= 2);

    const lowTrust = await post(services, '/knowledge', {
      project,
      sourceType: 'manual',
      sourceUri: 'manual://ops/low-trust',
      itemType: 'wiki',
      title: 'Questionable ops note',
      summary: 'Low trust review note.',
      content: 'This operations note should be listed for review.',
      trustLevel: 20,
      labels: [{ type: 'business_area', value: 'operations', weight: 1 }],
    }) as Record<string, unknown>;

    const patched = await patch(services, `/knowledge/${lowTrust.id}`, {
      status: 'needs_review',
      metadata: { reviewer: 'node-test' },
      labels: [{ type: 'severity', value: 'review', weight: 1 }],
    }) as Record<string, unknown>;
    equal(patched.status, 'needs_review');
    equal((patched.metadata as Record<string, unknown>).reviewer, 'node-test');

    const questionable = await get(services, `/knowledge?project=${project}&review=questionable`) as Array<Record<string, unknown>>;
    ok(questionable.some((item) => item.id === lowTrust.id));

    const labels = await get(services, `/labels?project=${project}`) as Array<Record<string, unknown>>;
    ok(labels.some((label) => label.type === 'severity' && label.value === 'review'));

    const inferredRelations = await get(services, `/operations/relations?project=${project}&inferred=true`) as Array<Record<string, unknown>>;
    ok(inferredRelations.some((relation) => relation.relationType === 'mentions_file'));

    const manualRelation = await post(services, '/operations/relations', {
      project,
      fromKnowledgeId: imported[0].id,
      relationType: 'related_to',
      targetKind: 'knowledge',
      targetKnowledgeId: lowTrust.id,
      confidence: 0.6,
    }) as Record<string, unknown>;
    equal(manualRelation.inferred, false);

    const patchedRelation = await patch(services, `/operations/relations/${manualRelation.id}`, {
      confidence: 0.8,
      metadata: { reviewer: 'node-test' },
    }) as Record<string, unknown>;
    equal(patchedRelation.confidence, 0.8);
    equal((patchedRelation.metadata as Record<string, unknown>).reviewer, 'node-test');

    const projectMap = await get(services, `/operations/organization/project-map?project=${project}`) as Record<string, unknown>;
    ok((projectMap.relationCount as number) >= 1);

    const graphJsonl = await get(services, `/operations/organization/knowledge-graph.jsonl?project=${project}`) as Record<string, unknown>;
    ok(String(graphJsonl.content).includes('"kind":"relation"'));

    const readableSummary = await get(services, `/operations/organization/readable-summary?project=${project}`) as Record<string, unknown>;
    ok(String(readableSummary.content).includes('Knowledge Summary'));

    const search = await post(services, '/context/search', {
      project,
      prompt: 'How should operations cleanup work?',
      bypassCache: true,
    }) as Record<string, unknown>;
    ok(search.id);

    await post(services, '/context/feedback', {
      contextPackId: search.id,
      project,
      feedbackType: 'stale',
      rejectedKnowledgeIds: [lowTrust.id],
      reason: 'Needs review before reuse.',
    });

    const stale = await get(services, `/knowledge?project=${project}&review=stale`) as Array<Record<string, unknown>>;
    ok(stale.some((item) => item.id === lowTrust.id));

    const packs = await get(services, `/context/packs?project=${project}`) as Array<Record<string, unknown>>;
    ok(packs.some((pack) => pack.id === search.id));

    const feedback = await get(services, `/feedback-events?project=${project}`) as Array<Record<string, unknown>>;
    ok(feedback.some((event) => event.feedbackType === 'stale'));

    const draft = await post(services, '/reflection-drafts', {
      project,
      title: 'Review operations notes',
      summary: 'Operations notes should remain reviewable.',
      content: 'When adding operations APIs, list reflection drafts and let reviewers reject stale drafts before approval.',
      triggerType: 'manual',
    }) as Record<string, unknown>;
    const rejectedDraft = await patch(services, `/reflection-drafts/${draft.id}`, {
      status: 'rejected',
      metadata: { reason: 'superseded' },
    }) as Record<string, unknown>;
    equal(rejectedDraft.status, 'rejected');

    const drafts = await get(services, `/reflection-drafts?project=${project}&status=rejected`) as Array<Record<string, unknown>>;
    ok(drafts.some((item) => item.id === draft.id));

    const sessionStart = await post(services, '/agent-sessions', {
      project,
      prompt: 'Review operations API coverage',
      bypassCache: true,
    }) as Record<string, unknown>;
    const session = sessionStart.session as Record<string, unknown>;
    await post(services, `/agent-sessions/${session.id}/context-decision`, {
      feedbackType: 'selected',
      contextPackId: (sessionStart.contextPack as Record<string, unknown>).id,
    });
    const decisions = await get(services, `/agent-sessions/${session.id}/context-decisions`) as Array<Record<string, unknown>>;
    equal(decisions[0].decision, 'selected');

    const cleanup = await post(services, '/operations/cleanup', {
      dryRun: true,
      olderThanDays: 1,
    }) as Record<string, unknown>;
    equal(cleanup.dryRun, true);
    ok(cleanup.deleted);

    const deleteRelation = await dispatchHttp(services, {
      method: 'DELETE',
      url: `/operations/relations/${manualRelation.id}`,
    });
    equal(deleteRelation.status, 200);
    equal((deleteRelation.body as Record<string, unknown>).deleted, true);
  } finally {
    await services.close();
  }
});

test('operations API creates and restores portable JSONL backups', async () => {
  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-backups-'));
  const services = createTestServices(backupDir);
  const project = 'backup-review';

  try {
    const stored = await post(services, '/knowledge', {
      project,
      sourceType: 'manual',
      sourceUri: 'manual://backup/original',
      itemType: 'wiki',
      title: 'Backup original',
      summary: 'Original backup note.',
      content: 'Backup restore should keep durable knowledge available for retrieval.',
      labels: [{ type: 'business_area', value: 'operations', weight: 1 }],
      references: [{ type: 'file', uri: 'docs/backup.md' }],
    }) as Record<string, unknown>;

    const backup = await post(services, '/operations/backups', { id: 'unit-backup' }) as Record<string, unknown>;
    equal(backup.id, 'unit-backup');
    ok(String(backup.path).startsWith(backupDir));

    const backups = await get(services, '/operations/backups') as Array<Record<string, unknown>>;
    ok(backups.some((item) => item.id === 'unit-backup'));
    const listedBackup = backups.find((item) => item.id === 'unit-backup') as Record<string, unknown>;
    ok((listedBackup.totalRows as number) > 0);
    ok(Array.isArray(listedBackup.tables));

    const status = await get(services, '/operations/backups/status') as Record<string, unknown>;
    equal(status.health, 'healthy');
    equal((status.latestBackup as Record<string, unknown>).id, 'unit-backup');

    const verification = await post(services, '/operations/backups/unit-backup/verify', {}) as Record<string, unknown>;
    equal(verification.ok, true);
    equal(verification.health, 'healthy');

    await post(services, '/knowledge', {
      project,
      sourceType: 'manual',
      sourceUri: 'manual://backup/extra',
      itemType: 'wiki',
      title: 'Backup extra',
      summary: 'Extra note after backup.',
      content: 'This note should disappear after replace restore.',
    });

    const dryRun = await post(services, '/operations/backups/unit-backup/restore', { dryRun: true }) as Record<string, unknown>;
    equal(dryRun.dryRun, true);
    ok((dryRun.restored as Record<string, number>).knowledge_items >= 1);

    const restored = await post(services, '/operations/backups/unit-backup/restore', { replace: true }) as Record<string, unknown>;
    equal(restored.replace, true);

    const items = await get(services, `/knowledge?project=${project}&limit=10`) as Array<Record<string, unknown>>;
    ok(items.some((item) => item.id === stored.id));
    equal(items.some((item) => item.title === 'Backup extra'), false);
  } finally {
    await services.close();
    await rm(backupDir, { recursive: true, force: true });
  }
});

test('backup verification blocks corrupt restore and retention keeps latest valid backup', async () => {
  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-backups-'));
  const services = createTestServices(backupDir);

  try {
    await post(services, '/knowledge', {
      project: 'backup-integrity',
      sourceType: 'manual',
      sourceUri: 'manual://backup/integrity',
      itemType: 'wiki',
      title: 'Backup integrity',
      summary: 'Integrity note.',
      content: 'Verification should catch modified backup table files.',
    });

    await post(services, '/operations/backups', { id: 'backup-a' });
    await post(services, '/operations/backups', { id: 'backup-b' });
    const latest = await post(services, '/operations/backups', { id: 'backup-c' }) as Record<string, unknown>;
    const chunkFile = join(String(latest.path), 'knowledge_chunks.jsonl');
    const rawChunks = await readFile(chunkFile, 'utf8');
    await writeFile(chunkFile, `${rawChunks}\n`, 'utf8');

    const verification = await post(services, '/operations/backups/backup-c/verify', {}) as Record<string, unknown>;
    equal(verification.ok, false);
    equal(verification.health, 'unhealthy');

    const restoreResponse = await dispatchHttp(services, {
      method: 'POST',
      url: '/operations/backups/backup-c/restore',
      body: { replace: true },
    });
    equal(restoreResponse.status, 400);

    const pruneDryRun = await post(services, '/operations/backups/prune', {
      dryRun: true,
      keepCount: 1,
      maxAgeDays: 1,
    }) as Record<string, unknown>;
    equal((pruneDryRun.pruned as Array<unknown>).length, 1);
    equal((pruneDryRun.kept as Array<Record<string, unknown>>).some((backup) => backup.id === 'backup-c'), true);
    equal((pruneDryRun.kept as Array<Record<string, unknown>>).some((backup) => backup.id === 'backup-b'), true);

    const prune = await post(services, '/operations/backups/prune', {
      keepCount: 1,
      maxAgeDays: 1,
    }) as Record<string, unknown>;
    equal((prune.pruned as Array<unknown>).length, 1);

    const backups = await get(services, '/operations/backups') as Array<Record<string, unknown>>;
    equal(backups.length, 2);
    equal(backups[0].id, 'backup-c');
    equal(backups[1].id, 'backup-b');
  } finally {
    await services.close();
    await rm(backupDir, { recursive: true, force: true });
  }
});

function createTestServices(backupDir = '.tuberosa/test-backups'): AppServices {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, config);
  const reflection = new ReflectionService(store, ingestion);
  const agentSessions = new AgentSessionService(store, retrieval, reflection);
  const operations = new OperationsService(store, ingestion, { backupDir, storeKind: 'memory' });

  return {
    config: { ...config, backupDir },
    store,
    cache,
    models,
    ingestion,
    retrieval,
    reflection,
    agentSessions,
    operations,
    safety: {} as AppServices['safety'],
    async close() {
      await Promise.allSettled([cache.close(), store.close()]);
    },
  };
}

async function post(services: AppServices, url: string, body: unknown): Promise<unknown> {
  const response = await dispatchHttp(services, { method: 'POST', url, body });
  equal(response.status, 200);
  return response.body;
}

async function patch(services: AppServices, url: string, body: unknown): Promise<unknown> {
  const response = await dispatchHttp(services, { method: 'PATCH', url, body });
  equal(response.status, 200);
  return response.body;
}

async function get(services: AppServices, url: string): Promise<unknown> {
  const response = await dispatchHttp(services, { method: 'GET', url });
  equal(response.status, 200);
  return response.body;
}

async function dispatchHttp(
  services: AppServices,
  input: { method: string; url: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const encoded = input.body === undefined ? '' : JSON.stringify(input.body);
  const request = Readable.from(encoded ? [Buffer.from(encoded)] : []) as IncomingMessage;
  request.method = input.method;
  request.url = input.url;
  request.headers = {
    'content-length': String(Buffer.byteLength(encoded)),
    'content-type': 'application/json',
  };

  let status = 0;
  let rawBody = '';
  const response = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    end(chunk?: unknown) {
      rawBody = typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk ?? '');
      return this;
    },
  } as unknown as ServerResponse;

  await handleHttpRequest(services, request, response);
  return { status, body: JSON.parse(rawBody) };
}
