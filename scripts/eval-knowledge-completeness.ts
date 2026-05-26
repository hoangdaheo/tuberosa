import { resolve } from 'node:path';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import {
  KnowledgeCompletenessEvaluator,
  skippedKnowledgeCompletenessReport,
  type KnowledgeCompletenessMode,
  type KnowledgeCompletenessReport,
  type KnowledgeCompletenessSearcher,
} from '../src/evaluation/knowledge-completeness-evaluator.js';
import { loadKnowledgeCompletenessFixture } from '../src/evaluation/knowledge-completeness-fixture-loader.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type { ContextPack, ContextSearchInput } from '../src/types.js';

interface CliOptions {
  fixturePath: string;
  mode: KnowledgeCompletenessMode;
  apiBase: string;
  json: boolean;
  failUnderScore?: number;
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
  errorLogDir: '.tuberosa/test-error-logs',
  errorLogMaxBytes: 256 * 1024,
  errorLogAutoCapture: true,
  errorLogCaptureClientErrors: false,
  persistReplay: false,
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const fixture = await loadKnowledgeCompletenessFixture(resolve(options.fixturePath));

  if (options.mode === 'live') {
    const available = await liveApiAvailable(options.apiBase);
    if (!available) {
      const report = skippedKnowledgeCompletenessReport(
        fixture,
        'live',
        `API server not reachable at ${options.apiBase}`,
      );
      printOrJson(report, options.json);
      return;
    }

    const evaluator = new KnowledgeCompletenessEvaluator(new HttpContextSearcher(options.apiBase));
    const report = await evaluator.run(fixture, { mode: 'live' });
    printOrJson(report, options.json);
    if (shouldFail(report, options)) {
      process.exitCode = 1;
    }
    return;
  }

  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(defaultConfig.embeddingDimensions);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, defaultConfig);
  const evaluator = new KnowledgeCompletenessEvaluator(retrieval, ingestion);

  try {
    const report = await evaluator.run(fixture, { mode: 'fixture' });
    printOrJson(report, options.json);
    if (shouldFail(report, options)) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.allSettled([store.close(), cache.close()]);
  }
}

class HttpContextSearcher implements KnowledgeCompletenessSearcher {
  constructor(private readonly apiBase: string) {}

  async searchContext(input: ContextSearchInput): Promise<ContextPack> {
    const response = await fetch(`${this.apiBase}/context/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, debug: true }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      throw new Error(`POST /context/search failed with HTTP ${response.status}`);
    }

    return response.json() as Promise<ContextPack>;
  }
}

async function liveApiAvailable(apiBase: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    fixturePath: 'eval/knowledge-completeness-fixtures.json',
    mode: 'fixture',
    apiBase: 'http://localhost:3027',
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

    if (arg === '--live') {
      options.mode = 'live';
      continue;
    }

    if (arg === '--fixture') {
      options.fixturePath = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--mode') {
      options.mode = readMode(readOptionValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg === '--api-base') {
      options.apiBase = readOptionValue(args, index, arg).replace(/\/+$/, '');
      index += 1;
      continue;
    }

    if (arg === '--fail-under-score') {
      options.failUnderScore = readScore(readOptionValue(args, index, arg), arg);
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

function readMode(value: string): KnowledgeCompletenessMode {
  if (value !== 'fixture' && value !== 'live') {
    throw new Error('--mode must be fixture or live.');
  }

  return value;
}

function readScore(value: string, option: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${option} must be a score from 0 to 100.`);
  }

  return parsed;
}

function printOrJson(report: KnowledgeCompletenessReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

function printReport(report: KnowledgeCompletenessReport): void {
  console.log(`Knowledge completeness eval: ${report.fixtureName}`);
  console.log(`Project: ${report.project}`);
  console.log(`Mode: ${report.mode}`);

  if (report.skipped) {
    console.log(`Skipped: ${report.skipReason ?? 'not available'}`);
    return;
  }

  console.log(`Cases: ${report.totalCases}`);
  console.log('');
  console.log('Metrics');
  console.log(`  pass rate: ${formatRate(report.metrics.passRate)}`);
  console.log(`  completeness: ${formatRate(report.metrics.averageCompleteness)}`);
  console.log(`  source coverage: ${formatRate(report.metrics.averageSourceCoverage)}`);
  console.log(`  direct evidence placement: ${formatRate(report.metrics.averageDirectEvidencePlacement)}`);
  console.log(`  noise rate: ${formatRate(report.metrics.averageNoiseRate)}`);
  console.log(`  knowledge gain score: ${formatScore(report.metrics.averageKnowledgeGainScore)}`);
  console.log('');
  console.log('Cases');

  for (const testCase of report.cases) {
    const status = testCase.passed ? 'PASS' : 'FAIL';
    console.log(`  ${status} ${testCase.id}: completeness=${formatRate(testCase.completeness)} sources=${formatRate(testCase.sourceCoverage)} noise=${formatRate(testCase.noiseRate)} score=${formatScore(testCase.knowledgeGainScore)}`);

    if (!testCase.passed) {
      for (const fact of testCase.factResults.filter((fact) => !fact.passed)) {
        console.log(`    fact ${fact.id}: missingTerms=[${fact.missingTerms.join(', ')}] missingRefs=[${fact.missingSourceRefs.join(', ')}]`);
      }
      for (const source of testCase.sourceResults.filter((source) => !source.passed)) {
        console.log(`    source ${source.type}:${source.value} missing`);
      }
      for (const hit of testCase.forbiddenHits) {
        console.log(`    forbidden ${hit.forbiddenType}:${hit.value} in ${hit.section} item "${hit.title}"`);
      }
    }
  }
}

function shouldFail(report: KnowledgeCompletenessReport, options: CliOptions): boolean {
  if (report.skipped) {
    return false;
  }

  const failedCase = report.cases.some((testCase) => !testCase.passed);
  const score = report.metrics.averageKnowledgeGainScore;
  const missedScore = options.failUnderScore !== undefined
    && score !== null
    && score < options.failUnderScore;

  return failedCase || missedScore;
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatScore(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(1);
}

function usage(): string {
  return [
    'Usage: pnpm run eval:knowledge-completeness -- [options]',
    '',
    'Options:',
    '  --fixture <path>              Fixture JSON path (default: eval/knowledge-completeness-fixtures.json)',
    '  --mode <fixture|live>         Run in memory fixture mode or against a live API (default: fixture)',
    '  --live                        Alias for --mode live',
    '  --api-base <url>              Live API base URL (default: http://localhost:3027)',
    '  --fail-under-score <0-100>    Exit non-zero when average knowledge gain drops below the score',
    '  --json                        Print the full JSON report',
    '  -h, --help                    Show this help',
  ].join('\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
