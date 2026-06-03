import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import {
  ContextMappingEvaluator,
  type ContextMappingCaseResult,
  type ContextMappingMetrics,
  type ContextMappingReport,
} from '../src/evaluation/context-mapping-evaluator.js';
import { loadContextMappingFixture } from '../src/evaluation/context-mapping-fixture-loader.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

interface CliOptions {
  fixturePath: string;
  topK: number;
  json: boolean;
  failUnderPrecision?: number;
  failUnderRecall?: number;
  failUnderNoiseSensitivity?: number;
  failUnderFitCalibration?: number;
  failUnderEntitiesRecall?: number;
  failOverForbiddenRate?: number;
  /** Phase 8 — minimum acceptable briefGroundedness (default off; CI can set 1.0). */
  failUnderBriefGroundedness?: number;
  writeBaseline?: string;
  help: boolean;
}

const defaultConfig: AppConfig = {
  env: 'eval',
  http: {
    port: 3027,
    host: '127.0.0.1',
    requireApiKeyForNonLoopback: false,
    maxRequestBytes: 10 * 1024 * 1024,
  },
  storage: {
    databaseUrl: '',
    redisUrl: '',
    store: 'memory',
    cache: 'memory',
    autoMigrate: false,
  },
  model: {
    provider: 'hash',
    openAiTimeoutMs: 30_000,
    embeddingDimensions: 1536,
    openAiEmbeddingModel: 'text-embedding-3-small',
    llmCriticEnabled: false,
  },
  context: {
    cacheTtlSeconds: 0,
  },
  ingest: {
    maxContentBytes: 2 * 1024 * 1024,
  },
  backup: {
    dir: '.tuberosa/test-backups',
    exportBaseDir: '.tuberosa/test-exports',
    importBaseDir: '.tuberosa/test-imports',
    intervalSeconds: 0,
    startupDelaySeconds: 0,
    retentionCount: 24,
    retentionMaxAgeDays: 30,
    writeThrough: false,
    writeThroughThrottleSeconds: 600,
  },
  mirror: {
    debounceMs: 500,
  },
  errorLog: {
    dir: '.tuberosa/test-error-logs',
    maxBytes: 256 * 1024,
    autoCapture: true,
    captureClientErrors: false,
  },
  worktree: {
    enabled: true,
    maxFiles: 50,
    maxMtimeAgeHours: 72,
  },
  archival: {
    enabled: false,
    intervalHours: 24,
  },
  graphInference: {
    enabled: false,
  },
  atlas: {},
  userStyle: {},
  persistReplay: false,
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const fixture = await loadContextMappingFixture(resolve(options.fixturePath));
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(defaultConfig.model.embeddingDimensions);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, defaultConfig);
  const evaluator = new ContextMappingEvaluator(ingestion, retrieval, retrieval, store);

  try {
    const report = await evaluator.run(fixture, { topK: options.topK });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }

    if (options.writeBaseline) {
      const baseline = {
        fixtureName: report.fixtureName,
        project: report.project,
        recordedAt: report.evaluatedAt,
        topK: report.topK,
        metrics: report.metrics,
      };
      await writeFile(resolve(options.writeBaseline), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
      console.log(`\nbaseline written to ${options.writeBaseline}`);
    }

    if (shouldFail(report, options)) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.allSettled([store.close(), cache.close()]);
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    fixturePath: 'eval/context-mapping-fixtures.json',
    topK: 5,
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--') continue;

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

    if (arg === '--write-baseline') {
      options.writeBaseline = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--fail-under-precision') {
      options.failUnderPrecision = readRate(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === '--fail-under-recall') {
      options.failUnderRecall = readRate(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === '--fail-under-noise-sensitivity') {
      options.failUnderNoiseSensitivity = readRate(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === '--fail-under-fit-calibration') {
      options.failUnderFitCalibration = readRate(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === '--fail-under-entities-recall') {
      options.failUnderEntitiesRecall = readRate(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === '--fail-over-forbidden-rate') {
      options.failOverForbiddenRate = readRate(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === '--fail-under-brief-groundedness') {
      options.failUnderBriefGroundedness = readRate(readOptionValue(args, index, arg), arg);
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

function printReport(report: ContextMappingReport): void {
  console.log(`Context-mapping eval: ${report.fixtureName}`);
  console.log(`Project: ${report.project}`);
  console.log(`Cases: ${report.totalCases}`);
  console.log(`Top K: ${report.topK}`);
  console.log('');
  printMetrics(report.metrics, report.topK);
  console.log('');
  printCases(report.cases);
}

function printMetrics(metrics: ContextMappingMetrics, topK: number): void {
  console.log('Metrics');
  console.log(`  context precision@${topK}: ${formatRate(metrics.contextPrecisionAtK)}`);
  console.log(`  context recall:           ${formatRate(metrics.contextRecall)}`);
  console.log(`  context entities recall:  ${formatRate(metrics.contextEntitiesRecall)}`);
  console.log(`  noise sensitivity:        ${formatRate(metrics.noiseSensitivity)}`);
  console.log(`  direct-evidence placement: ${formatRate(metrics.directEvidencePlacement)}`);
  console.log(`  fit calibration:          ${formatRate(metrics.fitCalibration)}`);
  console.log(`  forbidden-item rate:      ${formatRate(metrics.forbiddenItemRate)}`);
  console.log(`  brief groundedness:       ${formatRate(metrics.briefGroundedness)}`);

  if (metrics.perTaxon.length > 0) {
    console.log('');
    console.log('Per-taxon');
    for (const row of metrics.perTaxon) {
      console.log(`  ${row.taxon} (${row.caseCount} cases)`);
      console.log(`    precision@${topK}: ${formatRate(row.contextPrecisionAtK)}  recall: ${formatRate(row.contextRecall)}  entities: ${formatRate(row.contextEntitiesRecall)}`);
      console.log(`    noise: ${formatRate(row.noiseSensitivity)}  placement: ${formatRate(row.directEvidencePlacement)}  fit: ${formatRate(row.fitCalibration)}  forbidden: ${formatRate(row.forbiddenItemRate)}  briefGrounded: ${formatRate(row.briefGroundedness)}`);
    }
  }
}

function printCases(cases: ContextMappingCaseResult[]): void {
  console.log('Cases');
  for (const testCase of cases) {
    const status = testCase.passed ? 'PASS' : 'FAIL';
    console.log(`  ${status} ${testCase.id} (${testCase.taxon})`);
    console.log(`    top=[${testCase.topKnowledgeIds.join(', ')}]`);

    if (!testCase.passed) {
      console.log(`    essential=[${testCase.essentialKnowledgeIds.join(', ')}]`);
      console.log(`    expectedRelevant=[${testCase.expectedRelevantKnowledgeIds.join(', ')}] direct=[${testCase.directEvidenceKnowledgeIds.join(', ')}]`);
      console.log(`    precision=${formatRate(testCase.contextPrecisionAtK)} recall=${formatRate(testCase.contextRecall)} entitiesRecall=${formatRate(testCase.contextEntitiesRecall)}`);
      console.log(`    placement=${formatRate(testCase.directEvidencePlacement)} noise=${formatRate(testCase.noiseSensitivity)} forbiddenLeaks=${testCase.forbiddenLeakageCount} distractorLeaks=${testCase.distractorLeakageCount}`);
      if (testCase.missingEntities.length > 0) {
        console.log(`    missingEntities=[${testCase.missingEntities.join(', ')}]`);
      }
      if (!testCase.fitStatusPassed) {
        console.log(`    fitStatus: expected=${testCase.expectedFitStatus ?? 'n/a'} actual=${testCase.fitStatus ?? 'missing'}`);
      }
    }
  }
}

function shouldFail(report: ContextMappingReport, options: CliOptions): boolean {
  const failures: string[] = [];
  const metrics = report.metrics;

  if (options.failUnderPrecision !== undefined && metrics.contextPrecisionAtK !== null && metrics.contextPrecisionAtK < options.failUnderPrecision) {
    failures.push(`precision ${metrics.contextPrecisionAtK} < ${options.failUnderPrecision}`);
  }
  if (options.failUnderRecall !== undefined && metrics.contextRecall !== null && metrics.contextRecall < options.failUnderRecall) {
    failures.push(`recall ${metrics.contextRecall} < ${options.failUnderRecall}`);
  }
  if (options.failUnderEntitiesRecall !== undefined && metrics.contextEntitiesRecall !== null && metrics.contextEntitiesRecall < options.failUnderEntitiesRecall) {
    failures.push(`entitiesRecall ${metrics.contextEntitiesRecall} < ${options.failUnderEntitiesRecall}`);
  }
  if (options.failUnderNoiseSensitivity !== undefined && metrics.noiseSensitivity !== null && metrics.noiseSensitivity < options.failUnderNoiseSensitivity) {
    failures.push(`noiseSensitivity ${metrics.noiseSensitivity} < ${options.failUnderNoiseSensitivity}`);
  }
  if (options.failUnderFitCalibration !== undefined && metrics.fitCalibration !== null && metrics.fitCalibration < options.failUnderFitCalibration) {
    failures.push(`fitCalibration ${metrics.fitCalibration} < ${options.failUnderFitCalibration}`);
  }
  if (options.failOverForbiddenRate !== undefined && metrics.forbiddenItemRate !== null && metrics.forbiddenItemRate > options.failOverForbiddenRate) {
    failures.push(`forbiddenItemRate ${metrics.forbiddenItemRate} > ${options.failOverForbiddenRate}`);
  }
  if (options.failUnderBriefGroundedness !== undefined && metrics.briefGroundedness !== null && metrics.briefGroundedness < options.failUnderBriefGroundedness) {
    failures.push(`briefGroundedness ${metrics.briefGroundedness} < ${options.failUnderBriefGroundedness}`);
  }

  if (failures.length > 0) {
    console.error(`\nThreshold violations: ${failures.join('; ')}`);
    return true;
  }

  return false;
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function usage(): string {
  return [
    'Usage: pnpm run eval:context-mapping -- [options]',
    '',
    'Options:',
    '  --fixture <path>                      Fixture JSON path (default: eval/context-mapping-fixtures.json)',
    '  --top-k <number>                      Top-K cutoff for precision/leakage metrics (default: 5)',
    '  --write-baseline <path>               Write metrics to this baseline file',
    '  --fail-under-precision <0-1>          Exit non-zero when context precision drops below the threshold',
    '  --fail-under-recall <0-1>             Exit non-zero when context recall drops below the threshold',
    '  --fail-under-entities-recall <0-1>    Exit non-zero when entities recall drops below the threshold',
    '  --fail-under-noise-sensitivity <0-1>  Exit non-zero when noise sensitivity drops below the threshold',
    '  --fail-under-fit-calibration <0-1>    Exit non-zero when fit calibration drops below the threshold',
    '  --fail-over-forbidden-rate <0-1>      Exit non-zero when forbidden-item rate rises above the threshold',
    '  --fail-under-brief-groundedness <0-1> Exit non-zero when brief groundedness drops below the threshold',
    '  --json                                Print the full JSON report',
    '  -h, --help                            Show this help',
  ].join('\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
