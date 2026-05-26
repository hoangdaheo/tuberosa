# Workbench v2 — UX fixes & guidance pass

**Date:** 2026-05-27
**Surface:** `src/workbench-v2/` (Preact long-scroll explainer, 10 chapters)
**Goal:** Resolve eight concrete UX complaints, make the demo coherent, and guide
first-time readers better. No backend changes — every endpoint used already exists.

A final polish pass with the `frontend-design` skill runs **after** implementation
and verification are complete (see "Sequencing").

---

## Background

The workbench is a scroll-driven explainer for Tuberosa. The shell (`app.tsx`)
renders a `ProgressRail`, a `DemoToggle`, ten chapters (`Ch01`–`Ch10`), and a
`Toasts` host. Reusable visualizations live in `viz/`: `SignalChips`,
`PipelineFlow`, `PackTimeline`, `GraphCanvas`. Seeded demo data is
`data/demo/acme-billing.json` (exposed via `data/fixtures.ts`); ten curated prompt
replays live in `data/demo/replays/p1..p10.json`. Live data is fetched through
`data/api.ts` against the running HTTP server.

The complaints fall into three buckets: **redundancy** (Ch03/Ch04),
**unexplained visuals** (node colors, Fit/Assemble, raw ids, branch pills),
and **dead/empty interactivity** (live/seeded toggle, Ch09, Ch10).

---

## Decisions (locked with the user)

1. Ch03 and Ch04 duplication → **merge**: Ch03 becomes a short "big picture"
   framing; Ch04 is the single interactive pipeline/pack chapter.
2. live/seeded toggle → **wire it up** with a backend connection indicator.
3. Synthetic ids (`cr-paywall-001`) → **human-readable** display; raw id dropped
   from the primary view.
4. Fit stage → **threshold meter** + missing-signals list.
5. Assemble stage → **reuse `PackTimeline`**.
6. Ch09 (your sessions) → **seeded example fallback** when no live replay exists.
7. Ch10 (tune & operate) → **interactive**: approve/reject pending reflection
   drafts inline.
8. Guidance enhancements: **re-enable AutoTour**, a **shared legend/key**,
   **connection status**, plus lightweight **jargon tooltips** and a
   **reading-progress fill**.

---

## Shared building blocks (build first; everything else depends on them)

### B1. `viz/knowledge-colors.ts` — single source of node colors

Extract the `NODE_FILL` map currently inline in `GraphCanvas.tsx` into one
exported constant keyed by `itemType`:

| itemType   | token / hex            | label  |
|------------|------------------------|--------|
| `code_ref` | copper `#d4a574`       | code   |
| `spec`     | terracotta `#c46a4d`   | spec   |
| `memory`   | sage `#8fae7e`         | memory |
| `wiki`     | paper-2 `#948b7c`      | wiki   |

`GraphCanvas` imports from here instead of defining its own map.

### B2. `viz/GraphLegend.tsx`

Small horizontal legend: a swatch + label per item type, driven by B1. Rendered
directly under every `GraphCanvas` instance (Ch04 stages, Ch05). Accepts an
optional `types` prop to show only the types present in the current graph.

### B3. `viz/KnowledgeItem.tsx` — human-readable item row

Replaces bare-id rendering. Props: `{ id, title, itemType, sourceUri?, tokens? }`.
Renders: a type badge (color from B1, label from B1) + title + dim source path.
The raw `id` is **not** shown in the primary line. `data-id={id}` is kept on the
element for traceability/testing.

Consumed by `PackTimeline` (item rows), Ch06 before/after lists, Ch07 replay pack.
Where a fixture lacks `sourceUri`, fall back to showing nothing for the path line
(never the synthetic id).

> `acme-billing.json` items carry `sourceUri`; replay pack items
> (`{id,title,tokens}`) do not. For replay packs, `KnowledgeItem` shows
> badge + title only. The badge type for replay items is derived from an
> id-prefix heuristic (`cr-`→code_ref, `spec-`→spec, `mem-`→memory, else wiki),
> isolated in a `inferItemType(id)` helper in `KnowledgeItem.tsx`.

### B4. `viz/Term.tsx` — jargon tooltip (enhancement #3, scoped)

A `<Term def="…">word</Term>` inline component: dotted underline, native
`title`-style tooltip via an accessible pattern (`<abbr>` with `title`, plus
`aria-label`). A small `TERMS` dictionary in `Term.tsx` holds definitions for a
**fixed key set only**: `fuse`, `rerank`, `FTS`, `fit`, `layered`, `reflection`.
Not exhaustive — just the highest-friction insider terms. Authors opt in by
wrapping a word; no automatic scanning.

---

## Chapter changes

### Ch03 — "Big picture" (strip pipeline/pack)

Remove `SignalChips`, `PipelineFlow`, `PackTimeline` and their timing/IO setup.
Keep the prompt card and replace the split with a compact framing graphic:
**prompt in → [classify · search · rank · fit · assemble] → three groups of
context out, ~80 ms.** Static SVG or styled flex row; no Cytoscape. One sentence
of `Term`-annotated prose. This chapter no longer competes with Ch04.

### Ch04 — Pipeline, stage by stage (fix Fit & Assemble)

Keep `PipelineFlow` on the left and the per-stage detail panel on the right, but
make the **right panel stage-aware** instead of always rendering a graph:

- `classify`, `search`, `fuse`, `rerank`, `adjust`, `deep` → `GraphCanvas`
  (+ `GraphLegend` underneath).
- `fit` → new `viz/FitMeter.tsx`: a horizontal track showing `fitScore` against
  the `needs_confirmation` (0.45) and `ready` (0.72) thresholds, the status badge
  (ready / needs confirmation / insufficient), and a missing-signals list. Demo
  values come from a small inline `fit` fixture for the paywall prompt.
- `assemble` → `PackTimeline` (reuse), fed by the same paywall pack used in the
  old Ch03 plus one supporting item, so it shows essential/supporting/optional
  bars with `KnowledgeItem` rows.

`FitMeter` takes `{ score, status, thresholds: {needsConfirmation, ready},
missing: string[] }` and is pure/presentational so Ch07's replay panel can reuse
it.

Stage blurbs in `pipeline-flow-vm.ts` may wrap key terms in `Term`.

### Ch05 — Knowledge graph

Add `GraphLegend` under the `GraphCanvas`. No other change (node click → inspect
already works).

### Ch06 — Reflections (clearer + more creative)

Reframe as an explicit lifecycle with three labeled steps:
**1. Session ends → 2. Draft captured → 3. Reviewer approves → the next agent
reads it first.** Render the steps as a short numbered strip above the card.

Before/after lists switch to `KnowledgeItem`. On **Approve**, the reviewed memory
row animates from absent into **rank #1** of the "with memory" column (CSS
transition / `fade-in`), making the boost visible as motion, not just a color
swap. Keep the existing draft→approved badge transition.

### Ch07 — Try it (detailed, no raw ids)

- Add `BRANCH_LABELS: Record<BranchTag, string>` (in a new
  `data/branch-labels.ts`) turning each pill into plain language, e.g.
  `fit:ready` → "Fit: ready", `source:vector` → "Vector search hit",
  `adjust:memory_boost` → "Memory boost applied", `mode:layered_deep_context`
  → "Layered deep context". Render a one-line "what these mean" caption above the
  prompt grid.
- Replay panel: `PackTimeline` rows now use `KnowledgeItem`; the fit pill is
  replaced/augmented by `FitMeter` (using `replay.contextFit`). Pipeline +
  signals unchanged.

### Ch09 — Your sessions (seeded fallback)

Keep the live `/agent-sessions` + `/operations/workbench/session/{id}/replay`
flow. When the API returns no sessions, **or** the selected session has no replay
(404), fall back to a **bundled example replay** (reuse `p1.json`) rendered with
the full Signals/Pipeline/Pack/FitMeter treatment, clearly tagged with an
**"example"** pill and a one-line note: this is seeded; enable
`TUBEROSA_PERSIST_REPLAY=true` and finish a session to see your own. No fabricated
session metadata — only the replay visualization is shown as an example.

### Ch10 — Tune & operate (interactive)

The summary already returns a `pendingDrafts` array (`compactDraft`). Render each
pending draft in the "Review" card as a row with **Approve** and **Reject**
buttons:

- Approve → `POST /reflection-drafts/{id}/approve`.
- Reject → `POST /reflection-drafts/{id}/review` with a reject decision body
  (shape validated by `validateReflectionDraftReviewInput`; confirm exact field
  names — likely `{ decision: 'reject' }` or `{ status: 'rejected' }` — during
  implementation by reading `validateReflectionDraftReviewInput`).

On success: optimistic row removal, a toast, and a `refresh()` to re-pull counts.
On error: `api()` already toasts; restore the row. Keep project/limit knobs and
the read-only System card as-is; api-key input stays in the System/Feedback card.

---

## Shell / guidance changes

### G1. Re-enable AutoTour (enhancement #1)

Uncomment `<AutoTour />` in `app.tsx`. Update `shell/AutoTour.tsx` `SCRIPT`:
- Adjust the Ch03 caption to the new "big picture" framing.
- Add entries for Ch09 ("Inspect your own sessions") and Ch10 ("Review queues and
  operate") so the tour covers all ten chapters.
Wire **Ch01's "Start the tour →" button** to start the tour (set
`tour.value = { playing: true, index: 0 }` and kick `step(0)`) instead of merely
scrolling to Ch02. Export a `startTour()` from `AutoTour.tsx` for Ch01 to call.
Tour stays opt-in and already honors `prefers-reduced-motion`.

### G2. Shared key / legend (enhancement #2)

`GraphLegend` (B2) is the node-color key. Place it everywhere a graph appears.
This satisfies both the "explain node colors" fix and the "repeated key" guidance
goal without a second component.

### G3. Wire live/seeded + connection status (decision #2 + enhancement #5)

- Add a `dataSource` signal (rename/repurpose existing `demoMode`) consumed by the
  live-capable chapters (Ch07 stays seeded-only as curated replays; Ch09/Ch10 are
  the live consumers). In `seeded`, Ch09/Ch10 show seeded examples and do not call
  the API; in `live`, they call the API.
- Add a `connection` indicator in `DemoToggle`: a lightweight health probe
  (`GET /operations/workbench/summary` or an existing health endpoint) sets a
  `● connected` / `● offline — showing seeded` dot with the target origin. On
  `offline` in `live` mode, chapters fall back to seeded and show a banner.
- `DemoToggle` gets a `title`/tooltip explaining seeded vs live.

> Confirm a cheap health endpoint during implementation; if none, reuse the
> summary call with a short timeout. Keep the probe to one request, cached.

### G4. Reading-progress fill in ProgressRail (enhancement #4)

Add a thin progress fill to `ProgressRail` reflecting scroll position (active
chapter index / 10), e.g. a vertical fill behind the chapter list driven by
`activeChapter`. Purely additive; keep existing chapter links and `aria-current`.

---

## Data / API summary (all pre-existing)

- `GET /agent-sessions?project=&limit=` — Ch09 session list.
- `GET /operations/workbench/session/{id}/replay` — Ch09 replay (404 → fallback).
- `GET /operations/workbench/summary?project=&limit=` — Ch10 summary incl.
  `pendingDrafts[]`; also reused as the health probe.
- `POST /reflection-drafts/{id}/approve` — Ch10 approve.
- `POST /reflection-drafts/{id}/review` — Ch10 reject.

No server routes are added or modified.

---

## Components added / changed

**New:** `viz/knowledge-colors.ts`, `viz/GraphLegend.tsx`, `viz/KnowledgeItem.tsx`,
`viz/FitMeter.tsx`, `viz/Term.tsx`, `data/branch-labels.ts`.

**Changed:** `GraphCanvas.tsx` (import colors), `PackTimeline.tsx` (use
`KnowledgeItem`), `pipeline-flow-vm.ts` (Term-wrapped blurbs, optional),
`app.tsx` (enable AutoTour), `shell/AutoTour.tsx` (script + `startTour`),
`shell/DemoToggle.tsx` (connection + tooltip), `shell/ProgressRail.tsx`
(progress fill), `state/store.ts` (`dataSource`/`connection` signals),
`chapters/Ch01,Ch03,Ch04,Ch05,Ch06,Ch07,Ch09,Ch10`.

---

## Accessibility (CLAUDE.md WCAG 2.2 AA)

- Legend swatches need text labels, not color alone.
- `FitMeter` exposes score/status as text, not just bar position.
- `Term` uses an accessible tooltip (focusable, `aria`-labeled), not hover-only.
- Connection dot has a text label, not color alone.
- New buttons (Approve/Reject) have discernible names and visible focus states.

---

## Testing & verification

- `pnpm run build` (TypeScript compile) must pass.
- `pnpm test` must stay green (no retrieval logic touched, but run the suite).
- Manual browser check via `pnpm run dev` (port 3027):
  - Ch03 no longer shows pipeline/pack; Ch04 Fit shows a meter, Assemble shows
    pack bars.
  - Every graph has a legend; no raw `cr-…`/`mem-…` ids in Pack/Ch06/Ch07.
  - Toggle flips seeded↔live and the connection dot reflects backend state.
  - Ch07 branch pills read as plain language.
  - Ch09 with no live data shows the example replay; with data shows real.
  - Ch10 Approve/Reject acts on a pending draft and refreshes counts (requires a
    running backend with at least one pending draft; otherwise verify the empty
    state and note backend dependency explicitly).
  - AutoTour plays from Ch01 button and via its own control; respects reduced
    motion.

State plainly which checks could not be exercised (e.g. no pending drafts
available locally) rather than claiming success.

---

## Sequencing

1. Shared building blocks (B1–B4).
2. Chapter + shell changes (Ch03→Ch10, G1–G4).
3. `pnpm run build` + `pnpm test` + manual browser verification.
4. **Final:** run the `frontend-design` skill to polish visual quality across the
   updated chapters (spacing, type, color, motion) without changing behavior.

---

## Out of scope

- New chapters, search/command palette, backend route changes.
- Reworking the retrieval pipeline or fixtures beyond the small `fit` demo value
  and example-replay reuse.
- Exhaustive jargon dictionary (only the fixed key set in B4).
