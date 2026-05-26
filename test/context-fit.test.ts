import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import type { ModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type {
  ContextFit,
  FitDiagnostics,
  QueryRewriteInput,
  QueryRewriteResult,
  RerankInput,
  RerankResult,
} from '../src/types.js';

const config: AppConfig = {
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
};

class ThrowingRerankProvider implements ModelProvider {
  private readonly fallback: HashModelProvider;

  constructor(dimensions: number) {
    this.fallback = new HashModelProvider(dimensions);
  }

  async embed(text: string): Promise<number[]> {
    return this.fallback.embed(text);
  }

  async rewriteQuery(_input: QueryRewriteInput): Promise<QueryRewriteResult | undefined> {
    return undefined;
  }

  async rerank(_input: RerankInput): Promise<RerankResult> {
    throw new Error('synthetic rerank failure: model unavailable');
  }
}

function expectFit(pack: { contextFit?: ContextFit }): ContextFit {
  ok(pack.contextFit, 'contextFit should be present on the pack');
  return pack.contextFit as ContextFit;
}

function readDiagnostics(contextFit: ContextFit): FitDiagnostics | undefined {
  return (contextFit as ContextFit & { fitDiagnostics?: FitDiagnostics }).fitDiagnostics;
}

async function seedHandlerCorpus(store: MemoryKnowledgeStore, embedder: HashModelProvider): Promise<string> {
  const ingestion = new IngestionService(store, embedder);
  const knowledge = await ingestion.ingestKnowledge({
    project: 'phase3',
    sourceType: 'file',
    sourceUri: 'src/example/handler.ts',
    itemType: 'code_ref',
    title: 'HandlerService dispatches requests',
    summary: 'Primary request handler at src/example/handler.ts.',
    content: 'export class HandlerService { dispatch(request: Request) { return process(request); } }',
    labels: [
      { type: 'file', value: 'src/example/handler.ts' },
      { type: 'symbol', value: 'HandlerService' },
    ],
    references: [{ type: 'file', uri: 'src/example/handler.ts' }],
  });
  return knowledge.id;
}

test('rerank failure → fitStatus=needs_confirmation, candidates kept, reason recorded', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const embedder = new HashModelProvider(config.embeddingDimensions);
  const provider = new ThrowingRerankProvider(config.embeddingDimensions);
  const retrieval = new RetrievalService(store, cache, provider, config);

  const knowledgeId = await seedHandlerCorpus(store, embedder);

  const pack = await retrieval.searchContext({
    prompt: 'Explain how HandlerService works in src/example/handler.ts.',
    project: 'phase3',
    bypassCache: true,
  });

  const contextFit = expectFit(pack);
  equal(contextFit.fitStatus, 'needs_confirmation');
  ok(
    contextFit.fitReasons.includes('reranker_unavailable'),
    `fitReasons should include 'reranker_unavailable'; got ${JSON.stringify(contextFit.fitReasons)}`,
  );

  const flatIds = (pack.sections ?? []).flatMap((section) => section.items.map((item) => item.knowledgeId));
  ok(
    flatIds.includes(knowledgeId),
    `fused candidate should still surface despite rerank failure; got ${JSON.stringify(flatIds)}`,
  );

  const diagnostics = readDiagnostics(contextFit);
  ok(diagnostics, 'fitDiagnostics should be emitted even on rerank failure');
  equal(diagnostics.rerankerAvailable, false);
});

test('fitDiagnostics.contributors lists top1, top3Avg, coverage, worktreeMatchScore with numbers', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const embedder = new HashModelProvider(config.embeddingDimensions);
  const provider = new HashModelProvider(config.embeddingDimensions);
  const retrieval = new RetrievalService(store, cache, provider, config);

  await seedHandlerCorpus(store, embedder);

  const pack = await retrieval.searchContext({
    prompt: 'Explain how HandlerService works in src/example/handler.ts.',
    project: 'phase3',
    bypassCache: true,
  });

  const contextFit = expectFit(pack);
  const diagnostics = readDiagnostics(contextFit);
  ok(diagnostics, 'fitDiagnostics should be emitted on the happy path');

  equal(typeof diagnostics.contributors.top1, 'number');
  equal(typeof diagnostics.contributors.top3Avg, 'number');
  equal(typeof diagnostics.contributors.coverage, 'number');
  // Phase 5 placeholder — Phase 3 keeps this at 0 so weighting math is unchanged
  // until the worktree provider lands.
  equal(diagnostics.contributors.worktreeMatchScore, 0);

  equal(typeof diagnostics.weights.top1, 'number');
  equal(typeof diagnostics.weights.top3Avg, 'number');
  equal(typeof diagnostics.weights.coverage, 'number');
  equal(typeof diagnostics.weights.worktreeMatch, 'number');

  // Phase 3 default weights — locked in by the spec.
  equal(diagnostics.weights.top1, 0.55);
  equal(diagnostics.weights.top3Avg, 0.2);
  equal(diagnostics.weights.coverage, 0.15);
  equal(diagnostics.weights.worktreeMatch, 0.1);

  equal(typeof diagnostics.thresholds.ready, 'number');
  equal(typeof diagnostics.thresholds.needsConfirmation, 'number');

  equal(diagnostics.rerankerAvailable, true);
});

test('rerank failure causes fitDiagnostics.rerankerAvailable=false', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const embedder = new HashModelProvider(config.embeddingDimensions);
  const provider = new ThrowingRerankProvider(config.embeddingDimensions);
  const retrieval = new RetrievalService(store, cache, provider, config);

  await seedHandlerCorpus(store, embedder);

  const pack = await retrieval.searchContext({
    prompt: 'Explain how HandlerService works in src/example/handler.ts.',
    project: 'phase3',
    bypassCache: true,
  });

  const contextFit = expectFit(pack);
  const diagnostics = readDiagnostics(contextFit);
  ok(diagnostics, 'fitDiagnostics should be present even when rerank failed');
  equal(diagnostics.rerankerAvailable, false);
});
