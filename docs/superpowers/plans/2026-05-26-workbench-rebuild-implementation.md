# Workbench Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Tuberosa Workbench with a guided real-task workflow, session result visualization, unified review queue, knowledge browser, playbooks, and system surface while preserving the current HTTP/MCP APIs.

**Architecture:** Keep the backend API stable and build the new experience in the existing Preact workbench. Put all business shaping into presenter modules so views remain mostly rendering and user events. Use native CSS and SVG for the first evidence graph; add a graph library only after this plan if native SVG blocks the experience.

**Tech Stack:** Node 22.21.1, pnpm 11, strict TypeScript with NodeNext ESM, Preact, @preact/signals, lucide-preact, native SVG/CSS, Node test runner with tsx, Playwright browser smoke tests.

## Implementation Status

Status: Complete and verified on 2026-05-26.

Audit notes:
- The Workbench rebuild is already implemented in the current `main` history through the task-aligned commits from `608f634` through `a57c22a`, then merged by `7a984e3` and refined by `00a3e07`.
- The guided shell, route model, Start flow, session result visualizations, session decision/finish flow, unified Review workspace, Sessions/Knowledge/Playbooks/System views, responsive CSS, browser smoke tests, and presenter tests are present.
- Legacy tab-based Workbench views (`OverviewView`, `CatchupView`, `SessionView`, `QualityView`, `MemoryView`, `MemoryMaintenanceTab`, `GuideView`, `SummarySidebar`) are no longer present or imported.
- No backend retrieval, MCP, storage, or API semantics were changed by this audit update.

Latest verification:
- `npx gitnexus status` -> up to date at commit `00a3e07`.
- `node --test --import tsx test/workbench-routes.test.ts test/workbench-session-result-presenter.test.ts test/workbench-review-presenter.test.ts test/workbench-playbooks.test.ts test/workbench-presenters.test.ts` -> pass.
- `pnpm run build` -> pass.
- `pnpm test` -> pass, 432 tests.
- `pnpm run test:workbench-browser` -> pass.
- `git diff --check` -> pass.

---

## Scope Check

This is one cohesive subsystem: the Workbench UI. It touches routing, presenters, views, styling, and workbench browser tests, but it does not alter retrieval semantics or MCP behavior. Build it as vertical slices and commit after each task so the branch can be reviewed safely.

Before editing existing functions, classes, or methods, run GitNexus impact analysis for the symbol named in the task. If GitNexus reports HIGH or CRITICAL risk, stop and report the blast radius before editing.

Use this Node prefix for all commands unless the shell already has Node 22.21.1 active:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH
```

Do not run multiple `pnpm` commands concurrently.

## File Map

### Existing files to modify

- `src/workbench/app.tsx`: replace the current tab shell with the new guided shell and route rendering.
- `src/workbench/state/store.ts`: keep toasts, replace old route types with new route names via pure route helpers.
- `src/workbench/state/api.ts`: keep generic API helper and add typed session/ingest helper functions only if they reduce repeated code.
- `src/workbench/types.ts`: add browser-safe local types for new view models and ingest inputs.
- `src/workbench/styles/main.css`: replace the current admin-tab styling with the new friendly learning layout, graph, pipeline, review cards, responsive rules.
- `test/workbench-presenters.test.ts`: keep summary fixture coverage and add presenter tests for new review/session models, or split tests into focused files as listed below.
- `test/browser/workbench-browser.test.ts`: replace old tab assertions with guided Start, session result, decision, review, playbook, system, and overflow assertions.

### New files to create

- `src/workbench/state/routes.ts`: pure parse/serialize helpers for `start`, `sessions`, `session`, `review`, `knowledge`, `playbooks`, and `system`.
- `src/workbench/presenters/sessionResultPresenter.ts`: converts `AgentSessionStartResult` or `ContextPack` into verdict, pipeline, evidence graph, context stack, and handoff view models.
- `src/workbench/presenters/reviewQueuePresenter.ts`: converts `WorkbenchSummary` into a single prioritized mixed review queue.
- `src/workbench/presenters/playbookPresenter.ts`: static playbook data and small helpers for scenario recipes.
- `src/workbench/presenters/systemPresenter.ts`: converts summary/catchup data into readiness and system status cards.
- `src/workbench/components/TopNav.tsx`: primary navigation.
- `src/workbench/components/ReadinessStrip.tsx`: compact system/project readiness.
- `src/workbench/components/VerdictBand.tsx`: session verdict and next instruction.
- `src/workbench/components/PipelineRail.tsx`: retrieval pipeline visualization.
- `src/workbench/components/EvidenceGraph.tsx`: native SVG graph with accessible list fallback.
- `src/workbench/components/ContextStack.tsx`: essential/supporting/optional context columns.
- `src/workbench/components/AgentHandoff.tsx`: copyable brief and commands.
- `src/workbench/components/DecisionCard.tsx`: shared review queue item card.
- `src/workbench/components/DetailPanel.tsx`: side detail panel for graph/review items.
- `src/workbench/views/StartView.tsx`: first-use task mapping form and support rail.
- `src/workbench/views/SessionResultView.tsx`: renders the session result experience.
- `src/workbench/views/SessionsView.tsx`: session history and detail entry points.
- `src/workbench/views/ReviewView.tsx`: unified review queue with filters and actions.
- `src/workbench/views/KnowledgeView.tsx`: knowledge search and detail inspection.
- `src/workbench/views/PlaybooksView.tsx`: interactive guide/playbook area.
- `src/workbench/views/SystemView.tsx`: health, setup, catchup, API key, backup/eval status.
- `test/workbench-routes.test.ts`: pure route parser tests.
- `test/workbench-session-result-presenter.test.ts`: session result presenter tests.
- `test/workbench-review-presenter.test.ts`: unified review queue presenter tests.
- `test/workbench-playbooks.test.ts`: playbook data tests.

### Existing files to remove near the end

Remove these only after the new shell no longer imports them:

- `src/workbench/views/OverviewView.tsx`
- `src/workbench/views/CatchupView.tsx`
- `src/workbench/views/SessionView.tsx`
- `src/workbench/views/QualityView.tsx`
- `src/workbench/views/MemoryView.tsx`
- `src/workbench/views/MemoryMaintenanceTab.tsx`
- `src/workbench/views/GuideView.tsx`
- `src/workbench/views/SummarySidebar.tsx`

Keep shared components that are still useful, such as `Pill`, `EmptyState`, `Toasts`, `Markdown`, and `GlossaryTerm`.

---

### Task 1: Route Model And New Shell Skeleton

**Files:**
- Create: `src/workbench/state/routes.ts`
- Modify: `src/workbench/state/store.ts`
- Modify: `src/workbench/app.tsx`
- Test: `test/workbench-routes.test.ts`

- [x] **Step 1: Run impact analysis for edited route/shell symbols**

Run GitNexus impact analysis before editing:

```text
gitnexus_impact(repo="tuberosa", target="App", file_path="src/workbench/app.tsx", direction="upstream")
gitnexus_impact(repo="tuberosa", target="parseView", file_path="src/workbench/state/store.ts", direction="upstream")
```

Expected: report the direct callers/processes. Continue only if risk is LOW or MEDIUM; warn the user first for HIGH or CRITICAL.

- [x] **Step 2: Write the failing route tests**

Create `test/workbench-routes.test.ts`:

```ts
import test from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import {
  DEFAULT_WORKBENCH_ROUTE,
  parseWorkbenchHash,
  routeToHash,
  type WorkbenchRoute,
} from '../src/workbench/state/routes.js';

test('workbench routes parse new top-level surfaces', () => {
  deepEqual(parseWorkbenchHash('#/start'), { view: 'start' });
  deepEqual(parseWorkbenchHash('#/sessions'), { view: 'sessions' });
  deepEqual(parseWorkbenchHash('#/session/session-123'), { view: 'session', sessionId: 'session-123' });
  deepEqual(parseWorkbenchHash('#/review?filter=gaps'), { view: 'review', filter: 'gaps' });
  deepEqual(parseWorkbenchHash('#/knowledge'), { view: 'knowledge' });
  deepEqual(parseWorkbenchHash('#/playbooks/missing-context'), { view: 'playbooks', playbookId: 'missing-context' });
  deepEqual(parseWorkbenchHash('#/system'), { view: 'system' });
});

test('workbench route serialization keeps canonical hashes', () => {
  const cases: WorkbenchRoute[] = [
    { view: 'start' },
    { view: 'sessions' },
    { view: 'session', sessionId: 'session-123' },
    { view: 'review', filter: 'drafts' },
    { view: 'knowledge' },
    { view: 'playbooks', playbookId: 'first-task' },
    { view: 'system' },
  ];

  equal(routeToHash(cases[0]), '#/start');
  equal(routeToHash(cases[1]), '#/sessions');
  equal(routeToHash(cases[2]), '#/session/session-123');
  equal(routeToHash(cases[3]), '#/review?filter=drafts');
  equal(routeToHash(cases[4]), '#/knowledge');
  equal(routeToHash(cases[5]), '#/playbooks/first-task');
  equal(routeToHash(cases[6]), '#/system');
});

test('unknown hashes fall back to Start', () => {
  deepEqual(parseWorkbenchHash(''), DEFAULT_WORKBENCH_ROUTE);
  deepEqual(parseWorkbenchHash('#/overview'), DEFAULT_WORKBENCH_ROUTE);
  deepEqual(parseWorkbenchHash('#/memory/drafts'), DEFAULT_WORKBENCH_ROUTE);
});
```

- [x] **Step 3: Run route tests and verify failure**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/workbench-routes.test.ts
```

Expected: FAIL with a module-not-found error for `src/workbench/state/routes.js`.

- [x] **Step 4: Implement pure route helpers**

Create `src/workbench/state/routes.ts`:

```ts
export type ViewName = 'start' | 'sessions' | 'session' | 'review' | 'knowledge' | 'playbooks' | 'system';
export type ReviewFilter = 'all' | 'drafts' | 'quality' | 'gaps' | 'proposals' | 'conflicts' | 'risky' | 'errors' | 'maintenance';

export interface WorkbenchRoute {
  view: ViewName;
  sessionId?: string;
  filter?: ReviewFilter;
  playbookId?: string;
}

export type RouteTarget =
  | ViewName
  | { view: ViewName; sessionId?: string; filter?: ReviewFilter; playbookId?: string };

export const DEFAULT_WORKBENCH_ROUTE: WorkbenchRoute = { view: 'start' };

const REVIEW_FILTERS = new Set<ReviewFilter>([
  'all',
  'drafts',
  'quality',
  'gaps',
  'proposals',
  'conflicts',
  'risky',
  'errors',
  'maintenance',
]);

export function parseWorkbenchHash(hashValue: string): WorkbenchRoute {
  const raw = hashValue.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const view = parts[0];

  if (!view) return DEFAULT_WORKBENCH_ROUTE;
  if (view === 'start') return { view: 'start' };
  if (view === 'sessions') return { view: 'sessions' };
  if (view === 'session' && parts[1]) return { view: 'session', sessionId: decodeURIComponent(parts[1]) };
  if (view === 'review') {
    const filter = readReviewFilter(queryPart);
    return filter ? { view: 'review', filter } : { view: 'review' };
  }
  if (view === 'knowledge') return { view: 'knowledge' };
  if (view === 'playbooks') {
    return parts[1] ? { view: 'playbooks', playbookId: decodeURIComponent(parts[1]) } : { view: 'playbooks' };
  }
  if (view === 'system') return { view: 'system' };

  return DEFAULT_WORKBENCH_ROUTE;
}

export function routeToHash(route: WorkbenchRoute): string {
  switch (route.view) {
    case 'start':
      return '#/start';
    case 'sessions':
      return '#/sessions';
    case 'session':
      return route.sessionId ? `#/session/${encodeURIComponent(route.sessionId)}` : '#/sessions';
    case 'review':
      return route.filter ? `#/review?filter=${route.filter}` : '#/review';
    case 'knowledge':
      return '#/knowledge';
    case 'playbooks':
      return route.playbookId ? `#/playbooks/${encodeURIComponent(route.playbookId)}` : '#/playbooks';
    case 'system':
      return '#/system';
  }
}

export function normalizeRouteTarget(target: RouteTarget): WorkbenchRoute {
  if (typeof target === 'string') return { view: target };
  return target;
}

function readReviewFilter(queryPart: string | undefined): ReviewFilter | undefined {
  if (!queryPart) return undefined;
  const params = new URLSearchParams(queryPart);
  const raw = params.get('filter');
  return raw && REVIEW_FILTERS.has(raw as ReviewFilter) ? raw as ReviewFilter : undefined;
}
```

- [x] **Step 5: Update route store to use pure helpers**

Replace the route section in `src/workbench/state/store.ts` with:

```ts
import { signal } from '@preact/signals';
import {
  DEFAULT_WORKBENCH_ROUTE,
  normalizeRouteTarget,
  parseWorkbenchHash,
  routeToHash,
  type RouteTarget,
  type WorkbenchRoute,
} from './routes.js';

export type ToastKind = 'info' | 'good' | 'bad';
export interface Toast { id: number; kind: ToastKind; message: string; }

export const toasts = signal<Toast[]>([]);
let toastId = 0;

export function pushToast(message: string, kind: ToastKind = 'info', durationMs = 4000): void {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, kind, message }];
  if (durationMs > 0) {
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id);
    }, durationMs);
  }
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export type { RouteTarget, WorkbenchRoute };

export const currentRoute = signal<WorkbenchRoute>(readHashRoute());

export function ensureDefaultRoute(): void {
  const route = readHashRoute();
  const expected = routeToHash(route);
  if (window.location.hash !== expected) {
    window.history.replaceState(null, '', expected);
  }
}

export function navigate(target: RouteTarget): void {
  const route = normalizeRouteTarget(target);
  const nextHash = routeToHash(route);
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
  currentRoute.value = route;
}

function readHashRoute(): WorkbenchRoute {
  return parseWorkbenchHash(window.location.hash || routeToHash(DEFAULT_WORKBENCH_ROUTE));
}

window.addEventListener('hashchange', () => {
  currentRoute.value = readHashRoute();
});
```

- [x] **Step 6: Replace `App` with a minimal new shell**

Modify `src/workbench/app.tsx` to render the new route names with temporary placeholders. This task should not migrate full pages yet.

```tsx
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles/main.css';
import { api, getApiKey, getLimit, getProject, setApiKey, setLimit, setProject } from './state/api.js';
import { currentRoute, ensureDefaultRoute, pushToast } from './state/store.js';
import { presentSummary, type SummaryViewModel } from './presenters/summaryPresenter.js';
import { TopNav } from './components/TopNav.js';
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
      <main class="workbench-shell">
        <section class="workspace">
          <div class="panel" data-testid={`${route.view}-view`}>
            <h1>{route.view}</h1>
            <p class="muted">This surface will be migrated in the next tasks.</p>
          </div>
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
          {summaryVM && (
            <div class="panel">
              <h2>Readiness</h2>
              <p class={summaryVM.health.warning ? 'small' : 'small muted'}>{summaryVM.health.line}</p>
            </div>
          )}
          {summary && <div hidden data-testid="summary-loaded">{summary.generatedAt}</div>}
        </aside>
      </main>
      <Toasts />
    </>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
```

- [x] **Step 7: Add the new top navigation component**

Create `src/workbench/components/TopNav.tsx`:

```tsx
import { BookOpen, Brain, Database, Home, ListChecks, PlayCircle, Settings } from 'lucide-preact';
import { navigate, type WorkbenchRoute } from '../state/store.js';

interface Props {
  route: WorkbenchRoute;
}

const ITEMS = [
  { view: 'start', label: 'Start', icon: Home },
  { view: 'sessions', label: 'Sessions', icon: PlayCircle },
  { view: 'review', label: 'Review', icon: ListChecks },
  { view: 'knowledge', label: 'Knowledge', icon: Database },
  { view: 'playbooks', label: 'Playbooks', icon: BookOpen },
  { view: 'system', label: 'System', icon: Settings },
] as const;

export function TopNav({ route }: Props) {
  return (
    <header class="workbench-topbar">
      <div class="brand-lockup">
        <Brain size={20} aria-hidden="true" />
        <div>
          <strong>Tuberosa</strong>
          <span>Context broker workbench</span>
        </div>
      </div>
      <nav class="primary-nav" aria-label="Workbench navigation">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.view}
              class={route.view === item.view ? 'active' : ''}
              onClick={() => navigate(item.view)}
              data-testid={`nav-${item.view}`}
            >
              <Icon size={16} aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
```

- [x] **Step 8: Run route and build checks**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/workbench-routes.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build:workbench
```

Expected: route tests PASS and workbench bundle builds.

- [x] **Step 9: Commit Task 1**

```bash
git add src/workbench/app.tsx src/workbench/state/store.ts src/workbench/state/routes.ts src/workbench/components/TopNav.tsx test/workbench-routes.test.ts
git commit -m "feat(workbench): add guided route shell"
```

---

### Task 2: Session Result Presenter

**Files:**
- Create: `src/workbench/presenters/sessionResultPresenter.ts`
- Modify: `src/workbench/types.ts`
- Test: `test/workbench-session-result-presenter.test.ts`

- [x] **Step 1: Run impact analysis for the existing presenter**

Run GitNexus impact analysis:

```text
gitnexus_impact(repo="tuberosa", target="presentSessionStart", file_path="src/workbench/presenters/sessionPresenter.ts", direction="upstream")
```

Expected: report current callers. This task creates a new presenter rather than editing `presentSessionStart`, so the blast radius should remain small.

- [x] **Step 2: Write failing presenter tests**

Create `test/workbench-session-result-presenter.test.ts`:

```ts
import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { presentSessionResult } from '../src/workbench/presenters/sessionResultPresenter.js';
import type { AgentSessionStartResult } from '../src/workbench/types.js';

test('session result presenter creates verdict, pipeline, graph, stack, and handoff', () => {
  const view = presentSessionResult(makeResult());

  equal(view.sessionId, 'session-1');
  equal(view.verdict.status, 'ready');
  ok(view.verdict.headline.includes('ready'));
  deepEqual(view.pipeline.map((stage) => stage.key), ['prompt', 'classify', 'retrieve', 'rank', 'fit', 'decision', 'memory']);
  equal(view.graph.nodes.some((node) => node.id === 'pack-pack-1'), true);
  equal(view.graph.nodes.some((node) => node.kind === 'file' && node.label === 'src/retrieval/service.ts'), true);
  equal(view.contextStack.essential.length, 1);
  ok(view.handoff.text.includes('Fix retrieval ranking'));
  ok(view.nextActions.some((action) => action.kind === 'record_decision'));
});

test('session result presenter groups missing signals for insufficient context', () => {
  const result = makeResult({
    contextPack: {
      contextFit: {
        fitStatus: 'insufficient',
        fitScore: 0.31,
        fitReasons: ['top candidate weak'],
        missingSignals: ['file:docs/runbook.md', 'symbol:RankingPolicy', 'error:TS999'],
      },
      orientation: {
        inferredTask: 'fix missing docs',
        recommendedFiles: [],
        likelySurfaces: [],
        verificationCommands: [],
        missingSignals: {
          files: ['docs/runbook.md'],
          symbols: ['RankingPolicy'],
          errors: ['TS999'],
          docs: [],
          intent: [],
          other: [],
        },
        notes: ['Need more project knowledge.'],
      },
    },
  });
  const view = presentSessionResult(result);

  equal(view.verdict.status, 'insufficient');
  deepEqual(view.missingSignals.files, ['docs/runbook.md']);
  deepEqual(view.missingSignals.symbols, ['RankingPolicy']);
  deepEqual(view.missingSignals.errors, ['TS999']);
  equal(view.nextActions.some((action) => action.kind === 'ingest_missing_context'), true);
});

function makeResult(overrides: Partial<AgentSessionStartResult> = {}): AgentSessionStartResult {
  const base: AgentSessionStartResult = {
    session: {
      id: 'session-1',
      project: 'tuberosa',
      status: 'active',
      prompt: 'Fix retrieval ranking',
      reflectionDraftIds: [],
      metadata: {},
      createdAt: '2026-05-26T00:00:00.000Z',
    },
    policy: { action: 'proceed', instruction: 'Context is ready.' },
    contextPack: {
      id: 'pack-1',
      prompt: 'Fix retrieval ranking',
      status: 'proposed',
      confidence: 0.82,
      contextFit: {
        fitStatus: 'ready',
        fitScore: 0.82,
        fitReasons: ['covered file', 'covered symbol'],
        missingSignals: [],
      },
      orientation: {
        inferredTask: 'fix retrieval ranking',
        recommendedFiles: [{ path: 'src/retrieval/service.ts', reason: 'Direct file evidence.' }],
        likelySurfaces: ['src/retrieval/service.ts'],
        verificationCommands: ['pnpm test'],
        missingSignals: { files: [], symbols: [], errors: [], docs: [], intent: [], other: [] },
        notes: ['Use direct evidence.'],
      },
      taskBrief: {
        goal: 'Fix retrieval ranking',
        actionItems: [{ priority: 1, action: 'read_file', label: 'Read retrieval service', targetPath: 'src/retrieval/service.ts', reason: 'Direct evidence.' }],
        directEvidenceKnowledgeIds: ['knowledge-1'],
        adjacentKnowledgeIds: [],
      },
      sections: [
        {
          name: 'essential',
          tokenEstimate: 200,
          items: [{
            knowledgeId: 'knowledge-1',
            title: 'Retrieval service',
            summary: 'Ranking logic lives here.',
            itemType: 'code_ref',
            finalScore: 0.91,
            matchReasons: ['file:src/retrieval/service.ts', 'symbol:rank'],
            evidenceCategory: 'directTaskEvidence',
            evidenceStrength: 'strong',
            usefulnessReason: 'Direct file match.',
            references: [{ type: 'file', uri: 'src/retrieval/service.ts' }],
          }],
        },
        { name: 'supporting', tokenEstimate: 0, items: [] },
        { name: 'optional', tokenEstimate: 0, items: [] },
      ],
    },
  };

  return {
    ...base,
    ...overrides,
    contextPack: {
      ...base.contextPack,
      ...overrides.contextPack,
      contextFit: {
        ...base.contextPack.contextFit!,
        ...overrides.contextPack?.contextFit,
      },
      orientation: {
        ...base.contextPack.orientation!,
        ...overrides.contextPack?.orientation,
      },
    },
  };
}
```

- [x] **Step 3: Run presenter test and verify failure**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/workbench-session-result-presenter.test.ts
```

Expected: FAIL with a module-not-found error for `sessionResultPresenter.js`.

- [x] **Step 4: Add browser-safe view model types**

Append to `src/workbench/types.ts`:

```ts
export type SessionVerdictStatus = 'ready' | 'needs_confirmation' | 'insufficient' | 'unknown';

export interface SessionVerdictView {
  status: SessionVerdictStatus;
  headline: string;
  detail: string;
  score?: number;
  policyAction: 'proceed' | 'confirm' | 'clarify';
  policyInstruction: string;
}

export interface PipelineStageView {
  key: 'prompt' | 'classify' | 'retrieve' | 'rank' | 'fit' | 'decision' | 'memory';
  label: string;
  status: 'done' | 'attention' | 'waiting';
  detail: string;
  count?: number;
}

export type EvidenceGraphNodeKind = 'task' | 'pack' | 'knowledge' | 'file' | 'symbol' | 'memory' | 'feedback' | 'gap' | 'proposal';
export type EvidenceGraphTone = 'good' | 'warn' | 'bad' | 'muted' | 'accent';

export interface EvidenceGraphNode {
  id: string;
  kind: EvidenceGraphNodeKind;
  label: string;
  detail?: string;
  tone: EvidenceGraphTone;
}

export interface EvidenceGraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  tone: EvidenceGraphTone;
}

export interface EvidenceGraphView {
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
}

export interface ContextStackItemView {
  knowledgeId: string;
  title: string;
  summary: string;
  itemType: string;
  evidenceStrength: string;
  evidenceCategory: string;
  score: number;
  why?: string;
  references: ReferenceInput[];
}

export interface ContextStackView {
  essential: ContextStackItemView[];
  supporting: ContextStackItemView[];
  optional: ContextStackItemView[];
}

export interface MissingSignalGroups {
  files: string[];
  symbols: string[];
  errors: string[];
  docs: string[];
  intent: string[];
  other: string[];
}

export interface AgentHandoffView {
  title: string;
  text: string;
  commands: string[];
  files: Array<{ path: string; reason: string }>;
  warnings: string[];
}

export type SessionNextActionKind =
  | 'record_decision'
  | 'copy_handoff'
  | 'finish_session'
  | 'ingest_missing_context'
  | 'retry_same_task';

export interface SessionNextActionView {
  kind: SessionNextActionKind;
  label: string;
  tone: EvidenceGraphTone;
}

export interface SessionResultViewModel {
  sessionId: string;
  prompt: string;
  project?: string;
  verdict: SessionVerdictView;
  pipeline: PipelineStageView[];
  graph: EvidenceGraphView;
  contextStack: ContextStackView;
  handoff: AgentHandoffView;
  missingSignals: MissingSignalGroups;
  nextActions: SessionNextActionView[];
}
```

- [x] **Step 5: Implement the session result presenter**

Create `src/workbench/presenters/sessionResultPresenter.ts`:

```ts
import type {
  AgentSessionStartResult,
  ContextPack,
  ContextPackSection,
  EvidenceGraphEdge,
  EvidenceGraphNode,
  EvidenceGraphTone,
  MissingSignalGroups,
  PipelineStageView,
  RankedCandidate,
  SessionNextActionView,
  SessionResultViewModel,
  SessionVerdictStatus,
} from '../types.js';

const EMPTY_MISSING: MissingSignalGroups = {
  files: [],
  symbols: [],
  errors: [],
  docs: [],
  intent: [],
  other: [],
};

export function presentSessionResult(result: AgentSessionStartResult): SessionResultViewModel {
  const pack = result.contextPack;
  const missingSignals = groupMissingSignals(pack);
  const status = pack.contextFit?.fitStatus ?? 'unknown';

  return {
    sessionId: result.session.id,
    prompt: result.session.prompt,
    project: result.session.project,
    verdict: {
      status,
      headline: verdictHeadline(status, pack.contextFit?.fitScore),
      detail: verdictDetail(status, pack.contextFit?.fitReasons ?? []),
      score: pack.contextFit?.fitScore,
      policyAction: result.policy.action,
      policyInstruction: result.policy.instruction,
    },
    pipeline: pipelineStages(pack, status),
    graph: evidenceGraph(pack),
    contextStack: {
      essential: sectionItems(pack, 'essential'),
      supporting: sectionItems(pack, 'supporting'),
      optional: sectionItems(pack, 'optional'),
    },
    handoff: {
      title: pack.taskBrief?.goal ?? result.session.prompt,
      text: handoffText(result, missingSignals),
      commands: pack.orientation?.verificationCommands ?? [],
      files: pack.orientation?.recommendedFiles ?? [],
      warnings: [...missingSignals.files, ...missingSignals.symbols, ...missingSignals.errors, ...missingSignals.docs, ...missingSignals.intent, ...missingSignals.other],
    },
    missingSignals,
    nextActions: nextActions(status),
  };
}

function verdictHeadline(status: SessionVerdictStatus, score: number | undefined): string {
  const suffix = score === undefined ? '' : ` (${Math.round(score * 100)}%)`;
  if (status === 'ready') return `Context is ready${suffix}`;
  if (status === 'needs_confirmation') return `Context needs confirmation${suffix}`;
  if (status === 'insufficient') return `Context is insufficient${suffix}`;
  return 'No context verdict recorded';
}

function verdictDetail(status: SessionVerdictStatus, reasons: string[]): string {
  const reason = reasons.slice(0, 3).join(' · ');
  if (status === 'ready') return reason || 'Tuberosa found enough direct evidence for the agent to proceed.';
  if (status === 'needs_confirmation') return reason || 'Useful evidence exists, but the agent should confirm it before relying on it.';
  if (status === 'insufficient') return reason || 'Tuberosa needs more project knowledge or clearer task signals.';
  return 'The context pack did not include fit diagnostics.';
}

function pipelineStages(pack: ContextPack, status: SessionVerdictStatus): PipelineStageView[] {
  const candidateCount = pack.sections.reduce((sum, section) => sum + section.items.length, 0);
  const hasMissing = Object.values(groupMissingSignals(pack)).some((items) => items.length > 0);
  return [
    { key: 'prompt', label: 'Prompt', status: 'done', detail: pack.prompt },
    { key: 'classify', label: 'Classify', status: 'done', detail: pack.orientation?.inferredTask ?? pack.taskBrief?.goal ?? 'Task classified' },
    { key: 'retrieve', label: 'Retrieve', status: candidateCount > 0 ? 'done' : 'attention', detail: 'Knowledge candidates grouped by relevance.', count: candidateCount },
    { key: 'rank', label: 'Rank', status: candidateCount > 0 ? 'done' : 'attention', detail: 'Evidence is sorted into essential, supporting, and optional context.', count: candidateCount },
    { key: 'fit', label: 'Fit', status: status === 'ready' ? 'done' : 'attention', detail: pack.contextFit?.fitReasons?.[0] ?? 'Fit diagnostics unavailable.' },
    { key: 'decision', label: 'Decision', status: 'waiting', detail: 'Record whether this context helped.' },
    { key: 'memory', label: 'Memory', status: hasMissing ? 'attention' : 'waiting', detail: hasMissing ? 'Missing context can become review work.' : 'Finish the session to capture learning.' },
  ];
}

function evidenceGraph(pack: ContextPack): { nodes: EvidenceGraphNode[]; edges: EvidenceGraphEdge[] } {
  const nodes: EvidenceGraphNode[] = [
    { id: 'task', kind: 'task', label: 'Task', detail: pack.prompt, tone: 'accent' },
    { id: `pack-${pack.id}`, kind: 'pack', label: 'Context pack', detail: pack.contextFit?.fitStatus ?? pack.status, tone: toneForStatus(pack.contextFit?.fitStatus) },
  ];
  const edges: EvidenceGraphEdge[] = [
    { id: `task-pack-${pack.id}`, from: 'task', to: `pack-${pack.id}`, label: 'mapped into', tone: 'accent' },
  ];

  for (const section of pack.sections) {
    for (const item of section.items) {
      const knowledgeNodeId = `knowledge-${item.knowledgeId}`;
      nodes.push({
        id: knowledgeNodeId,
        kind: item.itemType === 'memory' ? 'memory' : 'knowledge',
        label: item.title,
        detail: item.summary,
        tone: toneForStrength(item.evidenceStrength),
      });
      edges.push({
        id: `${knowledgeNodeId}-pack`,
        from: `pack-${pack.id}`,
        to: knowledgeNodeId,
        label: section.name,
        tone: toneForStrength(item.evidenceStrength),
      });
      for (const ref of item.references ?? []) {
        const kind = ref.type === 'symbol' ? 'symbol' : 'file';
        const refNodeId = `${kind}-${ref.uri}`;
        if (!nodes.some((node) => node.id === refNodeId)) {
          nodes.push({ id: refNodeId, kind, label: ref.uri, tone: 'muted' });
        }
        edges.push({
          id: `${knowledgeNodeId}-${refNodeId}`,
          from: knowledgeNodeId,
          to: refNodeId,
          label: `references ${ref.type}`,
          tone: 'muted',
        });
      }
    }
  }

  return { nodes, edges };
}

function sectionItems(pack: ContextPack, sectionName: ContextPackSection['name']) {
  const section = pack.sections.find((entry) => entry.name === sectionName);
  return (section?.items ?? []).map(candidateItem);
}

function candidateItem(item: RankedCandidate) {
  return {
    knowledgeId: item.knowledgeId,
    title: item.title,
    summary: item.summary,
    itemType: item.itemType,
    evidenceStrength: item.evidenceStrength ?? 'unrated',
    evidenceCategory: evidenceCategoryLabel(item.evidenceCategory),
    score: item.finalScore,
    why: item.usefulnessReason ?? item.matchReasons?.join(' · '),
    references: item.references ?? [],
  };
}

function groupMissingSignals(pack: ContextPack): MissingSignalGroups {
  const orientationMissing = pack.orientation?.missingSignals;
  if (orientationMissing && !Array.isArray(orientationMissing)) {
    return {
      files: orientationMissing.files ?? [],
      symbols: orientationMissing.symbols ?? [],
      errors: orientationMissing.errors ?? [],
      docs: orientationMissing.docs ?? [],
      intent: orientationMissing.intent ?? [],
      other: orientationMissing.other ?? [],
    };
  }

  const out: MissingSignalGroups = { ...EMPTY_MISSING, files: [], symbols: [], errors: [], docs: [], intent: [], other: [] };
  const raw = pack.contextFit?.missingSignals ?? [];
  for (const entry of raw) {
    const [kind, ...rest] = entry.split(':');
    const value = rest.join(':') || entry;
    if (kind === 'file') out.files.push(value);
    else if (kind === 'symbol') out.symbols.push(value);
    else if (kind === 'error') out.errors.push(value);
    else if (kind === 'doc') out.docs.push(value);
    else if (kind === 'intent') out.intent.push(value);
    else out.other.push(entry);
  }
  return out;
}

function handoffText(result: AgentSessionStartResult, missing: MissingSignalGroups): string {
  const pack = result.contextPack;
  const lines = [
    `Task: ${result.session.prompt}`,
    `Policy: ${result.policy.action} - ${result.policy.instruction}`,
  ];
  if (pack.taskBrief?.goal) lines.push(`Goal: ${pack.taskBrief.goal}`);
  const files = pack.orientation?.recommendedFiles ?? [];
  if (files.length > 0) {
    lines.push('Read first:');
    for (const file of files.slice(0, 8)) lines.push(`- ${file.path}: ${file.reason}`);
  }
  const commands = pack.orientation?.verificationCommands ?? [];
  if (commands.length > 0) {
    lines.push('Verify with:');
    for (const command of commands) lines.push(`- ${command}`);
  }
  const missingValues = [...missing.files, ...missing.symbols, ...missing.errors, ...missing.docs, ...missing.intent, ...missing.other];
  if (missingValues.length > 0) {
    lines.push('Missing context:');
    for (const value of missingValues.slice(0, 8)) lines.push(`- ${value}`);
  }
  return lines.join('\n');
}

function nextActions(status: SessionVerdictStatus): SessionNextActionView[] {
  const actions: SessionNextActionView[] = [
    { kind: 'record_decision', label: 'Record decision', tone: status === 'ready' ? 'good' : 'warn' },
    { kind: 'copy_handoff', label: 'Copy agent handoff', tone: 'accent' },
    { kind: 'finish_session', label: 'Finish session', tone: 'muted' },
  ];
  if (status === 'insufficient' || status === 'needs_confirmation') {
    actions.splice(1, 0, { kind: 'ingest_missing_context', label: 'Ingest missing context', tone: 'warn' });
    actions.splice(2, 0, { kind: 'retry_same_task', label: 'Retry same task', tone: 'accent' });
  }
  return actions;
}

function evidenceCategoryLabel(value: RankedCandidate['evidenceCategory']): string {
  if (value === 'directTaskEvidence') return 'Direct evidence';
  if (value === 'priorLessons') return 'Prior lesson';
  if (value === 'workflowGuidance') return 'Workflow guidance';
  if (value === 'adjacentContext') return 'Adjacent context';
  return 'Context';
}

function toneForStatus(status: SessionVerdictStatus | undefined): EvidenceGraphTone {
  if (status === 'ready') return 'good';
  if (status === 'needs_confirmation') return 'warn';
  if (status === 'insufficient') return 'bad';
  return 'muted';
}

function toneForStrength(strength: RankedCandidate['evidenceStrength']): EvidenceGraphTone {
  if (strength === 'strong') return 'good';
  if (strength === 'moderate') return 'warn';
  if (strength === 'weak') return 'bad';
  return 'muted';
}
```

- [x] **Step 6: Run presenter test and verify pass**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/workbench-session-result-presenter.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 2**

```bash
git add src/workbench/types.ts src/workbench/presenters/sessionResultPresenter.ts test/workbench-session-result-presenter.test.ts
git commit -m "feat(workbench): present session result models"
```

---

### Task 3: Unified Review Queue Presenter

**Files:**
- Create: `src/workbench/presenters/reviewQueuePresenter.ts`
- Modify: `src/workbench/types.ts`
- Test: `test/workbench-review-presenter.test.ts`

- [x] **Step 1: Run impact analysis for summary presenter**

Run GitNexus impact analysis:

```text
gitnexus_impact(repo="tuberosa", target="presentSummary", file_path="src/workbench/presenters/summaryPresenter.ts", direction="upstream")
```

Expected: direct callers include the current workbench app/tests. This task creates a new review presenter and should not modify `presentSummary` yet.

- [x] **Step 2: Write failing review presenter tests**

Create `test/workbench-review-presenter.test.ts`:

```ts
import test from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { presentReviewQueue } from '../src/workbench/presenters/reviewQueuePresenter.js';
import type { WorkbenchSummary } from '../src/types.js';

test('review queue combines workbench summary queues by priority', () => {
  const queue = presentReviewQueue(makeSummary());

  deepEqual(queue.filters.map((filter) => filter.key), ['all', 'drafts', 'quality', 'gaps', 'proposals', 'conflicts', 'risky', 'errors', 'maintenance']);
  equal(queue.items[0].type, 'quality');
  equal(queue.items[0].priority, 1);
  equal(queue.items.some((item) => item.type === 'draft' && item.primaryAction === 'Review draft'), true);
  equal(queue.items.some((item) => item.type === 'conflict' && item.tone === 'bad'), true);
});

test('review queue filters by item type', () => {
  const queue = presentReviewQueue(makeSummary(), 'gaps');

  equal(queue.activeFilter, 'gaps');
  equal(queue.items.length, 1);
  equal(queue.items[0].type, 'gap');
});

function makeSummary(): WorkbenchSummary {
  const now = '2026-05-26T00:00:00.000Z';
  return {
    generatedAt: now,
    filters: { project: 'tuberosa', limit: 10 },
    health: {
      ok: true,
      service: 'tuberosa',
      store: 'memory',
      durability: 'ephemeral',
      cache: 'memory',
      modelProvider: 'hash',
      backupDir: '.tuberosa/backups',
      backupStatus: {
        backupDir: '.tuberosa/backups',
        store: 'memory',
        health: 'no_backups',
        backupCount: 0,
        totalRows: 0,
        scheduler: { enabled: false, running: false, writeThroughEnabled: false },
      },
    },
    counts: {
      recentSessions: 0,
      activeSessions: 0,
      pendingDrafts: 1,
      contextQualityRecords: 1,
      contextQualityMatched: 1,
      openGaps: 1,
      openProposals: 1,
      openConflicts: 1,
      autoMemories: 0,
      riskyAutoMemories: 1,
      openErrorLogs: 1,
      backupCount: 0,
      pendingMaintenance: 1,
    },
    countMetadata: { scanLimit: 100, capped: {} },
    recentSessions: [],
    contextQuality: {
      generatedAt: now,
      filters: { project: 'tuberosa', limit: 10 },
      totalMatched: 1,
      records: [{
        feedback: {
          id: 'feedback-1',
          project: 'tuberosa',
          contextPackId: 'pack-1',
          feedbackType: 'selected_but_noisy',
          reason: 'Too much adjacent context',
          rejectedKnowledgeCount: 0,
          createdAt: now,
        },
        adjacentItems: [],
        missingSignals: ['file:docs/runbook.md'],
        openKnowledgeGaps: [],
        openLearningProposals: [],
        suggestedReviewActions: ['Add runbook knowledge'],
      }],
      rollups: { feedbackTypes: [], projects: [], suggestedReviewActions: [], missingSignals: [], adjacentItems: [] },
    },
    pendingDrafts: [{ id: 'draft-1', title: 'Draft', summary: 'Draft summary', itemType: 'memory', triggerType: 'manual', status: 'pending', labelCount: 1, referenceCount: 1, duplicateCandidateCount: 0, createdAt: now }],
    openGaps: [{ id: 'gap-1', status: 'open', prompt: 'Need docs', missingSignals: ['file:docs/runbook.md'], missingSignalCount: 1, reason: 'Missing runbook', createdAt: now }],
    openProposals: [{ id: 'proposal-1', status: 'open', proposalType: 'missing_label', reason: 'Add label', evidence: ['file:src/app.ts'], evidenceCount: 1, createdAt: now }],
    openConflicts: [{ id: 'conflict-1', status: 'open', conflictType: 'summary_contradiction', leftKnowledgeId: 'left', rightKnowledgeId: 'right', sharedEvidence: ['symbol:X'], sharedEvidenceCount: 1, reason: 'Conflicting lessons', createdAt: now }],
    riskyAutoMemories: [{ id: 'memory-1', project: 'tuberosa', status: 'approved', itemType: 'memory', title: 'Risky', summary: 'Weak references', trustLevel: 62, labelCount: 0, referenceCount: 0, createdAt: now }],
    openErrorLogs: {
      generatedAt: now,
      project: 'tuberosa',
      totalMatched: 1,
      returned: 1,
      filters: { project: 'tuberosa', statuses: ['open'], limit: 10, offset: 0 },
      rollups: { categories: [], severities: [], statuses: [], files: [], symbols: [], errors: [], tags: [] },
      clusters: [],
      logs: [{
        id: 'error-1',
        project: 'tuberosa',
        category: 'test',
        severity: 'high',
        status: 'open',
        title: 'Browser test failed',
        summary: 'Graph did not render',
        occurrenceCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        files: ['src/workbench/app.tsx'],
        symbols: [],
        errors: ['AssertionError'],
        tags: [],
        references: [],
      }],
    },
    pendingMaintenance: {
      batchId: 'batch-1',
      generatedAt: now,
      counts: { duplicate_memory: 1, stale_relation: 0, superseded_reflection: 0, weak_label: 0 },
      totalDetected: 1,
      truncated: false,
      items: [{ id: 'maintenance-1', kind: 'duplicate_memory', risk: 'low', reason: 'Duplicate memory detected' }],
    },
    recommendedActions: [
      { priority: 1, target: 'context_quality', label: 'Review context-quality feedback', count: 1, reason: 'Noisy context affects startup trust.' },
    ],
  };
}
```

- [x] **Step 3: Run review presenter test and verify failure**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/workbench-review-presenter.test.ts
```

Expected: FAIL with a module-not-found error for `reviewQueuePresenter.js`.

- [x] **Step 4: Add review queue view model types**

Append to `src/workbench/types.ts`:

```ts
export type ReviewQueueFilter = 'all' | 'drafts' | 'quality' | 'gaps' | 'proposals' | 'conflicts' | 'risky' | 'errors' | 'maintenance';
export type ReviewQueueItemType = 'draft' | 'quality' | 'gap' | 'proposal' | 'conflict' | 'risky_memory' | 'error_log' | 'maintenance';

export interface ReviewQueueFilterView {
  key: ReviewQueueFilter;
  label: string;
  count: number;
}

export interface ReviewQueueItemView {
  id: string;
  type: ReviewQueueItemType;
  priority: number;
  tone: EvidenceGraphTone;
  title: string;
  summary: string;
  whyItMatters: string;
  evidence: string[];
  primaryAction: string;
  secondaryActions: string[];
  createdAt?: string;
}

export interface ReviewQueueViewModel {
  activeFilter: ReviewQueueFilter;
  filters: ReviewQueueFilterView[];
  items: ReviewQueueItemView[];
  emptyTitle: string;
  emptyHint: string;
}
```

- [x] **Step 5: Implement the review queue presenter**

Create `src/workbench/presenters/reviewQueuePresenter.ts`:

```ts
import type {
  EvidenceGraphTone,
  ReviewQueueFilter,
  ReviewQueueItemView,
  ReviewQueueViewModel,
  WorkbenchSummary,
} from '../types.js';

const FILTERS: Array<{ key: ReviewQueueFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'quality', label: 'Quality' },
  { key: 'gaps', label: 'Gaps' },
  { key: 'proposals', label: 'Proposals' },
  { key: 'conflicts', label: 'Conflicts' },
  { key: 'risky', label: 'Risky' },
  { key: 'errors', label: 'Errors' },
  { key: 'maintenance', label: 'Maintenance' },
];

export function presentReviewQueue(summary: WorkbenchSummary, filter: ReviewQueueFilter = 'all'): ReviewQueueViewModel {
  const allItems = [
    ...summary.contextQuality.records.map((item): ReviewQueueItemView => ({
      id: item.feedback.id,
      type: 'quality',
      priority: 1,
      tone: toneForFeedback(item.feedback.feedbackType),
      title: item.feedback.reason ?? item.contextPack?.prompt ?? item.session?.prompt ?? 'Context-quality feedback',
      summary: item.suggestedReviewActions[0] ?? 'Review why this context decision was recorded.',
      whyItMatters: 'Noisy, stale, rejected, or missing context directly affects agent startup trust.',
      evidence: [...item.missingSignals, ...item.suggestedReviewActions],
      primaryAction: 'Review feedback',
      secondaryActions: ['Open gaps', 'Open proposals'],
      createdAt: item.feedback.createdAt,
    })),
    ...summary.pendingDrafts.map((draft): ReviewQueueItemView => ({
      id: draft.id,
      type: 'draft',
      priority: 2,
      tone: 'warn',
      title: draft.title,
      summary: draft.summary,
      whyItMatters: 'Unreviewed drafts stay out of trusted retrieval until a reviewer decides.',
      evidence: [`${draft.labelCount} labels`, `${draft.referenceCount} references`, `${draft.duplicateCandidateCount} duplicate candidates`],
      primaryAction: 'Review draft',
      secondaryActions: ['Approve', 'Needs changes', 'Reject'],
      createdAt: draft.createdAt,
    })),
    ...summary.openGaps.map((gap): ReviewQueueItemView => ({
      id: gap.id,
      type: 'gap',
      priority: 3,
      tone: 'warn',
      title: gap.reason ?? gap.prompt,
      summary: gap.prompt,
      whyItMatters: 'Open gaps mark evidence agents could not find.',
      evidence: gap.missingSignals,
      primaryAction: 'Triage gap',
      secondaryActions: ['Approve', 'Needs changes', 'Dismiss'],
      createdAt: gap.createdAt,
    })),
    ...summary.openProposals.map((proposal): ReviewQueueItemView => ({
      id: proposal.id,
      type: 'proposal',
      priority: 3,
      tone: 'accent',
      title: proposal.reason,
      summary: proposal.proposalType,
      whyItMatters: 'Learning proposals are the review path for labels, relations, supersession, and cleanup.',
      evidence: proposal.evidence,
      primaryAction: 'Review proposal',
      secondaryActions: ['Approve', 'Needs changes', 'Dismiss'],
      createdAt: proposal.createdAt,
    })),
    ...summary.openConflicts.map((conflict): ReviewQueueItemView => ({
      id: conflict.id,
      type: 'conflict',
      priority: 3,
      tone: 'bad',
      title: conflict.reason,
      summary: `${conflict.leftKnowledgeId} vs ${conflict.rightKnowledgeId}`,
      whyItMatters: 'Conflicting guidance can make future context packs unreliable.',
      evidence: conflict.sharedEvidence,
      primaryAction: 'Resolve conflict',
      secondaryActions: ['Resolve', 'Dismiss'],
      createdAt: conflict.createdAt,
    })),
    ...summary.riskyAutoMemories.map((memory): ReviewQueueItemView => ({
      id: memory.id,
      type: 'risky_memory',
      priority: 2,
      tone: memory.trustLevel >= 80 ? 'warn' : 'bad',
      title: memory.title,
      summary: memory.summary,
      whyItMatters: 'Auto-approved memories with weak evidence should be audited before retrieval relies on them.',
      evidence: [`trust ${memory.trustLevel}`, `${memory.labelCount} labels`, `${memory.referenceCount} references`],
      primaryAction: 'Audit memory',
      secondaryActions: ['Mark needs review', 'Archive'],
      createdAt: memory.createdAt,
    })),
    ...summary.openErrorLogs.logs.map((log): ReviewQueueItemView => ({
      id: log.id,
      type: 'error_log',
      priority: log.severity === 'critical' || log.severity === 'high' ? 2 : 4,
      tone: log.severity === 'critical' || log.severity === 'high' ? 'bad' : 'warn',
      title: log.title,
      summary: log.summary ?? `${log.category} · ${log.status}`,
      whyItMatters: 'Resolved incidents can become reviewed bugfix lessons.',
      evidence: [...log.files, ...log.errors, ...log.tags],
      primaryAction: 'Triage error',
      secondaryActions: ['Mark triaged', 'Archive'],
      createdAt: log.lastSeenAt,
    })),
    ...summary.pendingMaintenance.items.map((item): ReviewQueueItemView => ({
      id: item.id,
      type: 'maintenance',
      priority: item.risk === 'high' ? 2 : 4,
      tone: item.risk === 'high' ? 'bad' : item.risk === 'medium' ? 'warn' : 'good',
      title: item.reason,
      summary: item.kind,
      whyItMatters: 'Maintenance keeps memory and relation quality from drifting.',
      evidence: [item.knowledgeId, item.relationId, item.reflectionDraftId, item.closestKnowledgeId].filter((value): value is string => Boolean(value)),
      primaryAction: 'Preview maintenance',
      secondaryActions: ['Apply selected'],
    })),
  ].sort((a, b) => a.priority - b.priority || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  const items = filter === 'all' ? allItems : allItems.filter((item) => filterMatches(filter, item.type));
  return {
    activeFilter: filter,
    filters: FILTERS.map((entry) => ({ key: entry.key, label: entry.label, count: entry.key === 'all' ? allItems.length : allItems.filter((item) => filterMatches(entry.key, item.type)).length })),
    items,
    emptyTitle: filter === 'all' ? 'Nothing needs a decision' : `No ${FILTERS.find((entry) => entry.key === filter)?.label.toLowerCase()} items`,
    emptyHint: filter === 'all' ? 'Tuberosa will surface review work here after sessions, feedback, drafts, or maintenance scans.' : 'Change the filter or map a new task to create review work.',
  };
}

function filterMatches(filter: ReviewQueueFilter, type: ReviewQueueItemView['type']): boolean {
  if (filter === 'all') return true;
  if (filter === 'drafts') return type === 'draft';
  if (filter === 'quality') return type === 'quality';
  if (filter === 'gaps') return type === 'gap';
  if (filter === 'proposals') return type === 'proposal';
  if (filter === 'conflicts') return type === 'conflict';
  if (filter === 'risky') return type === 'risky_memory';
  if (filter === 'errors') return type === 'error_log';
  if (filter === 'maintenance') return type === 'maintenance';
  return false;
}

function toneForFeedback(type: string): EvidenceGraphTone {
  if (type === 'selected') return 'good';
  if (type === 'selected_but_noisy') return 'warn';
  if (type === 'missing_context' || type === 'rejected' || type === 'stale' || type === 'irrelevant') return 'bad';
  return 'muted';
}
```

- [x] **Step 6: Run review presenter test and verify pass**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/workbench-review-presenter.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit Task 3**

```bash
git add src/workbench/types.ts src/workbench/presenters/reviewQueuePresenter.ts test/workbench-review-presenter.test.ts
git commit -m "feat(workbench): present unified review queue"
```

---

### Task 4: Start Flow View

**Files:**
- Create: `src/workbench/components/ReadinessStrip.tsx`
- Create: `src/workbench/views/StartView.tsx`
- Modify: `src/workbench/app.tsx`
- Modify: `src/workbench/types.ts`
- Test: `test/browser/workbench-browser.test.ts`

- [x] **Step 1: Run impact analysis for `App`**

Run:

```text
gitnexus_impact(repo="tuberosa", target="App", file_path="src/workbench/app.tsx", direction="upstream")
```

Expected: direct browser/app flow only. Continue if LOW or MEDIUM.

- [x] **Step 2: Replace first browser assertions with Start-first behavior**

In `test/browser/workbench-browser.test.ts`, update the first boot assertions inside the main test to expect Start as the default route:

```ts
await page.goto(`${baseUrl}/workbench`);
await page.locator('[data-testid="nav-start"]').waitFor();
await page.locator('[data-testid="start-view"]').waitFor();
equal(await page.evaluate(() => (globalThis as unknown as { location: { hash: string } }).location.hash), '#/start');

const startText = await page.locator('[data-testid="start-view"]').textContent();
ok(startText?.includes('What is the agent about to do?'), 'Start view asks for the real task first');
ok(startText?.includes('Map context'), 'Start view exposes the primary mapping action');
```

- [x] **Step 3: Run browser test and verify failure**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build:workbench
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/browser/workbench-browser.test.ts
```

Expected: FAIL because `start-view` and "Map context" do not render yet.

- [x] **Step 4: Add ingest and start form types**

Append to `src/workbench/types.ts`:

```ts
export interface WorkbenchStartForm {
  prompt: string;
  project: string;
  cwd: string;
  taskType: string;
  files: string;
  symbols: string;
  errors: string;
  contextMode: 'compact' | 'layered';
}

export interface WorkbenchIngestFileInput {
  project?: string;
  path: string;
  content: string;
  itemType?: KnowledgeItemType;
  mode?: 'document' | 'atomic';
  labels?: LabelInput[];
  metadata?: Record<string, unknown>;
}

export interface WorkbenchIngestFilesRequest {
  project: string;
  files: WorkbenchIngestFileInput[];
  mode?: 'document' | 'atomic';
}
```

- [x] **Step 5: Create readiness strip**

Create `src/workbench/components/ReadinessStrip.tsx`:

```tsx
import { AlertTriangle, CheckCircle2, Database, KeyRound } from 'lucide-preact';
import type { SummaryViewModel } from '../presenters/summaryPresenter.js';
import { Pill } from './Pill.js';

interface Props {
  summary: SummaryViewModel | null;
  apiKeySet: boolean;
  loading: boolean;
}

export function ReadinessStrip({ summary, apiKeySet, loading }: Props) {
  const warning = summary?.health.warning;
  const Icon = warning ? AlertTriangle : CheckCircle2;
  return (
    <section class="readiness-strip" data-testid="readiness-strip" aria-label="Workbench readiness">
      <div>
        <Icon size={17} aria-hidden="true" />
        <span>{loading ? 'Checking Tuberosa...' : summary?.health.line ?? 'Connect to Tuberosa to inspect readiness.'}</span>
      </div>
      <div class="readiness-pills">
        <Pill kind={warning ? 'warn' : 'good'}><Database size={12} aria-hidden="true" /> {warning ? 'ephemeral' : 'persistent'}</Pill>
        <Pill kind={apiKeySet ? 'good' : 'muted'}><KeyRound size={12} aria-hidden="true" /> {apiKeySet ? 'API key set' : 'loopback/dev'}</Pill>
      </div>
    </section>
  );
}
```

- [x] **Step 6: Create Start view**

Create `src/workbench/views/StartView.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { ChevronDown, PlayCircle } from 'lucide-preact';
import { api } from '../state/api.js';
import { navigate, pushToast } from '../state/store.js';
import type { AgentSessionStartResult, WorkbenchStartForm } from '../types.js';

const DEFAULT_FORM: WorkbenchStartForm = {
  prompt: '',
  project: '',
  cwd: '',
  taskType: '',
  files: '',
  symbols: '',
  errors: '',
  contextMode: 'compact',
};

interface Props {
  defaultProject: string;
  defaultCwd?: string;
  onSessionStarted: (result: AgentSessionStartResult) => void;
}

export function StartView({ defaultProject, defaultCwd = '', onSessionStarted }: Props) {
  const [form, setForm] = useState<WorkbenchStartForm>({ ...DEFAULT_FORM, project: defaultProject, cwd: defaultCwd });
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function update<K extends keyof WorkbenchStartForm>(key: K, value: WorkbenchStartForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function mapContext(e: Event) {
    e.preventDefault();
    if (!form.prompt.trim()) {
      pushToast('Enter the task the agent is about to do.', 'bad');
      return;
    }
    setBusy(true);
    try {
      const result = await api<AgentSessionStartResult>('/agent-sessions', {
        method: 'POST',
        body: {
          prompt: form.prompt.trim(),
          project: form.project.trim() || undefined,
          cwd: form.cwd.trim() || undefined,
          taskType: form.taskType || undefined,
          contextMode: form.contextMode,
          files: splitList(form.files),
          symbols: splitList(form.symbols),
          errors: splitList(form.errors),
        },
      });
      onSessionStarted(result);
      navigate({ view: 'session', sessionId: result.session.id });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="start-view" data-testid="start-view">
      <div class="start-copy">
        <p class="eyebrow">Real project first</p>
        <h1>Map the context for the task your agent is about to do.</h1>
        <p class="muted">Tuberosa will classify the task, retrieve evidence, explain confidence, and produce a handoff for Codex, Claude, Cursor, or another MCP-aware agent.</p>
      </div>
      <form class="start-card" onSubmit={mapContext} data-testid="start-form">
        <label htmlFor="start-prompt">What is the agent about to do?</label>
        <textarea
          id="start-prompt"
          data-testid="start-prompt"
          value={form.prompt}
          onInput={(e) => update('prompt', (e.target as HTMLTextAreaElement).value)}
          placeholder="Fix the build failure in src/retrieval/service.ts"
          required
        />
        <div class="form-grid">
          <div class="form-row">
            <label htmlFor="start-project">Project</label>
            <input id="start-project" value={form.project} onInput={(e) => update('project', (e.target as HTMLInputElement).value)} placeholder="tuberosa" />
          </div>
          <div class="form-row">
            <label htmlFor="start-cwd">Working directory</label>
            <input id="start-cwd" value={form.cwd} onInput={(e) => update('cwd', (e.target as HTMLInputElement).value)} placeholder="/home/nash/tuberosa" />
          </div>
        </div>
        <button class="advanced-toggle" type="button" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>
          <ChevronDown size={16} aria-hidden="true" /> Advanced signals
        </button>
        {advancedOpen && (
          <div class="advanced-panel" data-testid="start-advanced">
            <div class="form-grid">
              <div class="form-row">
                <label htmlFor="start-task-type">Task type</label>
                <select id="start-task-type" value={form.taskType} onChange={(e) => update('taskType', (e.target as HTMLSelectElement).value)}>
                  <option value="">auto</option>
                  <option value="implementation">implementation</option>
                  <option value="debugging">debugging</option>
                  <option value="refactor">refactor</option>
                  <option value="review">review</option>
                  <option value="testing">testing</option>
                  <option value="planning">planning</option>
                </select>
              </div>
              <div class="form-row">
                <label htmlFor="start-context-mode">Context mode</label>
                <select id="start-context-mode" value={form.contextMode} onChange={(e) => update('contextMode', (e.target as HTMLSelectElement).value as WorkbenchStartForm['contextMode'])}>
                  <option value="compact">compact</option>
                  <option value="layered">layered</option>
                </select>
              </div>
              <SignalInput id="start-files" label="Files" value={form.files} onInput={(value) => update('files', value)} />
              <SignalInput id="start-symbols" label="Symbols" value={form.symbols} onInput={(value) => update('symbols', value)} />
              <SignalInput id="start-errors" label="Errors" value={form.errors} onInput={(value) => update('errors', value)} />
            </div>
          </div>
        )}
        <div class="form-actions">
          <button class="primary icon-button" type="submit" disabled={busy} data-testid="map-context">
            <PlayCircle size={16} aria-hidden="true" /> {busy ? 'Mapping...' : 'Map context'}
          </button>
        </div>
      </form>
    </section>
  );
}

function SignalInput({ id, label, value, onInput }: { id: string; label: string; value: string; onInput: (value: string) => void }) {
  return (
    <div class="form-row">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onInput={(e) => onInput((e.target as HTMLInputElement).value)} placeholder="comma or newline separated" />
    </div>
  );
}

function splitList(value: string): string[] | undefined {
  const items = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}
```

- [x] **Step 7: Wire Start view into App**

In `src/workbench/app.tsx`, import `StartView`, `ReadinessStrip`, and `AgentSessionStartResult`. Add state:

```ts
const [activeSession, setActiveSession] = useState<AgentSessionStartResult | null>(null);
```

Render `ReadinessStrip` above the route content:

```tsx
<ReadinessStrip summary={summaryVM} apiKeySet={Boolean(apiKey)} loading={loading} />
```

Replace the placeholder for the `start` route with:

```tsx
{route.view === 'start' && (
  <StartView
    defaultProject={project}
    onSessionStarted={setActiveSession}
  />
)}
{route.view !== 'start' && (
  <div class="panel" data-testid={`${route.view}-view`}>
    <h1>{route.view}</h1>
    <p class="muted">This surface will be migrated in the next tasks.</p>
    {activeSession && <span hidden data-testid="active-session-id">{activeSession.session.id}</span>}
  </div>
)}
```

- [x] **Step 8: Run the updated browser test and verify pass for Start**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build:workbench
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/browser/workbench-browser.test.ts
```

Expected: the boot/Start assertions PASS. Later old assertions may fail until subsequent tasks replace them; if so, mark the old assertions for replacement in the next browser-test task rather than reverting the Start behavior.

- [x] **Step 9: Commit Task 4**

```bash
git add src/workbench/app.tsx src/workbench/types.ts src/workbench/components/ReadinessStrip.tsx src/workbench/views/StartView.tsx test/browser/workbench-browser.test.ts
git commit -m "feat(workbench): add guided start flow"
```

---

### Task 5: Session Result Views And Visualizations

**Files:**
- Create: `src/workbench/components/VerdictBand.tsx`
- Create: `src/workbench/components/PipelineRail.tsx`
- Create: `src/workbench/components/EvidenceGraph.tsx`
- Create: `src/workbench/components/ContextStack.tsx`
- Create: `src/workbench/components/AgentHandoff.tsx`
- Create: `src/workbench/views/SessionResultView.tsx`
- Modify: `src/workbench/app.tsx`
- Modify: `test/browser/workbench-browser.test.ts`

- [x] **Step 1: Run impact analysis for `App`**

Run:

```text
gitnexus_impact(repo="tuberosa", target="App", file_path="src/workbench/app.tsx", direction="upstream")
```

Expected: direct workbench flow only.

- [x] **Step 2: Update browser test for session result**

Replace the old "Start a session" block in `test/browser/workbench-browser.test.ts` with:

```ts
await page.locator('[data-testid="start-prompt"]').fill(
  'Implement browser verification for src/http/workbench.ts WorkbenchSummary and verification commands.',
);
await page.locator('#start-project').fill(project);
await page.locator('#start-cwd').fill('/home/nash/tuberosa');
await page.locator('[data-testid="map-context"]').click();
await page.locator('[data-testid="session-result-view"]').waitFor();

const resultText = await page.locator('[data-testid="session-result-view"]').textContent();
ok(resultText?.includes('Context'), 'session result renders context verdict');
ok(resultText?.includes('Pipeline'), 'session result renders pipeline');
ok(resultText?.includes('Evidence graph'), 'session result renders evidence graph');
ok(resultText?.includes('Agent handoff'), 'session result renders agent handoff');
await page.locator('[data-testid="context-stack-essential"]').waitFor();
```

- [x] **Step 3: Run browser test and verify failure**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build:workbench
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/browser/workbench-browser.test.ts
```

Expected: FAIL because `session-result-view` does not render yet.

- [x] **Step 4: Create visual components**

Create `src/workbench/components/VerdictBand.tsx`:

```tsx
import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-preact';
import type { SessionVerdictView } from '../types.js';
import { Pill } from './Pill.js';

export function VerdictBand({ verdict }: { verdict: SessionVerdictView }) {
  const Icon = verdict.status === 'ready' ? CheckCircle2 : verdict.status === 'insufficient' ? AlertTriangle : HelpCircle;
  return (
    <section class={`verdict-band ${verdict.status}`} data-testid="verdict-band">
      <Icon size={22} aria-hidden="true" />
      <div>
        <h1>{verdict.headline}</h1>
        <p>{verdict.detail}</p>
      </div>
      <Pill kind={verdict.status === 'ready' ? 'good' : verdict.status === 'insufficient' ? 'bad' : 'warn'}>
        {verdict.policyAction}
      </Pill>
    </section>
  );
}
```

Create `src/workbench/components/PipelineRail.tsx`:

```tsx
import type { PipelineStageView } from '../types.js';

export function PipelineRail({ stages }: { stages: PipelineStageView[] }) {
  return (
    <section class="visual-panel" data-testid="pipeline-rail">
      <div class="section-heading">
        <h2>Pipeline</h2>
        <p class="muted small">How Tuberosa turned the task into a context decision.</p>
      </div>
      <ol class="pipeline-rail">
        {stages.map((stage, index) => (
          <li class={stage.status} key={stage.key}>
            <span class="pipeline-index">{index + 1}</span>
            <strong>{stage.label}</strong>
            <span>{stage.detail}</span>
            {stage.count !== undefined && <em>{stage.count}</em>}
          </li>
        ))}
      </ol>
    </section>
  );
}
```

Create `src/workbench/components/EvidenceGraph.tsx`:

```tsx
import { useMemo, useState } from 'preact/hooks';
import type { EvidenceGraphNode, EvidenceGraphView } from '../types.js';
import { DetailPanel } from './DetailPanel.js';

export function EvidenceGraph({ graph }: { graph: EvidenceGraphView }) {
  const [selected, setSelected] = useState<EvidenceGraphNode | null>(null);
  const layout = useMemo(() => layoutGraph(graph.nodes), [graph.nodes]);
  return (
    <section class="visual-panel evidence-graph-panel" data-testid="evidence-graph">
      <div class="section-heading">
        <h2>Evidence graph</h2>
        <p class="muted small">Prompt, context pack, knowledge, files, and symbols that shaped this result.</p>
      </div>
      <div class="graph-wrap">
        <svg viewBox="0 0 720 360" role="img" aria-label="Evidence graph">
          {graph.edges.map((edge) => {
            const from = layout.get(edge.from);
            const to = layout.get(edge.to);
            if (!from || !to) return null;
            return <line key={edge.id} class={`graph-edge ${edge.tone}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
          })}
          {graph.nodes.map((node) => {
            const point = layout.get(node.id);
            if (!point) return null;
            return (
              <g key={node.id} class={`graph-node ${node.tone}`} onClick={() => setSelected(node)} tabIndex={0}>
                <circle cx={point.x} cy={point.y} r={node.kind === 'task' || node.kind === 'pack' ? 28 : 22} />
                <text x={point.x} y={point.y + 42}>{shortLabel(node.label)}</text>
              </g>
            );
          })}
        </svg>
        <ul class="graph-list" aria-label="Evidence graph fallback list">
          {graph.nodes.map((node) => <li key={node.id}><strong>{node.label}</strong><span>{node.kind}</span></li>)}
        </ul>
      </div>
      <DetailPanel title={selected?.label ?? 'Evidence detail'} open={Boolean(selected)} onClose={() => setSelected(null)}>
        {selected && <p>{selected.detail ?? selected.kind}</p>}
      </DetailPanel>
    </section>
  );
}

function layoutGraph(nodes: EvidenceGraphNode[]): Map<string, { x: number; y: number }> {
  const points = new Map<string, { x: number; y: number }>();
  const centerX = 360;
  const centerY = 180;
  const outer = nodes.filter((node) => node.kind !== 'task' && node.kind !== 'pack');
  points.set('task', { x: 250, y: centerY });
  const pack = nodes.find((node) => node.kind === 'pack');
  if (pack) points.set(pack.id, { x: 470, y: centerY });
  outer.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(outer.length, 1) - Math.PI / 2;
    points.set(node.id, { x: centerX + Math.cos(angle) * 270, y: centerY + Math.sin(angle) * 125 });
  });
  return points;
}

function shortLabel(label: string): string {
  return label.length > 22 ? `${label.slice(0, 19)}...` : label;
}
```

Create `src/workbench/components/DetailPanel.tsx`:

```tsx
import type { ComponentChildren } from 'preact';
import { X } from 'lucide-preact';

export function DetailPanel({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ComponentChildren }) {
  if (!open) return null;
  return (
    <aside class="detail-panel" data-testid="detail-panel">
      <div class="row between">
        <h3>{title}</h3>
        <button class="icon-only" onClick={onClose} aria-label="Close detail"><X size={16} aria-hidden="true" /></button>
      </div>
      {children}
    </aside>
  );
}
```

Create `src/workbench/components/ContextStack.tsx`:

```tsx
import type { ContextStackItemView, ContextStackView } from '../types.js';
import { Pill } from './Pill.js';

export function ContextStack({ stack }: { stack: ContextStackView }) {
  return (
    <section class="visual-panel" data-testid="context-stack">
      <div class="section-heading">
        <h2>Context stack</h2>
        <p class="muted small">Readable fallback for the graph: essential, supporting, and optional evidence.</p>
      </div>
      <div class="context-stack-grid">
        <StackColumn title="Essential" testid="context-stack-essential" items={stack.essential} />
        <StackColumn title="Supporting" testid="context-stack-supporting" items={stack.supporting} />
        <StackColumn title="Optional" testid="context-stack-optional" items={stack.optional} />
      </div>
    </section>
  );
}

function StackColumn({ title, testid, items }: { title: string; testid: string; items: ContextStackItemView[] }) {
  return (
    <div class="stack-column" data-testid={testid}>
      <h3>{title}</h3>
      {items.length === 0 ? <p class="muted small">No items.</p> : items.map((item) => (
        <article class="context-item" key={item.knowledgeId}>
          <div class="row between">
            <strong>{item.title}</strong>
            <Pill kind={item.evidenceStrength === 'strong' ? 'good' : item.evidenceStrength === 'moderate' ? 'warn' : 'muted'}>{item.evidenceStrength}</Pill>
          </div>
          <p class="small muted">{item.summary}</p>
          {item.why && <p class="small">{item.why}</p>}
        </article>
      ))}
    </div>
  );
}
```

Create `src/workbench/components/AgentHandoff.tsx`:

```tsx
import { Clipboard } from 'lucide-preact';
import type { AgentHandoffView } from '../types.js';
import { pushToast } from '../state/store.js';

export function AgentHandoff({ handoff }: { handoff: AgentHandoffView }) {
  async function copy() {
    await navigator.clipboard.writeText(handoff.text);
    pushToast('Agent handoff copied.', 'good');
  }
  return (
    <section class="visual-panel" data-testid="agent-handoff">
      <div class="section-heading row between">
        <div>
          <h2>Agent handoff</h2>
          <p class="muted small">Copy this into Codex, Claude, Cursor, or another agent when you want a clean handoff.</p>
        </div>
        <button class="icon-button" onClick={copy}><Clipboard size={16} aria-hidden="true" /> Copy</button>
      </div>
      <pre><code>{handoff.text}</code></pre>
    </section>
  );
}
```

- [x] **Step 5: Create session result view**

Create `src/workbench/views/SessionResultView.tsx`:

```tsx
import type { AgentSessionStartResult, SessionResultViewModel } from '../types.js';
import { presentSessionResult } from '../presenters/sessionResultPresenter.js';
import { VerdictBand } from '../components/VerdictBand.js';
import { PipelineRail } from '../components/PipelineRail.js';
import { EvidenceGraph } from '../components/EvidenceGraph.js';
import { ContextStack } from '../components/ContextStack.js';
import { AgentHandoff } from '../components/AgentHandoff.js';

interface Props {
  result: AgentSessionStartResult;
}

export function SessionResultView({ result }: Props) {
  const view: SessionResultViewModel = presentSessionResult(result);
  return (
    <section class="session-result-view" data-testid="session-result-view">
      <VerdictBand verdict={view.verdict} />
      <div class="session-visual-grid">
        <PipelineRail stages={view.pipeline} />
        <EvidenceGraph graph={view.graph} />
      </div>
      <ContextStack stack={view.contextStack} />
      <AgentHandoff handoff={view.handoff} />
    </section>
  );
}
```

- [x] **Step 6: Wire session result into App**

In `src/workbench/app.tsx`, import `SessionResultView` and render it when `route.view === 'session'` and `activeSession` exists:

```tsx
{route.view === 'session' && activeSession && <SessionResultView result={activeSession} />}
{route.view === 'session' && !activeSession && (
  <div class="panel" data-testid="session-result-missing">
    <h1>Session not loaded</h1>
    <p class="muted">Open this session from the Sessions list or map a new task from Start.</p>
  </div>
)}
```

- [x] **Step 7: Run presenter and browser checks**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/workbench-session-result-presenter.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build:workbench
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/browser/workbench-browser.test.ts
```

Expected: session presenter PASS; browser session result assertions PASS.

- [x] **Step 8: Commit Task 5**

```bash
git add src/workbench/app.tsx src/workbench/components/VerdictBand.tsx src/workbench/components/PipelineRail.tsx src/workbench/components/EvidenceGraph.tsx src/workbench/components/DetailPanel.tsx src/workbench/components/ContextStack.tsx src/workbench/components/AgentHandoff.tsx src/workbench/views/SessionResultView.tsx test/browser/workbench-browser.test.ts
git commit -m "feat(workbench): render session result visualizations"
```

---

### Task 6: Session Decisions, Finish, Missing Context, And Retry

**Files:**
- Create: `src/workbench/components/SessionActions.tsx`
- Create: `src/workbench/components/MissingContextPanel.tsx`
- Modify: `src/workbench/views/SessionResultView.tsx`
- Modify: `src/workbench/app.tsx`
- Modify: `test/browser/workbench-browser.test.ts`

- [x] **Step 1: Update browser test for session actions**

Add after the session result assertions:

```ts
await page.locator('[data-testid="decision-panel"]').waitFor();
await page.locator('#decision-type').selectOption('selected_but_noisy');
await page.locator('#decision-reason').fill('Browser smoke selected noisy context');
await page.locator('[data-testid="record-decision"]').click();
await page.locator('[data-testid="decision-recorded"]').waitFor();

await page.locator('#finish-summary').fill('Browser smoke finished the workbench session.');
await page.locator('[data-testid="finish-session"]').click();
await page.locator('[data-testid="finish-result"]').waitFor();
```

- [x] **Step 2: Run browser test and verify failure**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build:workbench
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/browser/workbench-browser.test.ts
```

Expected: FAIL because the decision panel does not render yet.

- [x] **Step 3: Create session action component**

Create `src/workbench/components/SessionActions.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { api } from '../state/api.js';
import { pushToast } from '../state/store.js';
import type { ContextDecisionResult, FinishSessionResult } from '../types.js';
import { Pill } from './Pill.js';

interface Props {
  sessionId: string;
  onChanged: () => void;
}

export function SessionActions({ sessionId, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState('selected');
  const [reason, setReason] = useState('');
  const [decisionResult, setDecisionResult] = useState<ContextDecisionResult | null>(null);
  const [outcome, setOutcome] = useState('completed');
  const [summary, setSummary] = useState('');
  const [finishResult, setFinishResult] = useState<FinishSessionResult | null>(null);

  async function recordDecision() {
    setBusy(true);
    try {
      const result = await api<ContextDecisionResult>(`/agent-sessions/${sessionId}/context-decision`, {
        method: 'POST',
        body: { feedbackType: decision, reason: reason || undefined },
      });
      setDecisionResult(result);
      pushToast('Context decision recorded.', 'good');
      onChanged();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function finishSession() {
    setBusy(true);
    try {
      const result = await api<FinishSessionResult>(`/agent-sessions/${sessionId}/finish`, {
        method: 'POST',
        body: { outcome, summary: summary || undefined },
      });
      setFinishResult(result);
      pushToast('Session finished.', 'good');
      onChanged();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="session-actions">
      <div class="panel" data-testid="decision-panel">
        <h2>Record decision</h2>
        <p class="muted small">Tell Tuberosa whether this context helped so future retrieval can improve.</p>
        <div class="form-grid">
          <div class="form-row">
            <label htmlFor="decision-type">Decision</label>
            <select id="decision-type" value={decision} onChange={(e) => setDecision((e.target as HTMLSelectElement).value)}>
              <option value="selected">selected</option>
              <option value="selected_but_noisy">selected_but_noisy</option>
              <option value="rejected">rejected</option>
              <option value="stale">stale</option>
              <option value="irrelevant">irrelevant</option>
              <option value="missing_context">missing_context</option>
            </select>
          </div>
          <div class="form-row">
            <label htmlFor="decision-reason">Reason</label>
            <input id="decision-reason" value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <button class="primary" disabled={busy} onClick={recordDecision} data-testid="record-decision">{busy ? 'Working...' : 'Record decision'}</button>
        {decisionResult && <p class="small good-line" data-testid="decision-recorded">Recorded <Pill kind="good">{decisionResult.decision.decision}</Pill></p>}
      </div>

      <div class="panel" data-testid="finish-panel">
        <h2>Finish session</h2>
        <div class="form-grid">
          <div class="form-row">
            <label htmlFor="finish-outcome">Outcome</label>
            <select id="finish-outcome" value={outcome} onChange={(e) => setOutcome((e.target as HTMLSelectElement).value)}>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
              <option value="blocked">blocked</option>
              <option value="cancelled">cancelled</option>
            </select>
          </div>
          <div class="form-row">
            <label htmlFor="finish-summary">Summary</label>
            <textarea id="finish-summary" value={summary} onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)} />
          </div>
        </div>
        <button class="primary" disabled={busy} onClick={finishSession} data-testid="finish-session">{busy ? 'Working...' : 'Finish session'}</button>
        {finishResult && (
          <div class="finish-result" data-testid="finish-result">
            <Pill kind="good">{finishResult.session.status}</Pill>
            <Pill kind={finishResult.compliance.status === 'compliant' ? 'good' : 'warn'}>compliance: {finishResult.compliance.status}</Pill>
            {finishResult.learningDecision && <Pill kind="accent">learning: {finishResult.learningDecision.status}</Pill>}
            <p class="small muted">{finishResult.compliance.instruction}</p>
          </div>
        )}
      </div>
    </section>
  );
}
```

- [x] **Step 4: Create missing context panel**

Create `src/workbench/components/MissingContextPanel.tsx`:

```tsx
import { useState } from 'preact/hooks';
import { api } from '../state/api.js';
import { pushToast } from '../state/store.js';
import type { MissingSignalGroups, WorkbenchIngestFilesRequest } from '../types.js';

interface Props {
  project: string;
  missing: MissingSignalGroups;
  onIngested: () => void;
}

export function MissingContextPanel({ project, missing, onIngested }: Props) {
  const [path, setPath] = useState(missing.files[0] ?? '');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const missingCount = Object.values(missing).reduce((sum, items) => sum + items.length, 0);
  if (missingCount === 0) return null;

  async function ingest() {
    if (!project || !path.trim() || !content.trim()) {
      pushToast('Project, path, and content are required to ingest missing context.', 'bad');
      return;
    }
    setBusy(true);
    try {
      const body: WorkbenchIngestFilesRequest = {
        project,
        files: [{ path: path.trim(), content: content.trim(), itemType: 'wiki', mode: 'document' }],
        mode: 'document',
      };
      await api('/ingest/files', { method: 'POST', body });
      pushToast('Missing context ingested. Retry the task to re-map context.', 'good');
      onIngested();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="panel missing-context" data-testid="missing-context-panel">
      <h2>Missing context</h2>
      <p class="muted small">Tuberosa can retry the same task after you add the missing project knowledge.</p>
      <div class="missing-grid">
        {Object.entries(missing).map(([kind, values]) => values.length > 0 && (
          <div key={kind}>
            <strong>{kind}</strong>
            <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>
          </div>
        ))}
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label htmlFor="missing-path">Path</label>
          <input id="missing-path" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
        </div>
        <div class="form-row">
          <label htmlFor="missing-content">Content</label>
          <textarea id="missing-content" value={content} onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)} />
        </div>
      </div>
      <button class="primary" disabled={busy} onClick={ingest} data-testid="ingest-missing-context">{busy ? 'Ingesting...' : 'Ingest missing context'}</button>
    </section>
  );
}
```

- [x] **Step 5: Wire actions into SessionResultView**

Modify `src/workbench/views/SessionResultView.tsx` to accept `onChanged` and render actions:

```tsx
import { AgentHandoff } from '../components/AgentHandoff.js';
import { MissingContextPanel } from '../components/MissingContextPanel.js';
import { SessionActions } from '../components/SessionActions.js';

interface Props {
  result: AgentSessionStartResult;
  onChanged: () => void;
}

// inside return after AgentHandoff:
<MissingContextPanel project={view.project ?? ''} missing={view.missingSignals} onIngested={onChanged} />
<SessionActions sessionId={view.sessionId} onChanged={onChanged} />
```

Update the `App` render call:

```tsx
<SessionResultView result={activeSession} onChanged={refresh} />
```

- [x] **Step 6: Run browser test and verify pass**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build:workbench
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/browser/workbench-browser.test.ts
```

Expected: browser test reaches `decision-recorded` and `finish-result`.

- [x] **Step 7: Commit Task 6**

```bash
git add src/workbench/app.tsx src/workbench/views/SessionResultView.tsx src/workbench/components/SessionActions.tsx src/workbench/components/MissingContextPanel.tsx test/browser/workbench-browser.test.ts
git commit -m "feat(workbench): add session decision and finish flow"
```

---

### Task 7: Unified Review Workspace

**Files:**
- Create: `src/workbench/components/DecisionCard.tsx`
- Create: `src/workbench/views/ReviewView.tsx`
- Modify: `src/workbench/app.tsx`
- Modify: `test/browser/workbench-browser.test.ts`

- [x] **Step 1: Update browser test for Review**

Replace old memory/quality tab checks with:

```ts
await page.locator('[data-testid="nav-review"]').click();
await page.locator('[data-testid="review-view"]').waitFor();
const reviewText = await page.locator('[data-testid="review-view"]').textContent();
ok(reviewText?.includes('Decision queue'), 'review view renders a unified decision queue');
ok(reviewText?.includes('Context-quality feedback') || reviewText?.includes('Review feedback'), 'review queue includes context quality work');
await page.locator('[data-testid="review-filter-gaps"]').click();
await page.locator('[data-testid="review-queue"]').waitFor();
```

- [x] **Step 2: Run browser test and verify failure**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build:workbench
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/browser/workbench-browser.test.ts
```

Expected: FAIL because `review-view` does not render yet.

- [x] **Step 3: Create DecisionCard**

Create `src/workbench/components/DecisionCard.tsx`:

```tsx
import type { ReviewQueueItemView } from '../types.js';
import { Pill } from './Pill.js';

export function DecisionCard({ item }: { item: ReviewQueueItemView }) {
  return (
    <article class={`decision-card ${item.tone}`} data-testid={`decision-card-${item.type}`}>
      <div class="card-header">
        <div>
          <Pill kind={pillKind(item.tone)}>P{item.priority}</Pill>
          <h3>{item.title}</h3>
        </div>
        <Pill kind="muted">{item.type}</Pill>
      </div>
      <p>{item.summary}</p>
      <p class="small muted"><strong>Why it matters:</strong> {item.whyItMatters}</p>
      {item.evidence.length > 0 && (
        <ul class="evidence-list">
          {item.evidence.slice(0, 5).map((entry) => <li key={entry}>{entry}</li>)}
        </ul>
      )}
      <div class="queue-actions">
        <button class="primary">{item.primaryAction}</button>
        {item.secondaryActions.slice(0, 3).map((action) => <button key={action}>{action}</button>)}
      </div>
    </article>
  );
}

function pillKind(tone: ReviewQueueItemView['tone']): 'good' | 'warn' | 'bad' | 'accent' | 'muted' {
  if (tone === 'good') return 'good';
  if (tone === 'warn') return 'warn';
  if (tone === 'bad') return 'bad';
  if (tone === 'accent') return 'accent';
  return 'muted';
}
```

- [x] **Step 4: Create Review view**

Create `src/workbench/views/ReviewView.tsx`:

```tsx
import type { ReviewQueueFilter, WorkbenchSummary } from '../types.js';
import { presentReviewQueue } from '../presenters/reviewQueuePresenter.js';
import { navigate } from '../state/store.js';
import { DecisionCard } from '../components/DecisionCard.js';
import { EmptyState } from '../components/EmptyState.js';

interface Props {
  summary: WorkbenchSummary | null;
  filter?: ReviewQueueFilter;
}

export function ReviewView({ summary, filter = 'all' }: Props) {
  if (!summary) {
    return <section class="panel" data-testid="review-view"><h1>Decision queue</h1><p class="muted">Loading review work...</p></section>;
  }
  const view = presentReviewQueue(summary, filter);
  return (
    <section class="review-view" data-testid="review-view">
      <div class="section-heading">
        <p class="eyebrow">Review</p>
        <h1>Decision queue</h1>
        <p class="muted">One prioritized place for drafts, context feedback, gaps, proposals, conflicts, risky memories, errors, and maintenance.</p>
      </div>
      <nav class="filter-strip" aria-label="Review filters">
        {view.filters.map((entry) => (
          <button
            key={entry.key}
            class={entry.key === view.activeFilter ? 'active' : ''}
            data-testid={`review-filter-${entry.key}`}
            onClick={() => navigate({ view: 'review', filter: entry.key })}
          >
            {entry.label} <span>{entry.count}</span>
          </button>
        ))}
      </nav>
      <div class="decision-queue" data-testid="review-queue">
        {view.items.length === 0
          ? <EmptyState title={view.emptyTitle} hint={view.emptyHint} />
          : view.items.map((item) => <DecisionCard item={item} key={`${item.type}-${item.id}`} />)}
      </div>
    </section>
  );
}
```

- [x] **Step 5: Wire Review into App**

In `src/workbench/app.tsx`, import and render:

```tsx
import { ReviewView } from './views/ReviewView.js';
```

```tsx
{route.view === 'review' && <ReviewView summary={summary} filter={route.filter} />}
```

- [x] **Step 6: Run presenter and browser checks**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/workbench-review-presenter.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build:workbench
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/browser/workbench-browser.test.ts
```

Expected: review presenter PASS and browser reaches `review-queue`.

- [x] **Step 7: Commit Task 7**

```bash
git add src/workbench/app.tsx src/workbench/components/DecisionCard.tsx src/workbench/views/ReviewView.tsx test/browser/workbench-browser.test.ts
git commit -m "feat(workbench): add unified review workspace"
```

---

### Task 8: Sessions, Knowledge, Playbooks, And System Surfaces

**Files:**
- Create: `src/workbench/presenters/playbookPresenter.ts`
- Create: `src/workbench/presenters/systemPresenter.ts`
- Create: `src/workbench/views/SessionsView.tsx`
- Create: `src/workbench/views/KnowledgeView.tsx`
- Create: `src/workbench/views/PlaybooksView.tsx`
- Create: `src/workbench/views/SystemView.tsx`
- Modify: `src/workbench/app.tsx`
- Test: `test/workbench-playbooks.test.ts`
- Test: `test/browser/workbench-browser.test.ts`

- [x] **Step 1: Write playbook tests**

Create `test/workbench-playbooks.test.ts`:

```ts
import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { getPlaybook, listPlaybooks } from '../src/workbench/presenters/playbookPresenter.js';

test('playbooks include required user scenarios', () => {
  const playbooks = listPlaybooks();
  deepEqual(playbooks.map((playbook) => playbook.id), [
    'first-task',
    'missing-context',
    'noisy-context',
    'review-memory',
    'debugging',
    'agent-mcp-examples',
    'cli-api-examples',
  ]);
});

test('missing context playbook includes a runnable workbench action', () => {
  const playbook = getPlaybook('missing-context');

  equal(playbook?.id, 'missing-context');
  ok(playbook?.steps.some((step) => step.action?.kind === 'open_start'));
});
```

- [x] **Step 2: Run playbook test and verify failure**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/workbench-playbooks.test.ts
```

Expected: FAIL with a module-not-found error for `playbookPresenter.js`.

- [x] **Step 3: Implement playbook presenter**

Create `src/workbench/presenters/playbookPresenter.ts`:

```ts
export interface PlaybookStep {
  title: string;
  body: string;
  example?: string;
  action?: { kind: 'open_start' | 'open_review' | 'open_system'; label: string };
}

export interface Playbook {
  id: string;
  title: string;
  summary: string;
  steps: PlaybookStep[];
}

const PLAYBOOKS: Playbook[] = [
  {
    id: 'first-task',
    title: 'Run your first task',
    summary: 'Map a real agent task and inspect the context verdict.',
    steps: [
      { title: 'Paste the task', body: 'Use the Start page to describe the work the agent is about to do.', example: 'Fix the build failure in src/retrieval/service.ts', action: { kind: 'open_start', label: 'Open Start' } },
      { title: 'Read the verdict', body: 'Check whether Tuberosa says ready, needs confirmation, or insufficient.' },
      { title: 'Copy the handoff', body: 'Give the handoff to the coding agent before it edits code.' },
    ],
  },
  {
    id: 'missing-context',
    title: 'Fix missing context',
    summary: 'Add missing project knowledge and retry the same task.',
    steps: [
      { title: 'Find the missing signal', body: 'Open the session result and look for files, symbols, docs, or errors under Missing context.' },
      { title: 'Ingest the missing material', body: 'Paste the document or file content into the missing context panel.', action: { kind: 'open_start', label: 'Retry from Start' } },
      { title: 'Retry the task', body: 'Run the same prompt again and compare the verdict.' },
    ],
  },
  {
    id: 'noisy-context',
    title: 'Handle noisy context',
    summary: 'Record selected_but_noisy and use review actions to improve future retrieval.',
    steps: [
      { title: 'Record feedback', body: 'Use selected_but_noisy when useful context appeared with too much unrelated material.' },
      { title: 'Open Review', body: 'Review generated feedback, gaps, or proposals.', action: { kind: 'open_review', label: 'Open Review' } },
    ],
  },
  {
    id: 'review-memory',
    title: 'Review a memory',
    summary: 'Approve, change, or reject lessons before they become trusted memory.',
    steps: [
      { title: 'Open Review', body: 'Filter the decision queue to Drafts.', action: { kind: 'open_review', label: 'Open Review' } },
      { title: 'Check evidence', body: 'Read labels, references, duplicate candidates, and recommendation signals.' },
    ],
  },
  {
    id: 'debugging',
    title: 'Debugging with Tuberosa',
    summary: 'Use errors, files, and symbols as retrieval signals.',
    steps: [
      { title: 'Paste the failure', body: 'Include the exact error and likely file in the Start prompt.' },
      { title: 'Inspect evidence', body: 'Check whether direct error/file evidence outranks generic memory.' },
    ],
  },
  {
    id: 'agent-mcp-examples',
    title: 'Agent/MCP usage examples',
    summary: 'How Codex, Claude, Cursor, or any MCP-aware agent should call Tuberosa.',
    steps: [
      { title: 'Start session', body: 'Call tuberosa_start_session before substantial work.' },
      { title: 'Record decision', body: 'Call tuberosa_record_context_decision before continuing.' },
      { title: 'Finish session', body: 'Call tuberosa_finish_session after meaningful work.' },
    ],
  },
  {
    id: 'cli-api-examples',
    title: 'CLI/API examples',
    summary: 'Terminal and HTTP examples for advanced users.',
    steps: [
      { title: 'Run workbench summary', body: 'Use pnpm run workbench -- --project tuberosa --limit 10.' },
      { title: 'Search context over HTTP', body: 'POST /context/search with prompt, project, files, symbols, and errors.' },
      { title: 'Check system setup', body: 'Use System for store, cache, provider, backup, and API key state.', action: { kind: 'open_system', label: 'Open System' } },
    ],
  },
];

export function listPlaybooks(): Playbook[] {
  return PLAYBOOKS;
}

export function getPlaybook(id: string | undefined): Playbook | undefined {
  if (!id) return PLAYBOOKS[0];
  return PLAYBOOKS.find((playbook) => playbook.id === id);
}
```

- [x] **Step 4: Create simple Sessions, Knowledge, Playbooks, and System views**

Create `src/workbench/views/SessionsView.tsx`:

```tsx
import type { WorkbenchSummary } from '../types.js';
import { navigate } from '../state/store.js';
import { EmptyState } from '../components/EmptyState.js';
import { Pill } from '../components/Pill.js';

export function SessionsView({ summary }: { summary: WorkbenchSummary | null }) {
  const sessions = summary?.recentSessions ?? [];
  return (
    <section class="sessions-view" data-testid="sessions-view">
      <h1>Sessions</h1>
      <p class="muted">Context mapping runs, newest first.</p>
      {sessions.length === 0
        ? <EmptyState title="No sessions yet" hint="Map your first task from Start." />
        : sessions.map((session) => (
          <button class="session-row" key={session.id} onClick={() => navigate({ view: 'session', sessionId: session.id })}>
            <strong>{session.prompt}</strong>
            <Pill kind={session.status === 'active' ? 'warn' : 'good'}>{session.outcome ?? session.status}</Pill>
          </button>
        ))}
    </section>
  );
}
```

Create `src/workbench/views/KnowledgeView.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { api } from '../state/api.js';
import { pushToast } from '../state/store.js';
import type { KnowledgeItem } from '../types.js';
import { EmptyState } from '../components/EmptyState.js';
import { Pill } from '../components/Pill.js';

export function KnowledgeView({ project, limit }: { project: string; limit: number }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<KnowledgeItem[] | null>(null);

  async function load() {
    try {
      setItems(await api<KnowledgeItem[]>('/knowledge', { query: { project: project || undefined, limit, status: 'approved', q: query || undefined } }));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    }
  }

  useEffect(() => { load(); }, [project, limit]);

  return (
    <section class="knowledge-view" data-testid="knowledge-view">
      <h1>Knowledge</h1>
      <p class="muted">Inspect approved knowledge, trust, labels, references, and source.</p>
      <div class="inline-filter">
        <input type="search" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} placeholder="Search title or content" />
        <button onClick={load}>Search</button>
      </div>
      {items === null ? <p class="muted">Loading...</p> : items.length === 0 ? <EmptyState title="No knowledge found" hint="Add project docs or source files." /> : items.map((item) => (
        <article class="knowledge-card" key={item.id}>
          <div class="row between">
            <h3>{item.title}</h3>
            <Pill kind={item.trustLevel >= 80 ? 'good' : item.trustLevel >= 50 ? 'warn' : 'muted'}>trust {item.trustLevel}</Pill>
          </div>
          <p>{item.summary}</p>
          <p class="small muted">{item.itemType} · {item.labels.length} labels · {item.references.length} references</p>
        </article>
      ))}
    </section>
  );
}
```

Create `src/workbench/views/PlaybooksView.tsx`:

```tsx
import { getPlaybook, listPlaybooks } from '../presenters/playbookPresenter.js';
import { navigate } from '../state/store.js';

export function PlaybooksView({ playbookId }: { playbookId?: string }) {
  const playbooks = listPlaybooks();
  const active = getPlaybook(playbookId) ?? playbooks[0];
  return (
    <section class="playbooks-view" data-testid="playbooks-view">
      <div class="section-heading">
        <h1>Playbooks</h1>
        <p class="muted">Learn Tuberosa through practical workflows and examples.</p>
      </div>
      <div class="playbook-layout">
        <nav class="playbook-list">
          {playbooks.map((playbook) => (
            <button class={playbook.id === active.id ? 'active' : ''} key={playbook.id} onClick={() => navigate({ view: 'playbooks', playbookId: playbook.id })}>
              <strong>{playbook.title}</strong>
              <span>{playbook.summary}</span>
            </button>
          ))}
        </nav>
        <article class="playbook-detail">
          <h2>{active.title}</h2>
          <p>{active.summary}</p>
          {active.steps.map((step, index) => (
            <section class="playbook-step" key={step.title}>
              <span>{index + 1}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                {step.example && <pre><code>{step.example}</code></pre>}
                {step.action && <button class="primary" onClick={() => navigate(actionRoute(step.action!.kind))}>{step.action.label}</button>}
              </div>
            </section>
          ))}
        </article>
      </div>
    </section>
  );
}

function actionRoute(kind: 'open_start' | 'open_review' | 'open_system') {
  if (kind === 'open_review') return 'review';
  if (kind === 'open_system') return 'system';
  return 'start';
}
```

Create `src/workbench/presenters/systemPresenter.ts`:

```ts
import type { WorkbenchSummary } from '../types.js';

export interface SystemStatusItem {
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'bad' | 'muted';
}

export function presentSystemStatus(summary: WorkbenchSummary | null): SystemStatusItem[] {
  if (!summary) return [{ label: 'status', value: 'loading', tone: 'muted' }];
  return [
    { label: 'store', value: summary.health.store, tone: summary.health.store === 'postgres' ? 'good' : 'warn' },
    { label: 'cache', value: summary.health.cache, tone: 'muted' },
    { label: 'provider', value: summary.health.modelProvider, tone: 'muted' },
    { label: 'backup', value: summary.health.backupStatus.health, tone: summary.health.backupStatus.health === 'ok' ? 'good' : 'warn' },
    { label: 'backups', value: String(summary.health.backupStatus.backupCount), tone: summary.health.backupStatus.backupCount > 0 ? 'good' : 'warn' },
  ];
}
```

Create `src/workbench/views/SystemView.tsx`:

```tsx
import type { SummaryViewModel } from '../presenters/summaryPresenter.js';
import { presentSystemStatus } from '../presenters/systemPresenter.js';
import type { WorkbenchSummary } from '../types.js';
import { Pill } from '../components/Pill.js';

export function SystemView({ summary, summaryVM }: { summary: WorkbenchSummary | null; summaryVM: SummaryViewModel | null }) {
  const items = presentSystemStatus(summary);
  return (
    <section class="system-view" data-testid="system-view">
      <h1>System</h1>
      <p class="muted">Health, setup, cache, provider, backups, and local operating state.</p>
      {summaryVM && <p class="system-line">{summaryVM.health.line}</p>}
      <div class="system-grid">
        {items.map((item) => (
          <article class="system-card" key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <Pill kind={item.tone}>{item.tone}</Pill>
          </article>
        ))}
      </div>
    </section>
  );
}
```

- [x] **Step 5: Wire new route views into App**

In `src/workbench/app.tsx`, import the new views:

```tsx
import { SessionsView } from './views/SessionsView.js';
import { KnowledgeView } from './views/KnowledgeView.js';
import { PlaybooksView } from './views/PlaybooksView.js';
import { SystemView } from './views/SystemView.js';
```

Render them:

```tsx
{route.view === 'sessions' && <SessionsView summary={summary} />}
{route.view === 'knowledge' && <KnowledgeView project={project} limit={limit} />}
{route.view === 'playbooks' && <PlaybooksView playbookId={route.playbookId} />}
{route.view === 'system' && <SystemView summary={summary} summaryVM={summaryVM} />}
```

- [x] **Step 6: Add browser assertions for Playbooks and System**

Add to `test/browser/workbench-browser.test.ts`:

```ts
await page.locator('[data-testid="nav-playbooks"]').click();
await page.locator('[data-testid="playbooks-view"]').waitFor();
const playbookText = await page.locator('[data-testid="playbooks-view"]').textContent();
ok(playbookText?.includes('Run your first task'), 'playbooks include first-task guide');
ok(playbookText?.includes('Fix missing context'), 'playbooks include missing-context guide');

await page.locator('[data-testid="nav-system"]').click();
await page.locator('[data-testid="system-view"]').waitFor();
const systemText = await page.locator('[data-testid="system-view"]').textContent();
ok(systemText?.includes('store'), 'system view renders store status');
ok(systemText?.includes('provider'), 'system view renders provider status');
```

- [x] **Step 7: Run tests and verify pass**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/workbench-playbooks.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build:workbench
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/browser/workbench-browser.test.ts
```

Expected: playbook tests PASS and browser reaches Playbooks and System.

- [x] **Step 8: Commit Task 8**

```bash
git add src/workbench/app.tsx src/workbench/presenters/playbookPresenter.ts src/workbench/presenters/systemPresenter.ts src/workbench/views/SessionsView.tsx src/workbench/views/KnowledgeView.tsx src/workbench/views/PlaybooksView.tsx src/workbench/views/SystemView.tsx test/workbench-playbooks.test.ts test/browser/workbench-browser.test.ts
git commit -m "feat(workbench): add sessions knowledge playbooks and system views"
```

---

### Task 9: Visual Polish, Responsive CSS, And Old UI Cleanup

**Files:**
- Modify: `src/workbench/styles/main.css`
- Delete old unused view files listed in the File Map after imports are removed.
- Test: `test/browser/workbench-browser.test.ts`

- [x] **Step 1: Update browser overflow assertions**

Keep the existing `verifyNoOverflowAcrossWorkbench(page)` helper and update its route list to cover the new routes:

```ts
for (const route of ['#/start', '#/sessions', '#/review', '#/knowledge', '#/playbooks', '#/system']) {
  await page.goto(`${baseUrl}/workbench${route}`);
  await page.waitForTimeout(100);
  await verifyNoOverflowAcrossWorkbench(page);
}
```

- [x] **Step 2: Run browser test and verify current CSS gaps**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build:workbench
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/browser/workbench-browser.test.ts
```

Expected: FAIL on one or more missing styles or overflow checks before CSS is replaced.

- [x] **Step 3: Replace core CSS layout tokens**

Modify `src/workbench/styles/main.css`. Keep existing base utility classes that still apply, but replace old header/sidebar/tab layout with:

```css
:root {
  color-scheme: light;
  --bg: #f6f5f1;
  --ink: #20231f;
  --muted: #667069;
  --line: #d9ddd5;
  --panel: #ffffff;
  --panel-soft: #f1f3ef;
  --accent: #2563eb;
  --accent-soft: #e8f0ff;
  --good: #166534;
  --good-soft: #e4f4e8;
  --warn: #a16207;
  --warn-soft: #fff5db;
  --bad: #b91c1c;
  --bad-soft: #fde8e8;
  --radius: 8px;
  --radius-sm: 5px;
  --font: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
}

.workbench-topbar {
  min-height: 68px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.92);
  position: sticky;
  top: 0;
  z-index: 20;
}

.brand-lockup,
.primary-nav,
.row,
.form-actions,
.readiness-strip,
.readiness-pills {
  display: flex;
  align-items: center;
}

.brand-lockup { gap: 10px; min-width: 220px; }
.brand-lockup span { display: block; color: var(--muted); font-size: 12px; }
.primary-nav { gap: 4px; overflow-x: auto; }
.primary-nav button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid transparent;
  background: transparent;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  white-space: nowrap;
}
.primary-nav button.active { background: var(--accent-soft); color: var(--accent); border-color: #bfd0ff; }

.workbench-shell {
  width: min(1440px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 20px 0 40px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 20px;
  align-items: start;
}

.workspace { min-width: 0; }
.support-rail { position: sticky; top: 88px; min-width: 0; }
.panel,
.visual-panel,
.start-card,
.decision-card,
.knowledge-card,
.system-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 16px;
  margin-bottom: 16px;
  min-width: 0;
}

.start-view {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(360px, 1.2fr);
  gap: 20px;
  align-items: start;
}

.start-copy h1 {
  max-width: 720px;
  font-size: 34px;
  line-height: 1.12;
  margin: 0 0 12px;
}

.session-visual-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.75fr) minmax(0, 1.25fr);
  gap: 16px;
}

.context-stack-grid,
.system-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.pipeline-rail,
.graph-list,
.evidence-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.pipeline-rail li {
  display: grid;
  grid-template-columns: 28px minmax(80px, 0.4fr) minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}

.pipeline-index {
  width: 24px;
  height: 24px;
  display: inline-grid;
  place-items: center;
  border-radius: 999px;
  background: var(--panel-soft);
  font-size: 12px;
}

.verdict-band {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--panel);
  margin-bottom: 16px;
}
.verdict-band.ready { border-color: #b9d9bf; background: var(--good-soft); }
.verdict-band.needs_confirmation { border-color: #efd082; background: var(--warn-soft); }
.verdict-band.insufficient { border-color: #eca7a7; background: var(--bad-soft); }

.graph-wrap { display: grid; gap: 12px; }
.graph-wrap svg { width: 100%; min-height: 280px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: #fbfcfa; }
.graph-edge { stroke: var(--line); stroke-width: 1.6; }
.graph-edge.good { stroke: var(--good); }
.graph-edge.warn { stroke: var(--warn); }
.graph-edge.bad { stroke: var(--bad); }
.graph-edge.accent { stroke: var(--accent); }
.graph-node { cursor: pointer; }
.graph-node circle { fill: var(--panel); stroke: var(--line); stroke-width: 2; }
.graph-node.good circle { stroke: var(--good); fill: var(--good-soft); }
.graph-node.warn circle { stroke: var(--warn); fill: var(--warn-soft); }
.graph-node.bad circle { stroke: var(--bad); fill: var(--bad-soft); }
.graph-node.accent circle { stroke: var(--accent); fill: var(--accent-soft); }
.graph-node text { text-anchor: middle; font-size: 11px; fill: var(--muted); }

.filter-strip {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  margin-bottom: 14px;
}

.filter-strip button.active { background: var(--accent-soft); color: var(--accent); border-color: #bfd0ff; }
.decision-queue { display: grid; gap: 12px; }

@media (max-width: 980px) {
  .workbench-shell,
  .start-view,
  .session-visual-grid {
    grid-template-columns: 1fr;
  }
  .support-rail {
    position: static;
  }
  .workbench-topbar {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 560px) {
  .workbench-shell {
    width: min(100vw - 20px, 1440px);
  }
  .start-copy h1 {
    font-size: 26px;
  }
  .primary-nav {
    width: 100%;
  }
}
```

- [x] **Step 4: Delete unused old views**

After confirming `rg "OverviewView|CatchupView|SessionView|QualityView|MemoryView|MemoryMaintenanceTab|GuideView|SummarySidebar" src/workbench` returns only the old file paths, remove them:

```bash
git rm src/workbench/views/OverviewView.tsx src/workbench/views/CatchupView.tsx src/workbench/views/SessionView.tsx src/workbench/views/QualityView.tsx src/workbench/views/MemoryView.tsx src/workbench/views/MemoryMaintenanceTab.tsx src/workbench/views/GuideView.tsx src/workbench/views/SummarySidebar.tsx
```

- [x] **Step 5: Run build and browser checks**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:workbench-browser
```

Expected: both PASS.

- [x] **Step 6: Commit Task 9**

```bash
git add src/workbench/styles/main.css test/browser/workbench-browser.test.ts
git add -u src/workbench/views
git commit -m "feat(workbench): polish responsive guided UI"
```

---

### Task 10: Final Presenter Coverage And Full Verification

**Files:**
- Modify: `test/workbench-presenters.test.ts`
- Modify: any new presenter tests from earlier tasks if assertions drift.

- [x] **Step 1: Add an aggregate presenter smoke test**

Append to `test/workbench-presenters.test.ts`:

```ts
test('new workbench presenters support guided shell surfaces', () => {
  const summary = makeSummary();
  const view = presentSummary(summary);

  equal(view.metrics.some((metric) => metric.label === 'Sessions'), true);
  equal(view.recommendedActions.length > 0, true);
  equal(view.queues.pendingDrafts.length, 1);
  equal(view.queues.gaps.length, 1);
  equal(view.queues.errorLogs.length, 1);
});
```

- [x] **Step 2: Run focused presenter tests**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/workbench-routes.test.ts test/workbench-session-result-presenter.test.ts test/workbench-review-presenter.test.ts test/workbench-playbooks.test.ts test/workbench-presenters.test.ts
```

Expected: all listed tests PASS.

- [x] **Step 3: Run full verification**

Run:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:workbench-browser
git diff --check
```

Expected:

- `pnpm run build`: PASS.
- `pnpm test`: PASS.
- `pnpm run test:workbench-browser`: PASS, or SKIP only when Chrome/bundle prerequisite is unavailable in the environment.
- `git diff --check`: no output.

- [x] **Step 4: Run GitNexus change detection before final commit**

Run:

```text
gitnexus_detect_changes(repo="tuberosa", scope="all")
```

Expected: changed symbols and affected processes match the workbench UI, presenter tests, and browser test surfaces. Investigate any unrelated symbol or process before committing.

- [x] **Step 5: Commit Task 10**

```bash
git add test/workbench-presenters.test.ts test/workbench-routes.test.ts test/workbench-session-result-presenter.test.ts test/workbench-review-presenter.test.ts test/workbench-playbooks.test.ts test/browser/workbench-browser.test.ts
git commit -m "test(workbench): cover guided rebuild flows"
```

---

## Final Acceptance Checklist

- [x] `/workbench` opens on `#/start`.
- [x] Start asks for a real agent task and exposes "Map context" as the primary action.
- [x] Mapping a task renders verdict, pipeline, evidence graph, context stack, and agent handoff.
- [x] Context decision recording works.
- [x] Session finishing works.
- [x] Missing context has an ingestion panel and retry guidance.
- [x] Review shows one prioritized mixed decision queue with filters.
- [x] Knowledge search/browse works.
- [x] Playbooks include all required scenarios.
- [x] System shows store/cache/provider/backup readiness.
- [x] Old tab-based workbench views are no longer imported.
- [x] Build, unit tests, browser smoke, diff check, and GitNexus change detection pass.

## Notes For Execution

- Do not add backend endpoints in this implementation unless an exact blocker appears. The current API can support the first replacement through frontend presenters and existing endpoints.
- Keep graph implementation native SVG in this plan. A graph dependency can be evaluated after the user can try the guided flow.
- Do not change retrieval ranking, context-pack assembly, MCP behavior, or storage semantics.
- Keep commits small and aligned with tasks.
