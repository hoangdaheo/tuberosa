import { access, mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import test from 'node:test';
import { ok } from 'node:assert/strict';
import { AgentSessionService } from '../../src/agent-session/service.js';
import type { AppServices } from '../../src/app.js';
import { MemoryCache } from '../../src/cache.js';
import type { AppConfig } from '../../src/config.js';
import { ErrorLogInsightService } from '../../src/error-log/insights.js';
import { ErrorLogService } from '../../src/error-log/service.js';
import { createHttpServer } from '../../src/http/server.js';
import { IngestionService } from '../../src/ingest/service.js';
import { HashModelProvider } from '../../src/model/provider.js';
import { OperationsService } from '../../src/operations/service.js';
import { ReflectionService } from '../../src/reflection/service.js';
import { RetrievalService } from '../../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../../src/storage/memory-store.js';
import { chromium, type Page } from 'playwright-core';

const chromePath = '/usr/bin/google-chrome';

const config: AppConfig = {
  env: 'test',
  port: 0,
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
};

test('workbench browser flow starts, reviews, and finishes an agent session', async (t) => {
  try {
    await access(chromePath);
  } catch {
    t.skip(`Chrome executable not found at ${chromePath}`);
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
      await page.locator('h1').filter({ hasText: 'Tuberosa Workbench' }).waitFor();

      await page.locator('#projectFilter').fill(project);
      await page.locator('#refresh').click();
      await waitForSummary(page);

      await page.locator('#prompt').fill(
        'Implement browser verification for src/http/workbench.ts WorkbenchSummary and verification commands.',
      );
      await page.locator('#sessionProject').fill(project);
      await page.locator('#cwd').fill('/home/nash/tuberosa');
      await page.locator('#taskType').selectOption('implementation');
      await page.locator('#contextMode').selectOption('layered');
      await page.locator('#includeDeepContext').selectOption('false');
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await page.locator('#sessionResult').getByText('Task Brief').waitFor();

      const sessionText = await page.locator('#sessionResult').textContent();
      ok(sessionText?.includes('Verification Commands'));
      ok(sessionText?.includes('Missing Signals'));
      ok(sessionText?.includes('Direct Evidence'));
      ok(sessionText?.includes('Adjacent Context'));
      ok(sessionText?.includes('Workbench browser audit workflow'), 'seeded direct evidence should render');

      for (const decision of ['selected', 'selected_but_noisy', 'rejected', 'missing_context']) {
        await page.locator('#decisionReason').fill(`Browser smoke ${decision}`);
        await page.getByRole('button', { name: decision, exact: true }).click();
        await page.waitForFunction((expected) => (
          (globalThis as unknown as { document: { querySelector(selector: string): { textContent?: string | null } | null } })
            .document
            .querySelector('#decisionResult')
            ?.textContent
            ?.includes(String(expected))
        ), decision);
      }

      await page.locator('#finishSummary').fill('Browser smoke finished the workbench session.');
      await page.getByRole('button', { name: 'Finish Session', exact: true }).click();
      await page.waitForFunction(() => (
        (globalThis as unknown as { document: { querySelector(selector: string): { textContent?: string | null } | null } })
          .document
          .querySelector('#finishResult')
          ?.textContent
          ?.includes('compliance')
      ));

      const metricsText = await page.locator('#metrics').textContent();
      ok(metricsText?.includes('Context-quality'));
      ok(metricsText?.includes('Active sessions'));

      await page.getByRole('button', { name: 'Context Quality Review', exact: true }).click();
      await page.locator('#qualityResult .item-title').filter({ hasText: 'selected_but_noisy' }).first().waitFor();

      await page.getByRole('button', { name: 'Memory Review', exact: true }).click();
      await page.locator('#memoryResult .item-title').filter({ hasText: 'Open Gaps' }).waitFor();
      await page.locator('#draftReviewResult').getByText('Pending browser workbench draft').waitFor();
      await page.locator('#knowledgeResult').getByText('Workbench browser audit workflow').waitFor();
      await page.locator('#draftReviewer').fill('browser-smoke');
      await page.locator('#draftReviewResult textarea').first().fill('Useful draft, but the smoke seed has no references.');
      await page.locator('#draftReviewResult').getByRole('button', { name: 'Needs changes', exact: true }).click();
      await page.waitForFunction(() => (
        (globalThis as unknown as { document: { querySelector(selector: string): { textContent?: string | null } | null } })
          .document
          .querySelector('#status')
          ?.textContent
          ?.includes('needs_changes')
      ));
      await page.locator('#draftReviewResult').getByText('No reflection drafts matched this status.').waitFor();

      ok(await hasNoHorizontalOverflow(page));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await page.locator('h1').filter({ hasText: 'Tuberosa Workbench' }).waitFor();
      await waitForSummary(page);
      ok(await hasNoHorizontalOverflow(page));
    } finally {
      await browser.close();
    }
  } finally {
    if (server) {
      await closeServer(server);
    }
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
    reason: 'Seeded gap keeps the memory review view populated.',
  });

  await services.store.createLearningProposal({
    project,
    proposalType: 'missing_label',
    affectedKnowledgeId: adjacent.id,
    reason: 'Adjacent workbench queue workflow needs a browser label.',
    evidence: [`knowledge:${direct.id}`, 'file:src/http/workbench.ts'],
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
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function waitForSummary(page: Page): Promise<void> {
  await page.waitForFunction(() => (
    (globalThis as unknown as { document: { querySelector(selector: string): { textContent?: string | null } | null } })
      .document
      .querySelector('#status')
      ?.textContent
      ?.includes('Summary loaded')
  ));
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
