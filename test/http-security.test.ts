import { Readable } from 'node:stream';
import test from 'node:test';
import { equal, rejects } from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { HttpError, isAuthorizedApiKey, readJsonBody } from '../src/http/server.js';

test('HTTP API key helper allows open dev mode and enforces configured keys', () => {
  equal(isAuthorizedApiKey(undefined, undefined), true);
  equal(isAuthorizedApiKey(undefined, 'test-key'), false);
  equal(isAuthorizedApiKey('wrong-key', 'test-key'), false);
  equal(isAuthorizedApiKey('test-key', 'test-key'), true);
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
