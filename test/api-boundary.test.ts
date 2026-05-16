import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { equal, ok, rejects } from 'node:assert/strict';
import type { AppServices } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { appErrorToJsonRpcError, ValidationError } from '../src/errors.js';
import { handleHttpRequest } from '../src/http/server.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import type { ContextPack } from '../src/types.js';

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
    cache: {},
    models: {},
    safety: {},
    close: async () => {},
    ...overrides,
  } as unknown as AppServices;
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
