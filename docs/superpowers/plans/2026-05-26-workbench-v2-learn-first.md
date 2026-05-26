# Workbench v2 — Learn-first Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the operator-only `/workbench` SPA with a long-scroll, story-driven web app that teaches Tuberosa through 10 animated chapters and lets active users inspect real sessions.

**Architecture:** A new `src/workbench-v2/` Preact + signals SPA mounted at `GET /workbench`. Chapters animate on scroll via Motion One + IntersectionObserver. Cytoscape.js is loaded as a separate chunk for the two graph chapters. Seeded `acme-billing.json` powers chapters 2–7 with zero live data; chapters 9–10 hit existing HTTP endpoints plus one new replay endpoint.

**Tech Stack:** Preact 10, @preact/signals, lucide-preact (existing); Motion One (new), Cytoscape.js + cytoscape-dagre + cytoscape-cose-bilkent (new lazy chunk); esbuild with code-splitting; node:test + playwright-core for tests.

**Reference spec:** `docs/superpowers/specs/2026-05-26-workbench-v2-learn-first-design.md`.

**Endpoint name corrections vs spec shorthand:** the codebase uses `/agent-sessions` (not `/sessions`) and `/reflection-drafts` (not `/reflections`). This plan uses the real paths.

---

## File map (locked before tasks)

**Created:**
- `src/workbench-v2/index.html`
- `src/workbench-v2/app.tsx`
- `src/workbench-v2/shell/{ProgressRail,AutoTour,DemoToggle,Toasts}.tsx`
- `src/workbench-v2/chapters/Ch0{1..9}_*.tsx`, `Ch10_TuneOps.tsx`
- `src/workbench-v2/viz/{PipelineFlow,GraphCanvas,PackTimeline,SignalChips}.tsx`
- `src/workbench-v2/viz/graph-data.ts` (Cytoscape adapter)
- `src/workbench-v2/data/api.ts`
- `src/workbench-v2/data/demo/acme-billing.json`
- `src/workbench-v2/data/fixtures.ts`
- `src/workbench-v2/state/{store,routes,scrollController}.ts`
- `src/workbench-v2/styles/{tokens,main}.css`
- `src/workbench-v2/types.ts`
- `src/operations/session-replay.ts` (read/write replay bundles)
- `src/http/workbench-v2.ts` (HTML + static asset handler, replaces `workbench.ts`)
- `migrations/0NN_agent_session_replays.sql` (NN = next free number)
- `scripts/build-workbench-v2.ts` (replaces `scripts/build-workbench.ts`)
- `test/workbench-v2/demo-fixture.test.ts`
- `test/workbench-v2/{pipeline-vm,signal-chips-vm,pack-timeline-vm,graph-data}.test.ts`
- `test/workbench-v2/session-replay.test.ts`
- `test/browser/workbench-v2-browser.test.ts`

**Modified:**
- `package.json` — add `motion`, `cytoscape`, `cytoscape-dagre`, `cytoscape-cose-bilkent`; replace `build:workbench` script; add `dev:workbench:v2`.
- `src/http/server.ts` — swap import from `./workbench.js` → `./workbench-v2.js`; mount new replay endpoint.
- `src/agent-session/service.ts` — call session-replay writer on finish when flag is on.
- `src/config.ts` — add `persistReplay: boolean` driven by `TUBEROSA_PERSIST_REPLAY`.
- `migrations/_meta.ts` or migration runner index — register the new migration.

**Deleted (one commit at the very end):**
- `src/workbench/` (entire directory)
- `src/http/workbench.ts`
- `test/browser/workbench-browser.test.ts`
- `scripts/build-workbench.ts`

---

## Conventions used throughout the plan

- **TDD:** every code-bearing task starts with a red test, then implementation, then green. UI components are tested via view-model functions (pure TS) + one playwright smoke test that exercises the whole shell end-to-end.
- **Commits:** small, one per task or sub-task. No `Co-Authored-By: Claude` trailer.
- **Eval guardrail:** after Phase B and again at the end, run `pnpm run eval:retrieval` and `pnpm run eval:agent-context`. They must pass.
- **GitNexus rule:** before modifying any function listed in the file map's *Modified* section, run `gitnexus_impact({target: "<symbol>", direction: "upstream"})` and surface the blast radius. Required by repo CLAUDE.md.

---

## Phase A — Foundations

### Task 1: Add dependencies + scaffold v2 build script

**Files:**
- Modify: `package.json`
- Create: `scripts/build-workbench-v2.ts`
- Create: `src/workbench-v2/index.html`
- Create: `src/workbench-v2/app.tsx` (stub)
- Create: `src/workbench-v2/types.ts` (stub)

- [ ] **Step 1: Add dependencies**

Run:
```bash
pnpm add motion cytoscape cytoscape-dagre cytoscape-cose-bilkent
pnpm add -D @types/cytoscape
```

Verify `package.json` "dependencies" now includes:
```json
"motion": "^10.18.0",
"cytoscape": "^3.30.0",
"cytoscape-dagre": "^2.5.0",
"cytoscape-cose-bilkent": "^4.1.0"
```

- [ ] **Step 2: Replace build script in package.json**

Edit `package.json` "scripts":
```json
"build": "tsc -p tsconfig.json && tsx scripts/build-workbench-v2.ts",
"build:workbench": "tsx scripts/build-workbench-v2.ts",
"dev:workbench": "tsx scripts/build-workbench-v2.ts --watch",
```

(Leave the old `scripts/build-workbench.ts` in place until Task 28 deletes it; the script reference now points at v2.)

- [ ] **Step 3: Write v2 build script with code-splitting**

Create `scripts/build-workbench-v2.ts`:
```ts
import esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src/workbench-v2');
const outDir = join(root, 'dist/workbench');

const watch = process.argv.includes('--watch');

async function run(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const options: esbuild.BuildOptions = {
    entryPoints: [join(srcDir, 'app.tsx')],
    outdir: outDir,
    bundle: true,
    format: 'esm',
    target: ['es2020'],
    platform: 'browser',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    splitting: true,
    minify: !watch,
    sourcemap: true,
    metafile: true,
    loader: { '.css': 'css', '.json': 'json' },
    logLevel: 'info',
  };

  await copyFile(join(srcDir, 'index.html'), join(outDir, 'index.html'));

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[workbench-v2] watching...');
    return;
  }

  const result = await esbuild.build(options);
  console.log('[workbench-v2] bundle written to dist/workbench/');
  if (result.metafile) {
    const total = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
    console.log(`[workbench-v2] total output: ${(total / 1024).toFixed(1)} KB`);
  }
}

run().catch((err) => {
  console.error('[workbench-v2] build failed:', err);
  process.exit(1);
});
```

- [ ] **Step 4: Stub index.html**

Create `src/workbench-v2/index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tuberosa Workbench</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/workbench/static/app.css">
</head>
<body>
  <div id="app"></div>
  <noscript>The Tuberosa Workbench needs JavaScript. Use the HTTP API directly.</noscript>
  <script type="module" src="/workbench/static/app.js"></script>
</body>
</html>
```

- [ ] **Step 5: Stub app.tsx and types.ts**

Create `src/workbench-v2/types.ts`:
```ts
export type ChapterId = 1|2|3|4|5|6|7|8|9|10;
```

Create `src/workbench-v2/app.tsx`:
```tsx
import { render } from 'preact';
function App() { return <main><h1>Tuberosa Workbench v2</h1></main>; }
const root = document.getElementById('app');
if (root) render(<App />, root);
```

- [ ] **Step 6: Verify build runs**

Run: `pnpm run build:workbench`
Expected: prints `[workbench-v2] bundle written to dist/workbench/` and an output size line.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml scripts/build-workbench-v2.ts src/workbench-v2/
git commit -m "scaffold workbench v2 build + entry stubs"
```

---

### Task 2: Hand-curate acme-billing.json seed fixture

**Files:**
- Create: `src/workbench-v2/data/demo/acme-billing.json`
- Create: `src/workbench-v2/data/fixtures.ts`

- [ ] **Step 1: Define fixture schema in fixtures.ts**

Create `src/workbench-v2/data/fixtures.ts`:
```ts
import demo from './demo/acme-billing.json' with { type: 'json' };

export type BranchTag =
  | 'fit:ready' | 'fit:needs_confirmation' | 'fit:insufficient'
  | 'source:labels' | 'source:fts' | 'source:vector' | 'source:memory' | 'source:graph'
  | 'adjust:memory_boost' | 'adjust:stale_penalty' | 'adjust:superseded'
  | 'mode:strict_noise' | 'mode:layered_deep_context'
  | 'classifier:symbols' | 'classifier:errors' | 'classifier:business_areas' | 'classifier:empty';

export interface SeedKnowledgeItem {
  id: string;
  itemType: 'wiki' | 'spec' | 'code_ref' | 'memory';
  title: string;
  content: string;
  sourceUri: string;
  labels: string[];
  references: string[];
  relations?: Array<{ targetId: string; kind: 'depends_on'|'related_to'|'supersedes' }>;
  status?: 'approved' | 'draft' | 'stale' | 'superseded';
}

export interface SeedPrompt {
  id: string;
  text: string;
  branches: BranchTag[];
  taskType?: 'implement'|'debug'|'refactor'|'research'|'review';
}

export interface SeedFixture {
  project: string;
  items: SeedKnowledgeItem[];
  prompts: SeedPrompt[];
}

export const acmeBilling = demo as SeedFixture;
```

- [ ] **Step 2: Write the JSON fixture**

Create `src/workbench-v2/data/demo/acme-billing.json` with this exact shape (truncated content fine, ~30 items + 10 prompts; each prompt must list the branches it claims to exercise):

```json
{
  "project": "acme-billing",
  "items": [
    {
      "id": "k-paywall-modal",
      "itemType": "code_ref",
      "title": "PaywallSelectionModal",
      "content": "PaywallSelectionModal renders the tier picker. Located at src/components/paywall-selection-modal.tsx.",
      "sourceUri": "src/components/paywall-selection-modal.tsx",
      "labels": ["paywall", "ui", "subscription"],
      "references": ["PaywallSelectionModal", "TierPicker"]
    },
    {
      "id": "k-paywall-spec",
      "itemType": "spec",
      "title": "Paywall spec",
      "content": "Tier selection requires legal copy + price formatting...",
      "sourceUri": "docs/paywall.md",
      "labels": ["paywall", "subscription"],
      "references": ["PaywallSelectionModal"],
      "relations": [{ "targetId": "k-paywall-modal", "kind": "related_to" }]
    },
    { "_comment_for_engineer": "...continue with ~28 more items covering: subscription tiers wiki, auth middleware code_ref + 2 dependents, billing webhook spec (long, for deep-context demo), test conventions wiki, vector-dimension-mismatch memory (approved), liveintent-zephyr memory (stale, status: 'stale'), liveintent-zephyr-v2 memory (approved, supersedes the stale one), 'agent missed migration' memory (approved), payment provider pattern docs (3 similar code_refs to force needs_confirmation), 'how to make X faster' has no good matches deliberately. Add `relations` to wire the graph-expansion demo: auth-middleware -> user-service -> worker." }
  ],
  "prompts": [
    { "id": "p1", "text": "Where does paywall logic live?", "branches": ["classifier:symbols", "source:fts", "source:vector", "fit:ready"] },
    { "id": "p2", "text": "Fix the vector dimension mismatch error", "branches": ["classifier:errors", "source:memory", "adjust:memory_boost", "fit:ready"] },
    { "id": "p3", "text": "How do I add a new subscription tier?", "branches": ["source:fts", "source:vector", "fit:ready"] },
    { "id": "p4", "text": "Refactor the auth middleware", "branches": ["classifier:symbols", "source:graph", "fit:ready"] },
    { "id": "p5", "text": "Make it faster", "branches": ["classifier:empty", "fit:insufficient"] },
    { "id": "p6", "text": "Update the LiveIntent ad tags", "branches": ["source:memory", "adjust:stale_penalty", "adjust:superseded", "fit:ready"] },
    { "id": "p7", "text": "Add a new payment provider following existing patterns", "branches": ["mode:strict_noise", "fit:needs_confirmation"] },
    { "id": "p8", "text": "Why did the agent miss the migration step last time?", "branches": ["source:memory", "adjust:memory_boost", "fit:ready"] },
    { "id": "p9", "text": "Read the whole spec for the billing webhook", "branches": ["mode:layered_deep_context", "fit:ready"] },
    { "id": "p10", "text": "What conventions does this project follow for tests?", "branches": ["classifier:business_areas", "source:fts", "fit:ready"] }
  ]
}
```

The engineer fills in the `_comment_for_engineer` items. Each `code_ref` content must include the file path and key symbol name so the lexical+symbol classifier catches it. Memories must have `status: 'approved'` to be retrievable (or `stale`/`superseded` to demonstrate penalty).

- [ ] **Step 3: Commit**

```bash
git add src/workbench-v2/data/
git commit -m "seed acme-billing demo fixture"
```

---

### Task 3: Fixture coverage test (locks the fixture before UI work)

**Files:**
- Create: `test/workbench-v2/demo-fixture.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/workbench-v2/demo-fixture.test.ts`:
```ts
import test from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../../src/storage/memory-store.js';
import { HashModelProvider } from '../../src/model/provider.js';
import { RetrievalService } from '../../src/retrieval/service.js';
import { IngestionService } from '../../src/ingest/service.js';
import { acmeBilling, type BranchTag } from '../../src/workbench-v2/data/fixtures.js';

async function seed(store: MemoryKnowledgeStore, model: HashModelProvider): Promise<void> {
  const ingest = new IngestionService(store, model);
  for (const item of acmeBilling.items) {
    await ingest.upsertKnowledgeItem({
      project: acmeBilling.project,
      sourceType: 'manual',
      sourceUri: item.sourceUri,
      itemType: item.itemType,
      title: item.title,
      content: item.content,
      labels: item.labels,
      references: item.references,
      // memories with explicit status pass through; default 'approved'
      status: item.status ?? (item.itemType === 'memory' ? 'approved' : undefined),
    });
  }
  // Relations
  for (const item of acmeBilling.items) {
    for (const rel of item.relations ?? []) {
      await store.upsertRelation({ sourceId: item.id, targetId: rel.targetId, kind: rel.kind });
    }
  }
}

test('acme-billing fixture exercises every advertised branch', async () => {
  const store = new MemoryKnowledgeStore();
  const model = new HashModelProvider();
  await seed(store, model);
  const retrieval = new RetrievalService(store, model);

  const observed = new Set<BranchTag>();

  for (const prompt of acmeBilling.prompts) {
    const result = await retrieval.searchContext({
      project: acmeBilling.project,
      prompt: prompt.text,
      contextMode: 'layered',
      noiseTolerance: prompt.branches.includes('mode:strict_noise') ? 'strict' : 'lenient',
      includeDeepContext: prompt.branches.includes('mode:layered_deep_context'),
      debug: true,
    });

    // contextFit branches
    observed.add(`fit:${result.contextFit.status}` as BranchTag);

    // source presence — debug bundle carries per-source candidate counts
    for (const src of Object.keys(result.debug?.sourceCandidates ?? {})) {
      if ((result.debug!.sourceCandidates as Record<string, unknown[]>)[src].length > 0) {
        observed.add(`source:${src}` as BranchTag);
      }
    }

    // classifier
    const c = result.classifier;
    if (c.symbols.length) observed.add('classifier:symbols');
    if (c.errors.length) observed.add('classifier:errors');
    if (c.businessAreas.length) observed.add('classifier:business_areas');
    if (!c.symbols.length && !c.errors.length && !c.businessAreas.length && !c.files.length) {
      observed.add('classifier:empty');
    }

    // ranking adjustments — debug bundle carries adjustment reasons
    for (const adj of result.debug?.adjustments ?? []) {
      if (adj.reason === 'memory_boost') observed.add('adjust:memory_boost');
      if (adj.reason === 'stale') observed.add('adjust:stale_penalty');
      if (adj.reason === 'superseded') observed.add('adjust:superseded');
    }

    // modes
    if (prompt.branches.includes('mode:strict_noise')) observed.add('mode:strict_noise');
    if (prompt.branches.includes('mode:layered_deep_context')
        && (result.deepContext?.length ?? 0) > 0) observed.add('mode:layered_deep_context');
  }

  // Every branch any prompt claims must actually show up
  const claimed = new Set<BranchTag>();
  for (const p of acmeBilling.prompts) for (const b of p.branches) claimed.add(b);

  for (const tag of claimed) {
    ok(observed.has(tag), `branch ${tag} was claimed but not observed in retrieval output`);
  }

  // Sanity floor: at least 10 distinct branches exercised
  ok(observed.size >= 10, `expected >=10 branches, observed ${observed.size}: ${[...observed].join(',')}`);
});
```

- [ ] **Step 2: Run and watch it fail loudly**

Run: `node --test --import tsx test/workbench-v2/demo-fixture.test.ts`
Expected: FAIL — the most likely failure is that the JSON's `_comment_for_engineer` placeholder hasn't been replaced with real items yet, so several branches won't appear.

- [ ] **Step 3: Iterate on the JSON until green**

Edit `src/workbench-v2/data/demo/acme-billing.json`, re-run the test. Each branch tag the assertion says is missing tells you what kind of item or relation to add. Keep iterating until green. Do not rewrite the test — fix the fixture.

- [ ] **Step 4: Run the broader retrieval eval to confirm no regression**

Run: `pnpm run eval:retrieval`
Expected: existing eval still passes (this task only adds a fixture; no logic changes).

- [ ] **Step 5: Commit**

```bash
git add test/workbench-v2/demo-fixture.test.ts src/workbench-v2/data/demo/acme-billing.json
git commit -m "lock acme-billing fixture with branch-coverage test"
```

---

## Phase B — Backend: replay endpoint + new HTML handler

### Task 4: Migration — agent_session_replays table

**Files:**
- Create: `migrations/0NN_agent_session_replays.sql` (NN = max(existing) + 1)

- [ ] **Step 1: Identify next migration number**

Run: `ls migrations/ | sort | tail -3`
Expected: existing migrations like `0xx_*.sql`. Pick the next integer.

- [ ] **Step 2: Write the migration**

Create `migrations/0NN_agent_session_replays.sql`:
```sql
CREATE TABLE IF NOT EXISTS agent_session_replays (
  session_id UUID PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  classifier JSONB NOT NULL,
  source_candidates JSONB NOT NULL,
  fusion_order JSONB NOT NULL,
  rerank_deltas JSONB NOT NULL,
  adjustments JSONB NOT NULL,
  context_fit JSONB NOT NULL,
  pack JSONB NOT NULL,
  timings JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_session_replays_recorded_at
  ON agent_session_replays (recorded_at DESC);
```

- [ ] **Step 3: Apply migration locally**

If Postgres is available: `pnpm run migrate`
Expected: prints applied migration NN.

If no Postgres: skip and verify the migration runner picks the file up by listing it on next run.

- [ ] **Step 4: Commit**

```bash
git add migrations/0NN_agent_session_replays.sql
git commit -m "migration: agent_session_replays table"
```

---

### Task 5: session-replay service + opt-in persistence

**Files:**
- Create: `src/operations/session-replay.ts`
- Create: `test/workbench-v2/session-replay.test.ts`
- Modify: `src/config.ts` (add `persistReplay`)
- Modify: `src/agent-session/service.ts` (call writer on finish)

- [ ] **Step 1: Run impact analysis before touching agent-session service**

Run: `gitnexus_impact({target: "AgentSessionService", direction: "upstream"})`
Expected: surfaced blast radius. If HIGH/CRITICAL, surface to the user and pause for approval.

- [ ] **Step 2: Add config flag**

In `src/config.ts`, locate the `AppConfig` interface and the `loadConfig()` function. Add the field and parsing alongside the existing booleans:

```ts
// In AppConfig
persistReplay: boolean;

// In loadConfig()
persistReplay: env.TUBEROSA_PERSIST_REPLAY === 'true',
```

Update the default test config used in `test/browser/workbench-v2-browser.test.ts` (created later) and any other tests that construct `AppConfig` literals to include `persistReplay: false`. Search for `AppConfig = {` to find them — there are 3 currently.

- [ ] **Step 3: Write the failing replay-service test**

Create `test/workbench-v2/session-replay.test.ts`:
```ts
import test from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../../src/storage/memory-store.js';
import { SessionReplayService, type SessionReplayBundle } from '../../src/operations/session-replay.js';

test('writeReplay/readReplay round-trips through memory store', async () => {
  const store = new MemoryKnowledgeStore();
  const svc = new SessionReplayService(store);

  const bundle: SessionReplayBundle = {
    sessionId: '00000000-0000-0000-0000-000000000001',
    classifier: { symbols: ['Foo'], errors: [], files: [], businessAreas: [], technologies: [], taskType: 'implement' },
    sourceCandidates: { fts: [{ id: 'k1', score: 0.8 }], vector: [], labels: [], memory: [], graph: [] },
    fusionOrder: [{ id: 'k1', rank: 1, score: 0.8 }],
    rerankDeltas: [],
    adjustments: [],
    contextFit: { status: 'ready', missingSignals: [] },
    pack: { essential: [{ id: 'k1' }], supporting: [], optional: [] },
    timings: { totalMs: 42, stageMs: {} },
  };

  await svc.writeReplay(bundle);
  const read = await svc.readReplay(bundle.sessionId);
  ok(read);
  deepEqual(read!.fusionOrder, bundle.fusionOrder);
  equal(read!.timings.totalMs, 42);
});

test('readReplay returns null for unknown id', async () => {
  const store = new MemoryKnowledgeStore();
  const svc = new SessionReplayService(store);
  equal(await svc.readReplay('00000000-0000-0000-0000-000000000099'), null);
});
```

Run: `node --test --import tsx test/workbench-v2/session-replay.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 4: Implement the service**

Create `src/operations/session-replay.ts`:
```ts
import type { KnowledgeStore } from '../storage/store.js';
import type { ContextFit } from '../retrieval/context-fit.js';

export interface SessionReplayBundle {
  sessionId: string;
  classifier: Record<string, unknown>;
  sourceCandidates: Record<string, Array<{ id: string; score: number }>>;
  fusionOrder: Array<{ id: string; rank: number; score: number }>;
  rerankDeltas: Array<{ id: string; before: number; after: number }>;
  adjustments: Array<{ id: string; reason: string; delta: number }>;
  contextFit: ContextFit;
  pack: { essential: Array<{ id: string }>; supporting: Array<{ id: string }>; optional: Array<{ id: string }> };
  timings: { totalMs: number; stageMs: Record<string, number> };
}

export class SessionReplayService {
  constructor(private readonly store: KnowledgeStore) {}

  async writeReplay(bundle: SessionReplayBundle): Promise<void> {
    await this.store.writeSessionReplay(bundle);
  }

  async readReplay(sessionId: string): Promise<SessionReplayBundle | null> {
    return this.store.readSessionReplay(sessionId);
  }
}
```

Now extend the `KnowledgeStore` interface and both implementations:

In `src/storage/store.ts`, add to the `KnowledgeStore` interface:
```ts
writeSessionReplay(bundle: import('../operations/session-replay.js').SessionReplayBundle): Promise<void>;
readSessionReplay(sessionId: string): Promise<import('../operations/session-replay.js').SessionReplayBundle | null>;
```

In `src/storage/memory-store.ts`, add a private `Map<string, SessionReplayBundle>` and the two methods.

In `src/storage/postgres-store.ts`, implement against the new table with `INSERT ... ON CONFLICT DO UPDATE` and a single `SELECT` returning the row decoded from JSONB.

Run: `node --test --import tsx test/workbench-v2/session-replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire opt-in write on session finish**

In `src/agent-session/service.ts`, locate `finishSession()`. Where it currently records the learning signal, also (when `config.persistReplay`) build a `SessionReplayBundle` from the last retrieval debug bundle stored on the session and call `SessionReplayService.writeReplay`.

The session already retains the last `tuberosa_search_context` debug output via the existing `learningSignals` plumbing; pluck it from there. If absent, skip write silently.

```ts
// inside finishSession, after the existing learning-signal block
if (this.config.persistReplay && session.lastSearchDebug) {
  await this.replayService.writeReplay({
    sessionId: session.id,
    ...session.lastSearchDebug,
  });
}
```

Wire `SessionReplayService` into the service constructor (in `src/app.ts` where services are composed). Add it to `AppServices`.

- [ ] **Step 6: Commit**

```bash
git add src/operations/session-replay.ts src/config.ts src/storage/ src/agent-session/service.ts src/app.ts test/workbench-v2/session-replay.test.ts
git commit -m "feat(replay): opt-in session replay persistence"
```

---

### Task 6: HTTP endpoint GET /operations/workbench/session/:id/replay

**Files:**
- Modify: `src/http/server.ts`

- [ ] **Step 1: Write the failing HTTP test**

Add this test to `test/workbench-v2/session-replay.test.ts`:
```ts
import { createHttpServer } from '../../src/http/server.js';
import type { AppServices } from '../../src/app.js';
import { createServer } from 'node:http';

test('GET /operations/workbench/session/:id/replay returns 404 for unknown, 200 for known', async () => {
  // construct minimal AppServices using MemoryKnowledgeStore + SessionReplayService
  // (factor a tiny helper above; see existing test/browser/workbench-browser.test.ts seedWorkbenchProject for style)
  const services = await buildTestServices();
  await services.sessionReplay.writeReplay({ sessionId: 'aaa', /* ...minimal bundle... */ } as any);

  const server = createHttpServer(services);
  // ...use the same listen() helper pattern from existing browser test...
  // assert 404 for unknown id, 200 + JSON for known id
});
```

(The engineer can copy the listen/fetch helpers from `test/browser/workbench-browser.test.ts` — do not import them; copy to keep tests self-contained.)

- [ ] **Step 2: Register the route**

In `src/http/server.ts`, after the existing `/operations/workbench/summary` route, add:
```ts
{
  match: pathPattern(/^\/operations\/workbench\/session\/([^/]+)\/replay$/, ['id']),
  method: 'GET',
  handle: async (_req, _res, { params, services }) => {
    const bundle = await services.sessionReplay.readReplay(params.id);
    if (!bundle) return jsonResponse(404, { error: { code: 'not_found', message: 'replay not found' } });
    return jsonResponse(200, bundle);
  },
},
```

(Use the existing `jsonResponse` helper and the same `services` accessor as adjacent routes.)

- [ ] **Step 3: Run the test, then full unit suite**

Run: `node --test --import tsx test/workbench-v2/session-replay.test.ts`
Expected: PASS.

Run: `pnpm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/http/server.ts test/workbench-v2/session-replay.test.ts
git commit -m "feat(http): /operations/workbench/session/:id/replay"
```

---

### Task 7: New static-asset handler (replaces src/http/workbench.ts)

**Files:**
- Create: `src/http/workbench-v2.ts`
- Modify: `src/http/server.ts`

- [ ] **Step 1: Copy + retitle**

Create `src/http/workbench-v2.ts` as a 1:1 port of the existing `src/http/workbench.ts` (read it first), with:
- `bundleRoot` still resolves to `dist/workbench` (same on-disk path; only the source moved).
- `workbenchHtml()` returns the same minimal HTML shell as `src/workbench-v2/index.html`.

The point of this task is not new behavior — it's reseating the imports onto a name that won't clash when we delete the old file at the very end. Do **not** delete `src/http/workbench.ts` yet (Task 28).

- [ ] **Step 2: Switch the server import**

In `src/http/server.ts`:
```ts
// before
import { readWorkbenchAsset, workbenchHtml } from './workbench.js';
// after
import { readWorkbenchAsset, workbenchHtml } from './workbench-v2.js';
```

- [ ] **Step 3: Smoke test the route**

Run: `pnpm run build:workbench && pnpm run dev` (background) then:
```bash
curl -s http://localhost:3027/workbench | head -5
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3027/workbench/static/app.js
```
Expected: `<!doctype html>` and `200`.

- [ ] **Step 4: Commit**

```bash
git add src/http/workbench-v2.ts src/http/server.ts
git commit -m "http: serve workbench v2 bundle"
```

---

## Phase C — Shell

### Task 8: Design tokens + main.css + index.html copy

**Files:**
- Create: `src/workbench-v2/styles/tokens.css`
- Create: `src/workbench-v2/styles/main.css`

- [ ] **Step 1: Write tokens.css**

```css
:root {
  --bg: #0b0d12;
  --bg-elev: #131722;
  --fg: #e7e9ee;
  --fg-muted: #9aa3b2;
  --accent: #6aa6ff;
  --accent-warm: #f6b86b;
  --good: #6ddc8e;
  --bad: #f37070;
  --line: #232838;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --shadow-soft: 0 1px 0 rgba(255,255,255,.04), 0 12px 32px rgba(0,0,0,.35);
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 36px; --space-7: 56px; --space-8: 96px;
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --chapter-gap: var(--space-8);
  --anim-fast: 180ms cubic-bezier(.2,.7,.2,1);
  --anim-med: 360ms cubic-bezier(.2,.7,.2,1);
  --anim-slow: 720ms cubic-bezier(.2,.7,.2,1);
}
@media (prefers-color-scheme: light) {
  :root { --bg: #fbfbfd; --bg-elev: #fff; --fg: #1a1d24; --fg-muted: #4a5060; --line: #e2e6ee; }
}
@media (prefers-reduced-motion: reduce) {
  :root { --anim-fast: 0ms; --anim-med: 0ms; --anim-slow: 0ms; }
}
```

- [ ] **Step 2: Write main.css**

Provides the layout grid (sticky left rail + content column + occasional right detail), chapter rhythm (each `<section.chapter>` reserves `--chapter-gap` vertical margin), shared component utility classes (`.pill`, `.card`, `.kbd`, `.code`), and `@media (prefers-reduced-motion)` overrides that disable transforms.

```css
@import './tokens.css';
html,body { margin:0; padding:0; background:var(--bg); color:var(--fg); font-family:var(--font-sans); }
body { line-height:1.55; }
.workbench-shell { display:grid; grid-template-columns: 64px minmax(0,1fr); gap:0; min-height:100vh; }
.progress-rail { position:sticky; top:0; height:100vh; border-right:1px solid var(--line); padding:var(--space-4) var(--space-2); }
.chapter { padding: var(--space-7) var(--space-6); border-bottom:1px dashed var(--line); scroll-margin-top: var(--space-4); }
.chapter h2 { font-size: clamp(28px, 3.5vw, 44px); margin: 0 0 var(--space-4); line-height:1.1; }
.chapter .lead { font-size: 18px; color: var(--fg-muted); max-width: 70ch; }
.card { background: var(--bg-elev); border:1px solid var(--line); border-radius: var(--radius-md); padding: var(--space-4); box-shadow: var(--shadow-soft); }
.pill { display:inline-flex; align-items:center; gap:var(--space-1); padding: 2px var(--space-2); border-radius:999px; background:rgba(106,166,255,.12); color:var(--accent); font-size:12px; }
.pill[data-tone="warm"]{ background:rgba(246,184,107,.14); color:var(--accent-warm); }
.pill[data-tone="bad"]{ background:rgba(243,112,112,.14); color:var(--bad); }
.code { font-family:var(--font-mono); font-size: 13px; background:rgba(255,255,255,.04); padding:2px 4px; border-radius: var(--radius-sm); }
button.primary { background: var(--accent); color: #0b0d12; border:0; border-radius: var(--radius-sm); padding: var(--space-2) var(--space-4); font-weight:600; cursor:pointer; }
button.ghost { background:transparent; color:var(--fg); border:1px solid var(--line); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-4); cursor:pointer; }
.kbd { font-family:var(--font-mono); border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:1px 6px; font-size:12px; }
.fade-in { animation: fadeIn var(--anim-med) both; }
@keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
@media (prefers-reduced-motion: reduce) {
  .fade-in { animation: none; opacity:1; transform:none; }
  * { scroll-behavior:auto !important; }
}
```

- [ ] **Step 3: Confirm CSS gets bundled**

Run: `pnpm run build:workbench`
Expected: `dist/workbench/app.css` exists.

- [ ] **Step 4: Commit**

```bash
git add src/workbench-v2/styles/
git commit -m "workbench v2: design tokens + base stylesheet"
```

---

### Task 9: state/store.ts + state/routes.ts (hash router)

**Files:**
- Create: `src/workbench-v2/state/store.ts`
- Create: `src/workbench-v2/state/routes.ts`
- Create: `src/workbench-v2/state/scrollController.ts`
- Create: `test/workbench-v2/routes.test.ts`

- [ ] **Step 1: Write the failing route test**

```ts
// test/workbench-v2/routes.test.ts
import test from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { parseHash, routeToHash } from '../../src/workbench-v2/state/routes.js';

test('parseHash', () => {
  deepEqual(parseHash(''), { chapter: 1 });
  deepEqual(parseHash('#/ch5'), { chapter: 5 });
  deepEqual(parseHash('#/ch5/node/abc'), { chapter: 5, graphNodeId: 'abc' });
  deepEqual(parseHash('#/ch9/session/s-1'), { chapter: 9, sessionId: 's-1' });
  deepEqual(parseHash('#/cheese'), { chapter: 1 }); // unknown → home
});
test('routeToHash', () => {
  equal(routeToHash({ chapter: 1 }), '#/ch1');
  equal(routeToHash({ chapter: 5, graphNodeId: 'abc' }), '#/ch5/node/abc');
  equal(routeToHash({ chapter: 9, sessionId: 's-1' }), '#/ch9/session/s-1');
});
```

Run: FAIL — module doesn't exist.

- [ ] **Step 2: Implement routes.ts**

```ts
// src/workbench-v2/state/routes.ts
import type { ChapterId } from '../types.js';
export interface Route { chapter: ChapterId; graphNodeId?: string; sessionId?: string; }
const VALID: ReadonlySet<ChapterId> = new Set([1,2,3,4,5,6,7,8,9,10]);
export function parseHash(hash: string): Route {
  const m = /^#\/ch(\d+)(?:\/(node|session)\/([^/?#]+))?/.exec(hash || '');
  if (!m) return { chapter: 1 };
  const n = Number(m[1]) as ChapterId;
  if (!VALID.has(n)) return { chapter: 1 };
  const kind = m[2];
  const value = m[3] ? decodeURIComponent(m[3]) : undefined;
  if (kind === 'node') return { chapter: n, graphNodeId: value };
  if (kind === 'session') return { chapter: n, sessionId: value };
  return { chapter: n };
}
export function routeToHash(route: Route): string {
  if (route.graphNodeId) return `#/ch${route.chapter}/node/${encodeURIComponent(route.graphNodeId)}`;
  if (route.sessionId) return `#/ch${route.chapter}/session/${encodeURIComponent(route.sessionId)}`;
  return `#/ch${route.chapter}`;
}
```

Run the route test: PASS.

- [ ] **Step 3: Implement store.ts (signals)**

```ts
// src/workbench-v2/state/store.ts
import { signal, computed } from '@preact/signals';
import { parseHash, routeToHash, type Route } from './routes.js';

export const route = signal<Route>(parseHash(typeof window !== 'undefined' ? window.location.hash : ''));
export const demoMode = signal<'seeded'|'live'>('seeded');
export const apiKey = signal<string>(typeof localStorage !== 'undefined' ? localStorage.getItem('tuberosa.v2.apiKey') ?? '' : '');
export const tour = signal<{ playing: boolean; index: number }>({ playing: false, index: 0 });
export const toasts = signal<Array<{ id: number; tone: 'info'|'bad'|'good'; text: string }>>([]);

let toastSeq = 0;
export function pushToast(text: string, tone: 'info'|'bad'|'good' = 'info') {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, tone, text }];
  setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id); }, 4500);
}

export function setRoute(next: Route, replace = false) {
  route.value = next;
  const hash = routeToHash(next);
  if (replace) history.replaceState(null, '', hash); else history.pushState(null, '', hash);
}

export function setApiKey(v: string) {
  apiKey.value = v;
  if (v) localStorage.setItem('tuberosa.v2.apiKey', v); else localStorage.removeItem('tuberosa.v2.apiKey');
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => { route.value = parseHash(window.location.hash); });
}
```

- [ ] **Step 4: Implement scrollController.ts (chapter-in-view tracker)**

```ts
// src/workbench-v2/state/scrollController.ts
import { signal } from '@preact/signals';
import type { ChapterId } from '../types.js';
import { setRoute, route } from './store.js';

export const activeChapter = signal<ChapterId>(1);

export function observeChapter(el: HTMLElement, chapter: ChapterId): () => void {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio > 0.4) {
        activeChapter.value = chapter;
        if (route.value.chapter !== chapter) setRoute({ ...route.value, chapter }, true);
      }
    }
  }, { threshold: [0.4, 0.6] });
  io.observe(el);
  return () => io.disconnect();
}
```

- [ ] **Step 5: Commit**

```bash
git add src/workbench-v2/state/ test/workbench-v2/routes.test.ts
git commit -m "workbench v2: routes + signal store + scroll controller"
```

---

### Task 10: ProgressRail + DemoToggle + Toasts components

**Files:**
- Create: `src/workbench-v2/shell/ProgressRail.tsx`
- Create: `src/workbench-v2/shell/DemoToggle.tsx`
- Create: `src/workbench-v2/shell/Toasts.tsx`

- [ ] **Step 1: ProgressRail.tsx**

```tsx
import { activeChapter } from '../state/scrollController.js';
import { setRoute, route } from '../state/store.js';
import type { ChapterId } from '../types.js';

const TITLES: Record<ChapterId, string> = {
  1:'Hello', 2:'Problem', 3:'Anatomy', 4:'Pipeline', 5:'Graph',
  6:'Reflections', 7:'Try it', 8:'Plug in', 9:'Your sessions', 10:'Tune & operate',
};

export function ProgressRail() {
  const active = activeChapter.value;
  return (
    <nav class="progress-rail" aria-label="Chapters">
      <ol style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">
        {([1,2,3,4,5,6,7,8,9,10] as ChapterId[]).map(n => (
          <li>
            <a href={`#/ch${n}`} onClick={(e) => { e.preventDefault(); setRoute({ ...route.value, chapter: n }); document.getElementById(`ch${n}`)?.scrollIntoView({ behavior: 'smooth' }); }}
               aria-current={active === n ? 'true' : undefined}
               style={`display:block;text-align:center;padding:6px 0;border-radius:6px;color:${active===n?'var(--accent)':'var(--fg-muted)'};font-size:11px;text-decoration:none`}>
              <strong style="display:block;font-size:13px">{n}</strong>
              <span style="display:block;font-size:10px">{TITLES[n]}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
```

- [ ] **Step 2: DemoToggle.tsx**

```tsx
import { demoMode } from '../state/store.js';
export function DemoToggle() {
  const mode = demoMode.value;
  return (
    <div style="display:flex;gap:4px;align-items:center;font-size:12px">
      <span class="pill" data-tone={mode==='seeded'?'':'warm'}>{mode}</span>
      <button class="ghost" style="padding:2px 8px;font-size:11px" onClick={() => demoMode.value = mode==='seeded' ? 'live' : 'seeded'}>
        switch to {mode==='seeded' ? 'live' : 'seeded'}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Toasts.tsx**

```tsx
import { toasts } from '../state/store.js';
export function Toasts() {
  return (
    <div style="position:fixed;bottom:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:50">
      {toasts.value.map(t => (
        <div key={t.id} class="card fade-in" data-tone={t.tone}
             style={`min-width:240px;border-color:var(--${t.tone==='bad'?'bad':t.tone==='good'?'good':'line'})`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/workbench-v2/shell/
git commit -m "workbench v2: progress rail, demo toggle, toasts"
```

---

### Task 11: AutoTour with reduced-motion support

**Files:**
- Create: `src/workbench-v2/shell/AutoTour.tsx`

- [ ] **Step 1: Write AutoTour.tsx**

```tsx
import { tour, setRoute, route } from '../state/store.js';
import type { ChapterId } from '../types.js';

const SCRIPT: Array<{ chapter: ChapterId; caption: string; dwellMs: number }> = [
  { chapter: 1, caption: 'Tuberosa is a context broker for coding agents.', dwellMs: 5000 },
  { chapter: 2, caption: 'Without context, an agent guesses. With Tuberosa, it cites.', dwellMs: 7000 },
  { chapter: 3, caption: 'A single session: prompt in, pack out, in about a second.', dwellMs: 9000 },
  { chapter: 4, caption: 'Ten short stages do the work. Click any to look inside.', dwellMs: 10000 },
  { chapter: 5, caption: 'Knowledge lives in a graph of items and relations.', dwellMs: 8000 },
  { chapter: 6, caption: 'Each session can leave a reviewed lesson behind.', dwellMs: 7000 },
  { chapter: 7, caption: 'Try ten curated prompts to see every branch.', dwellMs: 6000 },
  { chapter: 8, caption: 'Wire your agent in. One snippet per editor.', dwellMs: 6000 },
];

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let timer: number | null = null;
function clear() { if (timer !== null) { clearTimeout(timer); timer = null; } }

function step(i: number) {
  if (i >= SCRIPT.length) { tour.value = { playing: false, index: 0 }; return; }
  const s = SCRIPT[i];
  tour.value = { playing: true, index: i };
  setRoute({ ...route.value, chapter: s.chapter }, true);
  document.getElementById(`ch${s.chapter}`)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
  timer = setTimeout(() => step(i + 1), s.dwellMs) as unknown as number;
}

export function AutoTour() {
  const t = tour.value;
  const caption = t.playing ? SCRIPT[t.index]?.caption : 'Take the guided tour — about a minute.';
  return (
    <div style="position:fixed;top:12px;right:16px;z-index:40;display:flex;gap:8px;align-items:center">
      <span style="max-width:42ch;font-size:12px;color:var(--fg-muted)">{caption}</span>
      {!t.playing
        ? <button class="primary" onClick={() => { clear(); step(0); }}>▶ Tour</button>
        : <>
            <button class="ghost" onClick={() => { clear(); tour.value = { playing: false, index: t.index }; }}>⏸</button>
            <button class="ghost" onClick={() => { clear(); tour.value = { playing: false, index: 0 }; }}>✕</button>
          </>
      }
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/workbench-v2/shell/AutoTour.tsx
git commit -m "workbench v2: auto-tour with reduced-motion fallback"
```

---

### Task 12: data/api.ts fetch wrapper

**Files:**
- Create: `src/workbench-v2/data/api.ts`

- [ ] **Step 1: Implement api.ts**

```ts
import { apiKey, pushToast } from '../state/store.js';
export class ApiError extends Error { constructor(msg: string, public status: number, public code?: string) { super(msg); } }

export async function api<T>(path: string, init: RequestInit & { query?: Record<string, string|number|undefined> } = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = new Headers(init.headers ?? {});
  headers.set('accept', 'application/json');
  if (apiKey.value) headers.set('x-tuberosa-api-key', apiKey.value);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const body = data as { error?: { message?: string; code?: string } } | undefined;
    const message = body?.error?.message ?? `Request failed: ${res.status}`;
    pushToast(message, 'bad');
    throw new ApiError(message, res.status, body?.error?.code);
  }
  return data as T;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/workbench-v2/data/api.ts
git commit -m "workbench v2: api fetch wrapper"
```

---

## Phase D — Visualization primitives

### Task 13: SignalChips component + view-model

**Files:**
- Create: `src/workbench-v2/viz/SignalChips.tsx`
- Create: `test/workbench-v2/signal-chips-vm.test.ts`

- [ ] **Step 1: Write the VM test**

```ts
import test from 'node:test';
import { deepEqual } from 'node:assert/strict';
import { toSignalChips } from '../../src/workbench-v2/viz/SignalChips.js';

test('toSignalChips groups by kind and preserves order', () => {
  const chips = toSignalChips({ symbols: ['Foo','Bar'], errors: ['ENOENT'], files: ['a.ts'], businessAreas: [], technologies: [], taskType: 'implement' });
  deepEqual(chips, [
    { kind: 'task',    label: 'implement' },
    { kind: 'symbol',  label: 'Foo' },
    { kind: 'symbol',  label: 'Bar' },
    { kind: 'file',    label: 'a.ts' },
    { kind: 'error',   label: 'ENOENT' },
  ]);
});
```

Run: FAIL.

- [ ] **Step 2: Implement SignalChips.tsx + view-model**

```tsx
export interface ClassifierLike {
  symbols: string[]; errors: string[]; files: string[];
  businessAreas: string[]; technologies: string[]; taskType?: string;
}
export interface Chip { kind: 'task'|'symbol'|'file'|'error'|'tech'|'area'; label: string; }

export function toSignalChips(c: ClassifierLike): Chip[] {
  const chips: Chip[] = [];
  if (c.taskType) chips.push({ kind: 'task', label: c.taskType });
  c.symbols.forEach(s => chips.push({ kind: 'symbol', label: s }));
  c.files.forEach(s => chips.push({ kind: 'file', label: s }));
  c.errors.forEach(s => chips.push({ kind: 'error', label: s }));
  c.technologies.forEach(s => chips.push({ kind: 'tech', label: s }));
  c.businessAreas.forEach(s => chips.push({ kind: 'area', label: s }));
  return chips;
}

const TONE: Record<Chip['kind'], string> = {
  task: '', symbol: '', file: '', error: 'bad', tech: '', area: 'warm',
};

export function SignalChips({ chips, animate = true }: { chips: Chip[]; animate?: boolean }) {
  return (
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      {chips.map((c, i) => (
        <span class={`pill ${animate ? 'fade-in' : ''}`} data-tone={TONE[c.kind]} style={`animation-delay:${i * 60}ms`}>
          <span style="opacity:.7">{c.kind}:</span>{c.label}
        </span>
      ))}
    </div>
  );
}
```

Run: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/workbench-v2/viz/SignalChips.tsx test/workbench-v2/signal-chips-vm.test.ts
git commit -m "viz: signal chips + vm"
```

---

### Task 14: PipelineFlow component + view-model

**Files:**
- Create: `src/workbench-v2/viz/PipelineFlow.tsx`
- Create: `test/workbench-v2/pipeline-vm.test.ts`

- [ ] **Step 1: Write the VM test**

```ts
import test from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { pipelineSteps, type StageState } from '../../src/workbench-v2/viz/PipelineFlow.js';

test('pipelineSteps has 10 stages in canonical order', () => {
  const steps = pipelineSteps();
  equal(steps.length, 10);
  deepEqual(steps.map(s => s.id), ['receive','classify','rewrite','search','fuse','rerank','adjust','fit','assemble','deep']);
});

test('stage state derives from timings', () => {
  const steps = pipelineSteps({ classify: 12, rewrite: 0, fuse: 8 });
  const byId = Object.fromEntries(steps.map(s => [s.id, s.state]));
  equal(byId.receive,   'pending');
  equal(byId.classify,  'done');
  equal(byId.rewrite,   'skipped');
  equal(byId.fuse,      'done');
  equal(byId.deep,      'pending');
});
```

- [ ] **Step 2: Implement PipelineFlow.tsx + VM**

```tsx
export type StageState = 'pending'|'active'|'done'|'skipped'|'failed';
export interface Step { id: string; title: string; blurb: string; state: StageState; ms?: number; }

const STAGES: Array<Pick<Step,'id'|'title'|'blurb'>> = [
  { id: 'receive',  title: '1 · Receive',   blurb: 'Agent calls tuberosa_search_context.' },
  { id: 'classify', title: '2 · Classify',  blurb: 'Pull project, task, files, symbols, errors out of the prompt.' },
  { id: 'rewrite',  title: '3 · Rewrite',   blurb: 'If the probe is weak, ask the model for a better query.' },
  { id: 'search',   title: '4 · Search',    blurb: 'Labels, FTS, vector, memory — all in parallel. Then graph.' },
  { id: 'fuse',     title: '5 · Fuse',      blurb: 'Weighted reciprocal-rank fusion into one ranked list.' },
  { id: 'rerank',   title: '6 · Rerank',    blurb: 'Re-order the top slice with a reranker.' },
  { id: 'adjust',   title: '7 · Adjust',    blurb: 'Boost feedback winners, penalize stale or superseded.' },
  { id: 'fit',      title: '8 · Fit',       blurb: 'Decide: ready, needs_confirmation, insufficient.' },
  { id: 'assemble', title: '9 · Assemble',  blurb: 'Split into essential / supporting / optional within budget.' },
  { id: 'deep',     title: '10 · Deep',     blurb: 'Expand chosen items into full chunks (layered mode).' },
];

export function pipelineSteps(timings: Partial<Record<string, number>> = {}): Step[] {
  return STAGES.map(s => {
    const ms = timings[s.id];
    let state: StageState = 'pending';
    if (ms === undefined) state = 'pending';
    else if (ms === 0) state = 'skipped';
    else state = 'done';
    return { ...s, state, ms };
  });
}

export function PipelineFlow({ steps, onSelect, selected }:
  { steps: Step[]; onSelect?: (id: string) => void; selected?: string }) {
  return (
    <ol style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">
      {steps.map(s => (
        <li>
          <button class="card" onClick={() => onSelect?.(s.id)}
            style={`width:100%;text-align:left;cursor:pointer;display:flex;gap:12px;align-items:flex-start;border-color:${selected===s.id?'var(--accent)':'var(--line)'};opacity:${s.state==='skipped'?0.55:1}`}>
            <div style="flex:1">
              <div style="display:flex;justify-content:space-between;align-items:baseline">
                <strong>{s.title}</strong>
                <span class="pill" data-tone={s.state==='skipped'?'warm':s.state==='failed'?'bad':''}>{s.state}{s.ms?` · ${s.ms}ms`:''}</span>
              </div>
              <p style="margin:6px 0 0;color:var(--fg-muted);font-size:14px">{s.blurb}</p>
            </div>
          </button>
        </li>
      ))}
    </ol>
  );
}
```

Run: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/workbench-v2/viz/PipelineFlow.tsx test/workbench-v2/pipeline-vm.test.ts
git commit -m "viz: pipeline flow + vm"
```

---

### Task 15: PackTimeline component + VM

**Files:**
- Create: `src/workbench-v2/viz/PackTimeline.tsx`
- Create: `test/workbench-v2/pack-timeline-vm.test.ts`

- [ ] **Step 1: VM test**

```ts
import test from 'node:test';
import { equal } from 'node:assert/strict';
import { toPackVM } from '../../src/workbench-v2/viz/PackTimeline.js';

test('toPackVM totals counts and tokens', () => {
  const vm = toPackVM({
    essential: [{ id: 'a', title: 'A', tokens: 100 }, { id: 'b', title: 'B', tokens: 200 }],
    supporting: [{ id: 'c', title: 'C', tokens: 50 }],
    optional: [],
  });
  equal(vm.essential.count, 2);
  equal(vm.essential.tokens, 300);
  equal(vm.totals.tokens, 350);
});
```

- [ ] **Step 2: Implement PackTimeline.tsx + VM**

```tsx
export interface PackItem { id: string; title: string; tokens: number; matchReasons?: string[]; }
export interface Pack { essential: PackItem[]; supporting: PackItem[]; optional: PackItem[]; }
export interface PackSectionVM { count: number; tokens: number; items: PackItem[]; }
export interface PackVM { essential: PackSectionVM; supporting: PackSectionVM; optional: PackSectionVM; totals: { tokens: number }; }
const section = (items: PackItem[]): PackSectionVM => ({ count: items.length, tokens: items.reduce((n, i) => n + i.tokens, 0), items });
export function toPackVM(pack: Pack): PackVM {
  const essential = section(pack.essential);
  const supporting = section(pack.supporting);
  const optional = section(pack.optional);
  return { essential, supporting, optional, totals: { tokens: essential.tokens + supporting.tokens + optional.tokens } };
}
export function PackTimeline({ vm }: { vm: PackVM }) {
  const sections: Array<[string, PackSectionVM]> = [['essential', vm.essential], ['supporting', vm.supporting], ['optional', vm.optional]];
  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      {sections.map(([label, s]) => (
        <div class="card">
          <div style="display:flex;justify-content:space-between"><strong>{label}</strong><span class="pill">{s.count} items · {s.tokens} tok</span></div>
          <ul style="margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px">
            {s.items.map(i => <li class="fade-in"><span class="code">{i.id}</span> {i.title}</li>)}
          </ul>
        </div>
      ))}
      <div style="text-align:right;color:var(--fg-muted);font-size:12px">total {vm.totals.tokens} tokens</div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/workbench-v2/viz/PackTimeline.tsx test/workbench-v2/pack-timeline-vm.test.ts
git commit -m "viz: pack timeline + vm"
```

---

### Task 16: GraphCanvas (Cytoscape lazy chunk) + graph-data adapter

**Files:**
- Create: `src/workbench-v2/viz/graph-data.ts`
- Create: `src/workbench-v2/viz/GraphCanvas.tsx`
- Create: `test/workbench-v2/graph-data.test.ts`

- [ ] **Step 1: graph-data adapter test**

```ts
import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { toGraphElements } from '../../src/workbench-v2/viz/graph-data.js';

test('toGraphElements maps items + relations to cy elements', () => {
  const els = toGraphElements({
    items: [
      { id: 'a', title: 'A', itemType: 'code_ref', score: 0.9, labels: ['x'] },
      { id: 'b', title: 'B', itemType: 'spec',     score: 0.7, labels: ['x'] },
    ],
    relations: [{ sourceId: 'a', targetId: 'b', kind: 'related_to' }],
  });
  equal(els.length, 3);
  ok(els.find(e => e.data.id === 'a'));
  ok(els.find(e => e.data.source === 'a' && e.data.target === 'b'));
});
```

- [ ] **Step 2: Implement adapter**

```ts
// src/workbench-v2/viz/graph-data.ts
export interface GraphItem { id: string; title: string; itemType: string; score: number; labels?: string[]; }
export interface GraphRelation { sourceId: string; targetId: string; kind: string; }
export interface GraphInput { items: GraphItem[]; relations: GraphRelation[]; }
export interface CyElement { data: Record<string, unknown>; }

export function toGraphElements(input: GraphInput): CyElement[] {
  const nodes = input.items.map(i => ({ data: { id: i.id, label: i.title, itemType: i.itemType, score: i.score, labels: (i.labels ?? []).join(',') } }));
  const edges = input.relations.map(r => ({ data: { id: `${r.sourceId}->${r.targetId}:${r.kind}`, source: r.sourceId, target: r.targetId, kind: r.kind } }));
  return [...nodes, ...edges];
}
```

- [ ] **Step 3: Implement GraphCanvas with dynamic import**

```tsx
// src/workbench-v2/viz/GraphCanvas.tsx
import { useEffect, useRef } from 'preact/hooks';
import type { GraphInput } from './graph-data.js';
import { toGraphElements } from './graph-data.js';

export type LayoutKind = 'cose' | 'dagre';

export function GraphCanvas({ input, layout = 'cose', onNodeClick, selectedNodeId }:
  { input: GraphInput; layout?: LayoutKind; onNodeClick?: (id: string) => void; selectedNodeId?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    let destroyed = false;
    let cyInstance: { destroy(): void } | null = null;
    (async () => {
      const [{ default: cytoscape }, { default: dagre }, { default: cose }] = await Promise.all([
        import('cytoscape'),
        import('cytoscape-dagre'),
        import('cytoscape-cose-bilkent'),
      ]);
      cytoscape.use(dagre); cytoscape.use(cose);
      if (destroyed || !ref.current) return;
      const cy = cytoscape({
        container: ref.current,
        elements: toGraphElements(input),
        layout: { name: layout === 'dagre' ? 'dagre' : 'cose-bilkent', animate: true } as never,
        style: [
          { selector: 'node', style: { 'background-color': '#6aa6ff', label: 'data(label)', color: '#e7e9ee', 'font-size': 10 } },
          { selector: 'node[itemType="spec"]', style: { 'background-color': '#f6b86b' } },
          { selector: 'node[itemType="memory"]', style: { 'background-color': '#6ddc8e' } },
          { selector: 'node[itemType="wiki"]', style: { 'background-color': '#9aa3b2' } },
          { selector: 'edge', style: { 'line-color': '#232838', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#232838', 'curve-style': 'bezier' } },
          { selector: ':selected', style: { 'border-color': '#fff', 'border-width': 2 } },
        ],
      });
      cy.on('tap', 'node', (e) => onNodeClick?.(e.target.id()));
      if (selectedNodeId) cy.$id(selectedNodeId).select();
      cyInstance = cy;
    })();
    return () => { destroyed = true; cyInstance?.destroy(); };
  }, [input, layout]);

  return <div ref={ref} style="width:100%;height:480px;border:1px solid var(--line);border-radius:12px;background:var(--bg-elev)" />;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/workbench-v2/viz/graph-data.ts src/workbench-v2/viz/GraphCanvas.tsx test/workbench-v2/graph-data.test.ts
git commit -m "viz: graph canvas (cytoscape lazy chunk) + adapter"
```

---

## Phase E — Chapters

Each chapter is a `Ch0N_*.tsx` file exporting a default Preact component. It must render a `<section id="chN" class="chapter">…</section>` and call `observeChapter(el, N)` in a `useEffect` so the progress rail tracks scroll.

### Task 17: Ch01 — Hello

**Files:** Create `src/workbench-v2/chapters/Ch01_Hello.tsx`.

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useRef } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { setRoute, route } from '../state/store.js';

export default function Ch01_Hello() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current ? observeChapter(ref.current, 1) : undefined, []);
  return (
    <section id="ch1" class="chapter" ref={ref}>
      <h2 class="fade-in">Tuberosa is a context broker for coding agents.</h2>
      <p class="lead fade-in" style="animation-delay:120ms">It sits between your agent and your project knowledge.
      It retrieves the right references for the task, captures reviewed lessons, and feeds both back in.</p>
      <svg viewBox="0 0 600 120" width="100%" style="max-width:720px;margin-top:24px" aria-hidden>
        <defs>
          <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
          </marker>
        </defs>
        {[ [60,'Agent'], [300,'Tuberosa'], [540,'Knowledge'] ].map(([x, label]) => (
          <g>
            <rect x={(x as number)-60} y={36} width={120} height={48} rx={10} fill="var(--bg-elev)" stroke="var(--line)"/>
            <text x={x as number} y={66} text-anchor="middle" fill="var(--fg)" font-size="14">{label}</text>
          </g>
        ))}
        <path d="M120,60 L240,60" stroke="var(--accent)" stroke-width="2" marker-end="url(#ar)" style="stroke-dasharray:8;animation:dash 3s linear infinite"/>
        <path d="M360,60 L480,60" stroke="var(--accent-warm)" stroke-width="2" marker-end="url(#ar)" style="stroke-dasharray:8;animation:dash 3s linear infinite reverse"/>
        <style>{`@keyframes dash{to{stroke-dashoffset:-32}}@media (prefers-reduced-motion: reduce){path{animation:none}}`}</style>
      </svg>
      <div style="margin-top:24px;display:flex;gap:12px">
        <button class="primary" onClick={() => { setRoute({ ...route.value, chapter: 2 }); document.getElementById('ch2')?.scrollIntoView({ behavior: 'smooth' }); }}>Start the tour →</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/workbench-v2/chapters/Ch01_Hello.tsx
git commit -m "chapter 01: hello + animated agent⇄broker⇄knowledge"
```

---

### Task 18: Ch02 — The problem (without vs with)

**Files:** Create `src/workbench-v2/chapters/Ch02_Problem.tsx`.

- [ ] **Step 1: Implement**

Show two `.card` columns side by side. Each holds the same fake user message and an agent reply. Left reply is generic ("I'm not sure where that lives, maybe search the repo…"). Right reply cites the seeded paywall file from `acmeBilling`. Use CSS keyframes to typewriter-reveal each reply on view. Pull the answer text from `acmeBilling` so it stays consistent with the seed.

```tsx
import { useEffect, useRef } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { acmeBilling } from '../data/fixtures.js';

export default function Ch02_Problem() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current ? observeChapter(ref.current, 2) : undefined, []);
  const cited = acmeBilling.items.find(i => i.id === 'k-paywall-modal');
  return (
    <section id="ch2" class="chapter" ref={ref}>
      <h2>Same agent. Same prompt. Two answers.</h2>
      <p class="lead">Left: without Tuberosa. Right: with Tuberosa.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
        <div class="card">
          <p class="pill" data-tone="bad">without</p>
          <p><strong>You:</strong> Where does paywall logic live?</p>
          <p class="fade-in"><strong>Agent:</strong> I'm not sure — try grepping for "paywall" or "checkout"…</p>
        </div>
        <div class="card">
          <p class="pill">with</p>
          <p><strong>You:</strong> Where does paywall logic live?</p>
          <p class="fade-in"><strong>Agent:</strong> It's <span class="code">{cited?.title}</span> at <span class="code">{cited?.sourceUri}</span>. The tier picker is rendered from there.</p>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/workbench-v2/chapters/Ch02_Problem.tsx
git commit -m "chapter 02: without vs with comparison"
```

---

### Task 19: Ch03 — Anatomy of a session

**Files:** Create `src/workbench-v2/chapters/Ch03_Anatomy.tsx`.

Compose `SignalChips`, `PipelineFlow`, `PackTimeline` for prompt p1 (`"Where does paywall logic live?"`). Synthesize a canned classifier/timings/pack from the seeded data (no live call). Stage the animations: chips appear → pipeline steps light up one by one (use `setTimeout` to flip each step's `state` from `pending` → `done` with a ~150ms cadence; respect reduced motion by collapsing all delays to 0) → pack tiles fade in.

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { SignalChips, toSignalChips } from '../viz/SignalChips.js';
import { PipelineFlow, pipelineSteps } from '../viz/PipelineFlow.js';
import { PackTimeline, toPackVM } from '../viz/PackTimeline.js';

const TIMINGS = { receive: 1, classify: 12, rewrite: 0, search: 38, fuse: 5, rerank: 22, adjust: 3, fit: 1, assemble: 2, deep: 0 };

export default function Ch03_Anatomy() {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(0); // 0=none,1=chips,2=pipeline,3=pack
  useEffect(() => {
    if (!ref.current) return;
    const stop = observeChapter(ref.current, 3);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        if (reduce) { setShown(3); return; }
        setShown(1); setTimeout(() => setShown(2), 500); setTimeout(() => setShown(3), 2000);
        io.disconnect();
      }
    }, { threshold: 0.5 });
    io.observe(ref.current);
    return () => { stop(); io.disconnect(); };
  }, []);

  const chips = toSignalChips({ symbols: ['paywall','logic'], errors: [], files: [], businessAreas: ['subscription'], technologies: [], taskType: 'research' });
  const steps = pipelineSteps(TIMINGS);
  const pack = toPackVM({
    essential: [{ id: 'k-paywall-modal', title: 'PaywallSelectionModal', tokens: 220 }],
    supporting: [{ id: 'k-paywall-spec', title: 'Paywall spec', tokens: 180 }],
    optional: [],
  });
  return (
    <section id="ch3" class="chapter" ref={ref}>
      <h2>Anatomy of a session</h2>
      <p class="lead">One prompt, ~80ms, three groups of context.</p>
      <div class="card" style="margin-top:16px"><strong>Prompt</strong> · "Where does paywall logic live?"</div>
      <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <h3>Signals</h3>
          {shown >= 1 && <SignalChips chips={chips} />}
          <h3 style="margin-top:16px">Pipeline</h3>
          {shown >= 2 && <PipelineFlow steps={steps} />}
        </div>
        <div>
          <h3>Pack</h3>
          {shown >= 3 && <PackTimeline vm={pack} />}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/workbench-v2/chapters/Ch03_Anatomy.tsx
git commit -m "chapter 03: anatomy of a session (canned p1 replay)"
```

---

### Task 20: Ch04 — The pipeline with click-to-mini-graph

**Files:** Create `src/workbench-v2/chapters/Ch04_Pipeline.tsx`.

Render `PipelineFlow` driven by the same canned p1 timings, but clicking a step opens a right-pane mini `GraphCanvas` filtered to whatever that step produced:

- `classify` → graph of the classifier's symbols/files/errors as floating nodes
- `search` → 4 source clusters (labels/fts/vector/memory) as separate small subgraphs
- `fuse` → ranked column of candidates with rank edges
- `rerank` → same column with arrows showing position deltas
- `adjust` → top-K with red ✕ on suppressed items
- `fit` → small badge graph
- `assemble` → three sections as supernodes
- `deep` → essential items expanded into chunk children

Each step gets a hardcoded sub-graph derived from `acmeBilling` at module scope. Time budget: prioritize `search`, `fuse`, `assemble` looking polished; the others can be schematic.

- [ ] **Step 1: Implement** (skeleton — engineer fills the 8 step→graph mappings):

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { PipelineFlow, pipelineSteps } from '../viz/PipelineFlow.js';
import { GraphCanvas } from '../viz/GraphCanvas.js';
import { acmeBilling } from '../data/fixtures.js';
import type { GraphInput } from '../viz/graph-data.js';

function graphForStep(stepId: string): GraphInput {
  // Hardcoded sub-graphs per stage, derived from acmeBilling.
  // ... engineer fills each branch ...
  return { items: [], relations: [] };
}

const TIMINGS = { receive: 1, classify: 12, rewrite: 0, search: 38, fuse: 5, rerank: 22, adjust: 3, fit: 1, assemble: 2, deep: 0 };

export default function Ch04_Pipeline() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current ? observeChapter(ref.current, 4) : undefined, []);
  const [sel, setSel] = useState<string>('search');
  const steps = pipelineSteps(TIMINGS);
  return (
    <section id="ch4" class="chapter" ref={ref}>
      <h2>The pipeline, stage by stage</h2>
      <p class="lead">Click any stage to see exactly what it produced for our prompt.</p>
      <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:16px;margin-top:16px">
        <PipelineFlow steps={steps} selected={sel} onSelect={setSel} />
        <div>
          <h3 style="margin:0 0 8px">What "{steps.find(s => s.id === sel)?.title}" produced</h3>
          <GraphCanvas input={graphForStep(sel)} layout={sel === 'fuse' || sel === 'rerank' ? 'dagre' : 'cose'} />
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Fill in graphForStep mappings** for at least `classify`, `search`, `fuse`, `rerank`, `adjust`, `assemble`, `deep`. Each ≤ 8 nodes.

- [ ] **Step 3: Commit**

```bash
git add src/workbench-v2/chapters/Ch04_Pipeline.tsx
git commit -m "chapter 04: clickable pipeline with per-stage mini graphs"
```

---

### Task 21: Ch05 — The knowledge graph

**Files:** Create `src/workbench-v2/chapters/Ch05_KnowledgeGraph.tsx`.

Render `GraphCanvas` against `acmeBilling` (seeded) by default; if `demoMode === 'live'`, fetch `/knowledge?project=<current>` via `api()` and adapt the response into `GraphInput`. Provide filter chips: `wiki / spec / code_ref / memory` (multi-select). Provide layout toggle `cose ↔ dagre`. Selected node opens a right-side detail card with `title`, `sourceUri`, `labels`, `references`.

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { acmeBilling } from '../data/fixtures.js';
import { GraphCanvas } from '../viz/GraphCanvas.js';
import type { GraphInput } from '../viz/graph-data.js';
import { demoMode, route, setRoute } from '../state/store.js';
import { api } from '../data/api.js';

type ItemKind = 'wiki'|'spec'|'code_ref'|'memory';
const ALL: ItemKind[] = ['wiki','spec','code_ref','memory'];

export default function Ch05_KnowledgeGraph() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current ? observeChapter(ref.current, 5) : undefined, []);
  const [layout, setLayout] = useState<'cose'|'dagre'>('cose');
  const [filters, setFilters] = useState<Set<ItemKind>>(new Set(ALL));
  const [liveItems, setLiveItems] = useState<typeof acmeBilling.items | null>(null);

  useEffect(() => {
    if (demoMode.value === 'live') api<{ items: typeof acmeBilling.items }>('/knowledge', { query: { limit: 200 } })
      .then(r => setLiveItems(r.items)).catch(() => setLiveItems(null));
    else setLiveItems(null);
  }, [demoMode.value]);

  const items = liveItems ?? acmeBilling.items;
  const visible = items.filter(i => filters.has(i.itemType as ItemKind));
  const input: GraphInput = useMemo(() => ({
    items: visible.map(i => ({ id: i.id, title: i.title, itemType: i.itemType, score: 1, labels: i.labels })),
    relations: visible.flatMap(i => (i.relations ?? []).filter(r => visible.find(v => v.id === r.targetId)).map(r => ({ sourceId: i.id, targetId: r.targetId, kind: r.kind }))),
  }), [visible]);

  const selectedId = route.value.graphNodeId;
  const selected = selectedId ? items.find(i => i.id === selectedId) : undefined;

  return (
    <section id="ch5" class="chapter" ref={ref}>
      <h2>The knowledge graph</h2>
      <p class="lead">Items are nodes. Relations are edges. Click around.</p>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        {ALL.map(k => (
          <button class={`pill ${filters.has(k)?'':'ghost'}`} onClick={() => {
            const next = new Set(filters); next.has(k) ? next.delete(k) : next.add(k); setFilters(next);
          }}>{k}</button>
        ))}
        <button class="ghost" onClick={() => setLayout(layout === 'cose' ? 'dagre' : 'cose')}>layout: {layout}</button>
      </div>
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-top:16px">
        <GraphCanvas input={input} layout={layout} selectedNodeId={selectedId}
                     onNodeClick={(id) => setRoute({ ...route.value, graphNodeId: id })} />
        <aside class="card">
          {selected
            ? <>
                <strong>{selected.title}</strong>
                <div style="color:var(--fg-muted);font-size:12px;margin-top:4px"><span class="code">{selected.sourceUri}</span></div>
                <div style="margin-top:8px">{selected.labels.map(l => <span class="pill">{l}</span>)}</div>
                <p style="margin-top:8px;color:var(--fg-muted);font-size:13px">{selected.content.slice(0, 240)}…</p>
              </>
            : <span style="color:var(--fg-muted)">Click a node to inspect it.</span>}
        </aside>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/workbench-v2/chapters/Ch05_KnowledgeGraph.tsx
git commit -m "chapter 05: knowledge graph with filters + detail panel"
```

---

### Task 22: Ch06 — Reflections that learn

**Files:** Create `src/workbench-v2/chapters/Ch06_Reflections.tsx`.

Show a single reflection card morphing `draft → approved` (CSS class swap with transition on border + label). Below, a tiny before/after rerank visualization using `PipelineFlow`'s adjust-stage card pattern: same prompt, on the left adjust ranking without the memory, on the right with. Use seeded prompt p8.

- [ ] **Step 1: Implement** (engineer composes the two static rankings inline from `acmeBilling`).

- [ ] **Step 2: Commit**

```bash
git add src/workbench-v2/chapters/Ch06_Reflections.tsx
git commit -m "chapter 06: reflection draft→approved + before/after rank"
```

---

### Task 23: Ch07 — Try it yourself (10 example cards)

**Files:** Create `src/workbench-v2/chapters/Ch07_TryIt.tsx`.

Render 10 cards, one per `acmeBilling.prompts` entry, showing the prompt text and its branches as pills. Clicking a card runs a canned replay in place: for each prompt id, a fixed `{ classifier, timings, pack, adjustments, contextFit }` object lives in `src/workbench-v2/data/demo/replays/<id>.ts`. The chapter mounts `SignalChips`, `PipelineFlow`, `PackTimeline` with that replay data and animates them the same way Ch.3 does.

- [ ] **Step 1: Generate canned replays**

Run a one-shot script `scripts/gen-demo-replays.ts` that, for each prompt, executes the same retrieval pipeline used in the fixture-coverage test against `MemoryKnowledgeStore`, captures the debug bundle, and writes `src/workbench-v2/data/demo/replays/<id>.json`. (Bundled at build time, no network at runtime.)

```ts
// scripts/gen-demo-replays.ts (full code)
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { IngestionService } from '../src/ingest/service.js';
import { acmeBilling } from '../src/workbench-v2/data/fixtures.js';

async function main() {
  const store = new MemoryKnowledgeStore();
  const model = new HashModelProvider();
  const ingest = new IngestionService(store, model);
  for (const i of acmeBilling.items) {
    await ingest.upsertKnowledgeItem({ project: acmeBilling.project, sourceType: 'manual', sourceUri: i.sourceUri, itemType: i.itemType, title: i.title, content: i.content, labels: i.labels, references: i.references, status: i.status });
  }
  for (const i of acmeBilling.items) for (const r of i.relations ?? []) await store.upsertRelation({ sourceId: i.id, targetId: r.targetId, kind: r.kind });

  const retrieval = new RetrievalService(store, model);
  for (const p of acmeBilling.prompts) {
    const res = await retrieval.searchContext({
      project: acmeBilling.project, prompt: p.text, contextMode: 'layered',
      noiseTolerance: p.branches.includes('mode:strict_noise') ? 'strict' : 'lenient',
      includeDeepContext: p.branches.includes('mode:layered_deep_context'),
      debug: true,
    });
    const out = join('src/workbench-v2/data/demo/replays', `${p.id}.json`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify({
      classifier: res.classifier,
      sourceCandidates: res.debug?.sourceCandidates ?? {},
      fusionOrder: res.debug?.fusionOrder ?? [],
      rerankDeltas: res.debug?.rerankDeltas ?? [],
      adjustments: res.debug?.adjustments ?? [],
      contextFit: res.contextFit,
      pack: { essential: res.pack.essential, supporting: res.pack.supporting, optional: res.pack.optional },
      timings: res.debug?.timings ?? { totalMs: 0, stageMs: {} },
    }, null, 2));
  }
  console.log('[demo-replays] wrote', acmeBilling.prompts.length, 'files');
}
main().catch(e => { console.error(e); process.exit(1); });
```

Add to `package.json`:
```json
"gen:demo-replays": "tsx scripts/gen-demo-replays.ts"
```

Run: `pnpm run gen:demo-replays`
Expected: 10 JSON files under `src/workbench-v2/data/demo/replays/`.

- [ ] **Step 2: Chapter component**

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { acmeBilling } from '../data/fixtures.js';
import { SignalChips, toSignalChips } from '../viz/SignalChips.js';
import { PipelineFlow, pipelineSteps } from '../viz/PipelineFlow.js';
import { PackTimeline, toPackVM } from '../viz/PackTimeline.js';

async function loadReplay(id: string) {
  const url = new URL(`./data/demo/replays/${id}.json`, import.meta.url);
  return (await fetch(url)).json();
}

export default function Ch07_TryIt() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current ? observeChapter(ref.current, 7) : undefined, []);
  const [active, setActive] = useState<string | null>(null);
  const [replay, setReplay] = useState<any>(null);
  useEffect(() => { if (active) loadReplay(active).then(setReplay); }, [active]);
  return (
    <section id="ch7" class="chapter" ref={ref}>
      <h2>Try ten prompts</h2>
      <p class="lead">Click any card to replay it. Every branch is covered.</p>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px">
        {acmeBilling.prompts.map(p => (
          <button class="card" onClick={() => setActive(p.id)} style={`text-align:left;cursor:pointer;border-color:${active===p.id?'var(--accent)':'var(--line)'}`}>
            <div>"{p.text}"</div>
            <div style="margin-top:6px">{p.branches.map(b => <span class="pill" style="margin-right:4px">{b}</span>)}</div>
          </button>
        ))}
      </div>
      {replay && (
        <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div>
            <h3>Signals</h3><SignalChips chips={toSignalChips(replay.classifier)} />
            <h3 style="margin-top:16px">Pipeline</h3><PipelineFlow steps={pipelineSteps(replay.timings.stageMs)} />
          </div>
          <div><h3>Pack</h3><PackTimeline vm={toPackVM(replay.pack)} /></div>
        </div>
      )}
    </section>
  );
}
```

(esbuild + the `loader: { '.json': 'json' }` option will inline the JSON at build; the `fetch(new URL(...))` form is used so dev-mode HMR also works.)

- [ ] **Step 3: Commit**

```bash
git add src/workbench-v2/chapters/Ch07_TryIt.tsx src/workbench-v2/data/demo/replays/ scripts/gen-demo-replays.ts package.json
git commit -m "chapter 07: try-it gallery + generated canned replays"
```

---

### Task 24: Ch08 — Plug into your agent

**Files:** Create `src/workbench-v2/chapters/Ch08_PlugIn.tsx`.

Four cards: Claude Code, Codex, Cursor, GitHub Copilot. Each shows a `pre` with the exact MCP config snippet and a "Copy" button calling `navigator.clipboard.writeText`. Cards are click-to-expand (collapsed by default to one line).

- [ ] **Step 1: Implement** with the four real snippets sourced from `README.md`. Engineer pastes them verbatim — do not paraphrase. (Read `README.md` lines 1–250 for the canonical text.)

- [ ] **Step 2: Commit**

```bash
git add src/workbench-v2/chapters/Ch08_PlugIn.tsx
git commit -m "chapter 08: plug-in cards with copy buttons"
```

---

### Task 25: Ch09 — Inspect your own sessions

**Files:** Create `src/workbench-v2/chapters/Ch09_YourSessions.tsx`.

Collapsed `<details>` by default. On expand: `GET /agent-sessions?project=<current>&limit=20`. Render a list of sessions (id, prompt, generated-at, status). Clicking one fetches `GET /operations/workbench/session/:id/replay`:
- if 200, render the same `SignalChips + PipelineFlow + PackTimeline` view as Ch.7 with the bundle's data.
- if 404, render a "no replay recorded — enable `TUBEROSA_PERSIST_REPLAY=true`" banner instead.

The current `<current>` project comes from a separate signal (Ch.10 sets it). Default value is the workbench summary's most-active project, from `GET /operations/workbench/summary`.

- [ ] **Step 1: Implement** the chapter component, lazy-loading sessions only on `<details>` open.

- [ ] **Step 2: Commit**

```bash
git add src/workbench-v2/chapters/Ch09_YourSessions.tsx
git commit -m "chapter 09: inspect real sessions via replay endpoint"
```

---

### Task 26: Ch10 — Tune & operate (review / system / feedback)

**Files:** Create `src/workbench-v2/chapters/Ch10_TuneOps.tsx`.

Collapsed `<details>` by default. On expand, fetch `/operations/workbench/summary` and render three compact sub-panels:
- **Review** — list `reflection-drafts`, `operations/conflicts`, `operations/knowledge-gaps`, `operations/learning-proposals` from the summary; each item links to approve/dismiss via existing PATCH endpoints.
- **System** — store, cache, model provider, durability badges, error-log counts.
- **Feedback knobs** — current project selector, API key input (`type=password`), result limit, refresh button.

Reuse the existing summary endpoint (no new server code) — the rendering is the only new thing. Keep the markup minimal; no charts.

- [ ] **Step 1: Implement** (small VM helpers can be reused from current `src/workbench/presenters/summaryPresenter.ts` — copy what's still needed; do not import from the old folder because it will be deleted in Task 28).

- [ ] **Step 2: Commit**

```bash
git add src/workbench-v2/chapters/Ch10_TuneOps.tsx
git commit -m "chapter 10: collapsed review + system + feedback knobs"
```

---

### Task 27: Wire app.tsx — mount all chapters, shell, tour, toasts

**Files:**
- Modify: `src/workbench-v2/app.tsx`

- [ ] **Step 1: Final app.tsx**

```tsx
import { render } from 'preact';
import { ProgressRail } from './shell/ProgressRail.js';
import { AutoTour } from './shell/AutoTour.js';
import { Toasts } from './shell/Toasts.js';
import Ch01 from './chapters/Ch01_Hello.js';
import Ch02 from './chapters/Ch02_Problem.js';
import Ch03 from './chapters/Ch03_Anatomy.js';
import Ch04 from './chapters/Ch04_Pipeline.js';
import Ch05 from './chapters/Ch05_KnowledgeGraph.js';
import Ch06 from './chapters/Ch06_Reflections.js';
import Ch07 from './chapters/Ch07_TryIt.js';
import Ch08 from './chapters/Ch08_PlugIn.js';
import Ch09 from './chapters/Ch09_YourSessions.js';
import Ch10 from './chapters/Ch10_TuneOps.js';
import './styles/main.css';

function App() {
  return (
    <div class="workbench-shell">
      <ProgressRail />
      <main>
        <AutoTour />
        <Ch01 /><Ch02 /><Ch03 /><Ch04 /><Ch05 /><Ch06 /><Ch07 /><Ch08 /><Ch09 /><Ch10 />
      </main>
      <Toasts />
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
```

- [ ] **Step 2: Build + manual smoke**

Run: `pnpm run build:workbench && pnpm run dev` (background).
Visit `http://localhost:3027/workbench`.
Verify: all 10 chapters render, scroll updates the progress rail, clicking the rail jumps, ▶ Tour advances, Ch.7 cards replay, Ch.5 graph clicks open detail.

- [ ] **Step 3: Commit**

```bash
git add src/workbench-v2/app.tsx
git commit -m "workbench v2: mount full shell + 10 chapters"
```

---

## Phase F — Tests, cleanup, guardrails

### Task 28: Browser smoke test (replace existing)

**Files:**
- Create: `test/browser/workbench-v2-browser.test.ts`

- [ ] **Step 1: Port + extend the existing test**

Copy `test/browser/workbench-browser.test.ts` to `test/browser/workbench-v2-browser.test.ts`. Update:
- `bundlePath` still points at `dist/workbench/app.js`.
- Replace assertions about the old views with v2 assertions:
  - `await page.waitForSelector('section#ch1')`
  - Click the Ch.1 "Start the tour" button; assert `section#ch2` becomes the active chapter.
  - Click chapter 7 in the progress rail; assert at least one example card is present; click one; assert pipeline-flow renders.
  - Trigger `(window).matchMedia` with reduced-motion to verify no `animation` styles are applied (use `getComputedStyle`).
  - Hit `/operations/workbench/session/missing/replay`; assert 404 JSON.
- Add `persistReplay: false` to the test's `AppConfig` literal.

- [ ] **Step 2: Update `package.json` script**

```json
"test:workbench-browser": "node --test --import tsx test/browser/workbench-v2-browser.test.ts"
```

- [ ] **Step 3: Run**

```bash
pnpm run build:workbench && pnpm run test:workbench-browser
```
Expected: PASS (or auto-skip if Chrome not installed).

- [ ] **Step 4: Commit**

```bash
git add test/browser/workbench-v2-browser.test.ts package.json
git commit -m "test: v2 browser smoke covering chapters + tour + replay 404"
```

---

### Task 29: Delete old workbench code

**Files:**
- Delete: `src/workbench/` (entire directory)
- Delete: `src/http/workbench.ts`
- Delete: `test/browser/workbench-browser.test.ts`
- Delete: `scripts/build-workbench.ts`

- [ ] **Step 1: Run GitNexus impact on what we're deleting**

Run:
```
gitnexus_impact({target: "workbenchHtml", direction: "upstream"})
gitnexus_impact({target: "readWorkbenchAsset", direction: "upstream"})
```
Expected: callers in `src/http/server.ts` already swapped (Task 7). If anything else still imports from `src/workbench/` or `src/http/workbench.ts`, fix those imports first.

- [ ] **Step 2: Delete**

```bash
rm -rf src/workbench
rm src/http/workbench.ts
rm test/browser/workbench-browser.test.ts
rm scripts/build-workbench.ts
```

- [ ] **Step 3: Build + test**

```bash
pnpm run build
pnpm test
pnpm run test:workbench-browser
```
Expected: all green; no missing-import errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "remove old workbench"
```

---

### Task 30: Final guardrails

- [ ] **Step 1: Retrieval eval**

Run: `pnpm run eval:retrieval`
Expected: PASS (this work changed no retrieval logic).

- [ ] **Step 2: Agent-context eval**

Run: `pnpm run eval:agent-context`
Expected: PASS.

- [ ] **Step 3: Bundle size check**

After `pnpm run build:workbench`, inspect `dist/workbench/`:
```bash
ls -la dist/workbench/ | awk '{print $5, $9}'
```
Expected: main `app.js` under ~80KB minified (~60KB gzipped target); a separate chunk file containing Cytoscape ≥ 150KB exists and is named in the metafile output. If the shell chunk exceeds 80KB minified, find imports that pulled Cytoscape eagerly (likely a static `import 'cytoscape'` instead of dynamic `import()`).

- [ ] **Step 4: GitNexus detect-changes**

Run: `gitnexus_detect_changes()`
Expected: changes only inside `src/workbench-v2/`, `src/http/`, `src/operations/session-replay.ts`, `src/agent-session/service.ts`, `src/config.ts`, `src/app.ts`, `src/storage/`, `migrations/`, `scripts/`, `test/`, `package.json`. No unrelated processes touched.

- [ ] **Step 5: Done**

No commit — these are check-only steps.

---

## Self-review against spec

| Spec section | Plan tasks that cover it |
|---|---|
| Goals — first-time understanding in 5 min | Ch.1–8 (Tasks 17–24) + auto-tour (Task 11) |
| Goals — team-lead shareable | Auto-tour script (Task 11) + chapter outline (Tasks 17–24) |
| Goals — active user inspect own session | Ch.9 + replay endpoint (Tasks 5, 6, 25) |
| Goals — every pipeline branch reachable | Fixture coverage test (Task 3) + Ch.7 gallery (Task 23) |
| Goals — bundle modest | Code-split build script (Task 1) + Task 30 step 3 check |
| Non-goals | Honored: no CLI, no new ingestion, no auth, only one new endpoint, no shim |
| Shell choice (long-scroll) | app.tsx mount order (Task 27) + tokens/main.css (Task 8) |
| Tech stack (Preact + Motion + Cytoscape) | Task 1, Task 16 |
| Chapter outline 1–10 | Tasks 17–26 (one task per chapter) |
| Auto-tour | Task 11 |
| Demo toggle | Task 10 |
| Architecture file tree | File map at top of plan |
| Old code removed in same change-set | Task 29 |
| Data flow + new replay endpoint | Tasks 4, 5, 6 |
| Interaction model (no typing) | Buttons-only in chapters; api-key/limit text fields confined to Ch.10 (Task 26) |
| Animation details table | Tasks 11, 13, 14, 17, 19, 20, 22, 23 |
| Example library | Tasks 2, 3, 23 |
| Error handling | Toasts (Task 10), api wrapper (Task 12), Ch.9 404 banner (Task 25), reduced-motion in tokens (Task 8) + AutoTour (Task 11) |
| Testing | Tasks 3, 5 (round-trip), 6 (http), 9 (routes), 13 (chips vm), 14 (pipeline vm), 15 (pack vm), 16 (graph adapter), 28 (browser smoke) |
| Risks — bundle size | Task 30 step 3 |
| Risks — replay opt-in | Tasks 5, 25 |

**Placeholder scan:** the JSON fixture in Task 2 contains a deliberate `_comment_for_engineer` block that Task 3's red-test forces the engineer to fill in; that is intentional and not a plan placeholder. Steps 1–2 of Task 22 and Task 26 reference "compose inline from acmeBilling" / "small VM helpers" but ship enough context (which prompts, which fixture fields) to be unambiguous.

**Type consistency:** `SessionReplayBundle` is defined once in Task 5 and reused verbatim in Tasks 6, 25. `SeedFixture` defined once in Task 2 and used in Tasks 3, 23. `Route` defined once in Task 9 and used by Tasks 10, 17, 21.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-workbench-v2-learn-first.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
