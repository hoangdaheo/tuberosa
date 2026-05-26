# Workbench v2 UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve eight workbench-v2 UX complaints (Ch03/Ch04 duplication, unexplained node colors, unclear Fit/Assemble, dead live/seeded toggle, weak Reflection demo, cryptic Ch07 ids, empty Ch09/Ch10) and add guidance (AutoTour, legend, connection status, jargon tooltips, progress fill).

**Architecture:** Preact + signals long-scroll explainer in `src/workbench-v2/`. New presentational/VM units in `viz/` (colors, legend, item row, fit meter, term tooltip) and `data/branch-labels.ts` are built first; chapters and shell then consume them. Pure logic gets `node --test` unit tests; components are verified by build + the Playwright browser test + manual `dev` check. No backend routes change — all endpoints already exist.

**Tech Stack:** Preact, @preact/signals, TypeScript, esbuild (`scripts/build-workbench-v2.ts`), Cytoscape (graph), node:test + tsx, playwright-core (browser test).

---

## Conventions for this codebase (read before starting)

- JSX uses `class=` (not `className`) and inline `style="..."` **strings**, matching existing files.
- Imports use `.js` extensions even for `.tsx`/`.ts` sources (NodeNext resolution).
- Run a single VM test: `node --test --import tsx test/workbench-v2/<name>.test.ts`
- Build the workbench bundle: `pnpm run build:workbench` (emits `dist/workbench/app.js`).
- Full TS compile: `pnpm run build`. Full backend suite: `pnpm test`.
- Browser test: `pnpm run test:workbench-browser` (needs Chrome at `/usr/bin/google-chrome` and a built bundle).
- Design colors (paper/copper/terracotta/sage) are CSS vars in `src/workbench-v2/styles/tokens.css`; raw hexes used by Cytoscape live in JS.
- Do NOT add `Co-Authored-By` trailers to commits.

---

## File Structure

**New files:**
- `src/workbench-v2/viz/knowledge-colors.ts` — single source of itemType→{hex, label}.
- `src/workbench-v2/viz/GraphLegend.tsx` — swatch+label legend, driven by colors.
- `src/workbench-v2/viz/KnowledgeItem.tsx` — human-readable item row + `inferItemType(id)`.
- `src/workbench-v2/viz/fit-meter-vm.ts` — pure status/threshold logic for the Fit meter.
- `src/workbench-v2/viz/FitMeter.tsx` — Fit visualization (uses fit-meter-vm).
- `src/workbench-v2/viz/Term.tsx` — jargon tooltip + `TERMS` dictionary.
- `src/workbench-v2/data/branch-labels.ts` — `BranchTag`→plain-language label map.
- Tests: `test/workbench-v2/knowledge-colors.test.ts`, `knowledge-item-vm.test.ts`, `fit-meter-vm.test.ts`, `branch-labels.test.ts`.

**Modified files:**
- `viz/GraphCanvas.tsx` (import colors), `viz/PackTimeline.tsx` (use KnowledgeItem).
- `state/store.ts` (dataSource/connection signals + probe), `shell/DemoToggle.tsx`, `shell/ProgressRail.tsx`, `shell/AutoTour.tsx`, `app.tsx`.
- `chapters/Ch01_Hello.tsx`, `Ch03_Anatomy.tsx`, `Ch04_Pipeline.tsx`, `Ch05_KnowledgeGraph.tsx`, `Ch06_Reflections.tsx`, `Ch07_TryIt.tsx`, `Ch09_YourSessions.tsx`, `Ch10_TuneOps.tsx`.

---

## Task 1: Knowledge colors single source

**Files:**
- Create: `src/workbench-v2/viz/knowledge-colors.ts`
- Test: `test/workbench-v2/knowledge-colors.test.ts`
- Modify: `src/workbench-v2/viz/GraphCanvas.tsx` (lines 24-29, 108-111)

- [ ] **Step 1: Write the failing test**

`test/workbench-v2/knowledge-colors.test.ts`:
```ts
import test from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { KNOWLEDGE_COLORS, ITEM_TYPES, colorFor, labelFor } from '../../src/workbench-v2/viz/knowledge-colors.js';

test('every known item type has a hex and label', () => {
  deepEqual(ITEM_TYPES, ['code_ref', 'spec', 'memory', 'wiki']);
  for (const t of ITEM_TYPES) {
    equal(KNOWLEDGE_COLORS[t].hex.startsWith('#'), true);
    equal(typeof KNOWLEDGE_COLORS[t].label, 'string');
  }
});

test('colorFor/labelFor fall back to wiki for unknown types', () => {
  equal(colorFor('code_ref'), '#d4a574');
  equal(labelFor('spec'), 'spec');
  equal(colorFor('totally-unknown'), KNOWLEDGE_COLORS.wiki.hex);
  equal(labelFor('totally-unknown'), 'wiki');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/workbench-v2/knowledge-colors.test.ts`
Expected: FAIL — cannot find module `knowledge-colors.js`.

- [ ] **Step 3: Create the module**

`src/workbench-v2/viz/knowledge-colors.ts`:
```ts
export type KnowledgeItemType = 'code_ref' | 'spec' | 'memory' | 'wiki';

export const ITEM_TYPES: KnowledgeItemType[] = ['code_ref', 'spec', 'memory', 'wiki'];

export const KNOWLEDGE_COLORS: Record<KnowledgeItemType, { hex: string; label: string }> = {
  code_ref: { hex: '#d4a574', label: 'code' },
  spec: { hex: '#c46a4d', label: 'spec' },
  memory: { hex: '#8fae7e', label: 'memory' },
  wiki: { hex: '#948b7c', label: 'wiki' },
};

function asKnownType(itemType: string): KnowledgeItemType {
  return (ITEM_TYPES as string[]).includes(itemType) ? (itemType as KnowledgeItemType) : 'wiki';
}

export function colorFor(itemType: string): string {
  return KNOWLEDGE_COLORS[asKnownType(itemType)].hex;
}

export function labelFor(itemType: string): string {
  return KNOWLEDGE_COLORS[asKnownType(itemType)].label;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/workbench-v2/knowledge-colors.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Make GraphCanvas import the shared map**

In `src/workbench-v2/viz/GraphCanvas.tsx`, add to imports (top, after line 3):
```ts
import { KNOWLEDGE_COLORS } from './knowledge-colors.js';
```
Replace the inline `NODE_FILL` block (lines 24-29) with:
```ts
const NODE_FILL: Record<string, string> = {
  code_ref: KNOWLEDGE_COLORS.code_ref.hex,
  spec: KNOWLEDGE_COLORS.spec.hex,
  memory: KNOWLEDGE_COLORS.memory.hex,
  wiki: KNOWLEDGE_COLORS.wiki.hex,
};
```
(Leave the per-`itemType` Cytoscape style selectors at lines 108-111 unchanged — they already read `NODE_FILL.*`.)

- [ ] **Step 6: Verify build**

Run: `pnpm run build:workbench`
Expected: builds without TypeScript errors; `dist/workbench/app.js` updated.

- [ ] **Step 7: Commit**

```bash
git add src/workbench-v2/viz/knowledge-colors.ts test/workbench-v2/knowledge-colors.test.ts src/workbench-v2/viz/GraphCanvas.tsx
git commit -m "feat(workbench-v2): single source for knowledge node colors"
```

---

## Task 2: GraphLegend component

**Files:**
- Create: `src/workbench-v2/viz/GraphLegend.tsx`
- Modify: `src/workbench-v2/chapters/Ch05_KnowledgeGraph.tsx` (after the GraphCanvas at lines 77-84)

No unit test (presentational); verified by build + browser.

- [ ] **Step 1: Create the legend**

`src/workbench-v2/viz/GraphLegend.tsx`:
```tsx
import { ITEM_TYPES, KNOWLEDGE_COLORS, type KnowledgeItemType } from './knowledge-colors.js';

export function GraphLegend({ types }: { types?: string[] }) {
  const shown: KnowledgeItemType[] = types
    ? ITEM_TYPES.filter((t) => types.includes(t))
    : ITEM_TYPES;
  if (shown.length === 0) return null;
  return (
    <ul
      class="graph-legend"
      aria-label="Node color key"
      style="display:flex;flex-wrap:wrap;gap:12px;margin:10px 0 0;padding:0;list-style:none"
    >
      {shown.map((t) => (
        <li key={t} style="display:flex;align-items:center;gap:6px;font-size:var(--fs-overline);color:var(--paper-3);letter-spacing:0.06em">
          <span
            aria-hidden="true"
            style={`width:10px;height:10px;border-radius:50%;background:${KNOWLEDGE_COLORS[t].hex};border:1px solid #14110d;flex:none`}
          />
          {KNOWLEDGE_COLORS[t].label}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Render it in Ch05**

In `src/workbench-v2/chapters/Ch05_KnowledgeGraph.tsx`:
- Add import after line 5: `import { GraphLegend } from '../viz/GraphLegend.js';`
- Inside the graph column `<div style="min-width:0">` (lines 77-84), add `<GraphLegend />` immediately after the closing `</GraphCanvas>`/`/>` tag, before the closing `</div>`:
```tsx
        <div style="min-width:0">
          <GraphCanvas
            input={input}
            layout={layout}
            selectedNodeId={selectedId}
            onNodeClick={(id) => setRoute({ ...route.value, graphNodeId: id })}
          />
          <GraphLegend />
        </div>
```

- [ ] **Step 3: Verify build**

Run: `pnpm run build:workbench`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add src/workbench-v2/viz/GraphLegend.tsx src/workbench-v2/chapters/Ch05_KnowledgeGraph.tsx
git commit -m "feat(workbench-v2): node color legend under knowledge graph"
```

---

## Task 3: KnowledgeItem row + inferItemType

**Files:**
- Create: `src/workbench-v2/viz/KnowledgeItem.tsx`
- Test: `test/workbench-v2/knowledge-item-vm.test.ts`

`inferItemType` is exported as pure logic and unit-tested; the component is presentational.

- [ ] **Step 1: Write the failing test**

`test/workbench-v2/knowledge-item-vm.test.ts`:
```ts
import test from 'node:test';
import { equal } from 'node:assert/strict';
import { inferItemType } from '../../src/workbench-v2/viz/KnowledgeItem.js';

test('inferItemType maps id prefixes', () => {
  equal(inferItemType('cr-paywall-001'), 'code_ref');
  equal(inferItemType('spec-subscription-tiers'), 'spec');
  equal(inferItemType('mem-migration-step-missed'), 'memory');
  equal(inferItemType('wiki-anything'), 'wiki');
  equal(inferItemType('unknown-id'), 'wiki');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/workbench-v2/knowledge-item-vm.test.ts`
Expected: FAIL — cannot find module `KnowledgeItem.js`.

- [ ] **Step 3: Create the component + helper**

`src/workbench-v2/viz/KnowledgeItem.tsx`:
```tsx
import { KNOWLEDGE_COLORS, labelFor, type KnowledgeItemType } from './knowledge-colors.js';

export function inferItemType(id: string): KnowledgeItemType {
  if (id.startsWith('cr-')) return 'code_ref';
  if (id.startsWith('spec-')) return 'spec';
  if (id.startsWith('mem-')) return 'memory';
  return 'wiki';
}

export function KnowledgeItem({
  id,
  title,
  itemType,
  sourceUri,
  tokens,
}: {
  id: string;
  title: string;
  itemType?: string;
  sourceUri?: string;
  tokens?: number;
}) {
  const type = (itemType as KnowledgeItemType | undefined) ?? inferItemType(id);
  const hex = KNOWLEDGE_COLORS[type as KnowledgeItemType]?.hex ?? KNOWLEDGE_COLORS.wiki.hex;
  return (
    <div
      data-id={id}
      style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:baseline;font-size:var(--fs-small);color:var(--paper-1)"
    >
      <span
        style={`flex:none;font-size:var(--fs-overline);letter-spacing:0.06em;color:var(--paper-0);padding:1px 6px;border-radius:4px;border:1px solid ${hex};background:${hex}22`}
      >
        {labelFor(type)}
      </span>
      <span style="min-width:0">
        <span style="color:var(--paper-0)">{title}</span>
        {sourceUri && (
          <span class="code" style="display:block;color:var(--paper-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            {sourceUri}
          </span>
        )}
        {typeof tokens === 'number' && (
          <span style="color:var(--paper-3);font-size:var(--fs-overline);margin-left:0"> · {tokens} tok</span>
        )}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/workbench-v2/knowledge-item-vm.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/workbench-v2/viz/KnowledgeItem.tsx test/workbench-v2/knowledge-item-vm.test.ts
git commit -m "feat(workbench-v2): human-readable KnowledgeItem row"
```

---

## Task 4: PackTimeline uses KnowledgeItem

**Files:**
- Modify: `src/workbench-v2/viz/PackTimeline.tsx` (lines 42-61)

The `PackItem` type already carries `id`, `title`, `tokens`. Pack items from the
fixture also carry an `itemType`/`sourceUri` in some callers; `PackItem` does not
include them, so `KnowledgeItem` will infer the type from the id prefix.

- [ ] **Step 1: Import KnowledgeItem**

In `src/workbench-v2/viz/PackTimeline.tsx`, add after line 4:
```ts
import { KnowledgeItem } from './KnowledgeItem.js';
```

- [ ] **Step 2: Replace the raw-id `<li>` rendering**

Replace the items `<ul>` block (lines 42-61) with:
```tsx
            {s.items.length > 0 && (
              <ul style="margin:10px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px">
                {s.items.map((i) => (
                  <li key={i.id} class="fade-in">
                    <KnowledgeItem id={i.id} title={i.title} tokens={i.tokens} />
                  </li>
                ))}
              </ul>
            )}
```

- [ ] **Step 3: Verify build**

Run: `pnpm run build:workbench`
Expected: clean.

- [ ] **Step 4: Verify VM tests still pass**

Run: `node --test --import tsx test/workbench-v2/pack-timeline-vm.test.ts`
Expected: PASS (toPackVM logic unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/workbench-v2/viz/PackTimeline.tsx
git commit -m "feat(workbench-v2): PackTimeline rows show readable items, not raw ids"
```

---

## Task 5: FitMeter VM + component

**Files:**
- Create: `src/workbench-v2/viz/fit-meter-vm.ts`
- Create: `src/workbench-v2/viz/FitMeter.tsx`
- Test: `test/workbench-v2/fit-meter-vm.test.ts`

- [ ] **Step 1: Write the failing test**

`test/workbench-v2/fit-meter-vm.test.ts`:
```ts
import test from 'node:test';
import { equal } from 'node:assert/strict';
import { fitStatusFromScore, fitMeterVM, DEFAULT_FIT_THRESHOLDS } from '../../src/workbench-v2/viz/fit-meter-vm.js';

test('status derives from score and thresholds', () => {
  equal(fitStatusFromScore(0.8, DEFAULT_FIT_THRESHOLDS), 'ready');
  equal(fitStatusFromScore(0.5, DEFAULT_FIT_THRESHOLDS), 'needs_confirmation');
  equal(fitStatusFromScore(0.2, DEFAULT_FIT_THRESHOLDS), 'insufficient');
});

test('fitMeterVM clamps percent and respects explicit status', () => {
  const vm = fitMeterVM({ score: 1.4, status: 'ready' });
  equal(vm.percent, 100);
  equal(vm.status, 'ready');
  equal(vm.label, 'ready');
  const vm2 = fitMeterVM({ score: 0.5 });
  equal(vm2.status, 'needs_confirmation');
  equal(vm2.label, 'needs confirmation');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/workbench-v2/fit-meter-vm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the VM**

`src/workbench-v2/viz/fit-meter-vm.ts`:
```ts
export type FitStatus = 'ready' | 'needs_confirmation' | 'insufficient';

export interface FitThresholds {
  needsConfirmation: number;
  ready: number;
}

export const DEFAULT_FIT_THRESHOLDS: FitThresholds = { needsConfirmation: 0.45, ready: 0.72 };

const LABELS: Record<FitStatus, string> = {
  ready: 'ready',
  needs_confirmation: 'needs confirmation',
  insufficient: 'insufficient',
};

export function fitStatusFromScore(score: number, t: FitThresholds): FitStatus {
  if (score >= t.ready) return 'ready';
  if (score >= t.needsConfirmation) return 'needs_confirmation';
  return 'insufficient';
}

export interface FitMeterVM {
  percent: number;
  status: FitStatus;
  label: string;
  thresholds: FitThresholds;
  missing: string[];
}

export function fitMeterVM(input: {
  score: number;
  status?: FitStatus | string;
  thresholds?: FitThresholds;
  missing?: string[];
}): FitMeterVM {
  const thresholds = input.thresholds ?? DEFAULT_FIT_THRESHOLDS;
  const percent = Math.max(0, Math.min(100, input.score * 100));
  const status =
    (input.status as FitStatus) && LABELS[input.status as FitStatus]
      ? (input.status as FitStatus)
      : fitStatusFromScore(input.score, thresholds);
  return { percent, status, label: LABELS[status], thresholds, missing: input.missing ?? [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/workbench-v2/fit-meter-vm.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Create the component**

`src/workbench-v2/viz/FitMeter.tsx`:
```tsx
import { fitMeterVM, type FitStatus, type FitThresholds } from './fit-meter-vm.js';

const TONE: Record<FitStatus, string> = {
  ready: 'good',
  needs_confirmation: 'warm',
  insufficient: 'bad',
};

export function FitMeter({
  score,
  status,
  thresholds,
  missing,
}: {
  score: number;
  status?: FitStatus | string;
  thresholds?: FitThresholds;
  missing?: string[];
}) {
  const vm = fitMeterVM({ score, status, thresholds, missing });
  const ncLeft = Math.min(100, vm.thresholds.needsConfirmation * 100);
  const readyLeft = Math.min(100, vm.thresholds.ready * 100);
  return (
    <div class="card" style="padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px">
        <span class="overline">fit score</span>
        <span class="pill" data-tone={TONE[vm.status]}>{vm.label}</span>
      </div>
      <div style="position:relative;height:10px;background:var(--ink-2);border-radius:5px;margin-top:12px">
        <div style={`position:absolute;inset:0;width:${vm.percent}%;background:linear-gradient(90deg,var(--copper),var(--terracotta));border-radius:5px`} />
        <span aria-hidden="true" style={`position:absolute;top:-4px;bottom:-4px;left:${ncLeft}%;width:1px;background:var(--paper-3)`} />
        <span aria-hidden="true" style={`position:absolute;top:-4px;bottom:-4px;left:${readyLeft}%;width:1px;background:var(--paper-1)`} />
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;color:var(--paper-3);font-size:var(--fs-overline);letter-spacing:0.06em">
        <span>insufficient</span>
        <span>needs confirmation</span>
        <span>ready</span>
      </div>
      <div style="margin-top:10px;color:var(--paper-2);font-size:var(--fs-small)">
        score {vm.percent.toFixed(0)} / 100
      </div>
      <div style="margin-top:6px;color:var(--paper-3);font-size:var(--fs-small)">
        {vm.missing.length === 0 ? 'missing: none' : `missing: ${vm.missing.join(', ')}`}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Verify build**

Run: `pnpm run build:workbench`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/workbench-v2/viz/fit-meter-vm.ts src/workbench-v2/viz/FitMeter.tsx test/workbench-v2/fit-meter-vm.test.ts
git commit -m "feat(workbench-v2): FitMeter threshold visualization"
```

---

## Task 6: Term jargon tooltip

**Files:**
- Create: `src/workbench-v2/viz/Term.tsx`

Presentational; no unit test. The `def` prop overrides the dictionary so callers
can inline a definition.

- [ ] **Step 1: Create the component**

`src/workbench-v2/viz/Term.tsx`:
```tsx
import type { ComponentChildren } from 'preact';

const TERMS: Record<string, string> = {
  fuse: 'Combine the separate ranked candidate lists into one, using weighted reciprocal-rank fusion.',
  rerank: 'Re-order the top slice of candidates with a reranker model for better precision.',
  FTS: 'Full-text search — Postgres lexical keyword matching.',
  fit: 'Context fit — the decision of whether retrieved context is ready, needs confirmation, or insufficient.',
  layered: 'Layered mode — after ranking, expand the chosen items into full source chunks within a deep-context budget.',
  reflection: 'A reviewed lesson saved after a session so the next agent reads it first.',
};

export function Term({ k, def, children }: { k?: string; def?: string; children: ComponentChildren }) {
  const text = def ?? (k ? TERMS[k] : undefined);
  if (!text) return <>{children}</>;
  return (
    <abbr
      title={text}
      aria-label={text}
      tabIndex={0}
      style="text-decoration:underline dotted;text-underline-offset:3px;cursor:help"
    >
      {children}
    </abbr>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm run build:workbench`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/workbench-v2/viz/Term.tsx
git commit -m "feat(workbench-v2): Term jargon tooltip component"
```

---

## Task 7: branch-labels data + test

**Files:**
- Create: `src/workbench-v2/data/branch-labels.ts`
- Test: `test/workbench-v2/branch-labels.test.ts`

The `BranchTag` union is declared in `src/workbench-v2/data/fixtures.ts` (lines 4-13).

- [ ] **Step 1: Write the failing test**

`test/workbench-v2/branch-labels.test.ts`:
```ts
import test from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { BRANCH_LABELS, branchLabel } from '../../src/workbench-v2/data/branch-labels.js';
import { acmeBilling } from '../../src/workbench-v2/data/fixtures.js';

test('every branch tag used by a prompt has a label', () => {
  for (const p of acmeBilling.prompts) {
    for (const b of p.branches) {
      ok(BRANCH_LABELS[b], `missing label for branch ${b}`);
    }
  }
});

test('branchLabel falls back to the raw tag', () => {
  equal(branchLabel('fit:ready'), 'Fit: ready');
  equal(branchLabel('unknown:tag' as never), 'unknown:tag');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/workbench-v2/branch-labels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the map**

`src/workbench-v2/data/branch-labels.ts`:
```ts
import type { BranchTag } from './fixtures.js';

export const BRANCH_LABELS: Record<BranchTag, string> = {
  'fit:ready': 'Fit: ready',
  'fit:needs_confirmation': 'Fit: needs confirmation',
  'fit:insufficient': 'Fit: insufficient',
  'source:labels': 'Label/metadata hit',
  'source:fts': 'Full-text search hit',
  'source:vector': 'Vector search hit',
  'source:memory': 'Reviewed-memory hit',
  'source:graph': 'Graph-relation expansion',
  'adjust:memory_boost': 'Memory boost applied',
  'adjust:stale_penalty': 'Stale penalty applied',
  'adjust:superseded': 'Superseded penalty applied',
  'mode:strict_noise': 'Strict noise tolerance',
  'mode:layered_deep_context': 'Layered deep context',
  'classifier:symbols': 'Symbols extracted',
  'classifier:errors': 'Errors extracted',
  'classifier:business_areas': 'Business areas extracted',
  'classifier:empty': 'No signals extracted',
};

export function branchLabel(tag: BranchTag): string {
  return BRANCH_LABELS[tag] ?? (tag as string);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/workbench-v2/branch-labels.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/workbench-v2/data/branch-labels.ts test/workbench-v2/branch-labels.test.ts
git commit -m "feat(workbench-v2): plain-language branch tag labels"
```

---

## Task 8: Ch03 — strip pipeline/pack to a big-picture framing

**Files:**
- Modify: `src/workbench-v2/chapters/Ch03_Anatomy.tsx` (full rewrite)

- [ ] **Step 1: Rewrite the chapter**

Replace the entire contents of `src/workbench-v2/chapters/Ch03_Anatomy.tsx` with:
```tsx
import { useEffect, useRef } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { Term } from '../viz/Term.js';

const STAGES = ['classify', 'search', 'rank', 'fit', 'assemble'];

export default function Ch03_Anatomy() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 3) : undefined), []);
  return (
    <section id="ch3" class="chapter" data-numeral="03" ref={ref}>
      <span class="overline">A session, end to end</span>
      <h2 style="margin-top:var(--space-4)">The big picture</h2>
      <p class="lead">One prompt in. Three groups of context out. About eighty milliseconds.</p>
      <div class="card" style="margin-top:var(--space-4);display:flex;gap:var(--space-3);align-items:baseline">
        <span class="overline" style="flex:none">Prompt</span>
        <span style="font-family:var(--font-display);font-style:italic;font-size:18px;color:var(--paper-0)">
          "Where does paywall logic live?"
        </span>
      </div>
      <div
        class="fade-in"
        style="margin-top:var(--space-5);display:flex;align-items:center;gap:10px;flex-wrap:wrap"
      >
        <span class="pill" data-tone="neutral">prompt</span>
        <span style="color:var(--paper-3)">→</span>
        {STAGES.map((s) => (
          <span key={s} class="pill">{s}</span>
        ))}
        <span style="color:var(--paper-3)">→</span>
        <span class="pill" data-tone="good">essential · supporting · optional</span>
      </div>
      <p style="margin-top:var(--space-5);color:var(--paper-2);max-width:60ch">
        Ten short stages turn a question into a ranked, budgeted context pack. We{' '}
        <Term k="fuse">fuse</Term> several search sources, <Term k="rerank">rerank</Term>{' '}
        the top slice, decide context <Term k="fit">fit</Term>, and assemble the pack. The next
        chapter lets you click into each stage.
      </p>
    </section>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm run build:workbench`
Expected: clean. (The old `SignalChips`/`PipelineFlow`/`PackTimeline` imports are gone.)

- [ ] **Step 3: Commit**

```bash
git add src/workbench-v2/chapters/Ch03_Anatomy.tsx
git commit -m "feat(workbench-v2): Ch03 becomes a big-picture framing, no pipeline/pack"
```

---

## Task 9: Ch04 — stage-aware detail panel (Fit meter + Assemble pack)

**Files:**
- Modify: `src/workbench-v2/chapters/Ch04_Pipeline.tsx` (imports + render body lines 114-149)

- [ ] **Step 1: Add imports**

In `src/workbench-v2/chapters/Ch04_Pipeline.tsx`, after line 7 (`import type { GraphInput }...`):
```ts
import { GraphLegend } from '../viz/GraphLegend.js';
import { FitMeter } from '../viz/FitMeter.js';
import { PackTimeline } from '../viz/PackTimeline.js';
import { toPackVM } from '../viz/pack-timeline-vm.js';
```

- [ ] **Step 2: Add a demo assemble-pack constant**

After the `TIMINGS` block (after line 20), add:
```ts
const ASSEMBLE_PACK = {
  essential: [
    { id: 'cr-paywall-001', title: 'PaywallSelectionModal', tokens: 220 },
    { id: 'cr-paywall-002', title: 'paywall guard in src/billing/guard.ts', tokens: 180 },
  ],
  supporting: [{ id: 'spec-subscription-tiers', title: 'Subscription tiers', tokens: 180 }],
  optional: [],
};
```

- [ ] **Step 3: Replace the right-hand panel render**

Replace the right-column `<div>` block (the panel after `<PipelineFlow ... />`, lines 127-145) with a stage-aware switch:
```tsx
        <div>
          <h3 style="margin-bottom:var(--space-3)">
            {steps.find((s) => s.id === sel)?.title.replace(/^\d+\s*·\s*/, '')}
            <span style="color:var(--paper-3);font-weight:400"> · produced</span>
          </h3>
          {sel === 'fit' ? (
            <FitMeter score={0.78} status="ready" missing={[]} />
          ) : sel === 'assemble' ? (
            <PackTimeline vm={toPackVM(ASSEMBLE_PACK)} />
          ) : stageInput.items.length === 0 ? (
            <div class="card" style="height:460px;display:grid;place-items:center;color:var(--paper-3);font-style:italic">
              this stage produced no candidates
            </div>
          ) : (
            <>
              <GraphCanvas
                input={stageInput}
                layout={sel === 'fuse' || sel === 'rerank' ? 'dagre' : 'cose'}
              />
              <GraphLegend types={stageInput.items.map((i) => i.itemType)} />
            </>
          )}
        </div>
```

- [ ] **Step 4: Remove the now-dead `fit`/`assemble` graph cases (optional cleanup)**

In `graphForStep` (lines 79-96), the `fit` and `assemble` cases are no longer
reached by the render. Leave them — they are harmless and `graphForStep` is still
called for `stageInput` before the switch. (Do NOT delete `stageInput`; the
`default`/other cases still use it.) No code change in this step; just confirm
`stageInput` is still computed at line 119.

- [ ] **Step 5: Verify build**

Run: `pnpm run build:workbench`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/workbench-v2/chapters/Ch04_Pipeline.tsx
git commit -m "feat(workbench-v2): Ch04 Fit meter + Assemble pack, legend on graphs"
```

---

## Task 10: Ch06 — reframe reflections lifecycle + readable items + animated boost

**Files:**
- Modify: `src/workbench-v2/chapters/Ch06_Reflections.tsx` (full rewrite of render)

- [ ] **Step 1: Rewrite the chapter**

Replace the entire contents of `src/workbench-v2/chapters/Ch06_Reflections.tsx` with:
```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { acmeBilling } from '../data/fixtures.js';
import { KnowledgeItem } from '../viz/KnowledgeItem.js';
import { Term } from '../viz/Term.js';

const LIFECYCLE = [
  { n: 1, label: 'Session ends', detail: 'An agent finishes a task.' },
  { n: 2, label: 'Draft captured', detail: 'Tuberosa drafts a lesson.' },
  { n: 3, label: 'Reviewer approves', detail: 'A human approves it.' },
  { n: 4, label: 'Next agent reads it', detail: 'It ranks first next time.' },
];

export default function Ch06_Reflections() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 6) : undefined), []);
  const [approved, setApproved] = useState(false);

  const reflection = acmeBilling.items.find((i) => i.id === 'mem-migration-step-missed');

  const baseline = [
    { id: 'cr-auth-middleware-001', title: 'authMiddleware', sourceUri: 'src/auth/middleware.ts' },
    { id: 'cr-auth-token-service', title: 'AuthTokenService', sourceUri: 'src/auth/tokens.ts' },
    { id: 'cr-user-service', title: 'UserService', sourceUri: 'src/user/user-service.ts' },
  ];

  return (
    <section id="ch6" class="chapter" data-numeral="06" ref={ref}>
      <span class="overline">Reflections</span>
      <h2 style="margin-top:var(--space-4)">Reflections that learn</h2>
      <p class="lead">
        A <Term k="reflection">reflection</Term> is a reviewed lesson. Approve one and watch the
        next agent's ranking change.
      </p>

      <ol style="margin:var(--space-4) 0 0;padding:0;list-style:none;display:flex;gap:8px;flex-wrap:wrap">
        {LIFECYCLE.map((s) => (
          <li
            key={s.n}
            class="card"
            style={`flex:1;min-width:140px;border-color:${approved && s.n <= 3 ? 'var(--good)' : 'var(--line)'};transition:border-color var(--anim-med)`}
          >
            <span class="overline">step {s.n}</span>
            <strong style="display:block;font-family:var(--font-display);font-weight:500;margin-top:4px">{s.label}</strong>
            <span style="color:var(--paper-3);font-size:var(--fs-small)">{s.detail}</span>
          </li>
        ))}
      </ol>

      <div
        class="card fade-in"
        style={`margin-top:var(--space-4);border-color:${approved ? 'var(--good)' : 'var(--copper-deep)'};transition:border-color var(--anim-med)`}
      >
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-3)">
          <strong style="font-family:var(--font-display);font-weight:500;font-size:18px;color:var(--paper-0)">
            {reflection?.title}
          </strong>
          <span class="pill" data-tone={approved ? 'good' : 'warm'}>{approved ? 'approved' : 'draft'}</span>
        </div>
        <p style="color:var(--paper-2);font-size:var(--fs-small);margin-top:var(--space-2);line-height:1.55">
          {reflection?.content.slice(0, 220)}…
        </p>
        {!approved && (
          <button class="primary" style="margin-top:var(--space-3)" onClick={() => setApproved(true)}>
            Approve reflection
          </button>
        )}
      </div>

      <h3 style="margin-top:var(--space-6)">Before & after on the same prompt</h3>
      <div class="split-2" style="margin-top:var(--space-2)">
        <div class="card">
          <span class="overline">Without memory</span>
          <ol style="margin:var(--space-3) 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px">
            {baseline.map((r, i) => (
              <li key={r.id} style="display:grid;grid-template-columns:24px 1fr;gap:8px;align-items:baseline">
                <span style="font-family:var(--font-display);color:var(--paper-3);font-variant-numeric:tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <KnowledgeItem id={r.id} title={r.title} itemType="code_ref" sourceUri={r.sourceUri} />
              </li>
            ))}
          </ol>
        </div>
        <div class="card" style={`border-color:${approved ? 'var(--good)' : 'var(--line)'};transition:border-color var(--anim-med)`}>
          <span class="overline">With reviewed memory</span>
          <ol style="margin:var(--space-3) 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px">
            {approved && (
              <li class="fade-in" style="display:grid;grid-template-columns:24px 1fr;gap:8px;align-items:baseline">
                <span style="font-family:var(--font-display);color:var(--sage);font-variant-numeric:tabular-nums">01</span>
                <KnowledgeItem id="mem-migration-step-missed" title="Missed migration step lesson" itemType="memory" />
              </li>
            )}
            {baseline.map((r, i) => (
              <li key={r.id} style="display:grid;grid-template-columns:24px 1fr;gap:8px;align-items:baseline">
                <span style="font-family:var(--font-display);color:var(--paper-3);font-variant-numeric:tabular-nums">
                  {String(i + 1 + (approved ? 1 : 0)).padStart(2, '0')}
                </span>
                <KnowledgeItem id={r.id} title={r.title} itemType="code_ref" sourceUri={r.sourceUri} />
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm run build:workbench`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/workbench-v2/chapters/Ch06_Reflections.tsx
git commit -m "feat(workbench-v2): clearer reflection lifecycle with animated rank boost"
```

---

## Task 11: Ch07 — branch labels + readable pack + FitMeter

**Files:**
- Modify: `src/workbench-v2/chapters/Ch07_TryIt.tsx` (imports + branch pills + replay panel)

- [ ] **Step 1: Add imports**

In `src/workbench-v2/chapters/Ch07_TryIt.tsx`, after line 9 (`import { toPackVM }...`):
```ts
import { branchLabel } from '../data/branch-labels.js';
import { FitMeter } from '../viz/FitMeter.js';
import { fitStatusFromScore } from '../viz/fit-meter-vm.js';
```

- [ ] **Step 2: Add a one-line branch caption above the prompt grid**

Immediately after `<p class="lead">Click any card to replay it.</p>` (line 61), add:
```tsx
      <p style="color:var(--paper-3);font-size:var(--fs-small);margin-top:6px">
        Pills show which branches each prompt exercises — search sources, ranking adjustments, and the fit verdict.
      </p>
```

- [ ] **Step 3: Render branch pills with plain-language labels**

Replace the branch pill map (lines 81-85) with:
```tsx
              {p.branches.map((b) => (
                <span key={b} class="pill" data-tone="neutral">
                  {branchLabel(b)}
                </span>
              ))}
```

- [ ] **Step 4: Add a FitMeter to the replay panel**

In the replay panel, replace the fit pill block (lines 101-108) with a FitMeter.
The replay's `contextFit` only has `fitStatus`, so map status→an indicative score:
```tsx
            <div style="margin-top:var(--space-3)">
              <FitMeter
                score={
                  replay.contextFit.fitStatus === 'ready'
                    ? 0.8
                    : replay.contextFit.fitStatus === 'needs_confirmation'
                      ? 0.55
                      : 0.3
                }
                status={replay.contextFit.fitStatus}
              />
            </div>
```
(`fitStatusFromScore` is imported for type/consistency parity with other chapters; if unused after this edit, remove the import to satisfy the linter.)

- [ ] **Step 5: Verify build**

Run: `pnpm run build:workbench`
Expected: clean. (PackTimeline now renders readable items via Task 4.)

- [ ] **Step 6: Commit**

```bash
git add src/workbench-v2/chapters/Ch07_TryIt.tsx
git commit -m "feat(workbench-v2): Ch07 plain-language branches + fit meter"
```

---

## Task 12: store — dataSource + connection signal + health probe

**Files:**
- Modify: `src/workbench-v2/state/store.ts`

- [ ] **Step 1: Replace `demoMode` with `dataSource` + add `connection`**

In `src/workbench-v2/state/store.ts`, replace line 7 (`export const demoMode ...`) with:
```ts
export type DataSource = 'seeded' | 'live';
export const dataSource = signal<DataSource>('seeded');

export type ConnectionState = 'unknown' | 'connected' | 'offline';
export const connection = signal<ConnectionState>('unknown');

let probed = false;
export async function probeConnection(): Promise<void> {
  if (probed) return;
  probed = true;
  try {
    const res = await fetch('/health', { headers: { accept: 'application/json' } });
    connection.value = res.ok ? 'connected' : 'offline';
  } catch {
    connection.value = 'offline';
  }
}
```

- [ ] **Step 2: Verify build (expect DemoToggle to break — fixed next task)**

Run: `pnpm run build:workbench`
Expected: FAIL — `shell/DemoToggle.tsx` still imports `demoMode`. This is expected;
Task 13 fixes it. (If using strict CI gating, combine Tasks 12 and 13 into one commit.)

- [ ] **Step 3: Commit (with Task 13) — defer**

Do not commit yet; proceed to Task 13, then commit both together.

---

## Task 13: DemoToggle — wire dataSource + connection indicator + tooltip

**Files:**
- Modify: `src/workbench-v2/shell/DemoToggle.tsx` (full rewrite)

- [ ] **Step 1: Rewrite DemoToggle**

Replace the entire contents of `src/workbench-v2/shell/DemoToggle.tsx` with:
```tsx
import { useEffect } from 'preact/hooks';
import { connection, dataSource, probeConnection } from '../state/store.js';

export function DemoToggle() {
  const mode = dataSource.value;
  const conn = connection.value;
  useEffect(() => {
    void probeConnection();
  }, []);
  const dotColor = conn === 'connected' ? 'var(--good)' : conn === 'offline' ? 'var(--bad)' : 'var(--paper-3)';
  const connLabel =
    conn === 'connected' ? 'connected' : conn === 'offline' ? 'offline — showing seeded' : 'checking…';
  return (
    <div class="demo-toggle" title="Seeded uses bundled demo data. Live reads this checkout's running Tuberosa server.">
      <span class="pill" data-tone={mode === 'seeded' ? 'neutral' : 'warm'}>{mode}</span>
      <button
        class="ghost"
        onClick={() => {
          dataSource.value = mode === 'seeded' ? 'live' : 'seeded';
        }}
      >
        → {mode === 'seeded' ? 'live' : 'seeded'}
      </button>
      <span style="display:inline-flex;align-items:center;gap:6px;margin-left:10px;color:var(--paper-3);font-size:var(--fs-overline)">
        <span aria-hidden="true" style={`width:8px;height:8px;border-radius:50%;background:${dotColor}`} />
        {connLabel}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm run build:workbench`
Expected: clean.

- [ ] **Step 3: Commit Tasks 12 + 13 together**

```bash
git add src/workbench-v2/state/store.ts src/workbench-v2/shell/DemoToggle.tsx
git commit -m "feat(workbench-v2): wire data source toggle + backend connection indicator"
```

---

## Task 14: Ch09 — seeded example replay fallback

**Files:**
- Modify: `src/workbench-v2/chapters/Ch09_YourSessions.tsx`

When `dataSource` is `seeded`, or live calls yield no sessions / a 404 replay,
render a bundled example replay (reuse `p1.json`) tagged "example".

- [ ] **Step 1: Add imports + example replay**

In `src/workbench-v2/chapters/Ch09_YourSessions.tsx`, after line 10
(`import { toPackVM }...`), add:
```ts
import { FitMeter } from '../viz/FitMeter.js';
import { dataSource } from '../state/store.js';
import exampleReplay from '../data/demo/replays/p1.json' with { type: 'json' };
```

- [ ] **Step 2: Add an example-replay renderer helper inside the component**

Inside `Ch09_YourSessions`, before `return (`, add:
```tsx
  const ex = exampleReplay as unknown as ReplayBundle;
  const showExample =
    dataSource.value === 'seeded' || (sessions !== null && sessions.length === 0) || replayError === 'missing';

  const ExampleReplay = () => (
    <div class="card" data-tone="neutral" style="margin-top:16px;border-color:var(--line)">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="pill" data-tone="neutral">example</span>
        <span style="color:var(--paper-3);font-size:var(--fs-small)">
          Seeded sample. Enable <span class="code">TUBEROSA_PERSIST_REPLAY=true</span> and finish a session to see your own.
        </span>
      </div>
      <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <h3>Signals</h3>
          <SignalChips chips={toSignalChips(ex.classifier)} />
          <h3 style="margin-top:16px">Pipeline</h3>
          <PipelineFlow steps={pipelineSteps(ex.timings.stageMs)} />
        </div>
        <div>
          <h3>Pack</h3>
          <PackTimeline vm={toPackVM(ex.pack)} />
          {ex.contextFit?.fitStatus && (
            <div style="margin-top:12px">
              <FitMeter score={ex.contextFit.fitStatus === 'ready' ? 0.8 : 0.5} status={ex.contextFit.fitStatus} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
```

- [ ] **Step 3: Render the example fallback when there is no live replay**

In the render body, after the existing `{replay && (...)}` block (around line 147,
inside `<details>`), add:
```tsx
        {!replay && showExample && <ExampleReplay />}
```

- [ ] **Step 4: Verify build**

Run: `pnpm run build:workbench`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/workbench-v2/chapters/Ch09_YourSessions.tsx
git commit -m "feat(workbench-v2): Ch09 seeded example replay fallback"
```

---

## Task 15: Ch10 — interactive approve/reject of pending drafts

**Files:**
- Modify: `src/workbench-v2/chapters/Ch10_TuneOps.tsx`

The summary returns `pendingDrafts: Array<{ id; title; summary; itemType; status }>`.
Approve → `POST /reflection-drafts/{id}/approve`. Reject →
`POST /reflection-drafts/{id}/review` body `{ decision: 'reject' }`.

- [ ] **Step 1: Add imports + draft type + acting state**

In `src/workbench-v2/chapters/Ch10_TuneOps.tsx`:
- Update the import on line 3 to include `pushToast`:
```ts
import { api } from '../data/api.js';
import { apiKey, currentProject, setApiKey, pushToast } from '../state/store.js';
```
- Add a draft type to the `WorkbenchSummary` interface: change `pendingDrafts?` (line 14) to:
```ts
  pendingDrafts?: Array<{ id: string; title?: string; summary?: string; itemType?: string }>;
```
- Inside the component, after `const [limit, setLimit] = useState(10);` (line 28), add:
```ts
  const [acting, setActing] = useState<string | null>(null);

  async function actOnDraft(id: string, action: 'approve' | 'reject'): Promise<void> {
    setActing(id);
    try {
      if (action === 'approve') {
        await api(`/reflection-drafts/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' });
      } else {
        await api(`/reflection-drafts/${encodeURIComponent(id)}/review`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'reject' }),
        });
      }
      pushToast(`Draft ${action === 'approve' ? 'approved' : 'rejected'}`, 'good');
      refresh();
    } catch {
      // api() already toasts the error
    } finally {
      setActing(null);
    }
  }
```

- [ ] **Step 2: Render draft rows with Approve/Reject in the Review card**

In the Review card `<div class="card">` (lines 57-64), after the existing `<Row .../>`
lines and before the closing `</div>`, add a draft list:
```tsx
              {summary.pendingDrafts && summary.pendingDrafts.length > 0 && (
                <ul style="margin:12px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px">
                  {summary.pendingDrafts.map((d) => (
                    <li key={d.id} class="card" style="padding:10px 12px">
                      <strong style="font-size:13px;display:block;overflow:hidden;text-overflow:ellipsis">{d.title ?? d.id}</strong>
                      {d.summary && (
                        <span style="color:var(--fg-muted);font-size:12px;display:block;margin-top:2px">{d.summary}</span>
                      )}
                      <div style="display:flex;gap:8px;margin-top:8px">
                        <button class="primary" disabled={acting === d.id} onClick={() => actOnDraft(d.id, 'approve')}>
                          Approve
                        </button>
                        <button class="ghost" disabled={acting === d.id} onClick={() => actOnDraft(d.id, 'reject')}>
                          Reject
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
```

- [ ] **Step 3: Verify build**

Run: `pnpm run build:workbench`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/workbench-v2/chapters/Ch10_TuneOps.tsx
git commit -m "feat(workbench-v2): Ch10 inline approve/reject of pending drafts"
```

---

## Task 16: ProgressRail — reading-progress fill

**Files:**
- Modify: `src/workbench-v2/shell/ProgressRail.tsx`

- [ ] **Step 1: Add a progress fill driven by activeChapter**

In `src/workbench-v2/shell/ProgressRail.tsx`, inside the `<nav>` (before the `<ol>`,
after line 23), add a progress bar. Replace the `return (...)` body with:
```tsx
  const active = activeChapter.value;
  const pct = (active / CHAPTERS.length) * 100;
  return (
    <nav class="progress-rail" aria-label="Chapters">
      <div
        class="progress-rail-fill"
        role="progressbar"
        aria-valuenow={active}
        aria-valuemin={1}
        aria-valuemax={CHAPTERS.length}
        style={`position:absolute;left:0;top:0;width:2px;height:${pct}%;background:var(--copper);transition:height var(--anim-med)`}
      />
      <ol>
        {CHAPTERS.map((n) => (
          <li key={n}>
            <a
              href={`#/ch${n}`}
              onClick={(e) => {
                e.preventDefault();
                setRoute({ ...route.value, chapter: n });
                document.getElementById(`ch${n}`)?.scrollIntoView({ behavior: 'smooth' });
              }}
              aria-current={active === n ? 'true' : undefined}
            >
              <strong>{n}</strong>
              <span>{TITLES[n]}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
```

- [ ] **Step 2: Ensure the rail is a positioning context**

In `src/workbench-v2/styles/main.css`, find the `.progress-rail` rule and ensure it
has `position: relative;`. If it already has a `position`, leave it; otherwise add
`position: relative;` to that rule. (Search: `grep -n "progress-rail" src/workbench-v2/styles/main.css`.)

- [ ] **Step 3: Verify build**

Run: `pnpm run build:workbench`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/workbench-v2/shell/ProgressRail.tsx src/workbench-v2/styles/main.css
git commit -m "feat(workbench-v2): reading-progress fill in chapter rail"
```

---

## Task 17: Re-enable AutoTour + wire Ch01 button

**Files:**
- Modify: `src/workbench-v2/shell/AutoTour.tsx`, `src/workbench-v2/app.tsx`, `src/workbench-v2/chapters/Ch01_Hello.tsx`

- [ ] **Step 1: Export a `startTour` and extend the SCRIPT**

In `src/workbench-v2/shell/AutoTour.tsx`:
- Add two entries to `SCRIPT` (after the Ch08 entry, before the closing `]` at line 13):
```ts
  { chapter: 9, caption: 'Inspect your own sessions from this checkout.', dwellMs: 6000 },
  { chapter: 10, caption: 'Review queues and operate the system.', dwellMs: 6000 },
```
- Update the Ch03 caption (line 7) to:
```ts
  { chapter: 3, caption: 'The big picture: prompt in, three groups of context out.', dwellMs: 7000 },
```
- Export a `startTour` function (after the `step` function, before `export function AutoTour`):
```ts
export function startTour(): void {
  clear();
  step(0);
}
```

- [ ] **Step 2: Re-enable AutoTour in app.tsx**

In `src/workbench-v2/app.tsx`, change line 24 from:
```tsx
        {/* <AutoTour /> */}
```
to:
```tsx
        <AutoTour />
```

- [ ] **Step 3: Wire the Ch01 button to start the tour**

In `src/workbench-v2/chapters/Ch01_Hello.tsx`:
- Add import after line 3: `import { startTour } from '../shell/AutoTour.js';`
- Replace the "Start the tour →" button onClick (lines 94-98) with:
```tsx
          onClick={() => {
            startTour();
          }}
```
- Update the helper text (line 102-104) to: `Or just scroll. Ten short chapters.`

- [ ] **Step 4: Verify build**

Run: `pnpm run build:workbench`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/workbench-v2/shell/AutoTour.tsx src/workbench-v2/app.tsx src/workbench-v2/chapters/Ch01_Hello.tsx
git commit -m "feat(workbench-v2): re-enable guided tour and wire Ch01 start button"
```

---

## Task 18: Full verification

**Files:** none (verification only)

- [ ] **Step 1: TypeScript compile (whole repo)**

Run: `pnpm run build`
Expected: PASS — no TS errors across `tsconfig.json`, `tsconfig.workbench.json`, and the bundle build.

- [ ] **Step 2: Backend unit suite**

Run: `pnpm test`
Expected: PASS (no backend logic changed).

- [ ] **Step 3: Workbench VM tests**

Run:
```bash
node --test --import tsx test/workbench-v2/knowledge-colors.test.ts test/workbench-v2/knowledge-item-vm.test.ts test/workbench-v2/fit-meter-vm.test.ts test/workbench-v2/branch-labels.test.ts test/workbench-v2/pack-timeline-vm.test.ts
```
Expected: all PASS.

- [ ] **Step 4: Browser test**

Run: `pnpm run test:workbench-browser`
Expected: PASS, or — if Chrome is unavailable in this environment — state that explicitly and fall back to manual verification.

- [ ] **Step 5: Manual browser check**

Start: `TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run dev` and open `http://localhost:3027/workbench` (confirm the workbench route; otherwise the bundle path served by the server). Verify:
- Ch03 shows the big-picture row only (no pipeline/pack).
- Ch04: clicking `Fit` shows the meter; `Assemble` shows pack bars; other stages show a graph with a legend.
- Ch05 has a legend; no raw `cr-…`/`mem-…` ids appear in Ch05 aside, Ch06, or Ch07 packs.
- Ch06: approve animates the memory into rank 01 of the "with memory" column.
- Ch07: branch pills read as plain language; replay shows a fit meter.
- Toggle flips seeded↔live; the connection dot reflects backend reachability.
- Ch09: with no live replay, the "example" replay renders.
- Ch10: with at least one pending draft, Approve/Reject acts and counts refresh. If no pending drafts exist locally, verify the empty Review card renders and **state that the action path could not be exercised**.
- AutoTour: Ch01 "Start the tour →" plays the tour; reduced-motion disables auto-scroll.

State plainly any check that could not be run rather than claiming success.

- [ ] **Step 6: GitNexus change check**

Run: `npx gitnexus analyze` then verify scope is limited to workbench-v2 files (per repo CLAUDE.md). Report blast radius if anything unexpected appears.

---

## Task 19: frontend-design polish pass (FINAL)

**Files:** workbench-v2 chapters/viz/styles touched above (visual refinement only).

- [ ] **Step 1: Invoke the frontend-design skill**

Use the `frontend-design:frontend-design` skill to polish visual quality across the
updated chapters and new components (`GraphLegend`, `KnowledgeItem`, `FitMeter`,
`Term`, Ch03/Ch04/Ch06 layouts, DemoToggle indicator, ProgressRail fill): spacing,
type scale, color harmony, motion timing, and responsive behavior. **Behavior must
not change** — this is presentation only.

- [ ] **Step 2: Re-verify after polish**

Run: `pnpm run build && pnpm run test:workbench-browser`
Expected: PASS (or manual fallback as in Task 18).

- [ ] **Step 3: Commit**

```bash
git add -A src/workbench-v2
git commit -m "style(workbench-v2): frontend-design polish pass"
```

---

## Self-Review notes

- **Spec coverage:** Ch03/Ch04 merge → Tasks 8-9; node colors/legend → Tasks 1-2,9; Fit/Assemble → Tasks 5,9; live/seeded + connection → Tasks 12-13; readable ids → Tasks 3-4,10-11; Ch06 reflection → Task 10; Ch07 branches/detail → Tasks 7,11; Ch09 fallback → Task 14; Ch10 interactive → Task 15; AutoTour → Task 17; progress fill → Task 16; jargon tooltips → Tasks 6,8,10; frontend-design final → Task 19; accessibility woven into each component (text labels, aria, focusable abbr).
- **Type consistency:** `inferItemType`/`KnowledgeItem` (Task 3) reused by Tasks 4,10,11,14; `fitMeterVM`/`FitMeter` (Task 5) reused by Tasks 9,11,14; `dataSource`/`connection`/`probeConnection` (Task 12) consumed by Tasks 13,14; `branchLabel` (Task 7) consumed by Task 11.
- **Known runtime dependency:** Ch10's approve/reject path requires a live backend with a pending draft; Task 18 calls this out as possibly un-exercisable locally rather than assuming success.
- **Ordering caveat:** Tasks 12 and 13 are committed together because removing `demoMode` breaks `DemoToggle` until rewritten.
