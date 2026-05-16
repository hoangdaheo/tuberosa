import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppServices } from '../app.js';
import type { IngestFileInput, IngestionMode } from '../ingest/service.js';
import type { ContextSearchInput, FeedbackInput, KnowledgeInput, ReflectionDraftInput } from '../types.js';

type RouteParams = Record<string, string>;
type RouteMatcher = (url: URL) => RouteParams | undefined;
type RouteHandler = (context: RouteContext) => Promise<unknown> | unknown;

interface RouteContext {
  services: AppServices;
  request: IncomingMessage;
  url: URL;
  params: RouteParams;
}

interface HttpRoute {
  method: string;
  match: RouteMatcher;
  handle: RouteHandler;
  public?: boolean;
}

export function createHttpServer(services: AppServices) {
  const router = new HttpRouter(services);

  return createServer(async (request, response) => {
    await router.handle(request, response);
  });
}

class HttpRouter {
  private readonly routes: HttpRoute[];

  constructor(private readonly services: AppServices) {
    this.routes = createRoutes();
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method?.toUpperCase() ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');

    try {
      const matched = this.matchRoute(method, url);
      if (!matched) {
        throw new HttpError(404, `No route for ${method} ${url.pathname}`);
      }

      if (!matched.route.public) {
        authenticate(request, this.services.config.apiKey);
      }

      const body = await matched.route.handle({
        services: this.services,
        request,
        url,
        params: matched.params,
      });
      sendJson(response, 200, body);
    } catch (error) {
      sendJson(response, error instanceof HttpError ? error.status : errorStatusCode(error) ?? 500, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private matchRoute(method: string, url: URL): { route: HttpRoute; params: RouteParams } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) {
        continue;
      }

      const params = route.match(url);
      if (params) {
        return { route, params };
      }
    }

    return undefined;
  }
}

function createRoutes(): HttpRoute[] {
  return [
    {
      method: 'GET',
      match: exactPath('/health'),
      public: true,
      handle: ({ services }) => ({
        ok: true,
        service: 'tuberosa',
        store: services.config.store,
        cache: services.config.cache,
        modelProvider: services.config.modelProvider,
      }),
    },
    {
      method: 'POST',
      match: exactPath('/context/search'),
      handle: async ({ services, request }) => {
        const body = await readJsonBody<ContextSearchInput>(request, services.config.maxRequestBytes);
        return services.retrieval.searchContext(body);
      },
    },
    {
      method: 'GET',
      match: pathPattern(/^\/context\/packs\/([^/]+)$/, ['id']),
      handle: async ({ services, params }) => {
        const pack = await services.retrieval.getContextPack(params.id);
        if (!pack) {
          throw new HttpError(404, 'Context pack not found.');
        }

        return pack;
      },
    },
    {
      method: 'POST',
      match: exactPath('/context/feedback'),
      handle: async ({ services, request }) => {
        const body = await readJsonBody<FeedbackInput>(request, services.config.maxRequestBytes);
        return services.retrieval.recordFeedback(body);
      },
    },
    {
      method: 'POST',
      match: exactPath('/ingest/files'),
      handle: async ({ services, request }) => {
        const body = await readJsonBody<{ project?: string; files?: IngestFileInput[]; mode?: IngestionMode }>(
          request,
          services.config.maxRequestBytes,
        );
        if (!body.project || !Array.isArray(body.files)) {
          throw new HttpError(400, 'Expected { project, files }.');
        }

        return services.ingestion.ingestFiles(body.project, body.files, { mode: body.mode });
      },
    },
    {
      method: 'POST',
      match: exactPath('/knowledge'),
      handle: async ({ services, request }) => {
        const body = await readJsonBody<KnowledgeInput>(request, services.config.maxRequestBytes);
        return services.ingestion.ingestKnowledge(body);
      },
    },
    {
      method: 'GET',
      match: exactPath('/knowledge'),
      handle: ({ services, url }) => services.store.listKnowledge({
        project: url.searchParams.get('project') ?? undefined,
        query: url.searchParams.get('q') ?? undefined,
        limit: readLimit(url),
      }),
    },
    {
      method: 'POST',
      match: exactPath('/reflection-drafts'),
      handle: async ({ services, request }) => {
        const body = await readJsonBody<ReflectionDraftInput>(request, services.config.maxRequestBytes);
        return services.reflection.createDraft(body);
      },
    },
    {
      method: 'POST',
      match: pathPattern(/^\/reflection-drafts\/([^/]+)\/approve$/, ['id']),
      handle: async ({ services, params }) => {
        const draft = await services.reflection.approveDraft(params.id);
        if (!draft) {
          throw new HttpError(404, 'Reflection draft not found.');
        }

        return draft;
      },
    },
  ];
}

export async function readJsonBody<T = Record<string, unknown>>(request: IncomingMessage, maxBytes: number): Promise<T> {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (contentLength > maxBytes) {
    throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

function authenticate(request: IncomingMessage, apiKey: string | undefined): void {
  const provided = readProvidedApiKey(request);
  if (!isAuthorizedApiKey(provided, apiKey)) {
    throw new HttpError(401, 'Unauthorized.');
  }
}

function readProvidedApiKey(request: IncomingMessage): string | undefined {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }

  const header = request.headers['x-tuberosa-api-key'];
  return Array.isArray(header) ? header[0] : header;
}

export function isAuthorizedApiKey(provided: string | undefined, apiKey: string | undefined): boolean {
  if (!apiKey) {
    return true;
  }

  return Boolean(provided && secureEqual(provided, apiKey));
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function errorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function exactPath(pathname: string): RouteMatcher {
  return (url) => (url.pathname === pathname ? {} : undefined);
}

function pathPattern(pattern: RegExp, keys: string[]): RouteMatcher {
  return (url) => {
    const match = pattern.exec(url.pathname);
    if (!match) {
      return undefined;
    }

    try {
      return Object.fromEntries(
        keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]),
      );
    } catch {
      throw new HttpError(400, 'Invalid path parameter.');
    }
  };
}

function readLimit(url: URL): number {
  const rawLimit = url.searchParams.get('limit');
  if (!rawLimit) {
    return 25;
  }

  if (!/^\d+$/.test(rawLimit)) {
    throw new HttpError(400, 'Query parameter "limit" must be a positive integer.');
  }

  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new HttpError(400, 'Query parameter "limit" must be a positive integer.');
  }

  return Math.min(limit, 100);
}
