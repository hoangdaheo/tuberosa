import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { AgentSessionService } from '../src/agent-session/service.js';
import type { AppServices } from '../src/app.js';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { ErrorLogInsightService } from '../src/error-log/insights.js';
import { ErrorLogService } from '../src/error-log/service.js';
import { handleHttpRequest } from '../src/http/server.js';
import { IngestionService } from '../src/ingest/service.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { HashModelProvider } from '../src/model/provider.js';
import { OperationsService } from '../src/operations/service.js';
import { ReflectionService } from '../src/reflection/service.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { KnowledgeSafetyService } from '../src/security/knowledge-safety.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

const config: AppConfig = {
  env: 'test',
  port: 3027,
  databaseUrl: '',
  redisUrl: '',
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
  backupIntervalSeconds: 0,
  backupStartupDelaySeconds: 0,
  backupRetentionCount: 24,
  backupRetentionMaxAgeDays: 30,
  backupWriteThrough: false,
  backupWriteThroughThrottleSeconds: 600,
  errorLogDir: ".tuberosa/test-error-logs",
  errorLogMaxBytes: 256 * 1024,
  errorLogAutoCapture: true,
  errorLogCaptureClientErrors: false,
};

test('FLOW_LOGIC functional smoke sequence works across HTTP and MCP surfaces', async () => {
  const services = createTestServices();
  const project = 'flow-logic-regression';

  try {
    const legacy = await post(services, '/knowledge', {
      project,
      sourceType: 'log',
      sourceUri: 'log://flow/legacy-migration-race',
      itemType: 'bugfix',
      title: 'Legacy FlowSmoke migration race',
      summary: 'Old FlowSmoke migration guidance.',
      content: 'FlowSmoke should let app and worker race migrations during startup. This is stale guidance for FLOW-404.',
      trustLevel: 25,
      labels: [
        { type: 'business_area', value: 'storage', weight: 1 },
        { type: 'error', value: 'FLOW-404', weight: 1 },
        { type: 'symbol', value: 'FlowSmoke', weight: 1 },
      ],
      references: [{ type: 'tool', uri: 'docker compose logs app worker postgres' }],
    }) as Record<string, unknown>;

    const current = await post(services, '/knowledge', {
      project,
      sourceType: 'log',
      sourceUri: 'log://flow/current-migration-lock',
      itemType: 'bugfix',
      title: 'FlowSmoke migration lock',
      summary: 'Current FlowSmoke migration guidance.',
      content: 'FLOW-404 is fixed by serializing app and worker startup migrations with a Postgres advisory lock before creating agent_sessions.',
      trustLevel: 95,
      labels: [
        { type: 'business_area', value: 'storage', weight: 1 },
        { type: 'technology', value: 'postgres', weight: 1 },
        { type: 'error', value: 'FLOW-404', weight: 1 },
        { type: 'symbol', value: 'FlowSmoke', weight: 1 },
        { type: 'symbol', value: 'agent_sessions', weight: 1 },
      ],
      references: [{ type: 'file', uri: 'src/storage/migrations.ts' }],
    }) as Record<string, unknown>;

    ok(current.id);

    const search = await post(services, '/context/search', {
      project,
      prompt: 'Fix FLOW-404 in FlowSmoke for Postgres agent_sessions startup',
      taskType: 'debugging',
      errors: ['FLOW-404'],
      symbols: ['FlowSmoke', 'agent_sessions'],
      bypassCache: true,
    }) as Record<string, unknown>;
    const firstItem = firstPackItem(search);

    equal(firstItem.title, 'FlowSmoke migration lock');
    ok(Array.isArray(firstItem.references));
    ok(Array.isArray(firstItem.reasons ?? firstItem.matchReasons));
    equal((search.contextFit as { fitStatus?: string } | undefined)?.fitStatus, 'ready');

    const debugSearch = await post(services, '/context/search', {
      project,
      prompt: 'Fix FLOW-404 in FlowSmoke for Postgres agent_sessions startup',
      taskType: 'debugging',
      errors: ['FLOW-404'],
      symbols: ['FlowSmoke', 'agent_sessions'],
      bypassCache: true,
      debug: true,
    }) as Record<string, unknown>;
    ok(debugSearch.debug);
    ok((debugSearch.debug as { stages?: unknown[] }).stages?.length);

    const packId = String(debugSearch.id);
    const storedPack = await get(services, `/context/packs/${packId}`) as Record<string, unknown>;
    equal(storedPack.id, packId);
    equal(storedPack.debug, undefined);

    await post(services, '/context/feedback', {
      contextPackId: packId,
      project,
      feedbackType: 'selected',
      reason: 'Flow regression accepted the migration-lock context.',
    });
    const selectedPack = await get(services, `/context/packs/${packId}`) as Record<string, unknown>;
    equal(selectedPack.status, 'selected');

    const staleFeedback = await post(services, '/context/feedback', {
      contextPackId: packId,
      project,
      feedbackType: 'stale',
      rejectedKnowledgeIds: [legacy.id],
      reason: 'Legacy startup race guidance is stale.',
    }) as Record<string, unknown>;
    ok(staleFeedback.retry);
    const retryItems = packItems(staleFeedback.retry as Record<string, unknown>);
    ok(!retryItems.some((item) => item.knowledgeId === legacy.id));

    const sessionStart = await post(services, '/agent-sessions', {
      project,
      prompt: 'Fix FLOW-404 in FlowSmoke for Postgres agent_sessions startup',
      agentName: 'flow-regression',
      agentTool: 'node-test',
      taskType: 'debugging',
      errors: ['FLOW-404'],
      symbols: ['FlowSmoke', 'agent_sessions'],
      bypassCache: true,
    }) as Record<string, unknown>;
    const session = sessionStart.session as Record<string, unknown>;
    const sessionPack = sessionStart.contextPack as Record<string, unknown>;
    equal(session.status, 'active');
    equal(session.initialContextPackId, sessionPack.id);

    const decision = await post(services, `/agent-sessions/${session.id}/context-decision`, {
      feedbackType: 'selected',
      contextPackId: sessionPack.id,
      reason: 'Agent accepted the context.',
    }) as Record<string, unknown>;
    equal((decision.decision as Record<string, unknown>).decision, 'selected');

    const finished = await post(services, `/agent-sessions/${session.id}/finish`, {
      outcome: 'completed',
      summary: 'Completed FLOW_LOGIC smoke flow.',
      reflectionDraft: {
        project,
        title: 'Approve FlowSmoke memories',
        summary: 'FlowSmoke lessons become searchable only after approval.',
        content: 'When a FlowSmoke regression reveals durable behavior, create a reflection draft and approve it before expecting retrieval to return it as memory.',
        triggerType: 'manual',
        metadata: { taxonomy: 'workflow' },
      },
    }) as Record<string, unknown>;
    equal((finished.session as Record<string, unknown>).status, 'finished');
    equal((finished.reflectionDraft as Record<string, unknown>).status, 'pending');
    ok(((finished.session as Record<string, unknown>).reflectionDraftIds as unknown[]).length);

    const draft = await post(services, '/reflection-drafts', {
      project,
      title: 'Retrieve approved FlowSmoke memory',
      summary: 'Approved FlowSmoke memories should be searchable.',
      content: 'Approved FlowSmoke memories should show up during retrieval with their provenance and references preserved.',
      triggerType: 'manual',
      references: [{ type: 'file', uri: 'docs/FLOW_LOGIC.md' }],
      metadata: { taxonomy: 'workflow' },
    }) as Record<string, unknown>;
    equal(draft.status, 'pending');

    const approved = await post(services, `/reflection-drafts/${draft.id}/approve`, {}) as Record<string, unknown>;
    equal(approved.status, 'approved');

    const memorySearch = await post(services, '/context/search', {
      project,
      prompt: 'How should approved FlowSmoke memories be retrieved?',
      bypassCache: true,
    }) as Record<string, unknown>;
    ok(packItems(memorySearch).some((item) => item.itemType === 'memory'));

    const toolsList = await handleMcpRequest(services, { method: 'tools/list' }) as { tools: Array<{ name: string }> };
    const toolNames = toolsList.tools.map((tool) => tool.name);
    ok(toolNames.includes('tuberosa_search_context'));
    ok(toolNames.includes('tuberosa_start_session'));
    ok(toolNames.includes('tuberosa_reflect'));

    const mcpSearch = await handleMcpRequest(services, {
      method: 'tools/call',
      params: {
        name: 'tuberosa_search_context',
        arguments: {
          project,
          prompt: 'Fix FLOW-404 in FlowSmoke for Postgres startup',
          taskType: 'debugging',
          errors: ['FLOW-404'],
          symbols: ['FlowSmoke'],
          bypassCache: true,
        },
      },
    }) as { structuredContent?: { contextPackId?: string; contextFit?: { fitStatus?: string } } };
    equal(mcpSearch.structuredContent?.contextFit?.fitStatus, 'ready');

    const resource = await handleMcpRequest(services, {
      method: 'resources/read',
      params: { uri: `tuberosa://knowledge/${current.id}` },
    }) as { contents: Array<{ text: string }> };
    equal(JSON.parse(resource.contents[0].text).id, current.id);

    const prompts = await handleMcpRequest(services, { method: 'prompts/list' }) as { prompts: Array<{ name: string }> };
    deepEqual(
      prompts.prompts.map((prompt) => prompt.name).sort(),
      [
        'tuberosa_bootstrap_session',
        'tuberosa_capture_error_for_later',
        'tuberosa_fix_error_log',
        'tuberosa_reflect_after_task',
        'tuberosa_review_error_logs',
        'tuberosa_review_pending_reflections',
      ],
    );
  } finally {
    await services.close();
  }
});

function createTestServices(): AppServices {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const safety = new KnowledgeSafetyService();
  const ingestion = new IngestionService(store, models, { safety });
  const retrieval = new RetrievalService(store, cache, models, config, safety);
  const reflection = new ReflectionService(store, ingestion, safety);
  const agentSessions = new AgentSessionService(store, retrieval, reflection);
  const operations = new OperationsService(store, ingestion);
  const errorLogs = new ErrorLogService({ rootDir: config.errorLogDir, safety });
  const errorLogInsights = new ErrorLogInsightService(errorLogs, reflection);

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
    operations,
    errorLogs,
    errorLogInsights,
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

function firstPackItem(pack: Record<string, unknown>): Record<string, unknown> {
  const first = packItems(pack)[0];
  ok(first);
  return first;
}

function packItems(pack: Record<string, unknown>): Array<Record<string, unknown>> {
  return ((pack.sections as Array<{ items: Array<Record<string, unknown>> }> | undefined) ?? [])
    .flatMap((section) => section.items);
}
