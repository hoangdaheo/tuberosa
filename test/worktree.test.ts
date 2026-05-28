import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type { ContextPack, FitDiagnostics, RankedCandidate } from '../src/types.js';

const baseConfig: AppConfig = {
  env: 'test',
  port: 3027,
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
  backupDir: '.tuberosa/test-backups',
  backupIntervalSeconds: 0,
  backupStartupDelaySeconds: 0,
  backupRetentionCount: 24,
  backupRetentionMaxAgeDays: 30,
  backupWriteThrough: false,
  backupWriteThroughThrottleSeconds: 600,
  physicalMirrorDebounceMs: 500,
  errorLogDir: '.tuberosa/test-error-logs',
  errorLogMaxBytes: 256 * 1024,
  errorLogAutoCapture: true,
  errorLogCaptureClientErrors: false,
  persistReplay: false,
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
  llmCriticEnabled: false,
  archivalEnabled: false,
  archivalIntervalHours: 24,
};

function createSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'tuberosa-phase5-'));
}

function destroySandbox(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function flatItems(pack: ContextPack): RankedCandidate[] {
  return pack.sections.flatMap((section) => section.items);
}

function findEssentialSection(pack: ContextPack): RankedCandidate[] | undefined {
  return pack.sections.find((section) => section.name === 'essential')?.items;
}

function readDiagnostics(pack: ContextPack): FitDiagnostics | undefined {
  return pack.contextFit?.fitDiagnostics;
}

test('prompt-named handoff file surfaces from the worktree into the essential bucket', async () => {
  const sandbox = createSandbox();
  try {
    writeFileSync(
      join(sandbox, 'integrate-reranking.md'),
      [
        '# Integrate reranking',
        '',
        '## Current state',
        'The reranker is wired through HandlerService. Tests pass; latency is within budget.',
        '',
        '## Next steps',
        '1. Add a calibration eval for rerank.',
        '2. Document the fallback path in the runbook.',
      ].join('\n'),
    );

    const store = new MemoryKnowledgeStore();
    const cache = new MemoryCache();
    const models = new HashModelProvider(baseConfig.embeddingDimensions);
    const retrieval = new RetrievalService(store, cache, models, baseConfig);

    const pack = await retrieval.searchContext({
      prompt: 'Continue the reranking integration described in integrate-reranking.md.',
      project: 'phase5',
      cwd: sandbox,
      files: ['integrate-reranking.md'],
      taskType: 'implementation',
      bypassCache: true,
    });

    const essential = findEssentialSection(pack);
    assert.ok(essential && essential.length > 0, 'essential section should exist');
    const titles = essential!.map((item) => item.title);
    assert.ok(
      titles.includes('integrate-reranking.md'),
      `prompt-named handoff should appear in the essential bucket; got ${JSON.stringify(titles)}`,
    );
    const worktreeItem = essential!.find((item) => item.title === 'integrate-reranking.md');
    assert.equal(worktreeItem?.source, 'worktree');
    assert.equal(worktreeItem?.metadata?.worktree && (worktreeItem.metadata.worktree as { reason: string }).reason, 'prompt_named');

    const diagnostics = readDiagnostics(pack);
    assert.ok(diagnostics, 'fitDiagnostics should be present');
    assert.ok(
      diagnostics!.contributors.worktreeMatchScore > 0,
      `worktreeMatchScore should be > 0 when a prompt-named file matches; got ${diagnostics!.contributors.worktreeMatchScore}`,
    );
  } finally {
    destroySandbox(sandbox);
  }
});

test('worktree wins precedence over a conflicting durable memory for continuation tasks', async () => {
  const sandbox = createSandbox();
  try {
    // The worktree's truth: handler.ts has dispatchV2 + processV2 (the migration landed).
    mkdirSync(join(sandbox, 'src', 'example'), { recursive: true });
    writeFileSync(
      join(sandbox, 'src', 'example', 'handler.ts'),
      [
        'export class HandlerService {',
        '  dispatchV2(request: Request) {',
        '    return processV2(request);',
        '  }',
        '}',
        '',
        'export function processV2(request: Request) {',
        '  return { ok: true, route: request.path };',
        '}',
        '',
      ].join('\n'),
    );

    const store = new MemoryKnowledgeStore();
    const cache = new MemoryCache();
    const models = new HashModelProvider(baseConfig.embeddingDimensions);
    const ingestion = new IngestionService(store, models);
    const retrieval = new RetrievalService(store, cache, models, baseConfig);

    // The durable memory's *old* belief: handler still uses dispatch/process (pre-migration).
    await ingestion.ingestKnowledge({
      project: 'phase5',
      sourceType: 'memory',
      sourceUri: 'memory://handler-dispatch-old',
      itemType: 'memory',
      title: 'HandlerService dispatches via the legacy process() helper',
      summary: 'HandlerService.dispatch() calls process(request); used by the older pipeline.',
      content: [
        'HandlerService at src/example/handler.ts uses dispatch(request) which calls process(request).',
        'This memory describes the pre-migration behavior.',
      ].join('\n'),
      labels: [
        { type: 'file', value: 'src/example/handler.ts' },
        { type: 'symbol', value: 'HandlerService' },
        { type: 'symbol', value: 'dispatch' },
      ],
      references: [{ type: 'file', uri: 'src/example/handler.ts' }],
    });

    const pack = await retrieval.searchContext({
      prompt: 'Continue the HandlerService migration in src/example/handler.ts — confirm the dispatch path.',
      project: 'phase5',
      cwd: sandbox,
      files: ['src/example/handler.ts'],
      symbols: ['HandlerService'],
      taskType: 'implementation',
      bypassCache: true,
    });

    const items = flatItems(pack);
    assert.ok(items.length > 0, 'pack should contain candidates');

    const worktreeItem = items.find((item) => item.source === 'worktree' && item.title.endsWith('handler.ts'));
    // Memory may be tagged 'memory' or 'graph' depending on which source emitted the highest
    // rawScore for the same knowledgeId during fusion merge — the fusion keeps the
    // higher-scoring source's chunk fields. Identify it by its title instead.
    const memoryItem = items.find((item) => item.title.toLowerCase().includes('legacy process'));
    assert.ok(worktreeItem, 'worktree candidate for handler.ts should be present');
    assert.ok(memoryItem, 'memory candidate for the legacy handler belief should be present');

    assert.ok(
      worktreeItem!.rank < memoryItem!.rank,
      `worktree should outrank conflicting durable memory; worktree rank=${worktreeItem!.rank}, memory rank=${memoryItem!.rank}`,
    );

    assert.ok(
      worktreeItem!.matchReasons.includes('boost:worktree_live_evidence:prompt_named'),
      `worktree should carry the live-evidence boost reason; matchReasons=${JSON.stringify(worktreeItem!.matchReasons)}`,
    );

    // Worktree candidates point at live files without copying raw file bodies into the pack.
    assert.ok(worktreeItem!.content.includes('Path: src/example/handler.ts'), 'worktree content should identify the live file path');
    assert.ok(!worktreeItem!.content.includes('dispatchV2'), 'worktree content should stay bounded and omit raw file bodies');
    assert.ok(memoryItem!.content.toLowerCase().includes('dispatch(request)'), 'memory should still describe the old signature');
  } finally {
    destroySandbox(sandbox);
  }
});

test('planning task type opts out of the worktree provider', async () => {
  const sandbox = createSandbox();
  try {
    writeFileSync(join(sandbox, 'roadmap.md'), '# Roadmap\n\nPhase 5 ships the worktree provider.\n');

    const store = new MemoryKnowledgeStore();
    const cache = new MemoryCache();
    const models = new HashModelProvider(baseConfig.embeddingDimensions);
    const retrieval = new RetrievalService(store, cache, models, baseConfig);

    const pack = await retrieval.searchContext({
      prompt: 'Plan the next milestone using roadmap.md as the planning anchor.',
      project: 'phase5',
      cwd: sandbox,
      files: ['roadmap.md'],
      taskType: 'planning',
      bypassCache: true,
    });

    const worktreeItems = flatItems(pack).filter((item) => item.source === 'worktree');
    assert.equal(
      worktreeItems.length,
      0,
      `planning taskType should suppress the worktree provider; got ${JSON.stringify(worktreeItems.map((item) => item.title))}`,
    );

    const diagnostics = readDiagnostics(pack);
    assert.ok(diagnostics, 'fitDiagnostics should still be emitted');
    assert.equal(diagnostics!.contributors.worktreeMatchScore, 0);
  } finally {
    destroySandbox(sandbox);
  }
});

test('TUBEROSA_WORKTREE_ENABLED=false disables the provider entirely', async () => {
  const sandbox = createSandbox();
  try {
    writeFileSync(join(sandbox, 'handoff.md'), '# Handoff\n\nContext for the current effort.\n');

    const store = new MemoryKnowledgeStore();
    const cache = new MemoryCache();
    const models = new HashModelProvider(baseConfig.embeddingDimensions);
    const retrieval = new RetrievalService(store, cache, models, {
      ...baseConfig,
      worktreeEnabled: false,
    });

    const pack = await retrieval.searchContext({
      prompt: 'Continue working from handoff.md.',
      project: 'phase5',
      cwd: sandbox,
      files: ['handoff.md'],
      taskType: 'implementation',
      bypassCache: true,
    });

    const worktreeItems = flatItems(pack).filter((item) => item.source === 'worktree');
    assert.equal(
      worktreeItems.length,
      0,
      `disabled worktree provider should produce no worktree candidates; got ${JSON.stringify(worktreeItems.map((item) => item.title))}`,
    );

    const diagnostics = readDiagnostics(pack);
    assert.ok(diagnostics, 'fitDiagnostics should still be emitted');
    assert.equal(diagnostics!.contributors.worktreeMatchScore, 0);
  } finally {
    destroySandbox(sandbox);
  }
});

test('missing cwd is handled gracefully (no worktree candidates, no crash)', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(baseConfig.embeddingDimensions);
  const retrieval = new RetrievalService(store, cache, models, baseConfig);

  const pack = await retrieval.searchContext({
    prompt: 'Continue the integration — no cwd is provided here.',
    project: 'phase5',
    files: ['handoff.md'],
    taskType: 'implementation',
    bypassCache: true,
  });

  const worktreeItems = flatItems(pack).filter((item) => item.source === 'worktree');
  assert.equal(worktreeItems.length, 0);
  const diagnostics = readDiagnostics(pack);
  assert.equal(diagnostics?.contributors.worktreeMatchScore, 0);
});
