import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { AgentSessionService } from '../../src/agent-session/service.js';
import type { AppServices } from '../../src/app.js';
import { MemoryCache } from '../../src/cache.js';
import type { AppConfig } from '../../src/config.js';
import { ErrorLogInsightService } from '../../src/error-log/insights.js';
import { ErrorLogService } from '../../src/error-log/service.js';
import { createHttpServer } from '../../src/http/server.js';
import { IngestionService } from '../../src/ingest/service.js';
import { MaintenanceService } from '../../src/maintenance/service.js';
import { HashModelProvider } from '../../src/model/provider.js';
import { OperationsService } from '../../src/operations/service.js';
import { SessionReplayService } from '../../src/operations/session-replay.js';
import { ReflectionService } from '../../src/reflection/service.js';
import { RetrievalService } from '../../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../../src/storage/memory-store.js';
import { chromium } from 'playwright-core';

const chromePath = '/usr/bin/google-chrome';
const bundlePath = join(process.cwd(), 'dist/workbench/app.js');

const config: AppConfig = {
  env: 'test',
  port: 0,
  databaseUrl: '',
  redisUrl: '',
  httpHost: '127.0.0.1',
  requireApiKeyForNonLoopback: false,
  store: 'memory',
  cache: 'memory',
  autoMigrate: false,
  modelProvider: 'hash',
  embeddingDimensions: 1536,
  openAiEmbeddingModel: 'text-embedding-3-small',
  contextCacheTtlSeconds: 60,
  maxRequestBytes: 10 * 1024 * 1024,
  maxIngestContentBytes: 2 * 1024 * 1024,
  backupDir: '.tuberosa/test-workbench-v2-browser-backups',
  backupIntervalSeconds: 0,
  backupStartupDelaySeconds: 0,
  backupRetentionCount: 24,
  backupRetentionMaxAgeDays: 30,
  backupWriteThrough: false,
  backupWriteThroughThrottleSeconds: 600,
  physicalMirrorEnabled: false,
  physicalMirrorDebounceMs: 500,
  errorLogDir: '.tuberosa/test-workbench-v2-browser-error-logs',
  errorLogMaxBytes: 256 * 1024,
  errorLogAutoCapture: true,
  errorLogCaptureClientErrors: false,
  persistReplay: false,
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
};

test('workbench v2 browser smoke', async (t) => {
  try {
    await access(chromePath);
  } catch {
    t.skip(`Chrome executable not found at ${chromePath}`);
    return;
  }
  try {
    await stat(bundlePath);
  } catch {
    t.skip(`Workbench bundle not built (run pnpm run build:workbench). Missing ${bundlePath}`);
    return;
  }

  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-workbench-v2-browser-backups-'));
  const errorLogDir = await mkdtemp(join(tmpdir(), 'tuberosa-workbench-v2-browser-error-logs-'));
  const services = createBrowserServices(backupDir, errorLogDir);
  let server: Server | undefined;

  try {
    server = createHttpServer(services);
    const baseUrl = await listen(server);
    const browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${baseUrl}/workbench`);

      // Ch1 hello
      await page.waitForSelector('section#ch1');
      await page.locator('section#ch1 button.primary').first().click();
      await page.waitForSelector('section#ch2');

      // Progress rail jump to Ch7
      await page.locator('.progress-rail a[href="#/ch7"]').click();
      await page.waitForSelector('section#ch7');
      const cardCount = await page.locator('section#ch7 button.card').count();
      ok(cardCount >= 10, `Ch07 should have at least 10 example cards, got ${cardCount}`);

      // Click first example, expect pipeline to render
      await page.locator('section#ch7 button.card').first().click();
      await page.waitForSelector('section#ch7 ol li button.card');

      // Replay 404 for missing session
      const res = (await page.evaluate(async (url) => {
        const r = await fetch(`${url}/operations/workbench/session/does-not-exist/replay`);
        return { status: r.status, body: await r.json() };
      }, baseUrl)) as { status: number; body: { error?: unknown } };
      equal(res.status, 404);
      ok(res.body?.error, 'replay 404 returns an error envelope');
    } finally {
      await browser.close();
    }
  } finally {
    if (server) await closeServer(server);
    await services.close();
    await rm(backupDir, { recursive: true, force: true });
    await rm(errorLogDir, { recursive: true, force: true });
  }
});

function createBrowserServices(backupDir: string, errorLogDir: string): AppServices {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const localConfig = { ...config, backupDir, errorLogDir };
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, localConfig);
  const reflection = new ReflectionService(store, ingestion);
  const sessionReplay = new SessionReplayService(store);
  const agentSessions = new AgentSessionService(
    store,
    retrieval,
    reflection,
    sessionReplay,
    localConfig,
  );
  const operations = new OperationsService(store, ingestion, {
    backupDir,
    storeKind: 'memory',
    physicalMirror: { enabled: false, debounceMs: 10 },
  });
  const errorLogs = new ErrorLogService({ rootDir: errorLogDir });
  const errorLogInsights = new ErrorLogInsightService(errorLogs, reflection);
  const maintenance = new MaintenanceService(store);

  return {
    config: localConfig,
    store,
    cache,
    models,
    ingestion,
    retrieval,
    reflection,
    agentSessions,
    sessionReplay,
    operations,
    errorLogs,
    errorLogInsights,
    maintenance,
    safety: {} as AppServices['safety'],
    async close() {
      await Promise.allSettled([operations.close(), cache.close(), store.close()]);
    },
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
