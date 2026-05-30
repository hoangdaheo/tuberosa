# Workbench Removal & Codebase Audit — Design

- **Date:** 2026-05-30
- **Author:** nash-nguyen (with Claude Code)
- **Status:** Draft for review
- **Tuberosa session:** `48cf3f88-405e-418c-8c2f-6096e76fd2c8`

## Goal

Two outcomes the user asked for:

1. **Fully remove the workbench** from the project — the Preact UI, its HTTP route, its build tooling, *and* the `workbench-summary` data concept (the `tuberosa_get_workbench_summary` MCP tool, `operations/workbench-summary.ts`, `types/workbench.ts`, and every reference).
2. **Audit the whole codebase and fix what is found** — tech debt, unclean code, redundant side-effects, security issues, hidden bugs, missing exception handling, and unsafe nullish handling.

The work is decomposed into **four sequenced plans**, each gated by the project's verification commands. Each plan is independently reviewable and revertable.

## Context & conflict note

The workbench is **not dead code** — `feat/workbench-v2` (a 30-task rebuild) plus a 19-task UX-polish pass were merged to `main` on 2026-05-26/27. The user has explicitly confirmed full removal anyway. This spec records that the removal deletes recent, working, polished work by deliberate choice, not because it was abandoned.

The codebase is **healthier than typical**: zero `as any`/`@ts-ignore`/`@ts-expect-error`, no commented-out code, no TODO/FIXME/HACK markers, a structured `AppError` hierarchy with HTTP status mapping, fully parameterized SQL, constant-time auth, clean MCP stdout discipline, and a centralized hot-reloadable retrieval policy. The debt is concentrated, not pervasive.

## Confirmed decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Removal scope | **Everything workbench** (UI + HTTP + build + summary data concept + MCP tool) |
| Audit deliverable | **Fix what is found**, structured into sequenced plans |
| `/operations/catchup` summary field | **Drop the field** — catchup returns `{ catchup }` only; delete `buildWorkbenchSummary` |
| `/operations/workbench/session/:id/replay` | **Rename** to `/operations/session/:id/replay`; keep `SessionReplayService` + migration `004` |
| Big structural refactors (god-module splits, redis v6, `noUncheckedIndexedAccess`) | **Defer to written proposals** (Plan 4) for separate approval |
| `buildSourceHealth()` new home | **`src/source-sync/source-health.ts`** |

## Non-goals

- No god-module splitting of `postgres-store.ts` / `retrieval/service.ts` / `mcp/server.ts` in this engagement (Plan 4 proposal only).
- No `redis` v4→v6 migration or `noUncheckedIndexedAccess` adoption in this engagement (Plan 4 proposal only).
- No reorganization of `operations/` into `operations/cli/` in this engagement (Plan 4 proposal only).
- No retrieval-quality behavior change. Magic-number→policy migration in Plan 3 must preserve current eval results exactly.
- No new features.

## Verification gate (applies to every plan)

Each plan is "done" only when all pass, run with the Node 22 path if needed:

```bash
pnpm run build           # tsc (single config after Plan 1)
pnpm test                # full unit suite
pnpm run eval:retrieval  # deterministic retrieval quality gate
pnpm run eval:agent-context
```

Plan 1 additionally runs `pnpm install` (prune) and confirms the Docker build still works conceptually (no esbuild stage needed).

---

## Plan 1 — Workbench full removal

**Outcome:** every workbench artifact gone; build collapses to a single `tsc`; 10 npm deps dropped; one shared helper relocated; one endpoint renamed; one endpoint's response shape trimmed. No behavior change to any surviving non-workbench feature.

**Removal order (build never breaks mid-way):**

1. **Relocate the one load-bearing helper.** Move `buildSourceHealth` + the `WorkbenchSourceHealth` type to new `src/source-sync/source-health.ts`. Update `src/bootstrap/health.ts` import. Update `test/source-sync-workbench.test.ts` import and rename it `test/source-health.test.ts`. Keep all assertions. Run tests — green.
2. **Trim catchup.** In `src/http/server.ts` (~`805-813`), drop the `summary` field; `/operations/catchup` returns `{ catchup }`. Remove the `buildWorkbenchSummary` import (`server.ts:6`).
3. **Rename the replay route.** `/operations/workbench/session/:id/replay` → `/operations/session/:id/replay` (`server.ts:771-782`). `SessionReplayService` and migration `004_agent_session_replays.sql` are **untouched**.
4. **Remove HTTP UI routes + MCP tool.** `server.ts`: imports at `53`, routes `173-190` (`/workbench`, `/workbench/static`), summary route `766-770`, validation import/helper `51` + `1342-1347`. `mcp/server.ts`: imports `3`, `48`; handler `case 'tuberosa_get_workbench_summary'` `229-235`; tool definition `~1296+` (read to its closing brace).
5. **Remove validation.** `src/validation.ts`: `WorkbenchSummaryInput` import `63`, `validateWorkbenchSummaryInput` `593-601`.
6. **Delete CLI + scripts.** `src/operations/workbench-cli.ts`, `scripts/workbench.ts`, `scripts/build-workbench-v2.ts`, `scripts/gen-demo-replays.ts`.
7. **Delete the summary data concept.** `src/operations/workbench-summary.ts`, `src/types/workbench.ts`; update `src/types.ts:9` re-export (re-point `WorkbenchSourceHealth` if still re-exported).
8. **Delete the UI.** `src/workbench-v2/**` (entire tree), `src/http/workbench-v2.ts`.
9. **Delete / trim tests.** `test/workbench-v2/**`, `test/browser/workbench-v2-browser.test.ts`, `test/workbench-cli.test.ts`. Carve workbench blocks out of `test/operations.test.ts` (`20`, `615-665`) and `test/api-boundary.test.ts` (`10`, `626`) — keep the rest of each file.
10. **Build/config cleanup.** `package.json`: simplify `build` to `tsc -p tsconfig.json`; delete `build:workbench`, `dev:workbench`, `gen:demo-replays`, `workbench`, `test:workbench-browser` scripts; remove deps `preact`, `@preact/signals`, `lucide-preact`, `cytoscape`, `cytoscape-cose-bilkent`, `cytoscape-dagre`, `@motionone/dom`; remove devDeps `@types/cytoscape`, `esbuild`, `playwright-core`; remove `esbuild` from `pnpm.onlyBuiltDependencies` and `.npmrc allowBuilds`. Delete `tsconfig.workbench.json`; drop `src/workbench-v2/**` from `tsconfig.json` exclude. `pnpm install` to prune.
11. **Docs last.** Update `CLAUDE.md` (the startup rule lists `tuberosa_get_workbench_summary` — remove it) and `wiki/09-mcp-reference.md` / `wiki/13-operations-runbook.md` workbench mentions.
12. **Verify gate.**

**Risk:** Low–Med. Single trap is the `buildSourceHealth` relocation (step 1, done first and verified). Cosmetic "workbench" words in surviving comments/strings (`context-fit.ts`, `context-pack.ts`, `reflection/service.ts`, `maintenance/service.ts`, `types/*`, `atlas/builders.ts`, `context-quality-cli.ts` naming) will be scrubbed where trivially safe, left where renaming risks churn.

---

## Plan 2 — Security & robustness fixes

All findings verified by reading the cited lines.

| # | Sev | Fix | Location |
|---|---|---|---|
| 1 | **High** | Add UUID-shape guard (`if (!isPersistedKnowledgeId(id)) return undefined;`) to entity getters so non-UUID ids return 404, not a 503 `::uuid` throw — mirrors `getKnowledge`. | `getAgentSession` (`postgres-store.ts:1504`), `getContextPack` (`postgres/context-store.ts:59`), `getReflectionDraft` (`postgres-store.ts:1690`), `getKnowledgeRelation` (`postgres-store.ts:624`) |
| 2 | Med | Redact deep-context: run chunk content through `safety` redaction, and extend `sanitizeContextPack` to walk `pack.deepContext`. | `retrieval/service.ts:1080-1119`; `security/knowledge-safety.ts:439-454` |
| 3 | Med | Make cache best-effort: try/catch around `cache.getJson`/`cache.setJson`; on error log to stderr and fall through so a Redis fault never fails an otherwise-successful search. | `retrieval/service.ts:447`, `:1348` |
| 4 | Med | Batch-ingest resilience: per-file try/catch in `ingestFiles`; collect `{results, errors}` instead of aborting the batch on first throw. | `ingest/service.ts:128-141` |
| 5 | Med | Add `AbortSignal.timeout(config.openAiTimeoutMs ?? 30000)` to both OpenAI fetches; add the config key. | `model/provider.ts:401-460` |
| 6 | Med (latent) | Sanitize before LLM label enrichment: move `sanitizeKnowledgeInput` ahead of `refineInput`, or pass sanitized text to enrichers. | `ingest/service.ts:65-66` |
| 7 | Low | Bound `tokenBudget` upper limit in validation (parity with `deepContextBudget`); guard `Number(env)` NaN in `maxRequestBytes`/`maxIngestContentBytes`. | `validation.ts:522`; `config.ts:101-102` |
| 8 | Low/Med | Set Postgres pool limits: `connectionTimeoutMillis`, `max`, `statement_timeout`. | `postgres-store.ts:186` |

Each fix gets a failing test first where practical (uuid guards, cache fault, batch ingest, budget bound). Verify gate after.

---

## Plan 3 — Tech-debt consolidation (correctness + dedup)

| # | Sev | Fix | Location |
|---|---|---|---|
| 1 | **High (correctness)** | Delete the second `ValidationError` in `security/safe-paths.ts`; import the canonical one from `errors.ts` so `instanceof`/HTTP-400 mapping works. | `safe-paths.ts:4` vs `errors.ts:37` |
| 2 | Med | Unify UUID validation into one shared helper in `src/util/`; reconcile version-agnostic vs RFC-4122 regex; use everywhere ids reach a `::uuid` cast. | `postgres-store.ts:115` vs `service.ts:2399` |
| 3 | High (dedup) | Collapse 4 `cosineSimilarity` copies into one `src/util/` export. | `duplicate-detector.ts:158`, `write-gate.ts:211`, `memory-store.ts:1803`, `clusterer.ts:86` |
| 4 | Med | Extract shared error-log capture + `shouldAutoCapture` into one module imported by both servers. | `http/server.ts:1385`, `mcp/server.ts:1764` |
| 5 | Med | Move `canonicalKnowledgePair` + `shouldDropInferredRelationsForStatus` into `src/storage/shared.ts`; both stores import. | `postgres-store.ts:3219,3323` + `memory-store.ts:1817,1971` |
| 6 | Med | One `estimateTokens`/`TOKEN_CHARS`; replace inline `length/4` math. | `preprocessor.ts:14`, `anchor-window.ts:1`, `service.ts:1371,1413` |
| 7 | Med | Tighten `row: any` → `Record<string, unknown>`. | `postgres-store.ts:242,259` |
| 8 | Med | Migrate retrieval scoring magic numbers/limits into `config/retrieval-policy.json` + `policy.ts` **without changing eval outcomes**. | `service.ts:68-76,1448,2110,1863,1882,1926,2319,844,2179`; `context-pack.ts:22-24` |
| 9 | Low | Consolidate `truncate`/`truncateTitle`; replace non-null assertions (`!`) with explicit guards. | `util/text.ts:34` et al.; `classifier.ts:473`, `clusterer.ts:67-68`, `recommendation.ts:166`, `conflict-resolver.ts:75`, `write-gate.ts:125` |

Item 8 is the delicate one: the retrieval eval (`hitRate=1`, `staleRejectionRate=1`, all classification rates `=1`) must stay green — this is a pure move-to-config refactor, values unchanged.

---

## Plan 4 — Structural / stack modernization (PROPOSALS ONLY)

Delivered as written proposals for separate approval; not executed in this engagement:

1. Split `PostgresKnowledgeStore` (3605 L) using the existing `src/storage/postgres/` pattern (relations-store, session-store, atom-store, row-mappers).
2. Extract the feedback/learning write path out of `RetrievalService` (2485 L) into a `FeedbackService`; wrap its 4-write fan-out in a transaction.
3. Split `mcp/server.ts` (1844 L) tool handlers per domain.
4. `redis` v4 → v6 (isolated PR; small `src/cache.ts` surface).
5. Adopt `noUncheckedIndexedAccess` in `tsconfig.json` (expect a wave of fixes).
6. Tidy `operations/` — move `*-cli.ts` adapters into `operations/cli/`; confirm/clean root `src/types.ts` vs `src/types/` dir.

## Open implementation details (decided, low-risk)

- Cosmetic "workbench" word scrub: do where trivially safe in Plan 1; leave names like `ContextQualityWorkbenchOperations` (a surviving context-quality CLI, only a type name).
- Branch strategy: one branch per plan, merged in order, each behind the verify gate.
