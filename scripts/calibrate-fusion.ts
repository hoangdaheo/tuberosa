import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { MemoryCache } from '../src/cache.js';
import { generateSandboxFixture, type SandboxFixture, type SandboxKnowledge } from '../eval/sandbox/generator.js';
import { buildSandboxPrompts, type SandboxPrompt } from '../eval/sandbox/prompts.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { DEFAULT_POLICY } from '../src/retrieval/policy.js';
import type { RetrievalPolicy, TaskFusionProfile } from '../src/retrieval/policy.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type { AppConfig } from '../src/config.js';
import type { CandidateSource, FilterEvent, ScoreBreakdown, TaskType } from '../src/types.js';

interface CliOptions {
  seed: number;
  output: string;
  dryRun: boolean;
  help: boolean;
}

interface CalibrationOutput {
  calibratedAt: string;
  seed: number;
  globalContribution: Record<CandidateSource, number>;
  perTaskContribution: Partial<Record<TaskType, Record<CandidateSource, number>>>;
  patch: Partial<RetrievalPolicy>;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const fixture = generateSandboxFixture(options.seed);
  const prompts = buildSandboxPrompts(fixture).prompts;
  const aggregation = await runCalibration(fixture, prompts);
  const calibration = buildCalibrationOutput(aggregation, options.seed);

  if (options.dryRun) {
    console.log(JSON.stringify(calibration, null, 2));
    return;
  }

  await writeCalibration(options.output, calibration);
  printSummary(calibration);
}

async function runCalibration(fixture: SandboxFixture, prompts: SandboxPrompt[]) {
  const { ingestion, retrieval, store, cache } = createServices();
  try {
    const idMap = await ingestFixture(fixture, ingestion);
    return await aggregateContributions(prompts, idMap, fixture, retrieval);
  } finally {
    await Promise.allSettled([store.close(), cache.close()]);
  }
}

function createServices() {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(CALIBRATION_CONFIG.embeddingDimensions);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, CALIBRATION_CONFIG);
  return { ingestion, retrieval, store, cache };
}

async function ingestFixture(fixture: SandboxFixture, ingestion: IngestionService): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();
  for (const knowledge of fixture.knowledge) {
    try {
      const stored = await ingestion.ingestKnowledge({
        project: knowledge.project,
        sourceType: knowledge.sourceType,
        sourceUri: knowledge.sourceUri,
        sourceTitle: knowledge.sourceTitle,
        itemType: knowledge.itemType,
        title: knowledge.title,
        summary: knowledge.summary,
        content: knowledge.content,
        trustLevel: knowledge.trustLevel,
        labels: knowledge.labels,
        references: knowledge.references,
        freshnessAt: knowledge.freshnessAt,
        metadata: knowledge.metadata,
      });
      idMap.set(knowledge.sandboxId, stored.id);
    } catch {
      // Adversarial / duplicate ingest blocks are expected and not relevant to calibration.
    }
  }
  return idMap;
}

interface Aggregation {
  global: Record<CandidateSource, number>;
  perTask: Map<TaskType, Record<CandidateSource, number>>;
}

async function aggregateContributions(
  prompts: SandboxPrompt[],
  idMap: Map<string, string>,
  fixture: SandboxFixture,
  retrieval: RetrievalService,
): Promise<Aggregation> {
  const global = newSourceMap();
  const perTask = new Map<TaskType, Record<CandidateSource, number>>();
  const reverse = new Map<string, SandboxKnowledge>();
  for (const knowledge of fixture.knowledge) {
    const storedId = idMap.get(knowledge.sandboxId);
    if (storedId) reverse.set(storedId, knowledge);
  }

  for (const prompt of prompts) {
    const pack = await retrieval.searchContext({
      prompt: prompt.prompt,
      project: prompt.project,
      files: prompt.files,
      symbols: prompt.symbols,
      errors: prompt.errors,
      taskType: prompt.taskType,
      noiseTolerance: 'strict',
      contextMode: 'compact',
      debug: true,
    });
    const trace = pack.debug;
    if (!trace?.fusionBreakdown) continue;
    const breakdownById = new Map<string, ScoreBreakdown>();
    for (const entry of trace.fusionBreakdown) breakdownById.set(entry.knowledgeId, entry);
    const expectedSandboxIds = new Set(prompt.expectedSelectedSandboxIds);
    const expectedIds = [...expectedSandboxIds]
      .map((sandboxId) => idMap.get(sandboxId))
      .filter((id): id is string => Boolean(id));

    const promptTaskMap = perTask.get(prompt.taskType) ?? newSourceMap();
    for (const knowledgeId of expectedIds) {
      const entry = breakdownById.get(knowledgeId);
      if (!entry) continue;
      for (const contribution of entry.contributions) {
        global[contribution.source] += contribution.contribution;
        promptTaskMap[contribution.source] += contribution.contribution;
      }
    }
    perTask.set(prompt.taskType, promptTaskMap);
  }

  return { global, perTask };
}

function buildCalibrationOutput(aggregation: Aggregation, seed: number): CalibrationOutput {
  const globalWeights = toBoundedWeights(aggregation.global, DEFAULT_POLICY.sourceWeights);
  const taskProfiles: Partial<Record<TaskType, TaskFusionProfile>> = {};
  for (const [taskType, contributions] of aggregation.perTask) {
    const weights = toBoundedWeights(contributions, globalWeights);
    const deltas: Partial<Record<CandidateSource, number>> = {};
    for (const source of Object.keys(weights) as CandidateSource[]) {
      const delta = weights[source] - globalWeights[source];
      if (Math.abs(delta) >= 0.01) {
        deltas[source] = Math.round(delta * 1000) / 1000;
      }
    }
    if (Object.keys(deltas).length > 0) {
      taskProfiles[taskType] = { sourceWeights: deltas };
    }
  }

  const perTaskOutput: Partial<Record<TaskType, Record<CandidateSource, number>>> = {};
  for (const [taskType, contributions] of aggregation.perTask) {
    perTaskOutput[taskType] = roundEntries(contributions);
  }

  return {
    calibratedAt: new Date().toISOString(),
    seed,
    globalContribution: roundEntries(aggregation.global),
    perTaskContribution: perTaskOutput,
    patch: {
      sourceWeights: globalWeights,
      taskProfiles,
      calibration: {
        calibratedAt: new Date().toISOString(),
        seed,
        notes: 'Generated by scripts/calibrate-fusion.ts',
      },
    },
  };
}

function newSourceMap(): Record<CandidateSource, number> {
  return { metadata: 0, lexical: 0, vector: 0, memory: 0, graph: 0, reference: 0 };
}

function roundEntries(map: Record<CandidateSource, number>): Record<CandidateSource, number> {
  const out = { ...map };
  for (const key of Object.keys(out) as CandidateSource[]) {
    out[key] = Math.round(out[key] * 10000) / 10000;
  }
  return out;
}

/**
 * Convert raw per-source contribution totals into bounded weights.
 *
 * - Normalize to the mean so a source that contributes 1.5× the average gets a 1.5× weight.
 * - Clamp into [0.7, 1.4] to keep calibration from producing extreme values.
 * - Round to 3 decimals.
 */
function toBoundedWeights(
  contributions: Record<CandidateSource, number>,
  baseline: Record<CandidateSource, number>,
): Record<CandidateSource, number> {
  const sources: CandidateSource[] = ['metadata', 'lexical', 'vector', 'memory', 'graph', 'reference'];
  const values = sources.map((source) => contributions[source]);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return { ...baseline };
  }
  const mean = total / sources.length;
  const weights = { ...baseline };
  for (const source of sources) {
    if (mean === 0) {
      weights[source] = baseline[source];
      continue;
    }
    const ratio = contributions[source] / mean;
    const blended = baseline[source] * (0.6 + 0.4 * ratio);
    weights[source] = Math.max(0.7, Math.min(1.4, Math.round(blended * 1000) / 1000));
  }
  return weights;
}

async function writeCalibration(outputPath: string, calibration: CalibrationOutput): Promise<void> {
  const absolute = resolve(outputPath);
  await mkdir(dirname(absolute), { recursive: true });
  let existing: Partial<RetrievalPolicy> = {};
  try {
    const raw = await readFile(absolute, 'utf8');
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !trimmed.startsWith('//')) {
      existing = JSON.parse(trimmed) as Partial<RetrievalPolicy>;
    }
  } catch {
    existing = {};
  }
  const next: Partial<RetrievalPolicy> = {
    ...existing,
    ...calibration.patch,
    calibration: calibration.patch.calibration,
  };
  const serialized = JSON.stringify(next, null, 2) + '\n';
  await writeFile(absolute, serialized, 'utf8');
}

function printSummary(calibration: CalibrationOutput): void {
  console.log(`Calibration written. seed=${calibration.seed}`);
  console.log('Global per-source contribution toward expected items:');
  for (const [source, value] of Object.entries(calibration.globalContribution)) {
    console.log(`  ${source.padEnd(10)} ${value.toFixed(4)}`);
  }
  const taskCount = Object.keys(calibration.perTaskContribution).length;
  console.log(`Per-task profiles emitted: ${taskCount}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    seed: 0xC0FFEE,
    output: 'config/retrieval-policy.json',
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--seed') {
      options.seed = Number(args[index + 1]);
      index += 1;
      if (!Number.isFinite(options.seed)) throw new Error('--seed must be a number');
    } else if (arg === '--output') {
      options.output = args[index + 1];
      index += 1;
    } else if (arg === '--') continue;
    else throw new Error(`Unknown option: ${arg}\n${usage()}`);
  }
  return options;
}

function usage(): string {
  return [
    'Usage: pnpm run calibrate-fusion -- [options]',
    '',
    'Options:',
    '  --seed <number>          Sandbox fixture seed (default 12648430)',
    '  --output <path>          Path to write the calibrated policy patch (default config/retrieval-policy.json)',
    '  --dry-run                Print the patch without writing the file',
    '  -h, --help               Show this help',
  ].join('\n');
}

const CALIBRATION_CONFIG: AppConfig = {
  env: 'calibration',
  port: 3027,
  databaseUrl: '',
  redisUrl: '',
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
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

// Silence unused-import warning for the filter event type while keeping the import for future use.
export type _FilterEventRef = FilterEvent;
