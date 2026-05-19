import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeCompletenessReport } from '../src/evaluation/knowledge-completeness-evaluator.js';
import type { RetrievalEvalReport } from '../src/evaluation/retrieval-evaluator.js';

const ROOT = new URL('..', import.meta.url).pathname;
const LOG_FILE = join(ROOT, 'benchmarks', 'log.jsonl');
const HTTP_BASE = 'http://localhost:3027';
const PROJECT = 'tuberosa';
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

// ─── types ─────────────────────────────────────────────────────────────────

interface TestResult {
  pass: number;
  fail: number;
  total: number;
}

interface RetrievalMetrics {
  hitRate: number;
  mrr: number;
  staleRejectionRate: number;
  contextFitStatusRate: number;
  exactClassificationRate: number;
  contextFitScoreRate: number;
  selectedCoverageRate: number;
  unexpectedAvoidanceRate: number;
  confidenceThresholdRate: number;
  totalCases: number;
}

interface LiveProbe {
  name: string;
  pass: boolean;
  detail: string;
}

interface LiveProbeBlock {
  available: boolean;
  results: LiveProbe[];
  passRate: number;
}

interface KnowledgeCompletenessSummary {
  mode: 'fixture' | 'live';
  skipped: boolean;
  skipReason?: string;
  totalCases: number;
  passRate: number;
  averageCompleteness: number;
  averageSourceCoverage: number;
  averageNoiseRate: number;
  averageKnowledgeGainScore: number;
}

interface KnowledgeCompletenessBlock {
  fixture: KnowledgeCompletenessSummary;
  live: KnowledgeCompletenessSummary;
}

interface BenchmarkRun {
  timestamp: string;
  commit: string;
  branch: string;
  commitMessage: string;
  tests: TestResult;
  retrieval: RetrievalMetrics;
  knowledgeCompleteness: KnowledgeCompletenessBlock;
  agentContextPass: boolean;
  liveProbes: LiveProbeBlock | null;
  compositeScore: number;
}

// ─── data collection ──────────────────────────────────────────────────────

function gitInfo(): { commit: string; branch: string; message: string } {
  const run = (cmd: string) => spawnSync(cmd, { shell: true, encoding: 'utf8', cwd: ROOT }).stdout.trim();
  return {
    commit: run('git rev-parse --short HEAD'),
    branch: run('git branch --show-current'),
    message: run('git log -1 --format=%s'),
  };
}

function runTests(): TestResult {
  // Use pnpm so the glob expands correctly via the shell and PATH is set.
  // Take the LAST match for each counter — Node's test runner emits sub-totals for nested
  // suites before the final summary, so .at(-1) gives the accurate top-level count.
  const result = spawnSync('pnpm', ['test'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env },
  });
  const out = (result.stdout ?? '') + (result.stderr ?? '');
  const last = (rx: RegExp) => Number([...out.matchAll(rx)].at(-1)?.[1] ?? 0);
  return {
    pass: last(/# pass (\d+)/g),
    fail: last(/# fail (\d+)/g),
    total: last(/# tests (\d+)/g),
  };
}

function runRetrievalEval(): RetrievalMetrics {
  const result = spawnSync(TSX, ['scripts/eval-retrieval.ts', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const report = JSON.parse(result.stdout.trim()) as RetrievalEvalReport;
  const m = report.metrics;
  return {
    hitRate: m.hitRate ?? 0,
    mrr: m.meanReciprocalRank ?? 0,
    staleRejectionRate: m.staleRejectionRate ?? 0,
    contextFitStatusRate: m.contextFitStatusRate ?? 0,
    exactClassificationRate: m.exactClassificationMatchRate ?? 0,
    contextFitScoreRate: m.contextFitScoreRate ?? 0,
    selectedCoverageRate: m.selectedCoverageRate ?? 0,
    unexpectedAvoidanceRate: m.unexpectedAvoidanceRate ?? 0,
    confidenceThresholdRate: m.confidenceThresholdRate ?? 0,
    totalCases: report.totalCases,
  };
}

function runAgentContextEval(): boolean {
  const result = spawnSync(TSX, ['scripts/eval-agent-context.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return result.status === 0;
}

function runKnowledgeCompletenessEval(mode: 'fixture' | 'live'): KnowledgeCompletenessSummary {
  const result = spawnSync(TSX, [
    'scripts/eval-knowledge-completeness.ts',
    '--mode',
    mode,
    '--api-base',
    HTTP_BASE,
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: mode === 'live' ? 30_000 : 60_000,
  });
  const report = JSON.parse(result.stdout.trim()) as KnowledgeCompletenessReport;
  return summarizeKnowledgeCompleteness(report);
}

function summarizeKnowledgeCompleteness(report: KnowledgeCompletenessReport): KnowledgeCompletenessSummary {
  return {
    mode: report.mode,
    skipped: report.skipped ?? false,
    skipReason: report.skipReason,
    totalCases: report.totalCases,
    passRate: report.metrics.passRate ?? 0,
    averageCompleteness: report.metrics.averageCompleteness ?? 0,
    averageSourceCoverage: report.metrics.averageSourceCoverage ?? 0,
    averageNoiseRate: report.metrics.averageNoiseRate ?? 0,
    averageKnowledgeGainScore: report.metrics.averageKnowledgeGainScore ?? 0,
  };
}

// ─── live probes ──────────────────────────────────────────────────────────

async function searchContext(prompt: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`${HTTP_BASE}/context/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, project: PROJECT, debug: true, ...extra }),
    signal: AbortSignal.timeout(5_000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

async function probeCodeRefSurfacing(): Promise<LiveProbe> {
  // Use an explicit file reference — the realistic agent workflow.
  // With file label match, code_ref items should surface as directTaskEvidence.
  const pack = await searchContext('update feedbackScoreAdjustment in service.ts to fix the noisy penalty');
  const sections = (pack.sections as Array<{ items: Array<{ itemType: string; evidenceCategory?: string }> }>) ?? [];
  const allItems = sections.flatMap((s) => s.items ?? []);
  const codeRefItems = allItems.filter((item) => item.itemType === 'code_ref');
  const directItems = codeRefItems.filter((item) => item.evidenceCategory === 'directTaskEvidence');
  const pass = directItems.length > 0;
  return {
    name: 'code_ref surfacing',
    pass,
    detail: pass
      ? `${directItems.length} code_ref as directTaskEvidence`
      : `code_ref found: ${codeRefItems.length}, directTaskEvidence: 0`,
  };
}

async function probeStopWordsFixed(): Promise<LiveProbe> {
  const walkPack = await searchContext('Walk me through the agent session lifecycle');
  const refactorPack = await searchContext('Refactor reranker fusion weights', { taskType: 'refactor' });
  const walkSymbols = ((walkPack.classified as Record<string, unknown>)?.symbols as string[]) ?? [];
  const refactorSymbols = ((refactorPack.classified as Record<string, unknown>)?.symbols as string[]) ?? [];
  const falseSymbols = [
    ...walkSymbols.filter((s) => s.toLowerCase() === 'walk'),
    ...refactorSymbols.filter((s) => s.toLowerCase() === 'refactor'),
  ];
  const pass = falseSymbols.length === 0;
  return {
    name: 'stop words fix',
    pass,
    detail: pass
      ? `walkSymbols=[${walkSymbols.join(', ')}], refactorSymbols=[${refactorSymbols.join(', ')}]`
      : `false symbols=[${falseSymbols.join(', ')}]`,
  };
}

async function probeCompoundTermsFixed(): Promise<LiveProbe> {
  const pack = await searchContext('why is intent-suppression not applying correctly');
  const exactTerms = ((pack.classified as Record<string, unknown>)?.exactTerms as string[]) ?? [];
  const pass = exactTerms.includes('intent-suppression');
  return {
    name: 'compound terms fix',
    pass,
    detail: pass
      ? `exactTerms includes 'intent-suppression'`
      : `exactTerms=[${exactTerms.join(', ')}] — missing 'intent-suppression'`,
  };
}

async function probeOffDomainNoiseSuppressed(): Promise<LiveProbe> {
  const pack = await searchContext('Refactor SenderQueue retry policy in src/email/sender-queue.ts.');
  const sections = (pack.sections as Array<{ name: string; items: Array<{ title: string; labels?: Array<{ type: string; value: string }> }> }>) ?? [];
  const scopedSections = sections.filter((section) => section.name === 'essential' || section.name === 'supporting');
  const noisyItems = scopedSections.flatMap((section) => (
    (section.items ?? [])
      .filter((item) => {
        const title = item.title.toLowerCase();
        const labels = item.labels ?? [];
        return title.includes('own backup schedulers')
          || title.includes('debounce physical mirror')
          || title.includes('run migrations')
          || labels.some((label) => label.type === 'domain' && ['operations', 'storage'].includes(label.value.toLowerCase()));
      })
      .map((item) => `${section.name}:${item.title}`)
  ));
  const pass = noisyItems.length === 0;
  return {
    name: 'off-domain noise suppressed',
    pass,
    detail: pass
      ? 'no operations/storage noise in essential/supporting'
      : `noise=[${noisyItems.join(', ')}]`,
  };
}

async function runLiveProbes(): Promise<LiveProbeBlock | null> {
  try {
    await fetch(`${HTTP_BASE}/health`, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return null;
  }

  const probes = [probeCodeRefSurfacing, probeStopWordsFixed, probeCompoundTermsFixed, probeOffDomainNoiseSuppressed];
  const results: LiveProbe[] = [];
  for (const probe of probes) {
    try {
      results.push(await probe());
    } catch (err) {
      results.push({ name: probe.name, pass: false, detail: `error: ${String(err)}` });
    }
  }

  return {
    available: true,
    results,
    passRate: results.length > 0 ? results.filter((r) => r.pass).length / results.length : 0,
  };
}

// ─── composite score ──────────────────────────────────────────────────────

// Weights reflect what matters most for the goal: giving agents direct, actionable evidence.
const RETRIEVAL_WEIGHTS = {
  hitRate: 0.20,
  staleRejectionRate: 0.20,
  contextFitStatusRate: 0.15,
  exactClassificationRate: 0.15,
  mrr: 0.15,
  contextFitScoreRate: 0.10,
  selectedCoverageRate: 0.05,
} as const;

function computeCompositeScore(
  r: RetrievalMetrics,
  knowledgeCompleteness: KnowledgeCompletenessBlock,
  tests: TestResult,
  agentContextPass: boolean,
  liveProbes: LiveProbeBlock | null,
): number {
  const retrievalScore =
    r.hitRate * RETRIEVAL_WEIGHTS.hitRate +
    r.staleRejectionRate * RETRIEVAL_WEIGHTS.staleRejectionRate +
    r.contextFitStatusRate * RETRIEVAL_WEIGHTS.contextFitStatusRate +
    r.exactClassificationRate * RETRIEVAL_WEIGHTS.exactClassificationRate +
    r.mrr * RETRIEVAL_WEIGHTS.mrr +
    r.contextFitScoreRate * RETRIEVAL_WEIGHTS.contextFitScoreRate +
    r.selectedCoverageRate * RETRIEVAL_WEIGHTS.selectedCoverageRate;

  const testRate = tests.total > 0 ? tests.pass / tests.total : 0;
  const systemScore = testRate * 0.60 + (agentContextPass ? 1 : 0) * 0.40;
  const completenessScore = knowledgeCompletenessCompositeScore(knowledgeCompleteness);

  if (liveProbes?.available) {
    return Math.round((
      retrievalScore * 0.50
      + systemScore * 0.25
      + liveProbes.passRate * 0.10
      + completenessScore * 0.15
    ) * 100);
  }

  // Normalize without live probe slice
  return Math.round((retrievalScore * 0.55 + systemScore * 0.30 + completenessScore * 0.15) * 100);
}

function knowledgeCompletenessCompositeScore(block: KnowledgeCompletenessBlock): number {
  const scores = [block.fixture, block.live]
    .filter((summary) => !summary.skipped)
    .map((summary) => summary.averageKnowledgeGainScore / 100);
  if (scores.length === 0) {
    return 0;
  }
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

// ─── persistence ──────────────────────────────────────────────────────────

function loadLastRun(): BenchmarkRun | null {
  if (!existsSync(LOG_FILE)) {
    return null;
  }
  const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  try {
    return JSON.parse(lines[lines.length - 1]) as BenchmarkRun;
  } catch {
    return null;
  }
}

function saveRun(run: BenchmarkRun): void {
  mkdirSync(join(ROOT, 'benchmarks'), { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify(run) + '\n', 'utf8');
}

// ─── report ───────────────────────────────────────────────────────────────

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function deltaLabel(current: number, previous: BenchmarkRun | null): string {
  if (!previous) {
    return '(first run)';
  }
  const delta = current - previous.compositeScore;
  if (delta === 0) {
    return `(no change from ${previous.commit})`;
  }
  const sign = delta > 0 ? `▲ +${delta}` : `▼ ${delta}`;
  return `(${sign} from ${previous.compositeScore} @ ${previous.commit})`;
}

function printReport(run: BenchmarkRun, previous: BenchmarkRun | null): void {
  const bar = '─'.repeat(62);
  console.log(`\n${bar}`);
  console.log(`  TUBEROSA BENCHMARK  ${run.timestamp}`);
  console.log(`  commit: ${run.commit}  branch: ${run.branch}`);
  console.log(`  ${run.commitMessage}`);
  console.log(bar);
  console.log('');
  const testStatus = run.tests.fail === 0 ? '✓' : '✗';
  console.log(`  ${testStatus} Tests         ${run.tests.pass}/${run.tests.total} pass`);
  const evalStatus = run.retrieval.hitRate === 1 ? '✓' : '✗';
  console.log(`  ${evalStatus} Retrieval     ${run.retrieval.totalCases} cases — hit@5 ${pct(run.retrieval.hitRate)}`);
  const completenessStatus = run.knowledgeCompleteness.fixture.passRate === 1 ? '✓' : '✗';
  console.log(`  ${completenessStatus} Completeness  fixture ${knowledgeCompletenessLine(run.knowledgeCompleteness.fixture)}`);
  const agentStatus = run.agentContextPass ? '✓' : '✗';
  console.log(`  ${agentStatus} Agent Context ${run.agentContextPass ? 'pass' : 'FAIL'}`);

  if (run.liveProbes?.available) {
    const lp = run.liveProbes;
    const lpPass = lp.results.filter((r) => r.pass).length;
    const lpStatus = lpPass === lp.results.length ? '✓' : '✗';
    console.log(`  ${lpStatus} Live Probes   ${lpPass}/${lp.results.length} pass`);
  } else {
    console.log(`  - Live Probes   server not reachable (skipped)`);
  }

  console.log('');
  console.log('  Retrieval Metrics');
  console.log(`    hit@5                   ${pct(run.retrieval.hitRate)}`);
  console.log(`    stale rejection         ${pct(run.retrieval.staleRejectionRate)}`);
  console.log(`    context fit status      ${pct(run.retrieval.contextFitStatusRate)}`);
  console.log(`    exact classification    ${pct(run.retrieval.exactClassificationRate)}`);
  console.log(`    MRR                     ${pct(run.retrieval.mrr)}`);
  console.log(`    context fit score       ${pct(run.retrieval.contextFitScoreRate)}`);
  console.log(`    selected coverage       ${pct(run.retrieval.selectedCoverageRate)}`);

  console.log('');
  console.log('  Knowledge Completeness');
  console.log(`    fixture                 ${knowledgeCompletenessLine(run.knowledgeCompleteness.fixture)}`);
  console.log(`    live                    ${knowledgeCompletenessLine(run.knowledgeCompleteness.live)}`);

  if (run.liveProbes?.available) {
    console.log('');
    console.log('  Live Probe Results');
    for (const probe of run.liveProbes.results) {
      const icon = probe.pass ? '✓' : '✗';
      console.log(`    ${icon} ${probe.name.padEnd(26)} ${probe.detail}`);
    }
  }

  console.log('');
  console.log(bar);
  console.log(`  COMPOSITE SCORE:  ${run.compositeScore} / 100   ${deltaLabel(run.compositeScore, previous)}`);
  console.log(`${bar}\n`);
}

function knowledgeCompletenessLine(summary: KnowledgeCompletenessSummary): string {
  if (summary.skipped) {
    return `skipped (${summary.skipReason ?? 'not available'})`;
  }

  return [
    `${summary.totalCases} cases`,
    `score ${summary.averageKnowledgeGainScore.toFixed(1)}`,
    `complete ${pct(summary.averageCompleteness)}`,
    `sources ${pct(summary.averageSourceCoverage)}`,
    `noise ${pct(summary.averageNoiseRate)}`,
  ].join(' — ');
}

// ─── main ─────────────────────────────────────────────────────────────────

const git = gitInfo();

process.stdout.write('Running tests...');
const tests = runTests();
process.stdout.write(` ${tests.pass}/${tests.total}\n`);

process.stdout.write('Running retrieval eval...');
const retrieval = runRetrievalEval();
process.stdout.write(` ${retrieval.totalCases} cases, hit@5 ${pct(retrieval.hitRate)}\n`);

process.stdout.write('Running knowledge completeness eval...');
const knowledgeCompleteness: KnowledgeCompletenessBlock = {
  fixture: runKnowledgeCompletenessEval('fixture'),
  live: runKnowledgeCompletenessEval('live'),
};
process.stdout.write(
  ` fixture score ${knowledgeCompleteness.fixture.averageKnowledgeGainScore.toFixed(1)}, `
  + (
    knowledgeCompleteness.live.skipped
      ? 'live skipped\n'
      : `live score ${knowledgeCompleteness.live.averageKnowledgeGainScore.toFixed(1)}\n`
  ),
);

process.stdout.write('Running agent-context eval...');
const agentContextPass = runAgentContextEval();
process.stdout.write(` ${agentContextPass ? 'pass' : 'FAIL'}\n`);

process.stdout.write('Running live probes...');
const liveProbes = await runLiveProbes();
process.stdout.write(
  liveProbes?.available
    ? ` ${liveProbes.results.filter((r) => r.pass).length}/${liveProbes.results.length} pass\n`
    : ' server not reachable\n',
);

const compositeScore = computeCompositeScore(retrieval, knowledgeCompleteness, tests, agentContextPass, liveProbes);
const previous = loadLastRun();

const run: BenchmarkRun = {
  timestamp: new Date().toISOString(),
  commit: git.commit,
  branch: git.branch,
  commitMessage: git.message,
  tests,
  retrieval,
  knowledgeCompleteness,
  agentContextPass,
  liveProbes,
  compositeScore,
};

saveRun(run);
printReport(run, previous);
