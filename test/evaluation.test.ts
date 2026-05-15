import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { loadRetrievalEvalFixture } from '../src/evaluation/fixture-loader.js';
import { RetrievalEvaluator } from '../src/evaluation/retrieval-evaluator.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

const config: AppConfig = {
  env: 'test',
  port: 3027,
  databaseUrl: '',
  redisUrl: '',
  store: 'memory',
  cache: 'memory',
  modelProvider: 'hash',
  embeddingDimensions: 1536,
  openAiEmbeddingModel: 'text-embedding-3-small',
  contextCacheTtlSeconds: 0,
};

test('retrieval evaluation fixture produces passing quality metrics', async () => {
  const fixturePath = fileURLToPath(new URL('../eval/retrieval-fixtures.json', import.meta.url));
  const fixture = await loadRetrievalEvalFixture(fixturePath);
  const evaluator = createEvaluator();
  const report = await evaluator.run(fixture, { topK: 3 });

  equal(report.totalCases, fixture.cases.length);
  equal(report.metrics.hitRate, 1);
  equal(report.metrics.staleRejectionRate, 1);
  equal(report.metrics.unexpectedAvoidanceRate, 1);
  equal(report.metrics.exactFileMatchRate, 1);
  equal(report.metrics.exactSymbolMatchRate, 1);
  equal(report.metrics.exactErrorMatchRate, 1);
  ok((report.metrics.meanReciprocalRank ?? 0) > 0.8);
  ok(report.cases.every((testCase) => testCase.passed), failedCases(report));
});

function createEvaluator(): RetrievalEvaluator {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, config);
  return new RetrievalEvaluator(ingestion, retrieval);
}

function failedCases(report: Awaited<ReturnType<RetrievalEvaluator['run']>>): string {
  return report.cases
    .filter((testCase) => !testCase.passed)
    .map((testCase) => `${testCase.id}: ${testCase.topKnowledgeIds.join(', ')}`)
    .join('\n');
}
