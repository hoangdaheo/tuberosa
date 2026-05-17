import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import type { AppServices } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { appErrorToJsonRpcError, ValidationError } from '../src/errors.js';
import { handleHttpRequest } from '../src/http/server.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import type { ContextPack, ReflectionDraft } from '../src/types.js';

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

test('malformed HTTP inputs return structured validation errors', async () => {
  const response = await dispatchHttp(fakeServices(), {
    method: 'POST',
    url: '/context/search',
    body: { project: 'agent-memory' },
  });

  const body = response.body as { error?: unknown; code?: unknown; details?: Array<{ path?: string }> };

  equal(response.status, 400);
  equal(body.code, 'validation_error');
  equal(typeof body.error, 'string');
  ok(Array.isArray(body.details));
  equal(body.details[0]?.path, 'context search input.prompt');
});

test('valid HTTP knowledge inputs keep the success response shape', async () => {
  const response = await dispatchHttp(fakeServices(), {
    method: 'POST',
    url: '/knowledge',
    body: {
      project: 'agent-memory',
      sourceType: 'manual',
      sourceUri: 'manual://auth',
      itemType: 'wiki',
      title: 'Auth workflow',
      summary: 'Auth workflow notes.',
      content: 'Auth work should preserve bearer token rotation behavior.',
    },
  });
  const body = response.body as { id?: string; title?: string };

  equal(response.status, 200);
  equal(body.id, 'knowledge-1');
  equal(body.title, 'Auth workflow');
});

test('valid MCP tool calls are validated then dispatched', async () => {
  const result = await handleMcpRequest(fakeServices({
    retrieval: {
      searchContext: async () => samplePack(),
    },
  }), {
    method: 'tools/call',
    params: {
      name: 'tuberosa_search_context',
      arguments: {
        project: 'agent-memory',
        prompt: 'Find auth guidance',
      },
    },
  }) as {
    structuredContent?: {
      contextPackId?: string;
      contextFit?: { fitStatus?: string };
      sections?: Array<{ items: Array<{ fitReasons?: string[] }> }>;
    };
  };

  equal(result.structuredContent?.contextPackId, 'pack-1');
  equal(result.structuredContent?.contextFit?.fitStatus, 'ready');
  equal(result.structuredContent?.sections?.[0]?.items[0]?.fitReasons?.[0], 'project:agent-memory');
});

test('MCP reflection review tools list, inspect, and record decisions', async () => {
  const draft = sampleDraft();
  const services = fakeServices({
    operations: {
      listReflectionDrafts: async (options: { project?: string; status?: string; limit: number }) => {
        equal(options.project, 'agent-memory');
        equal(options.status, 'pending');
        equal(options.limit, 5);
        return [draft];
      },
      getReflectionDraft: async (id: string) => {
        equal(id, draft.id);
        return draft;
      },
      requestWriteThroughBackup: () => undefined,
      requestPhysicalMirror: () => undefined,
    },
    reflection: {
      createDraft: async () => {
        throw new Error('Unexpected reflection create call.');
      },
      approveDraft: async () => undefined,
      reviewDraft: async (input: {
        id: string;
        decision: string;
        reviewerNote?: string;
        evaluation?: Record<string, unknown>;
      }) => {
        equal(input.id, draft.id);
        equal(input.decision, 'needs_changes');
        equal(input.reviewerNote, 'Needs a narrower scope.');
        deepEqual(input.evaluation, {
          accuracy: 'pass',
          usefulness: 'concern',
          duplicateRisk: 'low',
        });

        return {
          ...draft,
          status: 'needs_changes',
          metadata: {
            ...draft.metadata,
            review: {
              decision: input.decision,
              evaluation: input.evaluation,
            },
          },
        };
      },
    },
  });

  const listed = await handleMcpRequest(services, {
    method: 'tools/call',
    params: {
      name: 'tuberosa_list_reflection_drafts',
      arguments: {
        project: 'agent-memory',
        limit: 5,
      },
    },
  }) as { structuredContent?: { drafts?: ReflectionDraft[] } };

  equal(listed.structuredContent?.drafts?.[0]?.id, draft.id);

  const fetched = await handleMcpRequest(services, {
    method: 'tools/call',
    params: {
      name: 'tuberosa_get_reflection_draft',
      arguments: { reflectionDraftId: draft.id },
    },
  }) as { structuredContent?: { draft?: ReflectionDraft } };

  equal(fetched.structuredContent?.draft?.title, draft.title);

  const reviewed = await handleMcpRequest(services, {
    method: 'tools/call',
    params: {
      name: 'tuberosa_review_reflection_draft',
      arguments: {
        id: draft.id,
        decision: 'needs_changes',
        reviewerNote: 'Needs a narrower scope.',
        evaluation: {
          accuracy: 'pass',
          usefulness: 'concern',
          duplicateRisk: 'low',
        },
      },
    },
  }) as {
    structuredContent?: {
      draft?: ReflectionDraft;
      instruction?: string;
    };
  };

  equal(reviewed.structuredContent?.draft?.status, 'needs_changes');
  equal(reviewed.structuredContent?.instruction, 'Draft marked as needing changes. Revise or recreate it before approval.');
});

test('MCP error log tools and resources dispatch through the filesystem journal service', async () => {
  const log = sampleErrorLog();
  const services = fakeServices({
    errorLogs: {
      recordLog: async (input: { title: string }) => ({ ...log, title: input.title }),
      listLogs: async (options: { project?: string; status?: string; limit: number }) => {
        equal(options.project, 'agent-memory');
        equal(options.status, 'open');
        equal(options.limit, 5);
        return [log];
      },
      getLog: async (id: string) => {
        equal(id, log.id);
        return log;
      },
      updateLog: async (id: string, patch: { status?: string; reflectionDraftId?: string }) => ({
        ...log,
        id,
        status: patch.status ?? log.status,
        reflectionDraftId: patch.reflectionDraftId,
      }),
      readLogMarkdown: async (id: string) => `# ${id}\n`,
    },
    errorLogInsights: {
      collect: async (options: { project?: string; statuses?: string[]; limit: number; offset: number }) => {
        equal(options.project, 'agent-memory');
        equal(options.statuses?.[0], 'open');
        equal(options.limit, 5);
        equal(options.offset, 0);
        return {
          project: 'agent-memory',
          generatedAt: new Date().toISOString(),
          totalMatched: 1,
          returned: 1,
          filters: options,
          rollups: {
            categories: [{ value: 'agent_tool', count: 1 }],
            severities: [{ value: 'error', count: 1 }],
            statuses: [{ value: 'open', count: 1 }],
            files: [],
            symbols: [],
            errors: [],
            tags: [],
          },
          clusters: [{
            fingerprint: log.fingerprint,
            title: log.title,
            count: 1,
            occurrenceCount: 1,
            severity: 'error',
            statuses: ['open'],
            categories: ['agent_tool'],
            firstSeenAt: log.firstSeenAt,
            lastSeenAt: log.lastSeenAt,
            logIds: [log.id],
            files: [],
            symbols: [],
            errors: [],
            tags: [],
          }],
          logs: [log],
          agentBrief: '# Error Log Brief\n',
        };
      },
      createReflectionDraft: async (input: { errorLogIds: string[] }) => ({
        draft: { ...sampleDraft(), id: 'draft-from-error-log' },
        linkedErrorLogIds: input.errorLogIds,
      }),
      resolve: async (input: { id: string; rootCause: string; resolutionSummary: string }) => ({
        log: {
          ...log,
          id: input.id,
          status: 'fixed',
          metadata: {
            resolution: {
              rootCause: input.rootCause,
              summary: input.resolutionSummary,
            },
          },
        },
        instruction: 'Error log resolved.',
      }),
    },
  });

  const recorded = await handleMcpRequest(services, {
    method: 'tools/call',
    params: {
      name: 'tuberosa_record_error_log',
      arguments: {
        project: 'agent-memory',
        title: 'Command failed',
        category: 'agent_tool',
      },
    },
  }) as { structuredContent?: { log?: { title?: string } } };
  equal(recorded.structuredContent?.log?.title, 'Command failed');

  const listed = await handleMcpRequest(services, {
    method: 'tools/call',
    params: {
      name: 'tuberosa_list_error_logs',
      arguments: {
        project: 'agent-memory',
        status: 'open',
        limit: 5,
      },
    },
  }) as { structuredContent?: { logs?: Array<{ id: string }> } };
  equal(listed.structuredContent?.logs?.[0]?.id, log.id);

  const collected = await handleMcpRequest(services, {
    method: 'tools/call',
    params: {
      name: 'tuberosa_collect_error_logs',
      arguments: {
        project: 'agent-memory',
        statuses: ['open'],
        limit: 5,
      },
    },
  }) as { structuredContent?: { collection?: { totalMatched?: number } } };
  equal(collected.structuredContent?.collection?.totalMatched, 1);

  const draft = await handleMcpRequest(services, {
    method: 'tools/call',
    params: {
      name: 'tuberosa_create_error_log_reflection_draft',
      arguments: {
        errorLogIds: [log.id],
      },
    },
  }) as { structuredContent?: { draft?: { id?: string }; linkedErrorLogIds?: string[] } };
  equal(draft.structuredContent?.draft?.id, 'draft-from-error-log');
  equal(draft.structuredContent?.linkedErrorLogIds?.[0], log.id);

  const updated = await handleMcpRequest(services, {
    method: 'tools/call',
    params: {
      name: 'tuberosa_update_error_log',
      arguments: {
        id: log.id,
        status: 'fixed',
        reflectionDraftId: 'draft-1',
      },
    },
  }) as { structuredContent?: { log?: { status?: string; reflectionDraftId?: string } } };
  equal(updated.structuredContent?.log?.status, 'fixed');
  equal(updated.structuredContent?.log?.reflectionDraftId, 'draft-1');

  const resolved = await handleMcpRequest(services, {
    method: 'tools/call',
    params: {
      name: 'tuberosa_resolve_error_log',
      arguments: {
        id: log.id,
        rootCause: 'The command used stale context.',
        resolutionSummary: 'Updated the fixture and reran tests.',
        changedFiles: ['test/api-boundary.test.ts'],
        verificationCommands: ['pnpm test'],
      },
    },
  }) as { structuredContent?: { log?: { metadata?: { resolution?: { rootCause?: string } } } } };
  equal(resolved.structuredContent?.log?.metadata?.resolution?.rootCause, 'The command used stale context.');

  const resource = await handleMcpRequest(services, {
    method: 'resources/read',
    params: { uri: `tuberosa://error-logs/${log.id}` },
  }) as { contents?: Array<{ text?: string }> };
  ok(resource.contents?.[0]?.text?.includes(log.id));

  const markdown = await handleMcpRequest(services, {
    method: 'resources/read',
    params: { uri: `tuberosa://error-logs/${log.id}/markdown` },
  }) as { contents?: Array<{ mimeType?: string; text?: string }> };
  equal(markdown.contents?.[0]?.mimeType, 'text/markdown');
  ok(markdown.contents?.[0]?.text?.includes(log.id));
});

test('HTTP and MCP unexpected errors are auto-captured when enabled', async () => {
  const captured: Array<{ title?: string; category?: string; metadata?: Record<string, unknown> }> = [];
  const services = fakeServices({
    retrieval: {
      searchContext: async () => {
        throw new Error('Search exploded.');
      },
      getContextPack: async () => undefined,
      recordFeedback: async () => ({}),
    },
    errorLogs: {
      recordLog: async (input: { title?: string; category?: string; metadata?: Record<string, unknown> }) => {
        captured.push(input);
        return sampleErrorLog();
      },
      listLogs: async () => [],
      getLog: async () => undefined,
      updateLog: async () => undefined,
      readLogMarkdown: async () => undefined,
    },
    errorLogInsights: {
      collect: async () => ({
        generatedAt: new Date().toISOString(),
        totalMatched: 0,
        returned: 0,
        filters: { limit: 25, offset: 0 },
        rollups: { categories: [], severities: [], statuses: [], files: [], symbols: [], errors: [], tags: [] },
        clusters: [],
        logs: [],
        agentBrief: '# Error Log Brief\n',
      }),
      createReflectionDraft: async () => ({
        draft: sampleDraft(),
        linkedErrorLogIds: [],
      }),
      resolve: async () => ({
        log: sampleErrorLog(),
        instruction: 'Error log resolved.',
      }),
    },
  });

  const http = await dispatchHttp(services, {
    method: 'POST',
    url: '/context/search',
    body: { project: 'agent-memory', prompt: 'Find auth guidance' },
  });
  equal(http.status, 500);
  equal(captured[0]?.category, 'http');

  await rejects(
    () => handleMcpRequest(services, {
      method: 'tools/call',
      params: {
        name: 'tuberosa_search_context',
        arguments: {
          project: 'agent-memory',
          prompt: 'Find auth guidance',
        },
      },
    }),
    /Search exploded/,
  );
  equal(captured[1]?.category, 'retrieval');
});

test('malformed MCP tool inputs map to JSON-RPC invalid params errors', async () => {
  await rejects(
    () => handleMcpRequest(fakeServices(), {
      method: 'tools/call',
      params: {
        name: 'tuberosa_search_context',
        arguments: { prompt: 42 },
      },
    }),
    (error) => error instanceof ValidationError && error.code === 'validation_error',
  );

  const rpcError = appErrorToJsonRpcError(new ValidationError('Bad input.', [{ path: 'prompt' }]));

  equal(rpcError.code, -32602);
  equal(rpcError.data.code, 'validation_error');
  equal(rpcError.data.status, 400);
});

function fakeServices(overrides: Record<string, unknown> = {}): AppServices {
  return {
    config,
    retrieval: {
      searchContext: async () => samplePack(),
      getContextPack: async () => undefined,
      recordFeedback: async () => ({}),
    },
    ingestion: {
      ingestKnowledge: async (input: { project: string; title: string }) => ({
        id: 'knowledge-1',
        project: input.project,
        itemType: 'wiki',
        title: input.title,
        summary: '',
        content: '',
        trustLevel: 50,
        metadata: {},
        labels: [],
        references: [],
        createdAt: new Date().toISOString(),
      }),
      ingestFiles: async () => [],
    },
    reflection: {
      createDraft: async () => {
        throw new Error('Unexpected reflection call.');
      },
      approveDraft: async () => undefined,
      reviewDraft: async () => undefined,
    },
    agentSessions: {
      startSession: async () => ({
        session: {
          id: 'session-1',
          project: 'agent-memory',
          prompt: 'Find auth guidance',
          status: 'active',
          initialContextPackId: 'pack-1',
          reflectionDraftIds: [],
          metadata: {},
          createdAt: new Date().toISOString(),
        },
        contextPack: samplePack(),
        policy: {
          action: 'proceed',
          instruction: 'Context fit is ready.',
        },
      }),
      recordContextDecision: async () => {
        throw new Error('Unexpected session decision call.');
      },
      finishSession: async () => {
        throw new Error('Unexpected session finish call.');
      },
    },
    store: {
      listKnowledge: async () => [],
      getKnowledge: async () => undefined,
    },
    operations: {
      listReflectionDrafts: async () => [],
      getReflectionDraft: async () => undefined,
      requestWriteThroughBackup: () => undefined,
      requestPhysicalMirror: () => undefined,
    },
    errorLogs: {
      recordLog: async () => ({
        id: 'error-log-1',
        category: 'unknown',
        severity: 'error',
        status: 'open',
        title: 'Error log',
        summary: 'Error log',
        message: '',
        files: [],
        symbols: [],
        errors: [],
        tags: [],
        references: [],
        metadata: {},
        fingerprint: 'fingerprint',
        occurrenceCount: 1,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        safety: { redactionCount: 0, checkedAt: new Date().toISOString() },
        truncated: false,
      }),
      listLogs: async () => [],
      getLog: async () => undefined,
      updateLog: async () => undefined,
      readLogMarkdown: async () => undefined,
    },
    cache: {},
    models: {},
    safety: {},
    close: async () => {},
    ...overrides,
  } as unknown as AppServices;
}

function sampleErrorLog() {
  const now = new Date().toISOString();
  return {
    id: 'error-log-1',
    project: 'agent-memory',
    category: 'agent_tool',
    severity: 'error',
    status: 'open',
    title: 'Command failed',
    summary: 'A command failed.',
    message: 'Command failed.',
    files: [],
    symbols: [],
    errors: [],
    tags: [],
    references: [],
    metadata: {},
    fingerprint: 'fingerprint',
    occurrenceCount: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    safety: { redactionCount: 0, checkedAt: now },
    truncated: false,
  };
}

function sampleDraft(): ReflectionDraft {
  return {
    id: 'draft-1',
    project: 'agent-memory',
    title: 'Review pending memory',
    summary: 'Pending memories need review before retrieval.',
    content: 'Reflection drafts should be checked for accuracy, usefulness, scope, labels, references, privacy, and duplicates.',
    itemType: 'memory',
    triggerType: 'manual',
    status: 'pending',
    suggestedLabels: [{ type: 'project', value: 'agent-memory', weight: 1 }],
    references: [{ type: 'file', uri: 'docs/reflection.md' }],
    metadata: { taxonomy: 'workflow' },
    duplicateCandidates: [],
    createdAt: new Date().toISOString(),
  };
}

async function dispatchHttp(
  services: AppServices,
  input: { method: string; url: string; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const encoded = JSON.stringify(input.body);
  const request = Readable.from([Buffer.from(encoded)]) as IncomingMessage;
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

function samplePack(): ContextPack {
  return {
    id: 'pack-1',
    queryId: 'query-1',
    project: 'agent-memory',
    prompt: 'Find auth guidance',
    confidence: 0.8,
    status: 'proposed',
    classified: {
      project: 'agent-memory',
      taskType: 'exploration',
      confidence: 0.7,
      files: [],
      symbols: [],
      errors: [],
      technologies: [],
      businessAreas: ['auth'],
      exactTerms: ['auth'],
      lexicalQuery: 'auth guidance',
    },
    contextFit: {
      fitStatus: 'ready',
      fitScore: 0.82,
      fitReasons: ['covered project:agent-memory'],
      missingSignals: [],
    },
    sections: [
      {
        name: 'essential',
        tokenEstimate: 10,
        items: [
          {
            knowledgeId: 'knowledge-1',
            chunkId: 'chunk-1',
            title: 'Auth workflow',
            summary: 'Auth workflow notes.',
            content: 'Auth guidance.',
            contextualContent: 'Project: agent-memory\nAuth guidance.',
            itemType: 'wiki',
            project: 'agent-memory',
            labels: [],
            references: [],
            tokenEstimate: 10,
            trustLevel: 80,
            source: 'metadata',
            rawScore: 1,
            rank: 1,
            fusedScore: 1,
            rerankScore: 1,
            finalScore: 0.9,
            matchReasons: ['metadata match'],
            fitScore: 0.82,
            fitReasons: ['project:agent-memory'],
            fitMissingSignals: [],
          },
        ],
      },
    ],
    rejectedKnowledgeIds: [],
    createdAt: new Date().toISOString(),
  };
}
