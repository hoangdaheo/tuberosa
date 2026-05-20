import type { SummaryViewModel } from '../presenters/summaryPresenter.js';
import { Pill } from '../components/Pill.js';
import { navigate } from '../state/store.js';

interface Props {
  summary: SummaryViewModel | null;
  project: string;
  limit: number;
  apiKey: string;
  loading: boolean;
  onProjectChange: (value: string) => void;
  onLimitChange: (value: number) => void;
  onApiKeyChange: (value: string) => void;
  onRefresh: () => void;
}

export function SummarySidebar(props: Props) {
  const { summary, project, limit, apiKey, loading, onProjectChange, onLimitChange, onApiKeyChange, onRefresh } = props;
  return (
    <aside class="sidebar">
      <div class="panel">
        <h2>Filters</h2>
        <div class="form-row">
          <label htmlFor="filter-project">Project</label>
          <input
            id="filter-project"
            type="text"
            placeholder="All projects"
            value={project}
            data-testid="project-input"
            onInput={(e) => onProjectChange((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="form-row" style={{ marginTop: 8 }}>
          <label htmlFor="filter-limit">Results per query</label>
          <input
            id="filter-limit"
            type="number"
            min={1}
            max={100}
            value={limit}
            onInput={(e) => onLimitChange(Number((e.target as HTMLInputElement).value))}
          />
        </div>
        <div class="form-row" style={{ marginTop: 8 }}>
          <label htmlFor="filter-key">API key (optional)</label>
          <input
            id="filter-key"
            type="password"
            placeholder="x-tuberosa-api-key"
            value={apiKey}
            onInput={(e) => onApiKeyChange((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="form-actions">
          <button
            class="primary"
            disabled={loading}
            onClick={onRefresh}
            data-testid="refresh-summary"
          >{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>

      {summary && (
        <>
          <div class="panel">
            <h2>Health</h2>
            <p class={summary.health.warning ? 'small' : 'small muted'}>
              {summary.health.warning && <Pill kind="warn">ephemeral</Pill>}{' '}
              {summary.health.line}
            </p>
          </div>

          <div class="panel">
            <h2>At a glance</h2>
            <div class="metrics" data-testid="summary-metrics">
              {summary.metrics.map((m) => (
                <button class="metric" key={m.label} title={m.hint} onClick={() => navigate(m.target)} data-testid={`metric-${slug(m.label)}`}>
                  <div class="value" style={{ color: emphasisColor(m.emphasis) }}>{m.value}{m.capped && '+'}</div>
                  <div class="label">{m.label}</div>
                </button>
              ))}
            </div>
            <p class="small muted metric-help">Select a metric to open the review surface. Hover for what the count means.</p>
          </div>

          {summary.recommendedActions.length > 0 && (
            <div class="panel">
              <h2>Next actions</h2>
              <ol class="bare small action-list">
                {summary.recommendedActions.map((a) => (
                  <li key={`${a.priority}-${a.label}`}>
                    <button class="action-row" onClick={() => navigate(a.target)}>
                      <strong>{a.label}</strong>
                      {a.count > 0 && <span class="pill muted">{a.count}</span>}
                    </button>
                    {a.reason && <div class="muted small">{a.reason}</div>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function emphasisColor(emphasis: 'warn' | 'good' | undefined): string | undefined {
  if (emphasis === 'warn') return 'var(--warn)';
  if (emphasis === 'good') return 'var(--good)';
  return undefined;
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
