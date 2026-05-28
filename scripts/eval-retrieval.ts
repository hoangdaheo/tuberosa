import { resolve } from 'node:path';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { loadRetrievalEvalFixture } from '../src/evaluation/fixture-loader.js';
import { writeLastEval } from '../src/operations/last-eval.js';
import {
  RetrievalEvaluator,
  type RetrievalEvalCaseResult,
  type RetrievalEvalMetrics,
  type RetrievalEvalReport,
} from '../src/evaluation/retrieval-evaluator.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

export interface CliOptions {
  fixturePath: string;
  topK: number;
  json: boolean;
  failUnderHitRate?: number;
  help: boolean;
}

const defaultConfig: AppConfig = {
  env: 'eval',
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
  persistReplay: false,
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
  llmCriticEnabled: false,
  archivalEnabled: false,
  graphInferenceEnabled: false,
  archivalIntervalHours: 24,
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const fixture = await loadRetrievalEvalFixture(resolve(options.fixturePath));
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(defaultConfig.embeddingDimensions);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, defaultConfig);
  const evaluator = new RetrievalEvaluator(ingestion, retrieval, retrieval, store);

  try {
    const report = await evaluator.run(fixture, { topK: options.topK });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }

    const failed = shouldFail(report, options);
    const num = (value: number | null): number | undefined => (typeof value === 'number' ? value : undefined);
    writeLastEval({
      status: failed ? 'fail' : 'pass',
      generatedAt: new Date().toISOString(),
      totalCases: report.totalCases,
      passedCases: report.cases.filter((testCase) => testCase.passed).length,
      fixtureName: report.fixtureName,
      project: report.project,
      metrics: {
        hitRate: num(report.metrics.hitRate),
        meanReciprocalRank: num(report.metrics.meanReciprocalRank),
        selectedCoverageRate: num(report.metrics.selectedCoverageRate),
        staleRejectionRate: num(report.metrics.staleRejectionRate),
        exactFileMatchRate: num(report.metrics.exactFileMatchRate),
        exactSymbolMatchRate: num(report.metrics.exactSymbolMatchRate),
        exactErrorMatchRate: num(report.metrics.exactErrorMatchRate),
      },
    });

    if (failed) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.allSettled([store.close(), cache.close()]);
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    fixturePath: 'eval/retrieval-fixtures.json',
    topK: 5,
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--') {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--fixture') {
      options.fixturePath = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--top-k') {
      options.topK = readPositiveInteger(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === '--fail-under-hit-rate') {
      options.failUnderHitRate = readRate(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }

  return options;
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

function readPositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }

  return parsed;
}

function readRate(value: string, option: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${option} must be a decimal rate from 0 to 1.`);
  }

  return parsed;
}

function printReport(report: RetrievalEvalReport): void {
  console.log(`Retrieval eval: ${report.fixtureName}`);
  console.log(`Project: ${report.project}`);
  console.log(`Cases: ${report.totalCases}`);
  console.log(`Top K: ${report.topK}`);
  console.log('');
  printMetrics(report.metrics, report.topK);
  console.log('');
  printCases(report.cases);
}

function printMetrics(metrics: RetrievalEvalMetrics, topK: number): void {
  console.log('Metrics');
  console.log(`  hit@${topK}: ${formatRate(metrics.hitRate)}`);
  console.log(`  MRR: ${formatDecimal(metrics.meanReciprocalRank)}`);
  console.log(`  precision@${topK}: ${formatRate(metrics.precisionAtK)}`);
  console.log(`  selected coverage: ${formatRate(metrics.selectedCoverageRate)}`);
  console.log(`  stale rejection: ${formatRate(metrics.staleRejectionRate)}`);
  console.log(`  unexpected avoidance: ${formatRate(metrics.unexpectedAvoidanceRate)}`);
  console.log(`  confidence thresholds: ${formatRate(metrics.confidenceThresholdRate)}`);
  console.log(`  context fit status: ${formatRate(metrics.contextFitStatusRate)}`);
  console.log(`  context fit score: ${formatRate(metrics.contextFitScoreRate)}`);
  console.log(`  exact file match: ${formatRate(metrics.exactFileMatchRate)}`);
  console.log(`  exact symbol match: ${formatRate(metrics.exactSymbolMatchRate)}`);
  console.log(`  exact error match: ${formatRate(metrics.exactErrorMatchRate)}`);
  console.log(`  exact classification match: ${formatRate(metrics.exactClassificationMatchRate)}`);
}

function printCases(cases: RetrievalEvalCaseResult[]): void {
  console.log('Cases');
  for (const testCase of cases) {
    const status = testCase.passed ? 'PASS' : 'FAIL';
    console.log(`  ${status} ${testCase.id}: top=[${testCase.topKnowledgeIds.join(', ')}]`);

    if (!testCase.passed) {
      console.log(`    expected=[${testCase.expectedKnowledgeIds.join(', ')}] matched=[${testCase.matchedExpectedKnowledgeIds.join(', ')}]`);
      console.log(`    selected=[${testCase.selectedKnowledgeIds.join(', ')}] expectedSelected=[${testCase.expectedSelectedKnowledgeIds.join(', ')}]`);
      console.log(`    unexpected=[${testCase.returnedUnexpectedKnowledgeIds.join(', ')}] rejected=[${testCase.returnedRejectedKnowledgeIds.join(', ')}]`);
      if (testCase.confidencePassed === false) {
        console.log(`    confidence: expected>=${testCase.minConfidence} actual=${formatDecimal(testCase.confidence)}`);
      }
      if (testCase.contextFitStatusPassed === false) {
        console.log(`    contextFit.status: expected=${testCase.expectedContextFitStatus} actual=${testCase.contextFitStatus ?? 'missing'}`);
      }
      if (testCase.contextFitScorePassed === false) {
        console.log(`    contextFit.score: expected>=${testCase.minContextFitScore} actual=${formatDecimal(testCase.contextFitScore ?? null)}`);
      }
      for (const check of testCase.classificationChecks.filter((item) => !item.passed)) {
        console.log(`    ${check.field}: expected=[${check.expected.join(', ')}] actual=[${check.actual.join(', ')}]`);
      }
    }
  }
}

export const DEFAULT_HIT_RATE_THRESHOLD = 1.0;

export function shouldFail(report: RetrievalEvalReport, options: CliOptions): boolean {
  const failedCase = report.cases.some((testCase) => !testCase.passed);
  const threshold = options.failUnderHitRate ?? DEFAULT_HIT_RATE_THRESHOLD;
  const missedThreshold = report.metrics.hitRate !== null
    && report.metrics.hitRate < threshold;

  return failedCase || missedThreshold;
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatDecimal(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

function usage(): string {
  return [
    'Usage: pnpm run eval:retrieval -- [options]',
    '',
    'Options:',
    '  --fixture <path>              Fixture JSON path (default: eval/retrieval-fixtures.json)',
    '  --top-k <number>              Ranking cutoff for hit and precision metrics (default: 5)',
    '  --fail-under-hit-rate <0-1>   Exit non-zero when hit rate drops below the threshold',
    '  --json                        Print the full JSON report',
    '  -h, --help                    Show this help',
  ].join('\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
