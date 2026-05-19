import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

interface BenchmarkRun {
  timestamp: string;
  commit: string;
  branch: string;
  commitMessage: string;
  tests: TestResult;
  retrieval: RetrievalMetrics;
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
  const pack = await searchContext('how does BM25 reranking work in the retrieval pipeline');
  const sections = (pack.sections as Array<{ items: Array<{ itemType: string }> }>) ?? [];
  const allItems = sections.flatMap((s) => s.items ?? []);
  const codeRefItems = allItems.filter((item) => item.itemType === 'code_ref');
  const pass = codeRefItems.length > 0;
  return {
    name: 'code_ref surfacing',
    pass,
    detail: pass ? `${codeRefItems.length} code_ref item(s) in pack` : 'no code_ref items in any section',
  };
}

async function probeStopWordsFixed(): Promise<LiveProbe> {
  const pack = await searchContext('Walk me through the agent session lifecycle');
  const symbols = ((pack.classified as Record<string, unknown>)?.symbols as string[]) ?? [];
  const falseSymbol = symbols.find((s) => s.toLowerCase() === 'walk');
  const pass = !falseSymbol;
  return {
    name: 'stop words fix',
    pass,
    detail: pass
      ? `symbols=[${symbols.join(', ')}] — no false "Walk"`
      : `"Walk" still in symbols: [${symbols.join(', ')}]`,
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

async function runLiveProbes(): Promise<LiveProbeBlock | null> {
  try {
    await fetch(`${HTTP_BASE}/health`, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return null;
  }

  const probes = [probeCodeRefSurfacing, probeStopWordsFixed, probeCompoundTermsFixed];
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

  if (liveProbes?.available) {
    return Math.round((retrievalScore * 0.55 + systemScore * 0.30 + liveProbes.passRate * 0.15) * 100);
  }

  // Normalize without live probe slice
  return Math.round((retrievalScore * 0.65 + systemScore * 0.35) * 100);
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

// ─── main ─────────────────────────────────────────────────────────────────

const git = gitInfo();

process.stdout.write('Running tests...');
const tests = runTests();
process.stdout.write(` ${tests.pass}/${tests.total}\n`);

process.stdout.write('Running retrieval eval...');
const retrieval = runRetrievalEval();
process.stdout.write(` ${retrieval.totalCases} cases, hit@5 ${pct(retrieval.hitRate)}\n`);

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

const compositeScore = computeCompositeScore(retrieval, tests, agentContextPass, liveProbes);
const previous = loadLastRun();

const run: BenchmarkRun = {
  timestamp: new Date().toISOString(),
  commit: git.commit,
  branch: git.branch,
  commitMessage: git.message,
  tests,
  retrieval,
  agentContextPass,
  liveProbes,
  compositeScore,
};

saveRun(run);
printReport(run, previous);
