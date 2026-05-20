import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles/main.css';
import { api, getApiKey, getLimit, getProject, setApiKey, setLimit, setProject } from './state/api.js';
import { currentView, navigate, pushToast } from './state/store.js';
import { presentSummary, type SummaryViewModel } from './presenters/summaryPresenter.js';
import { SummarySidebar } from './views/SummarySidebar.js';
import { SessionView } from './views/SessionView.js';
import { QualityView } from './views/QualityView.js';
import { MemoryView } from './views/MemoryView.js';
import { GuideView } from './views/GuideView.js';
import { Toasts } from './components/Toasts.js';
import type { WorkbenchSummary } from './types.js';

function App() {
  const [project, setProjectState] = useState(getProject());
  const [limit, setLimitState] = useState(getLimit());
  const [apiKey, setApiKeyState] = useState(getApiKey());
  const [summary, setSummary] = useState<WorkbenchSummary | null>(null);
  const [summaryVM, setSummaryVM] = useState<SummaryViewModel | null>(null);
  const [loading, setLoading] = useState(false);
  const view = currentView.value;

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

  useEffect(() => { refresh(); }, []);

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
      <header class="app">
        <div class="shell">
          <div class="row between">
            <div>
              <h1>Tuberosa Workbench</h1>
              <p class="subtitle">Review what the broker wants to learn. New here? Open the <a href="#/guide" onClick={(e) => { e.preventDefault(); navigate('guide'); }}>Guide</a>.</p>
            </div>
          </div>
          <nav class="tabs" role="tablist">
            <button class={view === 'session' ? 'active' : ''} onClick={() => navigate('session')} data-testid="nav-session">Start session</button>
            <button class={view === 'quality' ? 'active' : ''} onClick={() => navigate('quality')} data-testid="nav-quality">Context quality</button>
            <button class={view === 'memory' ? 'active' : ''} onClick={() => navigate('memory')} data-testid="nav-memory">Memory review</button>
            <button class={view === 'guide' ? 'active' : ''} onClick={() => navigate('guide')} data-testid="nav-guide">Guide</button>
          </nav>
        </div>
      </header>

      <main class="shell">
        <SummarySidebar
          summary={summaryVM}
          project={project}
          limit={limit}
          apiKey={apiKey}
          loading={loading}
          onProjectChange={onProjectChange}
          onLimitChange={onLimitChange}
          onApiKeyChange={onApiKeyChange}
          onRefresh={refresh}
        />
        <section>
          {view === 'session' && <SessionView defaultProject={project} />}
          {view === 'quality' && <QualityView summary={summary} />}
          {view === 'memory' && <MemoryView summary={summary} project={project} limit={limit} refresh={refresh} />}
          {view === 'guide' && <GuideView />}
        </section>
      </main>

      <Toasts />
    </>
  );
}

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
