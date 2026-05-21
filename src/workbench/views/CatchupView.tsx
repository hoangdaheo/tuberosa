import { useEffect, useState } from 'preact/hooks';
import { Clock, FlaskConical, Gauge, ListChecks, Map, ExternalLink, RefreshCcw, Target, Wrench } from 'lucide-preact';
import { api } from '../state/api.js';
import { Pill } from '../components/Pill.js';
import { Markdown } from '../components/Markdown.js';
import { EmptyState } from '../components/EmptyState.js';
import type { CatchupKnownIssue, CatchupMcpTool, CatchupResponse, CatchupRetrievalEval, CatchupSandboxHeadline, WorkbenchSummary } from '../types.js';

export function CatchupView() {
  const [data, setData] = useState<CatchupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const next = await api<CatchupResponse>('/operations/catchup', { query: { project: 'tuberosa', limit: 5 } });
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (loading && !data) {
    return <section data-testid="catchup-view" class="stack"><EmptyState title="Loading catchup" hint="Pulling project intent, sandbox health, and queue counts." /></section>;
  }

  if (error) {
    return (
      <section data-testid="catchup-view" class="stack">
        <EmptyState
          title="Could not load /operations/catchup"
          hint={error}
        />
        <button class="primary icon-button" onClick={refresh}><RefreshCcw size={16} aria-hidden="true" /> Retry</button>
      </section>
    );
  }

  if (!data) {
    return <section data-testid="catchup-view" class="stack"><EmptyState title="No catchup data" hint="Click refresh to fetch." /></section>;
  }

  const { catchup, summary } = data;
  const goalContent = catchup.projectGoal.content;
  const sandbox = catchup.sandbox;
  const retrievalEval = catchup.retrievalEval;

  return (
    <section data-testid="catchup-view" class="stack">
      <div class="overview-hero">
        <div>
          <div class="eyebrow"><Map size={14} aria-hidden="true" /> Catchup — one page, current state</div>
          <h1>{catchup.currentPhase ?? 'Tuberosa Catchup'}</h1>
          <p class="muted">Project intent, eval health, queue counts, recent activity, and known issues — refreshed each load.</p>
          <div class="form-actions">
            <button class="primary icon-button" onClick={refresh} disabled={loading}>
              <RefreshCcw size={16} aria-hidden="true" /> {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            {catchup.roadmap.exists && (
              <a class="icon-button" href={`#/guide`} title={catchup.roadmap.path}>
                <ExternalLink size={16} aria-hidden="true" /> Roadmap: {catchup.roadmap.path.split('/').pop()}
              </a>
            )}
          </div>
        </div>
        <div class="overview-control" aria-label="Live system health">
          <strong>Live health</strong>
          <HealthStripe summary={summary} sandbox={sandbox} retrievalEval={retrievalEval} />
        </div>
      </div>

      <section class="panel">
        <div class="row between">
          <div>
            <h2><FlaskConical size={16} aria-hidden="true" /> Eval health — retrieval</h2>
            <p class="muted small">Last <code>pnpm run eval:retrieval</code>. Sentinel at <code>.tuberosa/last-eval.json</code>.</p>
          </div>
          {retrievalEval
            ? <Pill kind={retrievalEval.status === 'pass' ? 'good' : 'bad'}>
                {retrievalEval.status === 'pass' ? `passed (${retrievalEval.passedCases}/${retrievalEval.totalCases})` : `failed (${retrievalEval.passedCases}/${retrievalEval.totalCases})`}
              </Pill>
            : <Pill kind="muted">never run</Pill>}
        </div>
        {retrievalEval
          ? <RetrievalEvalGrid record={retrievalEval} />
          : <EmptyState title="No retrieval eval recorded" hint="Run `pnpm run eval:retrieval` to populate the sentinel." />}
      </section>

      <section class="panel">
        <div class="row between">
          <div>
            <h2><FlaskConical size={16} aria-hidden="true" /> Eval health — sandbox</h2>
            <p class="muted small">Last <code>pnpm run sandbox</code> against the synthetic corpus.</p>
          </div>
          {sandbox
            ? <Pill kind={sandbox.status === 'pass' ? 'good' : sandbox.status === 'fail' ? 'bad' : 'muted'}>
                {sandbox.status === 'pass' ? 'all thresholds passed' : sandbox.status === 'fail' ? 'failing' : 'unknown status'}
              </Pill>
            : <Pill kind="muted">no report</Pill>}
        </div>
        {sandbox
          ? <EvalMetricsGrid headline={sandbox.headline} generatedAt={sandbox.generatedAt} />
          : <EmptyState title="No sandbox report yet" hint="Run `pnpm run sandbox` to produce eval/sandbox/report.md." />}
      </section>

      <section class="panel">
        <div class="row between">
          <div>
            <h2><Gauge size={16} aria-hidden="true" /> Review queues</h2>
            <p class="muted small">Pending review work — counts from the same summary that powers the Overview tab.</p>
          </div>
          <Pill kind="muted">generated {new Date(summary.generatedAt).toLocaleTimeString()}</Pill>
        </div>
        <QueueCountsGrid counts={summary.counts} />
      </section>

      <section class="panel">
        <div class="row between">
          <div>
            <h2><Clock size={16} aria-hidden="true" /> Recent activity</h2>
            <p class="muted small">Last few agent sessions — most recent first.</p>
          </div>
        </div>
        {summary.recentSessions.length === 0
          ? <EmptyState title="No agent sessions yet" hint="Start a session to populate this list." />
          : <ul class="catchup-list">
              {summary.recentSessions.slice(0, 5).map((session) => (
                <li key={session.id}>
                  <div class="row between">
                    <strong>{truncate(session.prompt, 100)}</strong>
                    <Pill kind={pillForSessionStatus(session.status, session.outcome)}>
                      {session.outcome ?? session.status}
                    </Pill>
                  </div>
                  <span class="muted small">{new Date(session.createdAt).toLocaleString()}{session.project ? ` · ${session.project}` : ''}</span>
                </li>
              ))}
            </ul>}
      </section>

      <section class="panel">
        <div class="row between">
          <div>
            <h2><ListChecks size={16} aria-hidden="true" /> Known issues</h2>
            <p class="muted small">Edit <code>config/catchup.json</code> to update this list. From the audit + Track A/B work.</p>
          </div>
        </div>
        {catchup.knownIssues.length === 0
          ? <EmptyState title="No known issues" hint="Add entries to config/catchup.json knownIssues[]." />
          : <ul class="catchup-issues">
              {catchup.knownIssues.map((issue) => (
                <li key={issue.id}>
                  <Pill kind={pillForIssue(issue)}>{issue.id}</Pill>
                  <span>{issue.title}</span>
                  <Pill kind={pillForIssueStatus(issue.status)}>{issue.status}</Pill>
                </li>
              ))}
            </ul>}
      </section>

      <section class="panel">
        <div class="row between">
          <div>
            <h2><Wrench size={16} aria-hidden="true" /> MCP tools you use every day</h2>
            <p class="muted small">From <code>config/catchup.json</code>. Minimum args for each tool.</p>
          </div>
        </div>
        <McpToolList tools={catchup.keyMcpTools} />
      </section>

      <section class="panel">
        <div class="row between">
          <div>
            <h2><Target size={16} aria-hidden="true" /> Project intent</h2>
            <p class="muted small">From {catchup.projectGoal.path || 'no doc configured'}.</p>
          </div>
        </div>
        {goalContent
          ? <Markdown text={goalContent} />
          : <EmptyState title="No project goal document" hint="Configure projectGoalDocPath in config/catchup.json." />}
      </section>
    </section>
  );
}

function HealthStripe({ summary, sandbox, retrievalEval }: { summary: WorkbenchSummary; sandbox: CatchupResponse['catchup']['sandbox']; retrievalEval: CatchupRetrievalEval | null }) {
  const health = summary.health;
  const sandboxStatus = sandbox?.status ?? 'unknown';
  const retrievalStatus = retrievalEval?.status ?? 'unknown';
  return (
    <div class="catchup-health">
      <span>store: <strong>{health.store ?? 'unknown'}</strong></span>
      <span>cache: <strong>{health.cache ?? 'unknown'}</strong></span>
      <span>provider: <strong>{health.modelProvider ?? 'unknown'}</strong></span>
      <span>backup: <strong>{health.durability ?? 'unknown'}</strong></span>
      <span>retrieval: <Pill kind={retrievalStatus === 'pass' ? 'good' : retrievalStatus === 'fail' ? 'bad' : 'muted'}>{retrievalStatus}</Pill></span>
      <span>sandbox: <Pill kind={sandboxStatus === 'pass' ? 'good' : sandboxStatus === 'fail' ? 'bad' : 'muted'}>{sandboxStatus}</Pill></span>
    </div>
  );
}

function RetrievalEvalGrid({ record }: { record: CatchupRetrievalEval }) {
  const rows: EvalMetricRow[] = [
    { label: 'hit rate', raw: record.metrics.hitRate, format: (v) => `${(v * 100).toFixed(1)}%`, good: (v) => v >= 1.0 },
    { label: 'MRR', raw: record.metrics.meanReciprocalRank, format: (v) => v.toFixed(3), good: (v) => v >= 0.8 },
    { label: 'selected cov.', raw: record.metrics.selectedCoverageRate, format: (v) => `${(v * 100).toFixed(0)}%`, good: (v) => v >= 1.0 },
    { label: 'stale reject', raw: record.metrics.staleRejectionRate, format: (v) => `${(v * 100).toFixed(0)}%`, good: (v) => v >= 1.0 },
    { label: 'file match', raw: record.metrics.exactFileMatchRate, format: (v) => `${(v * 100).toFixed(0)}%`, good: (v) => v >= 1.0 },
    { label: 'symbol match', raw: record.metrics.exactSymbolMatchRate, format: (v) => `${(v * 100).toFixed(0)}%`, good: (v) => v >= 1.0 },
    { label: 'error match', raw: record.metrics.exactErrorMatchRate, format: (v) => `${(v * 100).toFixed(0)}%`, good: (v) => v >= 1.0 },
  ];
  return (
    <>
      <div class="catchup-metrics" data-testid="catchup-retrieval-metrics">
        {rows.map((row) => {
          const value = row.raw;
          const formatted = value === undefined ? '—' : row.format(value);
          const kind = value === undefined ? 'muted' : row.bad?.(value) ? 'bad' : row.good?.(value) ? 'good' : 'default';
          return (
            <div class="catchup-metric" key={row.label}>
              <span class="queue-label">{row.label}</span>
              <Pill kind={kind}>{formatted}</Pill>
            </div>
          );
        })}
      </div>
      <p class="small muted">
        {record.fixtureName ? `fixture ${record.fixtureName}` : 'fixture'} · generated {new Date(record.generatedAt).toLocaleString()}
      </p>
    </>
  );
}

interface EvalMetricRow {
  label: string;
  raw: number | undefined;
  format: (value: number) => string;
  good?: (value: number) => boolean;
  bad?: (value: number) => boolean;
}

function EvalMetricsGrid({ headline, generatedAt }: { headline: CatchupSandboxHeadline; generatedAt?: string }) {
  const rows: EvalMetricRow[] = [
    { label: 'hit rate', raw: headline.hitRate, format: (v) => `${(v * 100).toFixed(1)}%`, good: (v) => v >= 0.9 },
    { label: 'MRR', raw: headline.mrr, format: (v) => v.toFixed(4), good: (v) => v >= 0.45 },
    { label: 'noise', raw: headline.noiseRate, format: (v) => `${(v * 100).toFixed(1)}%`, bad: (v) => v > 0.2 },
    { label: 'stale supp.', raw: headline.staleSuppression, format: (v) => `${(v * 100).toFixed(0)}%`, good: (v) => v >= 0.95 },
    { label: 'dup supp.', raw: headline.duplicateSuppression, format: (v) => `${(v * 100).toFixed(0)}%`, good: (v) => v >= 0.9 },
    { label: 'adv block', raw: headline.adversarialBlock, format: (v) => `${(v * 100).toFixed(0)}%`, good: (v) => v >= 0.9 },
    { label: 'p50 (ms)', raw: headline.latencyP50, format: (v) => `${v}`, good: (v) => v <= 30 },
    { label: 'p95 (ms)', raw: headline.latencyP95, format: (v) => `${v}`, good: (v) => v <= 60 },
  ];

  return (
    <>
      <div class="catchup-metrics" data-testid="catchup-eval-metrics">
        {rows.map((row) => {
          const value = row.raw;
          const formatted = value === undefined ? '—' : row.format(value);
          const kind = value === undefined ? 'muted' : row.bad?.(value) ? 'bad' : row.good?.(value) ? 'good' : 'default';
          return (
            <div class="catchup-metric" key={row.label}>
              <span class="queue-label">{row.label}</span>
              <Pill kind={kind}>{formatted}</Pill>
            </div>
          );
        })}
      </div>
      {generatedAt && <p class="small muted">generated {new Date(generatedAt).toLocaleString()}</p>}
    </>
  );
}

function QueueCountsGrid({ counts }: { counts: WorkbenchSummary['counts'] }) {
  const queueRows: Array<{ label: string; value: number; hint?: string }> = [
    { label: 'pending drafts', value: counts.pendingDrafts, hint: 'reflection drafts awaiting review' },
    { label: 'open gaps', value: counts.openGaps, hint: 'context that was searched but missing' },
    { label: 'open proposals', value: counts.openProposals, hint: 'learning proposals awaiting review' },
    { label: 'open conflicts', value: counts.openConflicts, hint: 'knowledge conflicts to resolve' },
    { label: 'risky auto memories', value: counts.riskyAutoMemories, hint: 'auto-approved memories flagged for review' },
    { label: 'open error logs', value: counts.openErrorLogs, hint: 'unresolved error log entries' },
  ];

  return (
    <div class="catchup-metrics">
      {queueRows.map((row) => (
        <div class="catchup-metric" key={row.label} title={row.hint}>
          <span class="queue-label">{row.label}</span>
          <Pill kind={row > 0 ? 'accent' : 'muted'}>{row}</Pill>
        </div>
      ))}
    </div>
  );
}

function McpToolList({ tools }: { tools: CatchupMcpTool[] }) {
  if (tools.length === 0) {
    return <EmptyState title="No tools configured" hint="Add keyMcpTools[] to config/catchup.json." />;
  }
  return (
    <ul class="catchup-tools">
      {tools.map((tool) => (
        <li key={tool.name}>
          <code>{tool.name}</code>
          {tool.purpose && <span class="muted small">— {tool.purpose}</span>}
          <div class="small">
            <span class="muted">args:</span>{' '}
            {tool.minArgs.map((arg, index) => (
              <code key={arg} class="catchup-arg">{arg}{index < tool.minArgs.length - 1 ? ',' : ''}</code>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

type PillKind = 'good' | 'bad' | 'warn' | 'muted' | 'default' | 'accent';

function pillForSessionStatus(status: string, outcome?: string): PillKind {
  if (outcome === 'completed') return 'good';
  if (outcome === 'failed') return 'bad';
  if (outcome === 'blocked' || outcome === 'cancelled') return 'warn';
  if (status === 'active') return 'accent';
  return 'muted';
}

function pillForIssue(issue: CatchupKnownIssue): 'good' | 'warn' | 'bad' | 'muted' | 'default' {
  if (issue.status === 'done') return 'good';
  if (issue.status === 'in_progress') return 'warn';
  if (issue.status === 'open') return 'bad';
  return 'muted';
}

function pillForIssueStatus(status: string): 'good' | 'warn' | 'bad' | 'muted' | 'default' {
  if (status === 'done') return 'good';
  if (status === 'in_progress') return 'warn';
  if (status === 'open') return 'bad';
  return 'muted';
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
