import { BookOpen, ClipboardList, Database, HeartPulse, PlayCircle, RefreshCcw, Waypoints } from 'lucide-preact';
import type { SummaryViewModel } from '../presenters/summaryPresenter.js';
import { navigate } from '../state/store.js';
import type { WorkbenchSummary } from '../types.js';
import { Pill } from '../components/Pill.js';
import { EmptyState } from '../components/EmptyState.js';

interface Props {
  summary: WorkbenchSummary | null;
  summaryVM: SummaryViewModel | null;
  project: string;
  loading: boolean;
  onProjectChange: (value: string) => void;
  onRefresh: () => void;
}

const FLOW = [
  { label: 'Prompt', detail: 'The agent asks for help with a task.' },
  { label: 'Broker', detail: 'Tuberosa classifies signals and retrieves evidence.' },
  { label: 'Context pack', detail: 'Relevant knowledge is ranked into a compact pack.' },
  { label: 'Decision', detail: 'The agent records selected, noisy, stale, or missing context.' },
  { label: 'Reviewed memory', detail: 'Useful lessons become searchable after review.' },
];

export function OverviewView({ summary, summaryVM, project, loading, onProjectChange, onRefresh }: Props) {
  return (
    <section data-testid="overview-view" class="stack">
      <div class="overview-hero">
        <div>
          <div class="eyebrow"><Waypoints size={14} aria-hidden="true" /> Local context control plane</div>
          <h1>Tuberosa chooses the right project context for agents and reviews what they learn.</h1>
          <p class="muted">
            Start by checking the review queues, then try a session to see exactly what context an agent would receive.
          </p>
          <div class="form-actions">
            <button class="primary icon-button" onClick={() => navigate('session')} data-testid="try-session">
              <PlayCircle size={16} aria-hidden="true" /> Try a session
            </button>
            <button class="icon-button" onClick={() => navigate('guide')}>
              <BookOpen size={16} aria-hidden="true" /> Read guide
            </button>
          </div>
        </div>
        <div class="overview-control" aria-label="Workbench health and project filter">
          <div class="row between">
            <strong>Workbench status</strong>
            {summaryVM
              ? <Pill kind={summaryVM.health.warning ? 'warn' : 'good'}>{summary?.health.durability ?? 'unknown'}</Pill>
              : <Pill kind="muted">loading</Pill>}
          </div>
          <p class="small muted status-line">{summaryVM?.health.line ?? 'Fetch the summary to inspect the current store, cache, provider, and backup state.'}</p>
          <label htmlFor="overview-project">Project filter</label>
          <div class="inline-filter">
            <input
              id="overview-project"
              value={project}
              placeholder="All projects"
              onInput={(e) => onProjectChange((e.target as HTMLInputElement).value)}
              data-testid="overview-project"
            />
            <button class="icon-only" disabled={loading} onClick={onRefresh} title="Refresh summary" aria-label="Refresh summary">
              <RefreshCcw size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <section class="panel">
        <div class="row between">
          <div>
            <h2>Workflow Map</h2>
            <p class="muted small">The normal loop is compact: retrieve context, record whether it helped, then review any lesson before it becomes trusted memory.</p>
          </div>
        </div>
        <div class="flow-map control-flow" data-testid="workflow-map" aria-label="Prompt to reviewed memory workflow">
          {FLOW.map((node, index) => (
            <div class="flow-node" key={node.label}>
              <span class="flow-index">{index + 1}</span>
              <strong>{node.label}</strong>
              <span>{node.detail}</span>
            </div>
          ))}
        </div>
      </section>

      <section class="panel">
        <div class="row between">
          <div>
            <h2>Primary Queues</h2>
            <p class="muted small">Use these counts to jump straight to the queue that needs a decision.</p>
          </div>
          {summary && <Pill kind="muted">generated {new Date(summary.generatedAt).toLocaleTimeString()}</Pill>}
        </div>
        {summaryVM
          ? (
            <div class="overview-metrics" data-testid="overview-queue-counts">
              {summaryVM.metrics.map((metric) => (
                <button class="queue-tile" key={metric.label} onClick={() => navigate(metric.target)} title={metric.hint}>
                  <span class="queue-icon">{iconForMetric(metric.label)}</span>
                  <span class="queue-value" style={{ color: valueColor(metric.emphasis) }}>{metric.value}{metric.capped && '+'}</span>
                  <span class="queue-label">{metric.label}</span>
                  <span class="queue-hint">{metric.hint}</span>
                </button>
              ))}
            </div>
          )
          : <EmptyState title="Summary not loaded" hint="Refresh the workbench summary to see review queue counts." />}
      </section>

      {summaryVM && (
        <section class="panel">
          <h2>Next Actions</h2>
          <div class="action-grid" data-testid="overview-next-actions">
            {summaryVM.recommendedActions.map((action) => (
              <button class="action-card" key={`${action.priority}-${action.label}`} onClick={() => navigate(action.target)}>
                <span class="action-priority">P{action.priority}</span>
                <strong>{action.label}</strong>
                <span>{action.reason ?? 'Open the relevant queue.'}</span>
                {action.count > 0 && <Pill kind="accent">{action.count}</Pill>}
              </button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

function iconForMetric(label: string) {
  if (label.includes('Session')) return <PlayCircle size={17} aria-hidden="true" />;
  if (label.includes('Quality')) return <HeartPulse size={17} aria-hidden="true" />;
  if (label.includes('draft')) return <ClipboardList size={17} aria-hidden="true" />;
  return <Database size={17} aria-hidden="true" />;
}

function valueColor(emphasis: 'warn' | 'good' | undefined): string | undefined {
  if (emphasis === 'warn') return 'var(--warn)';
  if (emphasis === 'good') return 'var(--good)';
  return undefined;
}
