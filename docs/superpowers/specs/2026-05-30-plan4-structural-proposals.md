# Plan 4 — Structural / Stack Proposals (for review, not yet scheduled)

- **Date:** 2026-05-30
- **Status:** Proposals only — each needs its own approved plan before execution.
- **Context:** Deferred from the audit engagement (Plans 1–3 shipped as PRs #20/#21/#22). These are higher-risk or higher-churn items the user chose to defer, plus three items recon pulled out of Plan 3 because their risk outweighed their value.

Each proposal lists: **what**, **why**, **risk**, **effort**, and a **verification approach**. They are independent; prioritize by the table at the end.

---

## P4-1 — Split `PostgresKnowledgeStore` (3605 lines)

**What:** Decompose the single `postgres-store.ts` god-class along the boundary the codebase already started (`src/storage/postgres/` already holds `context-store.ts`, `backup-store.ts`, `label-store.ts`). Extract `relations-store.ts`, `session-store.ts`, `atom-store.ts`, and a `row-mappers.ts` module; have `PostgresKnowledgeStore` compose them (delegation), preserving the `KnowledgeStore` interface unchanged.

**Why:** 3605 lines / ~88 methods in one class is the biggest single maintenance hotspot; the sub-store pattern already exists and works.

**Risk:** Medium. Pure mechanical move + delegation, but touches the production store broadly; transaction helpers (`rollbackAndRelease`, `finalReleaseClient`, `destroyedClients`) are shared and must stay coherent. Integration tests (docker) are the real safety net.

**Effort:** High (the file is large; do it sub-store by sub-store, one PR each, green between).

**Verification:** `pnpm run build`, full suite, `pnpm run test:integration` (Postgres up) after each extraction; the `KnowledgeStore` interface must be byte-identical so `MemoryKnowledgeStore` and all callers are untouched.

---

## P4-2 — Extract `FeedbackService` from `RetrievalService` (2485 lines) + transaction-wrap the learning fan-out

**What:** Move the feedback/learning write path (`recordFeedback`, `recordFeedbackLearning`, `recordAtomReuse`, continuation-signal extraction, review-queue assembly) out of `RetrievalService` into a `FeedbackService`, leaving `RetrievalService` as the read pipeline. Additionally wrap the 4 sequential learning writes (`recordFeedback` → `createKnowledgeGap` → `createLearningProposal` → `updateAtom`) in a single transaction so a partial failure can't leave inconsistent learning state.

**Why:** Separates the read pipeline from the write/learning path (single-responsibility); fixes a real partial-failure hazard.

**Risk:** Medium–High. The transaction wrap changes failure semantics; the eval must stay green and the agent-session/feedback flows must be re-verified. The store interface may need a `withTransaction`-style method exposed to the service layer.

**Effort:** Medium–High.

**Verification:** `pnpm run eval:retrieval`, `pnpm run eval:agent-context`, full suite, integration. Add a test that injects a mid-fan-out failure and asserts no partial commit.

---

## P4-3 — Split `mcp/server.ts` (1844 lines) tool handlers per domain

**What:** Break the hand-rolled JSON-RPC dispatch switch (41 tools) into per-domain handler modules (retrieval, agent-session, reflection, error-log, maintenance, atoms), keeping a thin dispatch table. The domain logic already lives in services; this is about the dispatch/arg-coercion layer.

**Why:** 1844 lines of dispatch in one file; per-domain modules are far easier to navigate and test.

**Risk:** Medium. Must preserve exact tool names, arg validation, and the **MCP stdout-protocol-only** constraint (no `console.log` in the path). `test/api-boundary.test.ts` and the MCP fuzz/invariants tests guard the wire behavior.

**Effort:** Medium.

**Verification:** Full suite (esp. `api-boundary`, `invariants`, `mcp-stdio-fuzz`), plus a manual MCP stdio smoke. Note: `test/invariants.test.ts` mcp-stdio frame test is a known load-timing flake — run it in isolation to confirm.

---

## P4-4 — `redis` v4 → v6

**What:** Upgrade the `redis` client major version; adapt `src/cache.ts` (`createClient`/`RedisClientType` surface is small).

**Why:** v4 line is aging; isolated, low-surface migration.

**Risk:** Low–Medium. API changes in the client; cache is already best-effort (Plan 2) so faults degrade gracefully.

**Effort:** Low–Medium.

**Verification:** `pnpm run test:integration` with Redis up; build + suite.

---

## P4-5 — Adopt `noUncheckedIndexedAccess`

**What:** Enable `noUncheckedIndexedAccess` in `tsconfig.json` and fix the resulting errors.

**Why:** High value for a retrieval/storage codebase that indexes heavily into arrays/records — surfaces a class of latent `undefined` bugs at compile time.

**Risk:** Low semantically (type-only), but expect a **large wave** of new errors to fix; must be its own branch.

**Effort:** Medium–High (breadth of fixes).

**Verification:** `pnpm run build` clean after the sweep; full suite + evals unchanged (no runtime change intended).

---

## P4-6 — Tidy `operations/` + confirm `src/types.ts` vs `src/types/`

**What:** Move the `*-cli.ts` adapters (`organization-cli`, `context-quality-cli`, `atom-gate-stats`, `atom-graph-*`, `sandbox-report`, `last-eval`) into `operations/cli/` to separate genuine operational services from CLI adapters. Confirm whether the root `src/types.ts` is legacy vs the `src/types/` directory and consolidate.

**Why:** `operations/` is trending toward a catch-all; the file-vs-dir `types` duplication is a minor smell.

**Risk:** Low (moves + import-path updates).

**Effort:** Low–Medium.

**Verification:** build + suite.

---

## P4-7 — Migrate retrieval magic numbers into `config/retrieval-policy.json` (deferred from Plan 3)

**What:** Move `SEARCH_LIMIT`, `RERANK_LIMIT`, the continuation limits, `LEGACY_REPLACED_GRACE_MULTIPLIER` (0.2), `SUPPRESSION_FLOOR` (0.1), and the inline scoring caps from `service.ts` into the typed `RetrievalPolicy` (`policy.ts` + `retrieval-policy.json`) so `calibrate-fusion` can reach them.

**Why:** Finishes the policy-framework migration; makes scoring calibratable.

**Risk:** **Medium — fingerprint hazard.** `getRetrievalPolicyFingerprint` is `sha256` of the whole policy object; adding fields to `DEFAULT_POLICY` changes it. **Before doing this, grep for any test/eval asserting a hardcoded fingerprint.** Defaults must be byte-identical so fused scores/ordering don't move.

**Effort:** Medium.

**Verification:** `pnpm run eval:retrieval` must stay byte-for-byte green; add a test asserting the migrated defaults equal the old literals.

---

## P4-8 — Consolidate `truncate` variants (deferred from Plan 3)

**What:** Provide one `truncate(value, max, { ellipsis, fallback })` in `src/util/text.ts` and migrate `maintenance/service.ts`, `reflection/recommendation.ts`, `reflection/write-gate.ts` (`truncateTitle`).

**Why:** Removes 3–4 near-duplicates.

**Risk:** Low–Medium — the variants differ in **emitted output** (`...` vs `…`, `'n/a'` fallback, reserve width). Callers/tests may assert exact strings, so the options bag must reproduce each call site's current output exactly.

**Effort:** Low.

**Verification:** full suite; diff emitted strings at each call site.

---

## P4-9 — Replace behavior-risky non-null assertions (deferred from Plan 3)

**What:** Add explicit guards for `classified.domain!` (classifier.ts:473), `event.reason!` (clusterer.ts:67-68), `user.metadata!.userStylePriority` (conflict-resolver.ts:75).

**Why:** Each is a latent runtime-crash point if the invariant breaks.

**Risk:** Medium — adding a guard **changes control flow** when the value is absent (e.g. classifier currently proceeds with `undefined`). Each needs a per-site behavioral decision: does "absent" mean skip, default, or proceed-as-today? Not a mechanical change.

**Effort:** Low per site, but requires judgment + a test per site capturing the chosen absent-behavior.

**Verification:** per-site unit test for the absent case; eval green.

---

## Suggested priority

| Rank | Proposal | Value | Risk | Notes |
|---|---|---|---|---|
| 1 | P4-2 transaction-wrap learning fan-out (the transaction half) | High | Med | Real consistency bug; do the transaction even if the FeedbackService split waits |
| 2 | P4-5 `noUncheckedIndexedAccess` | High | Low (breadth) | Catches latent undefined bugs; own branch |
| 3 | P4-9 non-null guards | Med | Med | Safety; needs per-site behavior decision |
| 4 | P4-1 split PostgresKnowledgeStore | Med | Med | Biggest file; incremental, sub-store per PR |
| 5 | P4-7 magic-numbers→policy | Med | Med | Mind the fingerprint |
| 6 | P4-3 split mcp/server.ts | Med | Med | Mind MCP stdout discipline |
| 7 | P4-4 redis v6 | Med | Low | Isolated |
| 8 | P4-6 operations/ tidy | Low | Low | Cosmetic |
| 9 | P4-8 truncate consolidation | Low | Low | Output-drift risk |
