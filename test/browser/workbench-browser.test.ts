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
import { ReflectionService } from '../../src/reflection/service.js';
import { RetrievalService } from '../../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../../src/storage/memory-store.js';
import { chromium, type Page } from 'playwright-core';

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
  backupDir: '.tuberosa/test-workbench-browser-backups',
  backupIntervalSeconds: 0,
  backupStartupDelaySeconds: 0,
  backupRetentionCount: 24,
  backupRetentionMaxAgeDays: 30,
  backupWriteThrough: false,
  backupWriteThroughThrottleSeconds: 600,
  physicalMirrorEnabled: false,
  physicalMirrorDebounceMs: 500,
  errorLogDir: '.tuberosa/test-workbench-browser-error-logs',
  errorLogMaxBytes: 256 * 1024,
  errorLogAutoCapture: true,
  errorLogCaptureClientErrors: false,
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
};

test('workbench browser flow exercises guided shell', async (t) => {
  try { await access(chromePath); } catch {
    t.skip(`Chrome executable not found at ${chromePath}`);
    return;
  }
  try { await stat(bundlePath); } catch {
    t.skip(`Workbench bundle not built (run pnpm run build:workbench). Missing ${bundlePath}`);
    return;
  }

  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-workbench-browser-backups-'));
  const errorLogDir = await mkdtemp(join(tmpdir(), 'tuberosa-workbench-browser-error-logs-'));
  const services = createBrowserServices(backupDir, errorLogDir);
  const project = 'workbench-browser-smoke';
  let server: Server | undefined;

  try {
    await seedWorkbenchProject(services, project);
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

      // Boots into Start
      await page.locator('[data-testid="nav-start"]').waitFor();
      await page.locator('[data-testid="start-view"]').waitFor();
      equal(
        await page.evaluate(() => (globalThis as unknown as { location: { hash: string } }).location.hash),
        '#/start',
      );

      const startText = await page.locator('[data-testid="start-view"]').textContent();
      ok(startText?.includes('What is the agent about to do?'), 'Start view asks for the real task first');
      ok(startText?.includes('Map context'), 'Start view exposes the primary mapping action');

      // Map a session
      await page.locator('[data-testid="start-prompt"]').fill(
        'Implement browser verification for src/http/workbench.ts WorkbenchSummary and verification commands.',
      );
      await page.locator('#start-project').fill(project);
      await page.locator('#start-cwd').fill('/home/nash/tuberosa');
      await page.locator('[data-testid="map-context"]').click();
      await page.locator('[data-testid="session-result-view"]').waitFor();

      const resultText = await page.locator('[data-testid="session-result-view"]').textContent();
      ok(resultText?.includes('Context'), 'session result renders context verdict');
      ok(resultText?.includes('Pipeline'), 'session result renders pipeline');
      ok(resultText?.includes('Evidence graph'), 'session result renders evidence graph');
      ok(resultText?.includes('Agent handoff'), 'session result renders agent handoff');
      await page.locator('[data-testid="context-stack-essential"]').waitFor();

      // Record decision
      await page.locator('[data-testid="decision-panel"]').waitFor();
      await page.locator('#decision-type').selectOption('selected_but_noisy');
      await page.locator('#decision-reason').fill('Browser smoke selected noisy context');
      await page.locator('[data-testid="record-decision"]').click();
      await page.locator('[data-testid="decision-recorded"]').waitFor();

      // Finish session
      await page.locator('#finish-summary').fill('Browser smoke finished the workbench session.');
      await page.locator('[data-testid="finish-session"]').click();
      await page.locator('[data-testid="finish-result"]').waitFor();

      // Review
      await page.locator('[data-testid="nav-review"]').click();
      await page.locator('[data-testid="review-view"]').waitFor();
      const reviewText = await page.locator('[data-testid="review-view"]').textContent();
      ok(reviewText?.includes('Decision queue'), 'review view renders a unified decision queue');
      await page.locator('[data-testid="review-filter-gaps"]').click();
      await page.locator('[data-testid="review-queue"]').waitFor();

      // Playbooks
      await page.locator('[data-testid="nav-playbooks"]').click();
      await page.locator('[data-testid="playbooks-view"]').waitFor();
      const playbookText = await page.locator('[data-testid="playbooks-view"]').textContent();
      ok(playbookText?.includes('Run your first task'), 'playbooks include first-task guide');
      ok(playbookText?.includes('Fix missing context'), 'playbooks include missing-context guide');

      // System
      await page.locator('[data-testid="nav-system"]').click();
      await page.locator('[data-testid="system-view"]').waitFor();
      const systemText = await page.locator('[data-testid="system-view"]').textContent();
      ok(systemText?.includes('store'), 'system view renders store status');
      ok(systemText?.includes('provider'), 'system view renders provider status');

      await verifyNoOverflowAcrossWorkbench(page, baseUrl);
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

async function seedWorkbenchProject(services: AppServices, project: string): Promise<void> {
  const direct = await services.ingestion.ingestKnowledge({
    project,
    sourceType: 'manual',
    sourceUri: 'manual://workbench-browser/direct',
    itemType: 'code_ref',
    title: 'Workbench browser audit workflow',
    summary: 'Use the workbench UI to inspect session context fit and evidence groups.',
    content: 'The workbench browser audit should start a session, inspect direct evidence, record decisions, and finish the session.',
    trustLevel: 92,
    labels: [
      { type: 'file', value: 'src/http/workbench.ts', weight: 1 },
      { type: 'symbol', value: 'WorkbenchSummary', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'src/http/workbench.ts' }],
  });

  const adjacent = await services.ingestion.ingestKnowledge({
    project,
    sourceType: 'manual',
    sourceUri: 'manual://workbench-browser/adjacent',
    itemType: 'workflow',
    title: 'Adjacent workbench queue workflow',
    summary: 'Adjacent review queues should not hide direct workbench evidence.',
    content: 'Context-quality and memory review queues are adjacent to the browser audit.',
    trustLevel: 70,
    labels: [{ type: 'business_area', value: 'operations', weight: 1 }],
  });

  await services.store.createReflectionDraft({
    project,
    title: 'Pending browser workbench draft',
    summary: 'Browser smoke drafts should stay reviewable.',
    content: 'Review browser workbench drafts through explicit review APIs.',
    triggerType: 'manual',
  }, []);

  await services.store.createKnowledgeGap({
    project,
    prompt: 'Browser workbench smoke',
    missingSignals: ['file:src/http/workbench.ts'],
    reason: 'Seeded gap keeps the review queue populated.',
  });

  await services.store.createLearningProposal({
    project,
    proposalType: 'missing_label',
    affectedKnowledgeId: adjacent.id,
    reason: 'Adjacent workbench queue workflow needs a browser label.',
    evidence: [`knowledge:${direct.id}`, 'file:src/http/workbench.ts'],
  });

  await services.ingestion.ingestKnowledge({
    project,
    sourceType: 'agent_session',
    sourceUri: 'agent-session://browser-risky-memory',
    itemType: 'memory',
    title: 'Risky auto memory without grounded references',
    summary: 'This memory has auto-learning metadata but lacks grounded references.',
    content: 'Risky memories should be visible in the workbench audit queue.',
    trustLevel: 72,
    metadata: { source: 'agent_session_finish', learningMode: 'auto' },
  });

  await services.store.createKnowledgeConflict({
    project,
    leftKnowledgeId: direct.id,
    rightKnowledgeId: adjacent.id,
    conflictType: 'summary_contradiction',
    sharedEvidence: ['file:src/http/workbench.ts'],
    reason: 'Seeded conflict keeps the conflicts queue populated.',
  });

  await services.errorLogs.recordLog({
    project,
    category: 'test',
    severity: 'error',
    status: 'open',
    title: 'Seeded workbench browser error log',
    summary: 'Browser test error logs should render from openErrorLogs.logs.',
    message: 'Seeded workbench browser error log',
    files: ['src/workbench/app.tsx'],
    symbols: ['App'],
    errors: ['WorkbenchBrowserSeedError'],
    tags: ['workbench-browser'],
  });
}

function createBrowserServices(backupDir: string, errorLogDir: string): AppServices {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const localConfig = { ...config, backupDir, errorLogDir };
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, localConfig);
  const reflection = new ReflectionService(store, ingestion);
  const agentSessions = new AgentSessionService(store, retrieval, reflection);
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

async function hasNoHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const global = globalThis as unknown as {
      document: { documentElement: { scrollWidth: number } };
      window: { innerWidth: number };
    };
    return global.document.documentElement.scrollWidth <= global.window.innerWidth + 1;
  });
}

async function verifyNoOverflowAcrossWorkbench(page: Page, baseUrl: string): Promise<void> {
  const routes = ['#/start', '#/sessions', '#/review', '#/knowledge', '#/playbooks', '#/system'];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const route of routes) {
      await page.goto(`${baseUrl}/workbench${route}`);
      await page.waitForTimeout(100);
      ok(await hasNoHorizontalOverflow(page), `${route} has no horizontal overflow at ${width}px`);
    }
  }
}
