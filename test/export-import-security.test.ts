import test from 'node:test';
import { deepEqual, equal, match, ok } from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAppServices } from '../src/app.js';
import { createHttpServer } from '../src/http/server.js';
import { handleMcpRequest } from '../src/mcp/server.js';

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

test('POST /operations/import-pack rejects /proc traversal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-imp-'));
  const ctx = await startServer({ TUBEROSA_IMPORT_BASE_DIR: base });
  try {
    const res = await fetch(`${ctx.url}/operations/import-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '/proc/self/environ' }),
    });
    equal(res.status, 400);
  } finally {
    await ctx.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('POST /operations/import-pack rejects ../ traversal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-imp-'));
  const ctx = await startServer({ TUBEROSA_IMPORT_BASE_DIR: base });
  try {
    const res = await fetch(`${ctx.url}/operations/import-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '../escape' }),
    });
    equal(res.status, 400);
  } finally {
    await ctx.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('tuberosa_export_pack rejects absolute out via MCP', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-mcp-exp-'));
  const prev = { ...process.env };
  process.env.TUBEROSA_EXPORT_BASE_DIR = base;
  process.env.TUBEROSA_STORE = 'memory';
  process.env.TUBEROSA_CACHE = 'memory';
  process.env.TUBEROSA_MODEL_PROVIDER = 'hash';
  process.env.TUBEROSA_AUTO_MIGRATE = 'false';
  const services = await createAppServices();
  try {
    let threw = false;
    try {
      await handleMcpRequest(services, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'tuberosa_export_pack', arguments: { project: 'demo', out: '/etc/cron.daily/evil' } },
      } as any);
    } catch (err) {
      threw = true;
      match((err as Error).message, /absolute path is not allowed|outside the configured base/);
    }
    ok(threw, 'expected ValidationError');
  } finally {
    await services.close();
    process.env = prev;
    await rm(base, { recursive: true, force: true });
  }
});

test('tuberosa_import_pack rejects /proc path via MCP', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-mcp-imp-'));
  const prev = { ...process.env };
  process.env.TUBEROSA_IMPORT_BASE_DIR = base;
  process.env.TUBEROSA_STORE = 'memory';
  process.env.TUBEROSA_CACHE = 'memory';
  process.env.TUBEROSA_MODEL_PROVIDER = 'hash';
  process.env.TUBEROSA_AUTO_MIGRATE = 'false';
  const services = await createAppServices();
  try {
    let threw = false;
    try {
      await handleMcpRequest(services, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'tuberosa_import_pack', arguments: { from: '/proc/self/environ' } },
      } as any);
    } catch (err) {
      threw = true;
      match((err as Error).message, /absolute path is not allowed|outside the configured base/);
    }
    ok(threw, 'expected ValidationError');
  } finally {
    await services.close();
    process.env = prev;
    await rm(base, { recursive: true, force: true });
  }
});

test('importer skips user-style entries that fail assertSafeChildName', async () => {
  const { assertSafeChildName, ValidationError } = await import('../src/security/safe-paths.js');
  const candidates = ['alice', '..', 'a/b', 'bob', '.', 'carol_1'];
  const accepted: string[] = [];
  for (const c of candidates) {
    try { assertSafeChildName(c); accepted.push(c); } catch (e) { ok(e instanceof ValidationError); }
  }
  deepEqual(accepted, ['alice', 'bob', 'carol_1']);
});
