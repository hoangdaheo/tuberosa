# Workbench v2 — Learn-first, Operate-second

**Status:** Draft (brainstorming approved 2026-05-26)
**Owner:** TBD
**Replaces:** `src/workbench/` and `src/http/workbench.ts` (current operator-only SPA)

## Summary

Replace the existing Tuberosa Workbench with a long-scroll, story-driven web app served at `/workbench`. Primary job: teach a new user what Tuberosa is and how its retrieval pipeline works, by clicking through an animated 10-chapter narrative backed by both seeded demo data and the user's live data. Secondary job: let active users inspect their real sessions and run lightweight ops (review queue, system health) inside the same shell.

Influences: [Understand-Anything](https://github.com/Lum1104/Understand-Anything) for the "click, don't type" interaction model and concept-first layout.

## Goals

- A first-time user understands what Tuberosa does within ~5 minutes of opening `/workbench`.
- A team lead can hand a teammate the same URL and walk them through it (auto-tour mode).
- An active user can inspect a real session through the same animated UI used in the tutorial.
- Every pipeline branch (`contextFit` values, every retrieval source, layered deep context, memory boosts, stale/superseded penalties, strict noise) is reachable via at least one seeded example.
- Bundle stays modest (target: shell <60KB gzipped; Cytoscape lazy-loaded only on graph chapters).

## Non-goals

- CLI replacement.
- New ingestion surfaces.
- Auth changes.
- Expanding the MCP tool surface beyond one new replay endpoint.
- Backwards-compatibility shims for the old workbench routes (the URL stays the same; the implementation is fully replaced).

## Primary user

Two-headed, with overlap:
1. **Active agent user** — has Tuberosa running daily; wants to see what's happening, debug bad packs, learn to tune.
2. **Team lead / onboarder** — needs a shareable surface to walk teammates through Tuberosa.

Both benefit from the same long-scroll narrative; (1) lives more in Ch.9–10, (2) lives more in Ch.1–8.

## Shell choice

Single-page long-scroll narrative (rejected alternatives: 3-pane explorer; tour → tile dashboard). Rationale: matches the user's stated Understand-Anything reference, gives a clear teaching order, and the operate features collapse cleanly to the bottom for daily users to expand on demand.

## Tech stack

- **Preact + @preact/signals** — keep current framework, smallest disruption.
- **Cytoscape.js** for knowledge-graph views (Ch.4 mini-graphs, Ch.5 full graph). Lazy-loaded chunk.
- **Motion (motion.dev, ~5KB)** + IntersectionObserver for scroll-triggered chapter animations.
- **esbuild** via existing `scripts/build-workbench.ts` (extended for code-splitting of the graph chunk).
- **No new server-side framework.** Existing Node HTTP router stays.

Rejected: GSAP+ScrollTrigger (too heavy for the lift), Svelte rewrite (new build chain).

## Chapter outline (the spine)

| # | Chapter | What animates | Primary data source |
|---|---|---|---|
| 1 | Hello | `Agent ⇄ Tuberosa ⇄ Knowledge` arrows | static |
| 2 | The problem | Split-screen typewriter answer (without vs with) | seeded |
| 3 | Anatomy of a session | Signal chips → pipeline → pack assembles (~20s) | seeded |
| 4 | The pipeline | 10 vertical stages, clickable → mini knowledge-graph | seeded |
| 5 | The knowledge graph | Full Cytoscape canvas with filters & node detail | seeded (default) / live (toggle) |
| 6 | Reflections that learn | Draft → approved → before/after ranking | seeded |
| 7 | Try it yourself | Click any of 10 example prompts to replay | seeded |
| 8 | Plug into your agent | MCP config cards per editor with copy buttons | static |
| 9 | Inspect your own sessions *(collapsed)* | Session replay through Ch.4 animations | live |
| 10 | Tune & operate *(collapsed)* | Review queue, system health, feedback knobs | live |

Cross-cutting:
- **Auto-tour** toggle in the top-right runs scripted scroll + captions through Ch.1–8.
- **DemoToggle** in the sticky progress rail flips Ch.2–7 between seeded and live.

## Architecture

```
src/workbench-v2/
  index.html
  app.tsx                         # mounts Chapter 1..10, scroll controller, hash router
  shell/
    ProgressRail.tsx              # sticky "Ch X / 10" + tour & demo controls
    AutoTour.tsx                  # scripted scroll + caption overlay
    DemoToggle.tsx                # toggle live ↔ seeded acme-billing
    Toasts.tsx
  chapters/
    Ch01_Hello.tsx
    Ch02_Problem.tsx
    Ch03_Anatomy.tsx
    Ch04_Pipeline.tsx
    Ch05_KnowledgeGraph.tsx
    Ch06_Reflections.tsx
    Ch07_TryIt.tsx
    Ch08_PlugIn.tsx
    Ch09_YourSessions.tsx
    Ch10_TuneOps.tsx
  viz/
    PipelineFlow.tsx              # vertical 10-stage animated flow (SVG + Motion)
    GraphCanvas.tsx               # Cytoscape wrapper, props-driven (lazy chunk)
    PackTimeline.tsx              # animated essential/supporting/optional rail
    SignalChips.tsx               # animated classifier chips
  data/
    api.ts                        # fetch wrapper (cookie / x-tuberosa-api-key)
    demo/acme-billing.json        # seeded project + 30 items + 10 prompts + 1 stale memory
    fixtures.ts                   # typed loaders for seed + live
  state/
    store.ts                      # signals: route, demoMode, selectedSession, etc.
    routes.ts                     # hash routing: #/ch4, #/ch5/node/<id>, #/ch9/session/<id>
  styles/
    tokens.css                    # color/spacing/typography tokens
    main.css                      # layout + chapter rhythm + dark/light
```

Old code fully removed in the same change-set: `src/workbench/` directory, `src/http/workbench.ts` rewritten to serve the new bundle, `src/workbench/styles/main.css` deleted, `test/browser/workbench-browser.test.ts` rewritten as `workbench-v2-browser.test.ts`. The HTTP route `GET /workbench` keeps its path so existing bookmarks survive.

## Data flow

```
Workbench (browser)
   │
   ├── live HTTP ──→ /operations/workbench/summary       (Ch.10)
   │                 /sessions, /sessions/:id             (Ch.9)
   │                 /operations/workbench/session/:id/replay  (Ch.9, new)
   │                 /knowledge/search, /knowledge/:id   (Ch.5)
   │                 /reflections, /reflections/:id      (Ch.6, Ch.10)
   │
   └── seeded JSON ─→ data/demo/acme-billing.json        (Ch.2–Ch.7)
                      bundled into the JS, no network
```

### New endpoint

`GET /operations/workbench/session/:id/replay` — returns per-stage candidate lists, fusion order, rerank deltas, and adjustment reasons for a real session. Implementation reuses what `RetrievalService.searchContext({ debug: true })` already produces; we persist the debug bundle on session finish behind `TUBEROSA_PERSIST_REPLAY=true` (default off). When the flag is off, Ch.9 falls back to a static "session summary" view and only seeded examples animate.

## Interaction model — no typing

The only text inputs anywhere: API key in Ch.10 (password, optional), and a search-as-you-type filter in Ch.5 graph (typing optional — filter chips do the same thing). Everything else is clicks.

- **Auto-tour** — top-right ▶ / ⏸ / ✕. Scripted scroll through Ch.1–8 with caption overlay.
- **Click-to-explore** — graph nodes/edges open a right-side detail card. ESC closes.
- **Click-to-run** — Ch.7 example cards run the pipeline against seeded data; replay plays in place.

## Animation details

| Where | What animates | Library |
|---|---|---|
| Ch.1 hero | Ping-pong arrows | Motion (SVG path) |
| Ch.2 split | Typewriter answer reveal | CSS keyframes |
| Ch.3 anatomy | Signal chips fly in, pipeline stages light up, pack tiles assemble | Motion + IO |
| Ch.4 pipeline | Stage hover/click micro-animations; selected stage opens inline mini-graph | Motion + Cytoscape mini |
| Ch.5 graph | Force-directed (`cose`) by default, `dagre` for DAG toggle | Cytoscape |
| Ch.6 reflections | Card morphs draft → approved, then mini-replay shows ranking change | Motion |
| Ch.7 gallery | Hover preview, click triggers animated pipeline in place | Motion |
| Auto-tour | Smooth scroll + caption overlay | Motion + custom scheduler |

`prefers-reduced-motion` → fades only, no transforms, instant scroll. Applies to auto-tour too.

## Example library (covers every pipeline branch)

Seeded project: `acme-billing` (small SaaS, ~30 knowledge items). 10 example prompts, each exercising a specific branch:

| # | Prompt | Demonstrates |
|---|---|---|
| 1 | "Where does paywall logic live?" | classifier(symbols); lexical+vector strong; `fit=ready` |
| 2 | "Fix the vector dimension mismatch error" | classifier(errors); approved-memory recall + boost |
| 3 | "How do I add a new subscription tier?" | wiki+spec fusion; multi-source balance |
| 4 | "Refactor the auth middleware" | graph-expansion across relations |
| 5 | "Make it faster" | classifier extracts nothing; `fit=insufficient` + missing-signals panel |
| 6 | "Update the LiveIntent ad tags" | stale-memory penalty + superseded suppression |
| 7 | "Add a new payment provider following existing patterns" | `fit=needs_confirmation` + strict-noise drops weak items |
| 8 | "Why did the agent miss the migration step last time?" | approved-reflection reshapes ranking (before/after replay) |
| 9 | "Read the whole spec for the billing webhook" | layered mode + `deepContextBudget` expansion |
| 10 | "What conventions does this project follow for tests?" | wiki+spec only; classifier(business areas) |

Together this hits: every `contextFit` value, every source (labels / FTS / vector / memory / graph), strict vs lenient noise, layered deep context, both negative adjustments (stale + superseded), and the positive memory-boost. A dedicated fixture test asserts this coverage continuously.

## Error handling

- **No JS** — `<noscript>` directs users to the HTTP API (same as today).
- **API unreachable / 5xx** — red banner in the progress rail + toast; chapters fall back to seeded data automatically.
- **Empty store** (real project, nothing ingested) — Ch.9 + Ch.10 show empty states with an ingest CTA. Ch.2–7 stay on seeded.
- **Stale session replay** (id not found) — toast + bounce to Ch.9 list.
- **Cytoscape large graphs** — cap to top-N by score with a "show more" affordance for graphs > ~2000 nodes.

## Testing

- **Unit / view-model tests** in `test/workbench-v2/` for each presenter (classifier-signals VM, pipeline-step VM, graph-data adapter, replay timeline builder). No DOM.
- **Browser smoke test** `test/browser/workbench-v2-browser.test.ts` (replaces the existing file). Asserts: each chapter renders, auto-tour advances, demo gallery click triggers replay, graph node click opens detail card, reduced-motion path works.
- **Fixture coverage test** `test/workbench-v2/demo-fixture.test.ts` — runs the seeded `acme-billing.json` through `RetrievalService` with `MemoryKnowledgeStore` and asserts that every branch listed in the Example Library table is actually exercised.
- **Retrieval eval untouched.** This work doesn't change classifier, fusion, or rerank logic; `pnpm run eval:retrieval` must pass without modification, and the plan runs it as a guardrail.

## Risks

- **Bundle size** — Cytoscape (~150KB gz) is lazy-loaded behind chapter visibility. Shell target < 60KB gz.
- **One-shot rewrite, no shim** — accepted; the workbench is internal and the URL stays.
- **Replay endpoint requires opt-in persistence** — without `TUBEROSA_PERSIST_REPLAY=true`, Ch.9 degrades to a static summary. Documented; not a blocker.
- **Animation polish drift** — Motion is small but easy to over-use. Style guide in `styles/tokens.css` caps total chapter animation budget; reviewer rejects animations that don't carry meaning.

## Out of scope (deferred to a later spec)

- Multi-language UI.
- Embeddable iframe widget for blog posts.
- A "share this session" public link.
- Real-time WebSocket updates (current data is fetched on demand).

## Open questions for the implementation plan

1. Should the seeded `acme-billing.json` be generated from a real ingestion run (deterministic seed script) or hand-curated JSON? Recommendation: hand-curated for stability of the fixture coverage test.
2. Where does the new replay endpoint persist the debug bundle — Postgres column on `agent_sessions`, or a sibling `agent_session_replays` table? Recommendation: sibling table to keep `agent_sessions` lean.
3. Auto-tour copy: who writes the captions? Recommendation: included in this design's follow-up, not in the implementation plan.
