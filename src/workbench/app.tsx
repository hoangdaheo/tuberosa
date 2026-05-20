import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { BookOpen, ClipboardList, HeartPulse, Home, PlayCircle } from 'lucide-preact';
import './styles/main.css';
import { api, getApiKey, getLimit, getProject, setApiKey, setLimit, setProject } from './state/api.js';
import { currentRoute, ensureDefaultRoute, navigate, pushToast } from './state/store.js';
import { presentSummary, type SummaryViewModel } from './presenters/summaryPresenter.js';
import { SummarySidebar } from './views/SummarySidebar.js';
import { OverviewView } from './views/OverviewView.js';
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
  const route = currentRoute.value;
  const view = route.view;

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
      <header class="app">
        <div class="shell">
          <div class="row between">
            <div>
              <h1>Tuberosa Workbench</h1>
              <p class="subtitle">Review context quality, memory drafts, gaps, conflicts, and learning signals from one local control plane.</p>
            </div>
          </div>
          <nav class="tabs" role="tablist">
            <button class={view === 'overview' ? 'active' : ''} onClick={() => navigate('overview')} data-testid="nav-overview"><Home size={15} aria-hidden="true" /> Overview</button>
            <button class={view === 'session' ? 'active' : ''} onClick={() => navigate('session')} data-testid="nav-session"><PlayCircle size={15} aria-hidden="true" /> Start session</button>
            <button class={view === 'quality' ? 'active' : ''} onClick={() => navigate('quality')} data-testid="nav-quality"><HeartPulse size={15} aria-hidden="true" /> Context quality</button>
            <button class={view === 'memory' ? 'active' : ''} onClick={() => navigate({ view: 'memory', memoryTab: route.memoryTab })} data-testid="nav-memory"><ClipboardList size={15} aria-hidden="true" /> Memory review</button>
            <button class={view === 'guide' ? 'active' : ''} onClick={() => navigate('guide')} data-testid="nav-guide"><BookOpen size={15} aria-hidden="true" /> Guide</button>
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
          {view === 'overview' && (
            <OverviewView
              summary={summary}
              summaryVM={summaryVM}
              project={project}
              loading={loading}
              onProjectChange={onProjectChange}
              onRefresh={refresh}
            />
          )}
          {view === 'session' && <SessionView defaultProject={project} />}
          {view === 'quality' && <QualityView summary={summary} />}
          {view === 'memory' && <MemoryView summary={summary} project={project} limit={limit} refresh={refresh} activeTab={route.memoryTab} />}
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
