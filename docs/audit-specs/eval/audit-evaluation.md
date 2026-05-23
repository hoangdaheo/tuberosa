# Audit Evaluation — `audit-and-check-coverage.md`

Author: Independent evaluation pass (Claude Code, Opus 4.7)
Date: 2026-05-24
Method: Two read-only verification agents (a *verifier* re-checking 29 high-severity claims against current code, and a *gap-hunter* looking for surfaces the 5 original specialists ignored), plus direct spot-checks on the most load-bearing items. No code changed.

This document answers the four questions the user posed:

1. **Does the audit detect the right problems?** — Mostly yes. 22/29 spot-checked claims are accurate as written; 2 are FALSE; 5 are PARTIAL (line drift, rounded counts, or a misread of where the issue lives).
2. **Did it skip anything?** — Yes, three large categories: **CI/supply-chain** (no `.github/workflows/` exists), **runtime perf** (no embedding cache, N+1 inserts), and **upgrade-path migration safety** (deleting the dup 002_ files orphans `schema_migrations` rows on existing DBs).
3. **Will the project break after fixing it?** — Some waves are safe; some carry real breakage risk if applied as written. Wave 1.3, 1.4, 1.6, and Wave 4.1–4.3 need migration paths called out below.
4. **What improvement do we get?** — Concrete deltas per wave in §5.

---

## 1. TL;DR

| Dimension | Finding |
|---|---|
| Audit accuracy | **22 TRUE / 2 FALSE / 5 PARTIAL** of 29 spot-checked claims (76% / 7% / 17%). |
| Audit completeness | Missed **CI gating** (no workflows at all), **perf** (uncached embeddings, N+1 inserts), and **migration-deletion safety** on existing DBs. |
| Wave 1 breakage risk | High for 1.3 (API key required), 1.4 (raw error stripping), 1.6 (delete migrations). Mitigations in §4. |
| Wave 4 breakage risk | High (touches hot path). Must follow §4 sequencing: parity matrix (W2.4) and types split (W4.4) before any postgres-store / service.ts split. |
| Biggest *missed* P0s | (a) CI never runs `pnpm test` / `eval:retrieval` on PRs; (b) physical mirror enabled by default writes `.tuberosa/current/` to the cwd on every Docker boot; (c) OpenAI embeddings never cached. |
| Recommended next step | Execute revised top-5 in §7 — same shape as the audit's top-5, but with two replacements (CI workflow ahead of structural refactor, embedding cache ahead of types split). |

---

## 2. Verification matrix — does the audit detect the right problems?

29 high-severity claims from the audit checked against current code. Verdict legend: TRUE = evidence matches today; FALSE = audit was wrong; PARTIAL = part of the claim correct, part not; STALE_LINE = same code exists at a different line; ALREADY_FIXED = code has changed since audit and the issue is gone.

### 2.1 QA / behavior auditor

| # | Claim (short) | Verdict | Evidence today |
|---|---|---|---|
| 1 | Worktree `::uuid` leak at `postgres-store.ts:1248` | **TRUE** | `(item->>'knowledgeId')::uuid AS knowledge_id` with no CASE/regex guard. |
| 2 | memory-store `allowed()` missing `status='approved'` at `:1205` | **TRUE** | Only filters project + rejectedKnowledgeIds. |
| 3 | eval `hitRate=1` only enforced with CLI flag at `eval-retrieval.ts:239` | **TRUE** | Gated on `options.failUnderHitRate !== undefined`. |
| 4 | `applyNoiseTolerance('strict')` no-op unless `ready` at `service.ts:1455` | **TRUE** | Returns early on non-`ready` fitStatus. |
| 5 | Fusion `keepExistingChunk` tie favors existing at `fusion.ts:75` | **TRUE** | `existing.rawScore >= candidate.rawScore`. |
| 6 | Fusion `maxScore = Math.max(..., 0.0001)` floor at `fusion.ts:85` | **TRUE** | Exact match. |
| 7 | Learning gate `gate.status === 'unknown'` at `recommendation.ts:100` and `service.ts:422` | **PARTIAL** | `recommendation.ts:100` *produces* `status:'unknown'`; the comparison lives at `:467`. `service.ts:422` uses `gate.status !== 'pass'` (collapsing `unknown` with `fail`). Functional concern is real; line:claim mapping is misleading. |
| 8 | Write-gate empty-embedding fallback at `write-gate.ts:169` | **TRUE** | Falls back to `clampCosine(candidate.rawScore)`. |

### 2.2 Security / pentest auditor

| # | Claim (short) | Verdict | Evidence today |
|---|---|---|---|
| 9 | HTTP unauthed by default at `server.ts:794-800` + `config.ts:52` | **TRUE** | `if (!apiKey) return true;`; env default `undefined`. |
| 10 | Listener binds `0.0.0.0` at `index.ts:7` | **PARTIAL** | No explicit `'0.0.0.0'` literal. Behavior arises from Node default when `listen(port)` omits host. Audit phrased it as if literal; effect is real. |
| 11 | Raw pg messages leak via `appErrorToHttpBody` at `errors.ts:101-138` | **TRUE** | Wraps `errorMessage(error)` directly into HTTP body. |
| 12 | MCP `JSON.parse` outside try/catch at `mcp-stdio.ts:28` | **TRUE** | Parse at :28; try block begins at :33. |
| 13 | PII regex `/g` flag race at `knowledge-safety.ts:228-241` | **TRUE** | Three module-level `/g` patterns; shared `lastIndex` state. |
| 14 | Dynamic SQL `buildRelationKindMultiplierSql` at `postgres-store.ts:2647-2657, 978` | **TRUE** | String-concat into SQL. Source is config (not user input) but pattern is fragile. |
| 15 | No request timeout / slowloris at `server.ts:756-775` | **TRUE** | Byte-cap only; no `requestTimeout` / `headersTimeout`. |

### 2.3 Code-quality auditor

| # | Claim (short) | Verdict | Evidence today |
|---|---|---|---|
| 16 | `postgres-store.ts` is 2746 LOC | **TRUE** | `wc -l` = 2746. |
| 17 | `retrieval/service.ts` is 2072 LOC | **TRUE** | `wc -l` = 2072. |
| 18 | `types.ts` is 1987 LOC | **TRUE** | `wc -l` = 1987. |
| 19 | `as unknown as` block on backup restore at `memory-store.ts:1062` | **TRUE** | Exact match. |
| 20 | "50 `as` casts" in postgres-store | **PARTIAL** | Actual count is 49 (` as ` substring) / 43 (` as <CapType>`). Audit rounded. |

### 2.4 Coverage auditor

| # | Claim (short) | Verdict | Evidence today |
|---|---|---|---|
| 21 | `backup-service.ts` has no direct unit tests | **FALSE** | `test/operations.test.ts:18` imports `BackupService` directly. |
| 22 | postgres-store paths only covered by Docker-skip `integration.test.ts` | **TRUE** | Only `integration.test.ts` and `types.test.ts` (type-only) reference `PostgresKnowledgeStore`. |
| 23 | `maintenance/service.ts` no direct test | **FALSE** | Imported by `test/phase10.test.ts:6`, `flow-regression.test.ts:13`, `operations.test.ts:16`, `browser/workbench-browser.test.ts:16`. |
| 24 | `validation.ts` no direct test | **TRUE** | No test file imports it directly. |
| 25 | `reflection/write-gate.ts` no direct test | **PARTIAL** | One importer in `test/phase6.test.ts`; no dedicated `write-gate.test.ts`. |

### 2.5 Dead-code auditor

| # | Claim (short) | Verdict | Evidence today |
|---|---|---|---|
| 26 | 3 of 4 `002_*.sql` duplicate `001_init.sql` | **TRUE (and worse)** | `001_init.sql` already creates the tables AND the same indexes (`idx_knowledge_relations_*` at 210-213; `idx_knowledge_conflicts_*` at 214-216; `idx_agent_sessions_project_status` and `idx_agent_decisions_session` at 221-222). All three duplicates are full table+index repeats. |
| 27 | `late-chunker.ts` zero importers | **TRUE** | Only self-reference; one stale mention in `model/provider.ts:23`. |
| 28 | `contextual-summarizer.ts` zero importers | **TRUE** | Only self-references. |
| 29 | CommonJS `require()` in ESM `model/provider.ts:57,64` | **TRUE** | Both lines `require('./registry.js')` inside ESM (NodeNext). |

### 2.6 Three most surprising results

1. **Two coverage claims were wrong** (#21, #23): `backup-service.ts` and `maintenance/service.ts` *do* have importers in test files. The audit's "no direct unit test" framing was too strong. The real coverage hole is `validation.ts` (#24, confirmed) and `write-gate.ts` (#25, only 1 importer, no dedicated suite). Wave 2.2 and 2.3 in the audit should be rescoped from "add direct tests" to "expand existing direct tests".
2. **The 002 migration duplication is worse than the audit said**: it duplicates not only tables but also four `idx_knowledge_relations_*`, three `idx_knowledge_conflicts_*`, and two `idx_agent_sessions_*` index definitions verbatim. `CREATE INDEX IF NOT EXISTS` masks the duplication today, but any future drift between the two definitions silently diverges. The audit reported "delete the file"; reality is harder (see §4, W1.6).
3. **Claim #10 (HTTP binds 0.0.0.0) survives but the cited evidence does not exist**: `src/index.ts:7` has no literal `'0.0.0.0'`. It binds to all interfaces only because `server.listen(port)` omits the host argument. The fix (pass `'127.0.0.1'`) is correct; the audit's phrasing implied an explicit binding that is not there.

---

## 3. Gaps — what did the audit skip?

The original 5 specialists were QA, security, code-quality, coverage, and dead-code. They covered the code *as written* but missed the operational and runtime layer. The gap-hunter pass found:

### 3.1 New P0 / P1 findings the audit missed

- **[P0][ci-supply] No CI workflows at all** — `/home/nash/tuberosa/.github/` does not exist. `CLAUDE.md` mandates `pnpm test` and `pnpm run eval:retrieval` as gates, but nothing enforces them on PRs. Fix: add `.github/workflows/{ci,eval}.yml` running build + tests + retrieval eval on every PR.
- **[P0][config-startup] Physical mirror enabled by default writes `.tuberosa/current/` into the cwd** — `src/config.ts:77` `readBoolean(process.env.TUBEROSA_PHYSICAL_MIRROR_ENABLED, true)`. Fresh Docker boots silently write app data into the bind-mounted source tree. Fix: default to `false`, require explicit opt-in.
- **[P0][performance] OpenAI embeddings never cached** — `src/model/provider.ts:128-141` `OpenAiModelProvider.embed` calls the API on every search and ingest with no content-hash cache. Every byte-identical prompt re-burns the same embedding. Fix: wrap with an LRU/Redis cache keyed on `(model, content_sha256, dims)`.
- **[P1][performance] N+1 inserts in postgres-store** — `attachLabels`, `attachReferences`, `insertChunks` each `for (const ...) { await client.query(...) }`. Ingesting a 200-chunk Markdown is 200 round-trips. Fix: `UNNEST`-based bulk inserts.
- **[P1][migration-safety] Deleting the 3 dup 002_ files orphans `schema_migrations` rows on existing DBs** — `src/storage/migrations.ts:31` `SELECT 1 FROM schema_migrations WHERE filename = $1` and `:53` `INSERT INTO schema_migrations (filename) VALUES ($1)`. Existing prod/dev DBs already recorded the three deleted files; after deletion the runtime tracking table contains inert orphan rows. Cosmetic only, but breaks the operator's mental model. The audit's W1.6 needs a paired cleanup step.
- **[P1][migration-safety] No down/rollback migrations** — `migrations/down/` does not exist; `migrations.ts` only forward-applies. Either add reverse SQL or document "forward-only" in `CLAUDE.md`.
- **[P1][concurrency] No cache-stampede protection** — `src/retrieval/service.ts:369` cache read then `:1063` write. N parallel callers on the same prompt all miss, all run the pipeline, all write back. Fix: in-process Map of in-flight promises keyed on cache key (single-flight).
- **[P1][observability] No `/readyz` (only `/health`)** — `src/http/server.ts:149` liveness probe returns `ok` even before migrations run. Fix: add `/readyz` that `SELECT 1`s the pool.
- **[P1][observability] Zero runtime metrics** — no `/metrics` endpoint, no request-latency histogram, no retrieval-stage timing exposed externally (the timings *are* measured at `service.ts:122-167`, just not exposed).
- **[P2][config-startup] No required-env validation** — `src/config.ts:46-87` silently falls back: missing `DATABASE_URL` becomes `postgres://tuberosa:tuberosa@localhost:5432/tuberosa`; missing `OPENAI_API_KEY` silently picks `hash`. Fix: `validateConfig()` that fails fast in production.
- **[P2][tuberosa-specific] Embedding-cache fingerprint excludes model identity** — `src/retrieval/service.ts:1420-1444` `fingerprintSearch` includes `queryRewriteModel` and `rerankModel` but NOT `openAiEmbeddingModel` or `embeddingDimensions`. Swapping the embed model returns packs from the prior embedding space.
- **[P2][tuberosa-specific] Namespace filter is metadata-derived JS, not SQL `WHERE`** — `src/storage/knowledge-namespace.ts:107` filters in-process after the DB returns cross-namespace rows. Wasted bandwidth and a tenancy footgun.
- **[P2][test-infra] Tests use real wall clock** — `freshness-policy.test.ts:58-89` and the freshness window logic in `service.ts:1903,1935` both call `Date.now()`. Midnight-rollover flake risk. Fix: injectable clock.
- **[P2][ci-supply] Dockerfile base image not pinned by digest** — `Dockerfile:1,7,14` `FROM node:22-alpine` with no `@sha256:`. Tag-mutation drift risk.
- **[P3][docs-drift] Sandbox metrics broken** — prior reflection cites `memory: 2642.9%` in `eval/sandbox/report.md`. `CLAUDE.md` still recommends `pnpm run sandbox` without a warning.

### 3.2 What the audit got right to skip

- **Workbench Preact XSS** — `grep -rn "dangerouslySetInnerHTML\|innerHTML" src/workbench/` finds nothing; all interpolation goes through JSX text nodes. Reasonable to skip.
- **Concurrent migration applier** — `migrations.ts:17-40` wraps the loop in `pg_advisory_lock(338452971, 195935983)` with `finally`-released unlock. Concurrency-safe.
- **MCP stdout discipline** — `grep -rn "console.log" src/mcp/` finds none. The invariant is honored in code (though *not* enforced by a test, which is a coverage gap the audit *did* call out at item 2.7).

---

## 4. Per-wave breakage risk and safe migration path

For each ticket in the audit's 5-wave plan: will the project break if applied as written?

### Wave 1 — Stop the bleed

| # | Ticket | Breakage risk | What breaks | Safe path |
|---|---|---|---|---|
| 1.1 | Worktree `::uuid` CASE guard | **Low** | Edge case: legitimate uuid-like text rejected by regex. | Add fixture with mixed `worktree:<sha>` + uuid; assert query succeeds; ship. |
| 1.2 | memory-store `status='approved'` | **Medium** | Any test that injects non-approved items and expects them in search results will fail. | Grep `test/` for `status:.*pending\|status:.*draft`; update fixtures or accept the failure as a real test bug. |
| 1.3 | Require API key + bind 127.0.0.1 | **HIGH** (breaking change) | Existing dev/CI/Docker users without `TUBEROSA_API_KEY` env get 401. Local curl flows break. | Default-allow on **loopback** (127.0.0.1) only; default bind to 127.0.0.1; add `TUBEROSA_HTTP_HOST` for explicit non-loopback. This keeps localhost dev unchanged while closing the remote-access hole. |
| 1.4 | Strip raw pg/redis messages | **Medium** | Tests asserting on specific error message text fail. Workbench UI loses debugging detail. | Keep `error.code`, add a public-safe `message`; log full detail server-side. Audit-fix call-sites that assert on text. |
| 1.5 | MCP `JSON.parse` try/catch | **Low** | None — pure defensive. | Ship. |
| 1.6 | Delete 3 dup 002_ migrations | **HIGH** (cosmetic-but-misleading on existing DBs) | Existing DBs keep orphan `schema_migrations` rows for the deleted filenames. Fresh DBs: no issue. | Don't delete the files. Either (a) keep them as no-op stubs with a comment, or (b) add `migrations/003_cleanup_dup_002s.sql` that `DELETE FROM schema_migrations WHERE filename LIKE '002_agent_sessions%' OR ...` and then delete the files. |
| 1.7 | Enforce `hitRate=1` default | **Low** if eval really passes at 1.0 today. | If a regression has slipped in unnoticed, CI starts failing. | Run `pnpm run eval:retrieval` first; if it passes at 1.0, flip the default and re-run. |

### Wave 2 — Coverage

Risk is uniformly **Low** (additive tests). Two adjustments after verification:

- **W2.2** rescope: `backup-service.ts` already has importers in `test/operations.test.ts` — change task to "expand existing tests for corruption / retention / partial-write" rather than "add from scratch".
- **W2.3** rescope: `maintenance/service.ts` has 4 importers — change task to "add a *dedicated* suite for proposal generation / dry-run / rollback" rather than "no test exists".
- **W2.4** (storage parity matrix) is the highest-upside item in the entire plan: it would have caught the verified divergence at #2 (status filter) and #5 (precise-vs-broad scoring buckets) automatically.

### Wave 3 — Security hardening

| # | Ticket | Breakage risk | Mitigation |
|---|---|---|---|
| 3.1 | Parameterize `buildRelationKindMultiplierSql` | **Medium** | Could shift ranking. Re-run `pnpm run eval:retrieval` and `fusion-profiles` tests. |
| 3.2 | Drop `/g` on PII regexes used with `.test()` | **Low** | Audit conflated `replace()` (which needs `/g`) with `.test()`. Real fix: keep `/g` for `replace`, reset `lastIndex = 0` before any `.test()`. |
| 3.3 | ASIA pattern | **Low** | Additive. |
| 3.4 | `requestTimeout` / `headersTimeout` | **Low** | Pick conservative defaults (e.g., 60s request, 10s headers). |
| 3.5 | Content-Type validation | **Medium** | Could break clients sending `text/plain` or omitting header. Allow `application/json` + `text/json`; log denials before rejecting for one release. |
| 3.6 | API-key into cache key | **Low** | Wait until W1.3 lands. |
| 3.7 | Unicode-normalize + base64-decode for prompt-injection | **Medium** | False-positive rate may rise. Roll out behind a config flag first. |

### Wave 4 — Maintainability split

**All structural splits in Wave 4 are HIGH-risk if applied without prerequisites.** They touch the hot path.

| Sequencing requirement | Why |
|---|---|
| W2.4 (storage parity matrix) **before** W4.1/W4.2 | Without parity tests, splitting `postgres-store.ts` ships divergence undetected. |
| W4.4 (types split) **before** W4.1/W4.2/W4.3 | If types stay in one barrel, every domain split drags the whole 1987-LOC import along; refactor benefit collapses. |
| W4.5 (mapRow* helpers) **before** removing `as` casts elsewhere | New validators must log-only first, reject second; otherwise rows the current code silently tolerates start failing. |
| W4.6 (magic numbers → config) **must preserve defaults exactly** | Audit-fix only — any default delta will move eval scores. |

### Wave 5 — Dead-code cleanup

Mostly **Low**. Two caveats:

- **W5.2** (replace CJS `require()` with `import`): the existing `require()` was added to break a circular dependency at module load. Read `model/provider.ts:55-70` and verify the cycle is gone before replacing.
- **W5.3** (prune npm scripts): need explicit team confirmation that `seed:self` / `backfill:domains` are unused. Don't silently delete.

---

## 5. Per-wave improvement upside (concrete deltas)

| Wave | Delta if shipped |
|---|---|
| **W1.1+1.2** | Closes 2 verified P0 invariants (worktree uuid crash, memory-store status drift). Storage parity tests stop showing memory↔postgres divergence on `status='approved'`. |
| **W1.3+1.4** | Closes 2 P0 security holes. Tuberosa can be deployed on a non-loopback interface without exposing raw pg internals. Pen-test surface reduced sharply. |
| **W1.5** | Removes a one-line crash vector that takes the MCP server down on any malformed frame. |
| **W1.6** | Schema authoritative — single source of truth in `001_init.sql`. Editing a dup file silently in one place stops being a class of bug. |
| **W1.7** | The CLAUDE.md-claimed invariant "`pnpm run eval:retrieval` must stay green at hitRate=1" becomes an actual build gate, not a documentation aspiration. |
| **W2.1** | `validation.ts` (1285 LOC, 0 direct tests) gets table-driven coverage. Schema drift catches at PR time, not at production. |
| **W2.4** | Storage parity matrix — single biggest upside in the plan. Would have caught both verified P0 storage-parity bugs automatically. Enables W4.1/W4.2 safely. |
| **W2.7** | Two CLAUDE.md invariants (MCP stdout discipline, embedding-dim consistency) become CI gates. |
| **W3.1** | Removes the only SQL string-interpolation site in the codebase. |
| **W3.2+3.3+3.4** | Closes redaction race + STS-key bypass + slowloris in one batch. |
| **W4.1+4.2** | postgres-store from 2746 LOC → ~5 files × 500-700; same for memory-store. Code review LOC-per-PR drops materially. |
| **W4.3** | `RetrievalService.searchContext` shrinks from 158-line orchestration to ~30-line orchestrator + 5 collaborators. |
| **W4.4** | `types.ts` 1987 → barrel + 6 per-domain files. Typecheck graph fan-out reduced; metadata field changes stop re-checking 36K LOC. |
| **W4.5** | ~50 `as` casts replaced with validated row mappers. The `as unknown as` block on backup restore (the riskiest cast in the codebase) gets a real validator. |
| **W4.6** | Suppression / fit / fusion deltas become config diffs with audit trail; eval-driven tuning stops requiring code review. |
| **W5.1** | ~600 LOC of dormant ingest modules removed; one fewer "future seam" trap for new contributors. |
| **W5.2** | Provider registry consolidates from 2 factories to 1; removes the ESM-CJS smell. |
| **W5.4** | Phase-N naming stops perpetuating phase-shaped thinking in new code. |
| **W5.5+5.6** | Worktree completeness: `tryAdd` no longer starves `git_changed` / `root_handoff`; git status with NUL-separated paths handles control chars correctly. |

### KPI roll-ups

| KPI | Before | After full plan |
|---|---|---|
| Files > 1000 LOC | 7 | 0–1 (types barrel may remain at ~200 LOC) |
| Direct `as` casts in storage | 49 + 12 `as unknown as` | <10, gated through `mapRow*` |
| Direct unit tests for trust-boundary modules (validation, write-gate, knowledge-namespace, factory) | 1 of 4 | 4 of 4 |
| CLAUDE.md invariants enforced by CI | 0 of 4 | 4 of 4 (eval hitRate, MCP stdout, embed-dim, fixture-first) |
| Documented HTTP attack surface | Unauthed on `0.0.0.0` | Authed on `127.0.0.1` default |
| Dormant LOC under `src/` | ~600 (late-chunker + contextual-summarizer + dup branches) | ~0 |
| Eval-replayed fixtures (retrieval-fixtures.json) | 14 | 17–18 (add 3–4 adversarial rows) |

---

## 6. Will the project break after fixing? — direct answer

**Per wave:**

- **Wave 1 (P0):** Safe if applied with the migration paths in §4. *Unsafe as written* for 1.3, 1.4, 1.6 (breaking changes without mitigation). Estimated rework after a naive merge: ~1 day to restore localhost dev flows and clean up orphan migration rows.
- **Wave 2 (coverage):** Safe (additive). Two rescopes recommended (W2.2, W2.3).
- **Wave 3 (security):** Safe with mitigations in §4 (W3.1 needs re-eval; W3.2 needs nuance; W3.5 needs a soft-rollout window).
- **Wave 4 (structural):** *Unsafe if applied before Wave 2.4 lands.* The parity matrix is the gate. With the matrix, safe in 1-PR-per-split increments.
- **Wave 5 (dead-code):** Safe. W5.2 needs a circular-dependency check first.

**Conclusion:** The audit's plan is correct in shape but written with assumed safety that doesn't always hold. The reordering in §7 below preserves the audit's intent while closing the breakage gaps.

---

## 7. Revised top-5 ship-first list

Incorporating both the verifier (audit corrections) and gap-hunter (audit blind spots):

1. **Add `.github/workflows/ci.yml` running `pnpm test`, `pnpm run build`, `pnpm run eval:retrieval`** (gap-hunter P0 — not in the audit). Without CI, every subsequent wave ships against a manual review gate. This is the single highest-leverage missing piece.
2. **Wave 1.6 with paired cleanup migration** — keep the 3 dup 002_ files as no-op stubs *or* add `003_cleanup_dup_002s.sql`. Don't naive-delete.
3. **Wave 1.3 + 1.4 with localhost-default allowlist** — require API key for non-loopback only; bind 127.0.0.1 default; strip raw pg messages but keep error.code. Highest blast-radius security fix that won't break local dev.
4. **Wave 1.1 + 1.2 + 1.5** — the cheap P0 patches. Worktree uuid CASE guard, memory-store status filter, MCP try/catch. ~½ day total.
5. **Flip `physicalMirrorEnabled` default to `false`** (gap-hunter P0 — not in the audit). One-line config change closes a silent-data-write footgun.

Defer until W2.4 (parity matrix) lands:
- All of Wave 4 structural splits.

Defer until embedding cache lands (gap-hunter P0, not in audit):
- Any latency / cost discussion about OpenAI provider.

---

## 8. Open questions for the user

1. **Wave 1.3 breaking-change tolerance** — okay with "default 127.0.0.1 + API key required on non-loopback" as the safe-path interpretation?
2. **Migration cleanup approach** — keep dup 002_ files as no-op stubs (safer) or add a 003_cleanup that removes orphan rows (cleaner)?
3. **CI workflow scope** — is the team okay with adding a `.github/workflows/` directory and gating PRs on test+eval, or do they prefer a different CI provider (GitLab, CircleCI, etc.)?
4. **`backup-service.ts` / `maintenance/service.ts` coverage scope** — rescope from "no tests" to "expand existing"? Confirmed by verifier.
5. **OpenAI embedding cache** — adopt now (Wave 1+) or wait until OpenAI provider becomes the default (currently `hash` is default unless `OPENAI_API_KEY` is set)?

---

## 9. What was *not* done in this evaluation

- No code edits.
- No `pnpm test` / `pnpm run eval:retrieval` run during this eval — verification was static (read + grep). A real implementation pass for any wave should run those gates before and after.
- No verification of the audit's lower-severity items (P2/P3 from the original 60+ findings). Only the P0/P1 set was spot-checked. If a wave starts execution, re-verify the relevant P2/P3 line numbers since the file may have drifted.
