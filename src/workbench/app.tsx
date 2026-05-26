import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles/main.css';
import { api, getApiKey, getLimit, getProject, setApiKey, setLimit, setProject } from './state/api.js';
import { currentRoute, ensureDefaultRoute, pushToast } from './state/store.js';
import { presentSummary, type SummaryViewModel } from './presenters/summaryPresenter.js';
import { TopNav } from './components/TopNav.js';
import { ReadinessStrip } from './components/ReadinessStrip.js';
import { Toasts } from './components/Toasts.js';
import { StartView } from './views/StartView.js';
import { SessionResultView } from './views/SessionResultView.js';
import { ReviewView } from './views/ReviewView.js';
import { SessionsView } from './views/SessionsView.js';
import { KnowledgeView } from './views/KnowledgeView.js';
import { PlaybooksView } from './views/PlaybooksView.js';
import { SystemView } from './views/SystemView.js';
import type { AgentSessionStartResult, WorkbenchSummary } from './types.js';

function App() {
  const [project, setProjectState] = useState(getProject());
  const [limit, setLimitState] = useState(getLimit());
  const [apiKey, setApiKeyState] = useState(getApiKey());
  const [summary, setSummary] = useState<WorkbenchSummary | null>(null);
  const [summaryVM, setSummaryVM] = useState<SummaryViewModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSession, setActiveSession] = useState<AgentSessionStartResult | null>(null);
  const route = currentRoute.value;

  async function refresh() {
    setLoading(true);
    try {
      const data = await api<WorkbenchSummary>('/operations/workbench/summary', { query: { project: project || undefined, limit } });
      setSummary(data);
      setSummaryVM(presentSummary(data));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    ensureDefaultRoute();
    refresh();
  }, []);

  function onProjectChange(value: string) {
    setProjectState(value);
    setProject(value);
  }

  function onLimitChange(value: number) {
    if (!Number.isFinite(value) || value <= 0) return;
    setLimitState(value);
    setLimit(value);
  }

  function onApiKeyChange(value: string) {
    setApiKeyState(value);
    setApiKey(value);
  }

  return (
    <>
      <TopNav route={route} />
      <ReadinessStrip summary={summaryVM} apiKeySet={Boolean(apiKey)} loading={loading} />
      <main class="workbench-shell">
        <section class="workspace">
          {route.view === 'start' && (
            <StartView defaultProject={project} onSessionStarted={setActiveSession} />
          )}
          {route.view === 'session' && activeSession && <SessionResultView result={activeSession} onChanged={refresh} />}
          {route.view === 'session' && !activeSession && (
            <div class="panel" data-testid="session-result-missing">
              <h1>Session not loaded</h1>
              <p class="muted">Open this session from the Sessions list or map a new task from Start.</p>
            </div>
          )}
          {route.view === 'review' && <ReviewView summary={summary} filter={route.filter} />}
          {route.view === 'sessions' && <SessionsView summary={summary} />}
          {route.view === 'knowledge' && <KnowledgeView project={project} limit={limit} />}
          {route.view === 'playbooks' && <PlaybooksView playbookId={route.playbookId} />}
          {route.view === 'system' && <SystemView summary={summary} summaryVM={summaryVM} />}
        </section>
        <aside class="support-rail">
          <div class="panel">
            <h2>Setup</h2>
            <label htmlFor="rail-project">Project</label>
            <input id="rail-project" value={project} onInput={(e) => onProjectChange((e.target as HTMLInputElement).value)} />
            <label htmlFor="rail-limit">Result limit</label>
            <input id="rail-limit" type="number" min={1} max={100} value={limit} onInput={(e) => onLimitChange(Number((e.target as HTMLInputElement).value))} />
            <label htmlFor="rail-api-key">API key</label>
            <input id="rail-api-key" type="password" value={apiKey} onInput={(e) => onApiKeyChange((e.target as HTMLInputElement).value)} />
            <button class="primary" disabled={loading} onClick={refresh}>{loading ? 'Refreshing...' : 'Refresh'}</button>
          </div>
          {summary && <div hidden data-testid="summary-loaded">{summary.generatedAt}</div>}
        </aside>
      </main>
      <Toasts />
    </>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
