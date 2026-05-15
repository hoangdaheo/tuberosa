import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppServices } from '../app.js';
import type { ContextSearchInput, FeedbackInput, KnowledgeInput, ReflectionDraftInput } from '../types.js';

export function createHttpServer(services: AppServices) {
  return createServer(async (request, response) => {
    try {
      await route(services, request, response);
    } catch (error) {
      sendJson(response, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}

async function route(services: AppServices, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'tuberosa',
      store: services.config.store,
      cache: services.config.cache,
      modelProvider: services.config.modelProvider,
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/context/search') {
    const body = await readJson<ContextSearchInput>(request);
    sendJson(response, 200, await services.retrieval.searchContext(body));
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/context/packs/')) {
    const id = url.pathname.split('/').at(-1);
    if (!id) {
      throw new HttpError(400, 'Missing context pack id.');
    }

    const pack = await services.retrieval.getContextPack(id);
    if (!pack) {
      throw new HttpError(404, 'Context pack not found.');
    }

    sendJson(response, 200, pack);
    return;
  }

  if (method === 'POST' && url.pathname === '/context/feedback') {
    const body = await readJson<FeedbackInput>(request);
    sendJson(response, 200, await services.retrieval.recordFeedback(body));
    return;
  }

  if (method === 'POST' && url.pathname === '/ingest/files') {
    const body = await readJson<{ project: string; files: unknown[] }>(request);
    if (!body.project || !Array.isArray(body.files)) {
      throw new HttpError(400, 'Expected { project, files }.');
    }

    sendJson(response, 200, await services.ingestion.ingestFiles(body.project, body.files as Parameters<typeof services.ingestion.ingestFiles>[1]));
    return;
  }

  if (method === 'POST' && url.pathname === '/knowledge') {
    const body = await readJson<KnowledgeInput>(request);
    sendJson(response, 200, await services.ingestion.ingestKnowledge(body));
    return;
  }

  if (method === 'GET' && url.pathname === '/knowledge') {
    sendJson(response, 200, await services.store.listKnowledge({
      project: url.searchParams.get('project') ?? undefined,
      query: url.searchParams.get('q') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 25),
    }));
    return;
  }

  if (method === 'POST' && url.pathname === '/reflection-drafts') {
    const body = await readJson<ReflectionDraftInput>(request);
    sendJson(response, 200, await services.reflection.createDraft(body));
    return;
  }

  if (method === 'POST' && url.pathname.startsWith('/reflection-drafts/') && url.pathname.endsWith('/approve')) {
    const id = url.pathname.split('/').at(-2);
    if (!id) {
      throw new HttpError(400, 'Missing reflection draft id.');
    }

    const draft = await services.reflection.approveDraft(id);
    if (!draft) {
      throw new HttpError(404, 'Reflection draft not found.');
    }

    sendJson(response, 200, draft);
    return;
  }

  throw new HttpError(404, `No route for ${method} ${url.pathname}`);
}

async function readJson<T = Record<string, unknown>>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
