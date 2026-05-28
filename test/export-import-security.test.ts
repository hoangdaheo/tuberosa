import test from 'node:test';
import { equal, match, ok } from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAppServices } from '../src/app.js';
import { createHttpServer } from '../src/http/server.js';

async function startServer(envOverrides: Record<string, string>) {
  const prev = { ...process.env };
  Object.assign(process.env, envOverrides);
  process.env.TUBEROSA_STORE = 'memory';
  process.env.TUBEROSA_CACHE = 'memory';
  process.env.TUBEROSA_MODEL_PROVIDER = 'hash';
  process.env.TUBEROSA_AUTO_MIGRATE = 'false';
  const services = await createAppServices();
  const server = createHttpServer(services);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await services.close();
      process.env = prev;
    },
  };
}

test('POST /operations/export-pack rejects absolute out path', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-exp-'));
  const ctx = await startServer({ TUBEROSA_EXPORT_BASE_DIR: base });
  try {
    const res = await fetch(`${ctx.url}/operations/export-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'demo', out: '/tmp/escape' }),
    });
    equal(res.status, 400);
    const body = (await res.json()) as { error?: string | { message?: string }; message?: string };
    const msg = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? '');
    match(msg, /absolute path is not allowed|outside the configured base/);
  } finally {
    await ctx.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('POST /operations/export-pack rejects .. traversal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-exp-'));
  const ctx = await startServer({ TUBEROSA_EXPORT_BASE_DIR: base });
  try {
    const res = await fetch(`${ctx.url}/operations/export-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'demo', out: '../escape' }),
    });
    equal(res.status, 400);
  } finally {
    await ctx.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('POST /operations/export-pack accepts a relative path under base', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-exp-'));
  const ctx = await startServer({ TUBEROSA_EXPORT_BASE_DIR: base });
  try {
    const res = await fetch(`${ctx.url}/operations/export-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'demo', out: 'snapshot-1' }),
    });
    ok(res.status === 200 || res.status === 404 || res.status === 500, `unexpected ${res.status}`);
  } finally {
    await ctx.close();
    await rm(base, { recursive: true, force: true });
  }
});
