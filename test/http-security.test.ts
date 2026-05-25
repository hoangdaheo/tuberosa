import { Readable } from 'node:stream';
import test from 'node:test';
import { doesNotMatch, equal, notEqual, rejects } from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { HttpError, isAuthorizedApiKey, isAuthorizedRequest, isLoopbackRequest, readJsonBody } from '../src/http/server.js';
import { appErrorToHttpBody, toAppError } from '../src/errors.js';
import type { AppConfig } from '../src/config.js';

test('HTTP API key helper allows open dev mode and enforces configured keys', () => {
  equal(isAuthorizedApiKey(undefined, undefined), true);
  equal(isAuthorizedApiKey(undefined, 'test-key'), false);
  equal(isAuthorizedApiKey('wrong-key', 'test-key'), false);
  equal(isAuthorizedApiKey('test-key', 'test-key'), true);
});

test('isLoopbackRequest treats 127.0.0.1 / ::1 / IPv4-mapped loopback as loopback', () => {
  equal(isLoopbackRequest(fakeRequest({ remoteAddress: '127.0.0.1' })), true);
  equal(isLoopbackRequest(fakeRequest({ remoteAddress: '::1' })), true);
  equal(isLoopbackRequest(fakeRequest({ remoteAddress: '::ffff:127.0.0.1' })), true);
  equal(isLoopbackRequest(fakeRequest({ remoteAddress: '203.0.113.5' })), false);
  equal(isLoopbackRequest(fakeRequest({ remoteAddress: undefined })), false);
});

test('isAuthorizedRequest: with apiKey set, requires the key regardless of source', () => {
  const config = baseConfig({ apiKey: 'k', requireApiKeyForNonLoopback: true });
  equal(isAuthorizedRequest(fakeRequest({ remoteAddress: '127.0.0.1' }), config), false);
  equal(isAuthorizedRequest(fakeRequest({ remoteAddress: '127.0.0.1', apiKey: 'k' }), config), true);
  equal(isAuthorizedRequest(fakeRequest({ remoteAddress: '203.0.113.5', apiKey: 'k' }), config), true);
});

test('isAuthorizedRequest: without apiKey but requireApiKeyForNonLoopback=true, allows loopback only', () => {
  const config = baseConfig({ apiKey: undefined, requireApiKeyForNonLoopback: true });
  equal(isAuthorizedRequest(fakeRequest({ remoteAddress: '127.0.0.1' }), config), true);
  equal(isAuthorizedRequest(fakeRequest({ remoteAddress: '::1' }), config), true);
  equal(isAuthorizedRequest(fakeRequest({ remoteAddress: '203.0.113.5' }), config), false);
});

test('isAuthorizedRequest: without apiKey and requireApiKeyForNonLoopback=false, opens up entirely', () => {
  const config = baseConfig({ apiKey: undefined, requireApiKeyForNonLoopback: false });
  equal(isAuthorizedRequest(fakeRequest({ remoteAddress: '203.0.113.5' }), config), true);
});

test('toAppError + appErrorToHttpBody strip raw pg message text but keep code', () => {
  const pgLike = { code: '22P02', severity: 'ERROR', message: 'invalid input syntax for type uuid: "xxx"' };
  const body = appErrorToHttpBody(toAppError(pgLike));
  equal(body.code, 'store_error');
  doesNotMatch(body.error, /invalid input syntax/);
  notEqual(body.error, pgLike.message);
});

test('toAppError + appErrorToHttpBody strip raw redis message text', () => {
  const redisError = new Error('NOAUTH Authentication required');
  redisError.name = 'RedisAuthenticationError';
  const body = appErrorToHttpBody(toAppError(redisError));
  equal(body.code, 'cache_error');
  doesNotMatch(body.error, /NOAUTH/);
});

test('createHttpServer sets requestTimeout=60s and headersTimeout=10s to defeat slowloris', async () => {
  const { createHttpServer: factory } = await import('../src/http/server.js');
  const server = factory({} as never);
  equal(server.requestTimeout, 60_000, 'requestTimeout should be 60s');
  equal(server.headersTimeout, 10_000, 'headersTimeout should be 10s');
  server.close();
});

test('HTTP JSON body reader rejects oversized request bodies', async () => {
  const request = requestFromJson({ content: 'x'.repeat(500) });

  await rejects(
    () => readJsonBody(request, 120),
    (error) => error instanceof HttpError && error.status === 413,
  );
});

test('HTTP JSON body reader parses bounded JSON bodies', async () => {
  const body = { ok: true, value: 42 };
  const parsed = await readJsonBody<typeof body>(requestFromJson(body), 1024);

  equal(parsed.ok, true);
  equal(parsed.value, 42);
});

function requestFromJson(body: unknown): IncomingMessage {
  const encoded = JSON.stringify(body);
  const request = Readable.from([Buffer.from(encoded)]) as IncomingMessage;
  request.headers = {
    'content-length': String(Buffer.byteLength(encoded)),
    'content-type': 'application/json',
  };
  return request;
}

function fakeRequest(options: { remoteAddress?: string; apiKey?: string }): IncomingMessage {
  const request = {
    socket: { remoteAddress: options.remoteAddress },
    headers: {} as Record<string, string>,
  } as unknown as IncomingMessage;
  if (options.apiKey) {
    (request.headers as Record<string, string>)['x-tuberosa-api-key'] = options.apiKey;
  }
  return request;
}

function baseConfig(overrides: Partial<AppConfig>): AppConfig {
  return {
    env: 'test',
    port: 0,
    databaseUrl: '',
    redisUrl: '',
    apiKey: undefined,
    httpHost: '127.0.0.1',
    requireApiKeyForNonLoopback: true,
    store: 'memory',
    cache: 'memory',
    autoMigrate: false,
    modelProvider: 'hash',
    embeddingDimensions: 1536,
    openAiEmbeddingModel: 'text-embedding-3-small',
    contextCacheTtlSeconds: 300,
    maxRequestBytes: 10 * 1024 * 1024,
    maxIngestContentBytes: 2 * 1024 * 1024,
    backupDir: '.tuberosa/backups',
    backupIntervalSeconds: 3600,
    backupStartupDelaySeconds: 60,
    backupRetentionCount: 24,
    backupRetentionMaxAgeDays: 30,
    backupWriteThrough: false,
    backupWriteThroughThrottleSeconds: 600,
    physicalMirrorDebounceMs: 500,
    errorLogDir: '.tuberosa/error-logs',
    errorLogMaxBytes: 256 * 1024,
    errorLogAutoCapture: false,
    errorLogCaptureClientErrors: false,
    worktreeEnabled: false,
    worktreeMaxFiles: 50,
    worktreeMaxMtimeAgeHours: 72,
    ...overrides,
  } as AppConfig;
}
