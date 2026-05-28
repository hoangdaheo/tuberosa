import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { MemoryCache } from '../src/cache.js';
import { generateSandboxFixture, type SandboxFixture, type SandboxKnowledge } from '../eval/sandbox/generator.js';
import { buildSandboxPrompts, type SandboxPrompt } from '../eval/sandbox/prompts.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { DEFAULT_POLICY, resetRetrievalPolicyCache, setRetrievalPolicy } from '../src/retrieval/policy.js';
import type { RetrievalPolicy, RrfConfig, TaskFusionProfile } from '../src/retrieval/policy.js';
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
  /** Phase 7 — best RRF k per task type, plus the picked global k. */
  rrfCalibration: {
    candidateKs: number[];
    globalHits: Record<number, number>;
    perTaskHits: Partial<Record<TaskType, Record<number, number>>>;
    selectedGlobalK: number;
    selectedPerTaskK: Partial<Record<TaskType, number>>;
  };
  patch: Partial<RetrievalPolicy>;
}

/**
 * Phase 7 — RRF k candidates for grid search. Range chosen to cover both ends
 * of the practical curve:
 *   - 30 (sharper / top-rank dominates) for exact-match tasks like debugging.
 *   - 60 (default, balanced).
 *   - 120 (smoothest) where multi-source aggregation should outweigh rank.
 */
const RRF_K_CANDIDATES: readonly number[] = [30, 45, 60, 80, 120];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const fixture = generateSandboxFixture(options.seed);
  const prompts = buildSandboxPrompts(fixture).prompts;
  const full = await runCalibration(fixture, prompts);
  const calibration = buildCalibrationOutput(full.contributions, full.rrf, options.seed);

  if (options.dryRun) {
    console.log(JSON.stringify(calibration, null, 2));
    return;
  }

  await writeCalibration(options.output, calibration);
  printSummary(calibration);
}

interface FullAggregation {
  contributions: Aggregation;
  rrf: RrfCalibrationResult;
}

async function runCalibration(fixture: SandboxFixture, prompts: SandboxPrompt[]): Promise<FullAggregation> {
  const { ingestion, retrieval, store, cache } = createServices();
  try {
    const idMap = await ingestFixture(fixture, ingestion);
    const contributions = await aggregateContributions(prompts, idMap, fixture, retrieval);
    // Phase 7 — RRF k grid search. Runs after weight aggregation so the
    // contribution pass uses the default global k (no per-task overrides),
    // then the k pass sweeps the candidate set with empty kByTaskType.
    const rrf = await calibrateRrfK(prompts, idMap, retrieval);
    return { contributions, rrf };
  } finally {
    resetRetrievalPolicyCache();
    await Promise.allSettled([store.close(), cache.close()]);
  }
}

interface RrfCalibrationResult {
  globalHits: Map<number, number>;
  perTaskHits: Map<TaskType, Map<number, number>>;
  selectedGlobalK: number;
  selectedPerTaskK: Map<TaskType, number>;
}

async function calibrateRrfK(
  prompts: SandboxPrompt[],
  idMap: Map<string, string>,
  retrieval: RetrievalService,
): Promise<RrfCalibrationResult> {
  const globalHits = new Map<number, number>();
  const perTaskHits = new Map<TaskType, Map<number, number>>();
  for (const k of RRF_K_CANDIDATES) {
    const policy = JSON.parse(JSON.stringify(DEFAULT_POLICY)) as RetrievalPolicy;
    policy.rrf.k = k;
    policy.rrf.kByTaskType = {};
    setRetrievalPolicy(policy);
    let totalHits = 0;
    for (const prompt of prompts) {
      const expectedIds = new Set(
        [...prompt.expectedSelectedSandboxIds]
          .map((sandboxId) => idMap.get(sandboxId))
          .filter((id): id is string => Boolean(id)),
      );
      if (expectedIds.size === 0) continue;
      const pack = await retrieval.searchContext({
        prompt: prompt.prompt,
        project: prompt.project,
        files: prompt.files,
        symbols: prompt.symbols,
        errors: prompt.errors,
        taskType: prompt.taskType,
        noiseTolerance: 'strict',
        contextMode: 'compact',
        bypassCache: true,
      });
      const surfacedIds = pack.sections
        .flatMap((section) => section.items)
        .slice(0, 5)
        .map((item) => item.knowledgeId);
      const hit = surfacedIds.some((id) => expectedIds.has(id));
      if (hit) {
        totalHits += 1;
        const taskMap = perTaskHits.get(prompt.taskType) ?? new Map<number, number>();
        taskMap.set(k, (taskMap.get(k) ?? 0) + 1);
        perTaskHits.set(prompt.taskType, taskMap);
      } else {
        // Make sure the task map for this task type exists with an entry for `k`
        // even on miss, so all (taskType, k) cells are comparable.
        const taskMap = perTaskHits.get(prompt.taskType) ?? new Map<number, number>();
        taskMap.set(k, taskMap.get(k) ?? 0);
        perTaskHits.set(prompt.taskType, taskMap);
      }
    }
    globalHits.set(k, totalHits);
  }
  resetRetrievalPolicyCache();

  // Pick the k with the highest hit count; ties go to the default k=60 to keep
  // shipped behavior stable when calibration is indeterminate.
  const selectedGlobalK = selectBestK(globalHits);

  const selectedPerTaskK = new Map<TaskType, number>();
  for (const [taskType, hitsMap] of perTaskHits) {
    const best = selectBestK(hitsMap);
    // Only emit a per-task override if it differs from the global default —
    // shipping unnecessary overrides bloats the patch and obscures real signal.
    if (best !== selectedGlobalK) {
      selectedPerTaskK.set(taskType, best);
    }
  }

  return { globalHits, perTaskHits, selectedGlobalK, selectedPerTaskK };
}

function selectBestK(hits: Map<number, number>): number {
  let bestK = DEFAULT_POLICY.rrf.k;
  let bestHits = hits.get(bestK) ?? -1;
  for (const [k, count] of hits) {
    if (count > bestHits) {
      bestK = k;
      bestHits = count;
    }
  }
  return bestK;
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

function buildCalibrationOutput(
  aggregation: Aggregation,
  rrf: RrfCalibrationResult,
  seed: number,
): CalibrationOutput {
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

  const rrfConfig: RrfConfig = {
    k: rrf.selectedGlobalK,
    kByTaskType: Object.fromEntries(rrf.selectedPerTaskK) as Partial<Record<TaskType, number>>,
  };

  const globalHitsObject: Record<number, number> = {};
  for (const [k, hits] of rrf.globalHits) globalHitsObject[k] = hits;
  const perTaskHitsObject: Partial<Record<TaskType, Record<number, number>>> = {};
  for (const [taskType, hitsMap] of rrf.perTaskHits) {
    const entry: Record<number, number> = {};
    for (const [k, hits] of hitsMap) entry[k] = hits;
    perTaskHitsObject[taskType] = entry;
  }

  return {
    calibratedAt: new Date().toISOString(),
    seed,
    globalContribution: roundEntries(aggregation.global),
    perTaskContribution: perTaskOutput,
    rrfCalibration: {
      candidateKs: [...RRF_K_CANDIDATES],
      globalHits: globalHitsObject,
      perTaskHits: perTaskHitsObject,
      selectedGlobalK: rrf.selectedGlobalK,
      selectedPerTaskK: Object.fromEntries(rrf.selectedPerTaskK) as Partial<Record<TaskType, number>>,
    },
    patch: {
      sourceWeights: globalWeights,
      taskProfiles,
      rrf: rrfConfig,
      calibration: {
        calibratedAt: new Date().toISOString(),
        seed,
        notes: 'Generated by scripts/calibrate-fusion.ts',
      },
    },
  };
}

function newSourceMap(): Record<CandidateSource, number> {
  return { metadata: 0, lexical: 0, vector: 0, memory: 0, graph: 0, worktree: 0, atoms: 0 };
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
  const sources: CandidateSource[] = ['metadata', 'lexical', 'vector', 'memory', 'graph'];
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
  console.log('RRF k grid search:');
  for (const [k, hits] of Object.entries(calibration.rrfCalibration.globalHits)) {
    console.log(`  k=${k.padStart(3)}  hits=${hits}`);
  }
  console.log(`Selected global k: ${calibration.rrfCalibration.selectedGlobalK}`);
  const perTaskKeys = Object.keys(calibration.rrfCalibration.selectedPerTaskK);
  if (perTaskKeys.length === 0) {
    console.log('Per-task k overrides: none (global k wins for every task type)');
  } else {
    console.log('Per-task k overrides:');
    for (const [taskType, k] of Object.entries(calibration.rrfCalibration.selectedPerTaskK)) {
      console.log(`  ${taskType.padEnd(14)} k=${k}`);
    }
  }
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
  llmCriticEnabled: false,
  archivalEnabled: false,
  archivalIntervalHours: 24,
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

// Silence unused-import warning for the filter event type while keeping the import for future use.
export type _FilterEventRef = FilterEvent;
