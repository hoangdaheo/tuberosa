import test from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import {
  evaluateKnowledgeCompletenessPack,
  KnowledgeCompletenessEvaluator,
} from '../src/evaluation/knowledge-completeness-evaluator.js';
import {
  loadKnowledgeCompletenessFixture,
  parseKnowledgeCompletenessFixture,
} from '../src/evaluation/knowledge-completeness-fixture-loader.js';
import { loadRetrievalEvalFixture } from '../src/evaluation/fixture-loader.js';
import { RetrievalEvaluator } from '../src/evaluation/retrieval-evaluator.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type { ClassifiedQuery, ContextPack, RankedCandidate } from '../src/types.js';

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
  contextCacheTtlSeconds: 0,
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
  errorLogDir: ".tuberosa/test-error-logs",
  errorLogMaxBytes: 256 * 1024,
  errorLogAutoCapture: true,
  errorLogCaptureClientErrors: false,
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
};

test('retrieval evaluation fixture produces passing quality metrics', async () => {
  const fixturePath = fileURLToPath(new URL('../eval/retrieval-fixtures.json', import.meta.url));
  const fixture = await loadRetrievalEvalFixture(fixturePath);
  const evaluator = createEvaluator();
  const report = await evaluator.run(fixture, { topK: 3 });

  equal(report.totalCases, fixture.cases.length);
  equal(report.metrics.hitRate, 1);
  equal(report.metrics.selectedCoverageRate, 1);
  equal(report.metrics.staleRejectionRate, 1);
  equal(report.metrics.unexpectedAvoidanceRate, 1);
  equal(report.metrics.confidenceThresholdRate, 1);
  equal(report.metrics.contextFitStatusRate, 1);
  equal(report.metrics.contextFitScoreRate, 1);
  equal(report.metrics.exactFileMatchRate, 1);
  equal(report.metrics.exactSymbolMatchRate, 1);
  equal(report.metrics.exactErrorMatchRate, 1);
  ok((report.metrics.meanReciprocalRank ?? 0) > 0.8);
  ok(report.cases.every((testCase) => testCase.confidencePassed !== false), failedCases(report));
  ok(report.cases.every((testCase) => testCase.contextFitStatusPassed !== false), failedCases(report));
  ok(report.cases.every((testCase) => testCase.contextFitScorePassed !== false), failedCases(report));
  ok(report.cases.every((testCase) => testCase.passed), failedCases(report));
});

test('retrieval evaluation treats explicit empty classification arrays as exact expectations', async () => {
  const pack = contextPack([]);
  pack.classified = {
    ...pack.classified,
    files: [],
    symbols: ['Analyze'],
    exactTerms: ['Analyze'],
    lexicalQuery: 'Analyze',
  };
  const evaluator = new RetrievalEvaluator(
    {
      async ingestKnowledge() {
        throw new Error('fixture should not ingest knowledge');
      },
    },
    {
      async searchContext() {
        return pack;
      },
    },
  );

  const report = await evaluator.run({
    name: 'empty classification assertion',
    project: 'tuberosa',
    knowledge: [],
    cases: [{
      id: 'empty-symbols',
      prompt: 'Analyze retrieval behavior.',
      expectedClassification: { symbols: [] },
    }],
  });

  equal(report.cases[0].passed, false);
  equal(report.cases[0].classificationChecks[0]?.field, 'symbols');
  equal(report.cases[0].classificationChecks[0]?.passed, false);
});

test('retrieval evaluation passes noiseTolerance through to context search', async () => {
  let observedNoiseTolerance: unknown;
  const evaluator = new RetrievalEvaluator(
    {
      async ingestKnowledge() {
        throw new Error('fixture should not ingest knowledge');
      },
    },
    {
      async searchContext(input) {
        observedNoiseTolerance = input.noiseTolerance;
        return contextPack([]);
      },
    },
  );

  await evaluator.run({
    name: 'noise tolerance pass-through',
    project: 'tuberosa',
    knowledge: [],
    cases: [{
      id: 'strict-noise',
      prompt: 'How should weak memories be handled?',
      noiseTolerance: 'strict',
    } as any],
  });

  equal(observedNoiseTolerance, 'strict');
});

test('knowledge completeness fixture parser validates required evidence', () => {
  const fixture = parseKnowledgeCompletenessFixture({
    name: 'parser fixture',
    project: 'tuberosa',
    cases: [{
      id: 'case-1',
      prompt: 'Use src/retrieval/fusion.ts',
      requiredFacts: [{
        id: 'fact-1',
        weight: 2,
        terms: ['fusion'],
        sourceRefs: ['src/retrieval/fusion.ts'],
      }],
      requiredSources: [{
        type: 'file',
        value: 'src/retrieval/fusion.ts',
      }],
    }],
  });

  equal(fixture.cases[0].requiredFacts[0].weight, 2);
  equal(fixture.cases[0].requiredSources?.[0]?.type, 'file');

  throws(() => parseKnowledgeCompletenessFixture({
    name: 'invalid fixture',
    project: 'tuberosa',
    cases: [{
      id: 'case-1',
      prompt: 'No expected evidence',
      requiredFacts: [],
    }],
  }), /requiredFacts or requiredSources/);
});

test('knowledge completeness scoring covers facts, sources, direct placement, and noise', () => {
  const pack = contextPack([
    rankedCandidate({
      knowledgeId: 'direct-fusion',
      title: 'Fusion evidence',
      content: 'Candidate fusion and reranking use source coverage checks.',
      contextualContent: 'Candidate fusion and reranking use source coverage checks.',
      labels: [
        { type: 'file', value: 'src/retrieval/fusion.ts', weight: 1 },
        { type: 'symbol', value: 'fuseCandidates', weight: 1 },
      ],
      references: [{ type: 'file', uri: 'src/retrieval/fusion.ts' }],
      evidenceCategory: 'directTaskEvidence',
      usefulnessReason: 'Direct task evidence from file:src/retrieval/fusion.ts.',
    }),
    rankedCandidate({
      knowledgeId: 'backup-noise',
      title: 'Forbidden backup workflow',
      content: 'Backup retention notes unrelated to retrieval fusion.',
      contextualContent: 'Backup retention notes unrelated to retrieval fusion.',
      labels: [{ type: 'domain', value: 'storage', weight: 1 }],
      references: [{ type: 'file', uri: 'src/operations/backup-service.ts' }],
      evidenceCategory: 'adjacentContext',
    }),
  ]);

  const result = evaluateKnowledgeCompletenessPack({
    id: 'case-1',
    prompt: 'Use fusion source',
    requiredFacts: [{
      id: 'fact-1',
      terms: ['candidate fusion', 'reranking', 'source coverage'],
      sourceRefs: ['src/retrieval/fusion.ts'],
    }],
    requiredSources: [
      { type: 'file', value: 'src/retrieval/fusion.ts' },
      { type: 'symbol', value: 'fuseCandidates' },
    ],
    forbiddenItems: [{ type: 'title', value: 'Forbidden backup workflow' }],
    maxNoiseRate: 0.5,
  }, pack);

  equal(result.completeness, 1);
  equal(result.sourceCoverage, 1);
  equal(result.directEvidencePlacement, 1);
  equal(result.noiseRate, 0.5);
  equal(result.passed, true);

  const strictNoiseResult = evaluateKnowledgeCompletenessPack({
    id: 'case-2',
    prompt: 'Use fusion source',
    requiredFacts: [{
      id: 'fact-1',
      terms: ['candidate fusion'],
    }],
    forbiddenItems: [{ type: 'title', value: 'Forbidden backup workflow' }],
    maxNoiseRate: 0,
  }, pack);

  equal(strictNoiseResult.noiseRatePassed, false);
  equal(strictNoiseResult.passed, false);
});

test('knowledge completeness fixture reaches its minimum score', async () => {
  const fixturePath = fileURLToPath(new URL('../eval/knowledge-completeness-fixtures.json', import.meta.url));
  const fixture = await loadKnowledgeCompletenessFixture(fixturePath);
  const services = createCompletenessEvaluator();

  try {
    const report = await services.evaluator.run(fixture, { mode: 'fixture' });

    const fixtureCases = fixture.cases.filter((testCase) => !testCase.modes || testCase.modes.includes('fixture'));
    equal(report.totalCases, fixtureCases.length);
    equal(report.metrics.passRate, 1);
    equal(report.metrics.averageCompleteness, 1);
    equal(report.metrics.averageSourceCoverage, 1);
    ok((report.metrics.averageKnowledgeGainScore ?? 0) >= 95, failedCompletenessCases(report));
    ok(report.cases.every((testCase) => testCase.passed), failedCompletenessCases(report));
  } finally {
    await services.close();
  }
});

function createEvaluator(): RetrievalEvaluator {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, config);
  return new RetrievalEvaluator(ingestion, retrieval, retrieval, store);
}

function createCompletenessEvaluator(): {
  evaluator: KnowledgeCompletenessEvaluator;
  close(): Promise<void>;
} {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, config);
  return {
    evaluator: new KnowledgeCompletenessEvaluator(retrieval, ingestion),
    close: async () => {
      await Promise.allSettled([store.close(), cache.close()]);
    },
  };
}

function failedCases(report: Awaited<ReturnType<RetrievalEvaluator['run']>>): string {
  return report.cases
    .filter((testCase) => !testCase.passed)
    .map((testCase) => `${testCase.id}: ${testCase.topKnowledgeIds.join(', ')}`)
    .join('\n');
}

function failedCompletenessCases(report: Awaited<ReturnType<KnowledgeCompletenessEvaluator['run']>>): string {
  return report.cases
    .filter((testCase) => !testCase.passed)
    .map((testCase) => `${testCase.id}: score=${testCase.knowledgeGainScore} selected=${testCase.selectedKnowledgeIds.join(', ')}`)
    .join('\n');
}

function contextPack(items: RankedCandidate[]): ContextPack {
  const classified: ClassifiedQuery = {
    project: 'tuberosa',
    taskType: 'implementation',
    confidence: 0.8,
    files: ['src/retrieval/fusion.ts'],
    symbols: ['fuseCandidates'],
    errors: [],
    technologies: [],
    businessAreas: [],
    exactTerms: ['src/retrieval/fusion.ts', 'fuseCandidates'],
    lexicalQuery: 'src/retrieval/fusion.ts fuseCandidates',
    intent: {
      taskGoal: 'implement requested change',
      workflowStage: 'implementation',
      impliedFiles: ['src/retrieval/fusion.ts'],
      impliedSymbols: ['fuseCandidates'],
      impliedDomains: [],
      recentSessionReferences: [],
      requiredEvidenceTypes: ['code_reference'],
      uncertaintyReasons: [],
    },
  };

  return {
    id: 'pack-1',
    project: 'tuberosa',
    prompt: 'Use fusion source',
    confidence: 0.9,
    status: 'proposed',
    classified,
    contextFit: {
      fitStatus: 'ready',
      fitScore: 0.9,
      fitReasons: ['covered file:1/1'],
      missingSignals: [],
    },
    sections: [{
      name: 'essential',
      tokenEstimate: 100,
      items,
    }],
    rejectedKnowledgeIds: [],
    createdAt: '2026-05-19T00:00:00.000Z',
  };
}

function rankedCandidate(overrides: Partial<RankedCandidate>): RankedCandidate {
  return {
    knowledgeId: 'candidate',
    title: 'Candidate',
    summary: '',
    content: '',
    contextualContent: '',
    itemType: 'code_ref',
    project: 'tuberosa',
    labels: [],
    references: [],
    tokenEstimate: 1,
    trustLevel: 80,
    source: 'lexical',
    rawScore: 1,
    rank: 1,
    fusedScore: 1,
    rerankScore: 1,
    finalScore: 1,
    matchReasons: [],
    ...overrides,
  };
}
