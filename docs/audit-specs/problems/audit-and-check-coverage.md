# Tuberosa Multi-Agent Audit and Coverage Report

Author: Mother-agent synthesis (Claude Code, Opus 4.7)
Date: 2026-05-24
Scope: Read-only audit of `/home/nash/tuberosa` (~36K LOC TypeScript). No code changed.

Five specialist sub-agents (QA / behavior, security / pentest, code-quality, coverage, dead-code) ran in parallel against the codebase. This document is the consolidated record: the project understanding the mother agent built up, the cross-agent themes where findings reinforced each other, the full per-agent findings, and a 5-wave remediation plan with dependency ordering and effort sizing.

---

## 1. What Tuberosa is

Tuberosa is a local-first **MCP context broker**. It sits between coding agents and durable project knowledge, fetches ranked context for a task, and stores reviewed reflection memories so future agents avoid repeating mistakes.

### Two entry points

- `src/index.ts` → HTTP REST (`src/http/server.ts`).
- `src/mcp-stdio.ts` → MCP stdio (`src/mcp/server.ts`).

### Core pipeline (`src/retrieval/service.ts`)

classify → query-rewrite → parallel search (lexical / vector / metadata / memory / graph) → fusion → rerank → context-fit → context-pack → optional deep-context expansion.

### Storage

Two parallel implementations of `KnowledgeStore` (`src/storage/store.ts`):

- `PostgresKnowledgeStore` (2746 LOC) — pgvector + FTS + graph relations.
- `MemoryKnowledgeStore` (1524 LOC) — in-process.

`StorageFactory` selects by env (`TUBEROSA_STORE`).

### Agent session lifecycle

`tuberosa_start_session` → `tuberosa_record_context_decision` → `tuberosa_finish_session`. A learning gate (`src/reflection/write-gate.ts`) decides auto-approve vs. draft.

### Cross-cutting invariants (from `CLAUDE.md`)

1. `pnpm run eval:retrieval` must stay green (hitRate=1, staleRejectionRate=1).
2. `EMBEDDING_DIMENSIONS` must match `vector(N)` in `migrations/001_init.sql`.
3. MCP stdout is protocol-only — JSON-RPC frames only.
4. Retrieval improvements require a fixture case first.

### Codebase shape at audit time

- ~36K LOC TypeScript, Node 22, pnpm 11.
- Biggest files:
  - `src/storage/postgres-store.ts` 2746
  - `src/retrieval/service.ts` 2072
  - `src/types.ts` 1987
  - `src/storage/memory-store.ts` 1524
  - `src/validation.ts` 1285
  - `src/retrieval/context-pack.ts` 1182
  - `src/operations/service.ts` 1006
- 43 test files in `test/*.test.ts`.
- 4 eval-fixture JSON files in `eval/`.
- 5 SQL migration files (note: three of them share the `002_` prefix).

---

## 2. Cross-agent themes

Where multiple auditors converged on the same underlying problem.

| Theme | Auditors agreeing | Severity |
|---|---|---|
| Worktree `::uuid` leak still partially open in `getFeedbackSummaries.pack_feedback` CTE | QA | P0 |
| HTTP boundary is open-by-default: no API key required, binds `0.0.0.0`, raw pg errors leak, no slowloris timeout | Security | P0/P1 |
| MCP stdio crashes on bad JSON frame (no try/catch around `JSON.parse`) | QA + Security | P1 |
| Storage parity gap: memory-store skips `status='approved'` filter; tests only exercise pg store via 4 Docker-skipped cases | QA + Coverage | P0 |
| Documented invariants not actually enforced: eval `hitRate=1` only checked when CLI flag passed; no test for MCP stdout discipline; no test for embedding-dim equality | QA + Coverage | P0/P1 |
| Oversized modules: `postgres-store.ts` 2746, `service.ts` 2072, `types.ts` 1987, `validation.ts` 1285 — and `validation.ts` has no direct tests | Code-Quality + Coverage | P1 |
| Type-safety leak at storage boundary: 50 `as` casts in postgres-store, 12-line `as unknown as` block on restore | Code-Quality | P1 |
| Magic numbers in retrieval policy (`-0.28`, `0.0001` floor, `0.01` epsilon) belong in `config/retrieval-policy.json` | Code-Quality | P2 |
| 3 of 4 `002_*.sql` migrations duplicate `001_init.sql` | Dead-Code | P0 |
| Dormant "future seam" modules with zero importers: `late-chunker.ts`, `contextual-summarizer.ts` | Dead-Code | P1 |
| Phase-N naming pollution in test filenames and source comments | Dead-Code + Code-Quality | P3 |

---

## 3. Sub-agent findings (full)

### 3.1 QA / behavior auditor

#### Summary

The pipeline core is reasonably defended (`filterPersistedKnowledgeIds` is broadly applied), but at least one `::uuid` cast path (`getFeedbackSummaries` `pack_feedback` CTE) still crashes on `worktree:<sha>` ids, `MemoryKnowledgeStore` drifts from `PostgresKnowledgeStore` on status filtering and metadata precision, the CLAUDE.md-claimed "hitRate=1" eval is not actually asserted by default in the eval script, and several edge cases in fusion / context-fit / write-gate can mis-rank or mis-classify. Overall: "good with sharp edges" — none of the issues are subtle data-loss bugs but several are easy live-crashes or invariant violations that would silently disagree with documentation.

#### Findings

- **[P0][storage-parity] Worktree synthetic ids still leak into `::uuid` in `getFeedbackSummaries` `pack_feedback` CTE** — `src/storage/postgres-store.ts:1248` — `(item->>'knowledgeId')::uuid AS knowledge_id` is unconditional, but worktree candidates land in `pack.sections[].items` with ids like `worktree:<sha>`. Fix: wrap with `CASE WHEN item->>'knowledgeId' ~ '^[0-9a-f-]{36}$' THEN ... END` or filter in `WHERE`.
- **[P0][storage-parity] MemoryKnowledgeStore returns non-approved items from lexical/metadata/vector/memory search** — `src/storage/memory-store.ts:1205` — `allowed()` checks project/rejected only, never `item.status === 'approved'`. Fix: add status filter to `allowed`, matching Postgres' `WHERE ki.status = 'approved'`.
- **[P1][eval] CLAUDE.md says eval asserts hitRate=1 but the script only fails when `--fail-under-hit-rate` is passed** — `scripts/eval-retrieval.ts:239` — `missedThreshold = options.failUnderHitRate !== undefined && …`. Fix: set a built-in default `failUnderHitRate=1` or document that per-case `passed` is the actual invariant.
- **[P1][pipeline] `applyNoiseTolerance('strict')` is a no-op unless `fitStatus` is already `ready`** — `src/retrieval/service.ts:1455` — `if (noiseTolerance !== 'strict' || contextFit.fitStatus !== 'ready') return contextFit;`. A strict caller getting `needs_confirmation` with weak semantic evidence is not downgraded further to `insufficient`. Fix: also penalize `needs_confirmation` lacking hard signals.
- **[P1][pipeline] Fusion `keepExistingChunk` logic discards higher-`rawScore` content when `existing.rawScore` ties or wins by epsilon** — `src/retrieval/fusion.ts:75` — `const keepExistingChunk = existing.rawScore >= candidate.rawScore;`. If a stronger source (e.g. worktree raw 1.0) arrives after a metadata hit at 0.94, the spread-merge branch still merges fields, but tie at 0.94 keeps the older chunk silently. Fix: prefer the more authoritative source on ties (worktree / lexical > metadata).
- **[P1][pipeline] Empty `maxScore` guard collapses tiny scores to inflated normalized values** — `src/retrieval/fusion.ts:85` — `Math.max(..., 0.0001)`. When every candidate has `fusedScore ~1e-5` (one source, deep rank), the divisor 0.0001 normalizes everything to ~10x its true relative ranking, then `clamp(0,1)` flattens to 1. Fix: track whether any candidate exceeds the floor before normalizing.
- **[P1][session] Learning gate counts `gate.status === 'unknown'` as failure but `gateLearningMode` returns `'unknown'` when mode is undefined** — `src/reflection/recommendation.ts:100` and `src/agent-session/service.ts:422` — `gates.filter((gate) => gate.status !== 'pass')` blocks auto-approve unless mode is explicitly set. The auto session path defaults `input.learningMode ?? 'auto'` so this works for first call, but any future caller passing `undefined` silently never auto-approves. Fix: treat absent mode as `'auto'` inside `gateLearningMode` or assert non-undefined upstream.
- **[P1][reflection] Write-gate `cosineFn` ignores zero-length embedding and falls back to `rawScore`, masking embedding failures** — `src/reflection/write-gate.ts:169` — `if (!candidateEmbedding || candidateEmbedding.length === 0) return clampCosine(candidate.rawScore);`. When `models.embed` returns `[]` silently for a hostile input, the gate uses the lexical proxy and may auto-NOOP/UPDATE a draft that contradicts an existing memory. Fix: when embedding fails, refuse to auto-decide stronger than ADD.
- **[P2][worktree] Worktree `tryAdd` early-exits the whole collection once `seen.size >= maxFiles` is hit during the prompt phase** — `src/retrieval/worktree.ts:235,248` — `if (seen.size >= this.options.maxFiles) return;` triggers after just the basename-root expansion (six paths per name), so `git_changed` and `root_handoff` can be starved when several prompt-named files exist. Fix: track `prompt_named` additions separately, or only cap per-reason bucket.
- **[P2][pipeline] `applyQueryRewrite` token regex strips Vietnamese / non-ASCII identifiers** — `src/retrieval/service.ts:1495` — `sanitizedRewriteQuery.match(/[a-zA-Z0-9_./:-]{3,}/g)`. A CLAUDE.md-mandated Vietnamese landing-page query loses every diacritic token after rewrite. Fix: use `\p{L}\p{N}` Unicode classes.
- **[P2][storage-parity] `memory-store.searchMetadata` does not distinguish precise vs broad terms; Postgres assigns 0.94/0.82** — `src/storage/memory-store.ts:513` and `src/storage/postgres-store.ts:884`. Memory store uses uniform `matches/terms.size` ratio, so tests that pass on `MemoryKnowledgeStore` can mask ranking regressions only visible in Postgres. Fix: mirror precise/broad scoring buckets.
- **[P2][session] `selectedContextPack` returns the most-recent selected decision but uses `.reverse()` on an unordered list** — `src/agent-session/service.ts:315` — `[...decisions].reverse().find(...)` assumes input order is chronological; `listAgentContextDecisions` is order-dependent. Fix: explicitly sort by `createdAt desc`.
- **[P2][reflection] `detectContradiction` compares basenames but only flags when paths share basename AND differ; identical paths with differing line ranges escape** — `src/reflection/write-gate.ts:272` — `basename(candidateFile) === draftBase && draftFile !== candidateFile`. A draft saying "set X = false" pointing to the same file/line as an existing "set X = true" memory never triggers DELETE. Fix: also detect content negation patterns inside the same path.
- **[P2][ingestion] Worktree `collectGitStatusPaths` strips only quotes, not C-style backslash escapes git emits for paths with control chars** — `src/retrieval/worktree.ts:323` — `stripGitQuoting` only handles leading/trailing `"`. Paths like `"hand\noff.md"` are accepted with literal `\n`, causing `tryAdd` to silently miss the real file. Fix: pass `-z` to git status and split on NUL.
- **[P3][mcp-boundary] Diagnostics inside `process.stdin('data')` handlers can crash the buffer-drain loop with unhandled `JSON.parse` on truncated frames** — `src/mcp-stdio.ts:28` — `JSON.parse(framed.body)` lacks try/catch. A malformed line frame from a misbehaving client tears down the stdio loop. Fix: wrap in try/catch and write a parse-error response.

#### Top-priority list

1. Fix the `worktree:<sha>` `::uuid` leak in `getFeedbackSummaries.pack_feedback` CTE (`postgres-store.ts:1248`) — same bug class as the known P0, only partially closed.
2. Add `status='approved'` filter to `MemoryKnowledgeStore.allowed()` so storage backends are semantically interchangeable.
3. Make `pnpm run eval:retrieval` enforce `hitRate=1` by default, so the documented invariant is actually a build gate.
4. Tighten `applyNoiseTolerance` to downgrade `needs_confirmation` when strict callers lack hard signals.
5. Guard `fuseCandidates` against the `maxScore=0.0001` floor inflating tiny scores; require at least one candidate above the floor before normalizing.

---

### 3.2 Security / pentest auditor

#### Summary

Tuberosa has solid baseline hygiene — every Postgres call is parameterized, the workbench static handler defends path traversal, secrets are redacted at ingest and at retrieval. The biggest blind spots are at the perimeter: the HTTP server ships unauthenticated by default and likely binds to `0.0.0.0`; raw pg / Redis error messages and stacks reach clients via `appErrorToHttpBody`; one PII regex carries `/g` state across `replace+test` boundaries; and the MCP stdio frame is a hard crash on bad input.

#### Findings

- **[P0][http] HTTP server is unauthenticated by default** — `src/http/server.ts:794-800` — `if (!apiKey) return true;` in `isAuthorizedApiKey`, and `src/config.ts:52` defaults `apiKey: process.env.TUBEROSA_API_KEY || undefined`, so every mutating route (ingest, knowledge POST/PATCH, restore-backup, cleanup) is wide open when the env var is unset. Fix: make `apiKey` required at boot, or refuse to start non-loopback listeners without one.
- **[P0][http] Listener implicitly binds to `0.0.0.0`** — `src/index.ts:7` — `server.listen(services.config.port, () => { ... console.log('listening on http://localhost') })` calls `listen(port)` with no host, which Node binds to `::`/`0.0.0.0`; the log is misleading. Fix: pass `'127.0.0.1'` explicitly, or gate the bind host via config.
- **[P1][info-leak] Raw error messages leak to clients** — `src/errors.ts:101-129, 132-138` — `toAppError` builds `StoreError(errorMessage(error), error)` from the raw pg error and `appErrorToHttpBody` returns `error: error.message`, exposing pg syntax / SQLSTATE / table names (e.g. forcing `getAgentSession('not-a-uuid')` returns `invalid input syntax for type uuid: "not-a-uuid"`). Fix: replace pg / redis messages with a code-only generic message; keep details in server logs.
- **[P1][info-leak] HTTP 500 errors include client User-Agent + path in persisted logs** — `src/http/server.ts:1023-1042` — `services.errorLogs.recordLog({ ... message: error.message, stack: error.stack, ... userAgent: request.headers['user-agent'] })` writes attacker-controlled UA into disk-backed JSON read by the workbench. Fix: strip / limit stack traces and validate UA length before persisting.
- **[P1][mcp] MCP stdio crashes on malformed JSON frame** — `src/mcp-stdio.ts:28` — `const message = JSON.parse(framed.body) as JsonRpcRequest;` runs outside the try/catch (line 33-42 wraps only `handleMcpRequest`). A single garbled frame terminates the process. Fix: wrap parse in try/catch and emit a `-32700 Parse error` response.
- **[P1][redaction] PII regex `/g` flag carries `lastIndex` across `test`+`replace`** — `src/security/knowledge-safety.ts:228-241` plus `redactSecretPatterns` — `PII_EMAIL_PATTERN.pattern = /.../g` shares state. Other code paths call `pattern.test(text)` in BLOCK/SUSPICIOUS lists (line 251, 256) — fine there (no `/g`), but combining `/g` regexes with `.replace(pattern, …)` in tight loops with no reset is fragile if any new caller does `.test()` on them. Fix: drop `/g` from regexes you also pass to `.test()`, or `regex.lastIndex = 0` defensively.
- **[P1][sqli] Dynamic SQL string interpolation in graph relations** — `src/storage/postgres-store.ts:2647-2657, 978` — `buildRelationKindMultiplierSql` interpolates `relation_type` keys via `formatSqlString('${value}')` doubling quotes manually. Comment claims values are "server-side config (no user input)", but `policy.relationKindMultipliers` is read from `config/retrieval-policy.json` (`src/retrieval/policy.ts:345 JSON.parse`) which is editable on disk. Fix: use a parameterized `CASE` with `unnest($1::text[], $2::real[])` or whitelist `relationType` against the `KnowledgeRelationType` union before interpolation.
- **[P1][http] No request-timeout / slowloris protection** — `src/http/server.ts:756-775` — `readJsonBody` `for await (const chunk of request)` has byte cap (10 MiB) but no socket timeout. A 1-byte-per-second client holds a worker indefinitely. Fix: set `server.requestTimeout` / `headersTimeout` in `src/index.ts`.
- **[P2][redaction] AWS access key bypass via lowercase / context** — `src/security/knowledge-safety.ts:115-117` — `/\bAKIA[0-9A-Z]{16}\b/g` misses `aSIA`/`ASIA` STS temporary keys and any wrapping like `aws_access=AKIA…` only catches if the assignment validator also matches (which is the *medium* `credential_assignment` rule). Fix: add ASIA pattern and consider entropy-only fallback for high-entropy 20-char base32 tokens.
- **[P2][redaction] `credential_assignment` skips comments and "placeholder" — `PLACEHOLDER_REGEXES` is too permissive** — `src/security/knowledge-safety.ts:129-138` — anything matching `/^(?:your[_-]|my[_-]|test[_-]|dummy[_-]…)/i` is treated as a placeholder. A real secret prefixed with `test_` (e.g. `password = "test_secrets_real_value_123"`) is silently kept. Fix: tighten the prefix list to require trailing placeholder marker, not just any continuation.
- **[P2][cache] Cache key not namespaced by API key / principal** — `src/retrieval/service.ts:170` + `1426` — `cacheKey = 'context:' + sha256(stableJson({ ..., namespace: input.namespace ?? null }))`. If two tenants share a Redis but pass different `namespace` they get separate entries — good. But `apiKey` / principal is not in the fingerprint, so when the API-key fix above lands, two callers with the same prompt+namespace still share cached packs (and any future per-principal authz filters). Fix: mix the API-key fingerprint into the cache key.
- **[P2][exec] `new Function('s','return import(s)')` indirection** — `src/model/local-provider.ts:210` — used to lazy-load an optional transformers package. The `specifier` is a hard-coded string, so it's not directly exploitable, but it bypasses static analyzers and could become a sink if a future caller passes user-influenced module names. Fix: replace with a direct `await import('@xenova/transformers')` guarded by try/catch.
- **[P3][prompt-injection] BLOCK list is English-only / easily encoded** — `src/security/knowledge-safety.ts:186-215` — patterns are case-insensitive English, no base64 / URL-encoding / zero-width handling. A retrieved file containing `aWdub3JlIGFsbCBwcmV2aW91cyBpbnN0cnVjdGlvbnM=` or `ignore​all​previous​instructions` passes. Fix: add unicode-normalization + base64 candidate decoding before classification (still on the read path only).
- **[P3][http] No Content-Type validation on POST routes** — `src/http/server.ts:748-775` — `readJsonBody` parses any payload as JSON regardless of `Content-Type`. Combined with no CORS preflight on browsers, this enables form-encoded CSRF on a browser sharing localhost. Fix: require `application/json`.
- **[P3][http] `decodeURIComponent` of path params can throw a different error than expected** — `src/http/server.ts:868-875` — malformed `%` sequences raise `URIError` but are caught and remapped to 400. Fine; just confirm no logs at this layer leak the raw URL.

#### Top-priority list

1. Require an API key at boot for all non-public routes and bind HTTP to `127.0.0.1` unless `TUBEROSA_HTTP_HOST` is explicitly set (`src/index.ts:7`, `src/http/server.ts:794-800`, `src/config.ts:52`).
2. Stop returning raw pg / redis error messages to HTTP and JSON-RPC clients — return code-only bodies, log details server-side (`src/errors.ts:101-138`).
3. Wrap `JSON.parse` in `src/mcp-stdio.ts:28` in try/catch and respond with `-32700`; reject frames > a hard byte cap (matches `maxRequestBytes`).
4. Replace `buildRelationKindMultiplierSql` interpolation with a parameterized `unnest()` form, or whitelist `relationType` against `KNOWLEDGE_RELATION_TYPES` before formatting (`src/storage/postgres-store.ts:2647-2657`).
5. Drop the `/g` flag on PII regexes that are also used with `.test()` and add an explicit `pattern.lastIndex = 0` guard in `redactSecretPatterns` (`src/security/knowledge-safety.ts:228-241, 453-492`); add ASIA temporary-key pattern and tighten the placeholder allowlist.

---

### 3.3 Code-quality auditor

#### Summary

The hot paths (`postgres-store.ts`, `retrieval/service.ts`, `types.ts`) have grown well past the size where cohesion is defensible: 2746 / 2072 / 1987 LOC. Type safety is leaky at the storage boundary (50 `as` casts in `postgres-store.ts`, a 12-line block of `as unknown as` row coercions in `memory-store.ts`), and retrieval logic is studded with hard-coded magic floats whose meaning lives only in narrative comments. There are no swallowed catches and no `TODO/FIXME/HACK` debt markers (a real positive), but "Phase N deviation" comments are doing the same job less visibly.

#### Findings

- **[P1][file-size] `postgres-store.ts` is a 2746-LOC dumping ground** — `src/storage/postgres-store.ts:1` — single class mixes knowledge CRUD, labels, references, chunks, FTS/vector/memory/graph search, feedback, sessions, drafts, conflicts, gaps, proposals, and backup. Fix: split per domain (see Module-split proposals).
- **[P1][file-size] `RetrievalService` is 2072 LOC with 19 private methods** — `src/retrieval/service.ts:118` — one class owns classify → probe → rewrite → search → rank → fit → assemble plus all feedback / learning side effects. Fix: extract `QueryRewriter`, `CandidateRanker`, and `FeedbackLearningService` collaborators.
- **[P1][abstraction] `types.ts` is a 1987-LOC barrel of 203 exports** — `src/types.ts:1` — every interface/type/enum across storage, retrieval, agent sessions, feedback, operations, workbench coexists in one file. Fix: split into `types/{knowledge,retrieval,feedback,session,workbench}.ts` re-exported from a barrel.
- **[P1][typing] `as unknown as` block bypasses validation on backup restore** — `src/storage/memory-store.ts:1062` — `const item = row as unknown as StoredKnowledge;` repeats for 12 row kinds with zero shape check. Fix: add per-table runtime validators in `validation.ts` and parse rows instead of double-casting.
- **[P1][typing] 50 row-cast assertions in postgres-store** — `src/storage/postgres-store.ts:793` — e.g. `type: row.label_type as LabelRecord['type']` trusts the DB driver to align discriminated unions. Fix: introduce one `mapRow*` helper per table that validates enum membership and yields a typed object once.
- **[P1][complexity] `RetrievalService.searchContext` is a 158-line orchestration with 12 named locals** — `src/retrieval/service.ts:118` — interleaves rewrite-probe, cache check, classify, rank, fit, deep-context, debug timing in one method. Fix: extract `prepareRewrite()`, `runCandidatePipeline()`, `assemble()` and keep `searchContext` to ~30 lines.
- **[P1][complexity] `intentSuppressionAdjustment` is a 128-line tower of feature flags** — `src/retrieval/service.ts:1767` — six conditional branches each push to `reasons`/`events` with different penalty math. Fix: drive it from a `SuppressionRule[]` table where each rule owns its predicate, delta, reason code, and evidence formatter.
- **[P1][complexity] `cleanupOperations` duplicates four SELECT/DELETE pairs inline** — `src/storage/postgres-store.ts:1681` — same `created_at < now() - ($1::int * interval '1 day')` predicate repeated four times with hand-written count + delete. Fix: loop over a `CleanupTask[]` config of `{ countSql, deleteSql }`.
- **[P2][magic-number] Suppression and freshness penalties are bare literals** — `src/retrieval/service.ts:1781` — `const delta = -Math.min(0.28, 0.18 + strongest * 0.08);` with two more `-0.14`, `-0.10`, `0.6`, `0.22` deltas inline. Fix: move to a `SUPPRESSION_DELTAS` constant block or to `retrieval-policy.json` alongside the existing `domainMismatch` config.
- **[P2][magic-number] Context-fit clamp values are inline** — `src/retrieval/context-fit.ts:212` — `fitScore = Math.min(fitScore, thresholds.ready - 0.01);` with a sibling `- 0.01` at line 221 and `0.12` floor at 539. Fix: name them (`READY_FLOOR_EPSILON`, `WORKTREE_SCORE_CAP`) so a reader can grep their meaning.
- **[P2][duplication] `searchMemories` exists in both stores with different shapes** — `src/storage/postgres-store.ts:924` and `src/storage/memory-store.ts:544` — each rebuilds query parsing, lexical-vs-substring matching, ranking, dedup, and limit by hand. Fix: define a shared `CandidateMatcher` helper module that returns `(item, score, source)` so both stores diverge only on the IO layer.
- **[P2][duplication] `canonicalKnowledgePair` defined twice** — `src/storage/postgres-store.ts:2410` and `src/storage/memory-store.ts:1245` — verbatim sort-and-tuple helper exists in both stores. Fix: move to `src/storage/shared.ts`.
- **[P2][abstraction] `metadata?: Record<string, unknown>` appears 35× in hot paths and ≥30× in `types.ts`** — `src/types.ts:105` — typed entry points immediately erase to `unknown`, so every reader re-validates. Fix: define `KnowledgeMetadata`, `FeedbackMetadata`, etc. with `extends Record<string, unknown>` so producers stay loose but readers get hints.
- **[P2][comments] "Phase N deviation" comments are the new TODO** — `src/storage/postgres-store.ts:968`, `src/retrieval/context-fit.ts:146`, `src/retrieval/service.ts:436`, `src/storage/memory-store.ts:559` — load-bearing eval-driven exceptions ("regressed 3 retrieval-eval confidence thresholds") buried in prose. Fix: move each to a tracked entry in `retrieval-policy.json` or a `DEVIATIONS.md`; reference by id from the code.
- **[P2][naming] Suppression reason codes are stringly-typed across files** — `src/retrieval/service.ts:1785` emits `'superseded'`, `'stale_freshness'`, `'evidence_mismatch'`, `'domain_mismatch'`; `src/retrieval/context-pack.ts:768,800` use free-text reasons. Fix: promote to `type SuppressionReason = …` literal union (already partially present at 1810) and require every emit site to use it.
- **[P3][complexity] `isContinuationIntent` is a 259-line predicate** — `src/retrieval/classifier.ts:519` — single boolean function ranking continuation evidence with nested branches. Fix: split into `hasContinuationLexicalCue`, `hasContinuationPronominal`, `hasContinuationEntityRef` and combine with a small scorer.
- **[P3][complexity] `recommendedActions` is 142 lines** — `src/operations/workbench-summary.ts:220` — assembles UI suggestions through chained pushes per workbench area. Fix: drive from a declarative `Recommendation[]` config keyed by workbench-area state.
- **[P3][dead-branch] `ki.item_type = ANY('{memory,workflow,rule,bugfix}'::text[])` then re-filters on `OR lower(ki.title) LIKE $5`** — `src/storage/postgres-store.ts:932` — the `LIKE` substring fallback runs even when `search_vector @@ q.query` already matched, doubling the cost on common queries. Fix: use `WHERE … (search_vector @@ q.query OR (q.query IS NULL AND lower(...) LIKE $5))` and gate the substring branch on empty `lexicalQuery`.

#### Module-split proposals

- `src/storage/postgres-store.ts` (2746) → `postgres/{knowledge-store, label-store, search-store, feedback-store, session-store, backup-store}.ts` with a thin `PostgresKnowledgeStore` facade composing them.
- `src/retrieval/service.ts` (2072) → `retrieval/{service, query-rewriter, candidate-finder, ranker, suppression, feedback-learning}.ts`; `service.ts` shrinks to the orchestrator only.
- `src/types.ts` (1987) → `types/{knowledge, retrieval, feedback, session, workbench, ingestion}.ts` with `src/types.ts` as a barrel re-export.
- `src/storage/memory-store.ts` (1524) → mirror the postgres split into `memory/{knowledge, search, feedback, session, backup}.ts` so the two stores stay structurally symmetric.
- `src/validation.ts` (1285) → `validation/{knowledge, retrieval, agent-session, feedback}.ts`.

#### Top-priority list

1. Split `postgres-store.ts` along the same domain seams as the memory-store split — biggest LOC blast radius and unblocks safer typed row mappers.
2. Replace the 50 `as` casts (postgres-store) and 12 `as unknown as` rows (memory-store) with validated `mapRow*` helpers; the backup restore at `memory-store.ts:1062` is the highest-risk path because it accepts arbitrary input.
3. Extract `QueryRewriter`, `CandidateRanker`, and `FeedbackLearningService` out of `RetrievalService` so `searchContext` (158L) and `recordFeedback`-driven learning (lines 282-366) stop sharing state with classification.
4. Promote all suppression / fit magic numbers (`service.ts:1781,1793,1807,1827`, `context-fit.ts:212,221,539`) into `retrieval-policy.json` so eval-driven tuning stays a config diff, not a code diff.
5. Decompose `types.ts` into per-domain files; today every change to a `metadata` field forces a re-typecheck across 36K LOC because everything imports from one barrel.

---

### 3.4 Coverage auditor

#### Summary

Tuberosa has dense unit coverage of the retrieval pipeline and core happy paths (43 test files, ~13K test LOC against ~36K source LOC), with strong fixture-based safety / retrieval evals. The biggest gaps are: storage-implementation parity (Postgres-only paths are exercised by one Docker-gated file with 4 cases), several real source modules with no dedicated test (`backup-service.ts`, `maintenance/service.ts`, `label-enricher.ts`, `contextual-summarizer.ts`, `late-chunker.ts`, `http/server.ts`, `mcp/server.ts`, `validation.ts`, `errors.ts`, `cache.ts`), and the absence of a fixture asserting MCP stdout discipline / embedding-dimension consistency invariants stated in CLAUDE.md.

#### Coverage matrix

**retrieval/**
- `src/retrieval/classifier.ts` → `test/classifier-phase1.test.ts` + `test/retrieval.test.ts` [strong]
- `src/retrieval/fusion.ts` → `test/fusion-profiles.test.ts` + `test/retrieval.test.ts` [strong]
- `src/retrieval/context-fit.ts` → `test/context-fit-phase3.test.ts` [weak] (3 cases, focused on rerank-failure branch)
- `src/retrieval/context-pack.ts` → `test/context-pack-phase8.test.ts` + `test/retrieval.test.ts` [strong]
- `src/retrieval/policy.ts` → `test/retrieval-policy.test.ts` [strong]
- `src/retrieval/feedback-scorer.ts` → `test/feedback-scorer-phase2.test.ts` [strong]
- `src/retrieval/service.ts` → `test/retrieval.test.ts` (44 cases) [strong]
- `src/retrieval/worktree.ts` → `test/worktree-phase5.test.ts` [strong]
- `src/retrieval/debug.ts` → none [none]
- `src/retrieval/candidate-helpers.ts` → none [none]

**storage/**
- `src/storage/memory-store.ts` → exercised by 15+ test files [strong]
- `src/storage/postgres-store.ts` → `test/integration.test.ts` (4 cases, Docker-skip) [weak]
- `src/storage/factory.ts` → none directly [none]
- `src/storage/migrations.ts` → `test/integration.test.ts` (concurrent runner case) [weak]
- `src/storage/knowledge-namespace.ts` → none [none]
- `src/storage/store.ts` (interface) → `test/types.test.ts` (producer-symmetry check) [weak]

**ingest/**
- `src/ingest/service.ts` → `test/retrieval.test.ts` (re-ingestion cases) + others [strong]
- `src/ingest/document-atomizer.ts` → `test/document-atomizer-phase4.test.ts` [strong]
- `src/ingest/duplicate-detector.ts` → `test/duplicate-detector.test.ts` [strong]
- `src/ingest/item-type-inference.ts` → `test/item-type-inference.test.ts` [strong]
- `src/ingest/label-enricher.ts` → none [none]
- `src/ingest/contextual-summarizer.ts` → none [none]
- `src/ingest/late-chunker.ts` → none [none]

**reflection/**
- `src/reflection/service.ts` → `test/agent-session.test.ts`, `test/phase10.test.ts` [strong]
- `src/reflection/recommendation.ts` → `test/recommendation.test.ts` [strong]
- `src/reflection/write-gate.ts` → none [none]

**agent-session/**
- `src/agent-session/service.ts` → `test/agent-session.test.ts` (10 cases) [strong]

**relations/**
- `src/relations/ast-extractor.ts` → `test/ast-extractor.test.ts` (4 cases) [weak]
- `src/relations/inference.ts` → none directly [none]
- `src/relations/ontology.ts` → `test/ontology.test.ts` [strong]

**model/**
- `src/model/provider.ts` → `test/model-provider.test.ts` [strong]
- `src/model/local-provider.ts` → `test/local-provider.test.ts` [strong]
- `src/model/ollama-provider.ts` → `test/ollama-provider.test.ts` [strong]
- `src/model/registry.ts` → none [none]

**mcp/ + http/**
- `src/mcp/server.ts` (1365 LOC) → `test/api-boundary.test.ts` (boundary), no direct unit suite [weak]
- `src/http/server.ts` (1067 LOC) → `test/api-boundary.test.ts`, `test/http-security.test.ts` (3 cases) [weak]
- `src/http/workbench.ts` → none directly [none]
- `src/mcp-stdio.ts` → `test/cli.test.ts` (stdout sanity smoke) [weak]

**security/**
- `src/security/knowledge-safety.ts` → `test/knowledge-safety-phase9.test.ts` + `eval/safety-fixtures.json` [strong]

**operations/**
- `src/operations/service.ts` → `test/operations.test.ts` (17 cases) [strong]
- `src/operations/backup-service.ts` (802 LOC) → only `test/operations.test.ts` backup/restore cases [weak]
- `src/operations/workbench-cli.ts` → `test/workbench-cli.test.ts` [strong]
- `src/operations/context-quality-cli.ts` → `test/context-quality-cli.test.ts` [strong]
- `src/operations/organization-cli.ts` → `test/organization-cli.test.ts` [strong]
- `src/operations/sandbox-report.ts` → `test/sandbox-report.test.ts` [strong]
- `src/operations/last-eval.ts` → `test/last-eval.test.ts` [strong]
- `src/operations/catchup.ts` → `test/catchup-metadata.test.ts` [strong]
- `src/operations/workbench-summary.ts` → `test/operations.test.ts` (1 case) [weak]

**maintenance/, error-log/, evaluation/, workbench/**
- `src/maintenance/service.ts` → none directly [none]
- `src/error-log/service.ts` → `test/error-log.test.ts` [strong]
- `src/error-log/insights.ts` → none directly [none]
- `src/evaluation/*` → `test/evaluation.test.ts` (303 LOC) [weak] (covers retrieval + safety; mapping/completeness branches lighter)
- `src/workbench/presenters/*` → `test/workbench-presenters.test.ts` [strong]
- `src/workbench/state/*` → none [none]
- `src/workbench/glossary/terms.ts` → none [none]

**infra/**
- `src/cache.ts` → integration-only [weak]
- `src/config.ts` → `test/config.test.ts` (2 cases) [weak]
- `src/validation.ts` (1285 LOC) → indirectly via `test/api-boundary.test.ts` [weak]
- `src/errors.ts` → indirectly [weak]
- `src/app.ts` → none [none]
- `src/worker.ts` → none [none]

#### Findings (gaps)

- **[P0][untested] No unit tests for `backup-service.ts`** — `src/operations/backup-service.ts` — an 802-LOC module (backup, verify, restore, retention) is only exercised through 2 end-to-end operations tests; corruption / retention edge branches are untested in isolation. Add focused tests for checksum mismatch, partial-write recovery, retention pruning order, and restore-into-non-empty-store.
- **[P0][parity] Postgres vs Memory store parity is single-case** — `src/storage/postgres-store.ts` (2746 LOC) — only `test/integration.test.ts` cases 1 and 2 exercise pgvector + FTS, and they are Docker-skipped on CI absent a fixture. Add a parity matrix that runs the same retrieval / ingest scenarios against both `StorageFactory` outputs.
- **[P0][untested] `maintenance/service.ts` has no dedicated test** — `src/maintenance/service.ts` (396 LOC) — `tuberosa_propose_maintenance` / `apply_maintenance` are referenced only indirectly through `operations.test.ts`; no test asserts proposal generation, dry-run vs apply, or rollback. Add a unit suite covering proposal types, idempotency, and refusal paths.
- **[P0][untested] `validation.ts` is the trust boundary, no direct tests** — `src/validation.ts` (1285 LOC) — schemas are exercised only via `api-boundary.test.ts` happy / malformed pairs; branch coverage of enum coercion (taskType aliases), numeric bounds, optional-field defaults, and recursive label/reference validation is thin. Add table-driven tests per schema.
- **[P1][untested] Several ingest helpers untested** — `src/ingest/label-enricher.ts`, `src/ingest/contextual-summarizer.ts`, `src/ingest/late-chunker.ts` — no direct test files; behavior only seen end-to-end. Add unit tests for label-inference precedence, summary truncation, and late-chunk boundary rules.
- **[P1][untested] `reflection/write-gate.ts` has no test** — `src/reflection/write-gate.ts` (326 LOC) — gate decisions (auto-approve vs review) are only verified via `agent-session.test.ts` outcomes. Add direct cases for each gate input (low confidence, negative feedback, missing-context decision, noisy selection).
- **[P1][branch-gap] context-fit thresholds have only 3 cases** — `src/retrieval/context-fit.ts` (684 LOC, 3 tests) — only the rerank-failure branch and contributor-shape assertions exist; `ready / needs_confirmation / insufficient` threshold transitions, missing-signal enumeration, and worktree-match scoring boundaries lack explicit fixture rows. Add prompts where each status is the exact expected output.
- **[P1][untested] `knowledge-namespace` + `storage/factory` + `model/registry`** — `src/storage/knowledge-namespace.ts`, `src/storage/factory.ts`, `src/model/registry.ts` — no test references. Add tests for namespace normalization across projects / worktrees and factory env-driven selection (memory / pg).
- **[P1][weak] `errors.ts` and `http-security.test.ts`** — `src/errors.ts` (197 LOC) + `test/http-security.test.ts` (only 3 cases) — error class hierarchy, code-to-HTTP mapping, and API-key handling under proxy headers / empty config are barely covered. Add tests for each `TuberosaError` subtype and for the unauthenticated-vs-misconfigured branch.
- **[P1][eval-gap] No fixture asserts MCP stdout discipline** — `src/mcp-stdio.ts`, `src/mcp/server.ts` — CLAUDE.md says "MCP stdout is protocol-only" but only `test/cli.test.ts` greps `mcp stdout sanity` once. Add a spawned-child fixture that pipes every server tool call and asserts every stdout chunk parses as JSON-RPC.
- **[P1][eval-gap] No invariant test for embedding-dimension consistency** — `src/config.ts`, `migrations/001_init.sql` — CLAUDE.md mandates `EMBEDDING_DIMENSIONS` matches `vector(N)` but no test reads the SQL to compare. Add a config test that parses the migration and asserts equality.
- **[P2][weak] evaluation/* suite is 303 LOC for 4 evaluators** — `src/evaluation/{context-mapping,knowledge-completeness,retrieval,safety}-evaluator.ts` — `test/evaluation.test.ts` covers retrieval + safety primarily; context-mapping and knowledge-completeness evaluators get fewer assertions. Add scenarios that flip fail/pass states for each evaluator independently.
- **[P2][untested] workbench state store + glossary** — `src/workbench/state/{api,store}.ts`, `src/workbench/glossary/terms.ts` — no direct tests; only presenters are covered. Add reducer / store transition tests and glossary completeness assertion.
- **[P2][weak] `ast-extractor.ts` has 4 tests for 150 LOC** — `src/relations/ast-extractor.ts` — only TS console-filter + basic call extraction. Add cases for default exports, re-exports, decorators, JSX, dynamic imports.
- **[P3][eval-gap] `retrieval-fixtures.json` has 14 cases** — `eval/retrieval-fixtures.json` — covers paywall, auth, phase handoff, sender-queue clusters but no negative-mismatch ("retrieve nothing"), no multi-project namespace isolation, no large-pack overflow. Add 3-4 adversarial rows.

#### Top-priority list

1. **Add a memory/Postgres parity test matrix.** Same fixtures run twice through `StorageFactory` — currently only `integration.test.ts` cases 1–2 verify pgvector equivalence, and they skip outside Docker.
2. **Unit test `backup-service.ts` corruption / restore / retention paths in isolation** — 802 LOC of dangerous code with only e2e coverage.
3. **Direct tests for `validation.ts` schemas** — 1285 LOC at the HTTP / MCP boundary, currently only exercised indirectly.
4. **Cover `maintenance/service.ts` and `reflection/write-gate.ts` directly** — both are gating logic and only seen through outer flows.
5. **Add eval fixtures for the two CLAUDE.md invariants without coverage**: MCP stdout discipline (spawned-process JSON-RPC frame check) and embedding-dimension consistency (parse migration SQL vs config).

---

### 3.5 Dead-code / redundancy auditor

#### Summary

The biggest dead-code issues are at the schema layer: three of the four `002_*.sql` migrations duplicate tables and indexes already defined in `001_init.sql` (effective no-ops thanks to `CREATE TABLE IF NOT EXISTS`), and only `002_learning_review_records.sql` adds new schema (`knowledge_gaps`, `learning_review_records`). At the code layer, `src/ingest/late-chunker.ts` and `src/ingest/contextual-summarizer.ts` are explicit "future seam, not an active code path" modules with zero call sites in `src/`, `test/`, or `scripts/`. A handful of npm scripts (`seed:self`, `backfill:domains`) target files referenced nowhere outside `package.json`, and one CommonJS `require()` in an ESM module is a dead-branch smell. Overall burden is moderate, not severe.

#### Findings

- **[P0][migration-conflict] `002_knowledge_relations.sql` recreates table already in `001_init.sql`** — `migrations/002_knowledge_relations.sql:1-20` vs `migrations/001_init.sql:75-90,210-213` — `diff` showed table body identical; only the four `idx_knowledge_relations_*` indexes are deltas, and all four are already present in `001_init.sql:210-213`. Migration runs as a no-op against fresh DBs. Delete the file.
- **[P0][migration-conflict] `002_agent_sessions.sql` recreates table already in `001_init.sql`** — `migrations/002_agent_sessions.sql:1-32` vs `migrations/001_init.sql:175-221` — `agent_sessions` + `agent_context_decisions` + `idx_agent_sessions_project_status` and `idx_agent_decisions_session` all live in `001_init.sql`. Delete the file.
- **[P0][migration-conflict] `002_knowledge_conflicts.sql` recreates table already in `001_init.sql`** — `migrations/002_knowledge_conflicts.sql:1-20` vs `migrations/001_init.sql:91-?,214-216` — table + indexes already in 001. Delete the file. Keep `002_learning_review_records.sql` (only one with novel tables `learning_review_records` / `knowledge_gaps`).
- **[P0][migration-conflict] Migration ordering is lexicographic-only** — `src/storage/migrations.ts:28` (`readdir().sort()`) — four `002_*` files apply in alpha order, which is deterministic but conceals the dependency that `002_learning_review_records` references `agent_sessions` (created in 001). Re-number remaining new tables to `002_learning_review_records.sql` → `003_…` after removing the redundant 002s.
- **[P1][orphan-file] `src/ingest/late-chunker.ts`** — `src/ingest/late-chunker.ts:1-40` — `grep -rn "late-chunker\|LateChunker\|lateChunkDocument\|isLateChunkingEnabled"` returns zero hits outside the file itself; module header self-declares "future seam, not an active code path". Delete or move under a clearly-marked `experiments/`.
- **[P1][orphan-file] `src/ingest/contextual-summarizer.ts`** — `src/ingest/contextual-summarizer.ts:1-40` — zero importers across `src` / `test` / `scripts`; header self-declares dormant. Delete with `late-chunker.ts` as a pair.
- **[P1][dead-branch] CommonJS `require()` in an ES-module `src/model/provider.ts`** — `src/model/provider.ts:57,64` — `const { buildProviderRegistry } = require('./registry.js') as typeof import('./registry.js');` runs in a `"type": "module"` package; this branch can only execute in CJS, which never happens here. Replace with top-level `await import('./registry.js')` or static import.
- **[P2][npm-script] `package.json#scripts.seed:self`** — `package.json:24` → `scripts/seed-tuberosa-src.ts` — script is not referenced in `Dockerfile`, `docker-compose.yml`, `README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/`. Looks like a developer-convenience leftover. Verify with team; remove if unused.
- **[P2][npm-script] `package.json#scripts.backfill:domains`** — `package.json:25` → `scripts/backfill-domains.ts` — no external references; one-off migration that has likely run already. Confirm with project owner before deleting.
- **[P2][npm-script] `package.json#scripts.import:docs`** — `package.json:23` → `scripts/import-docs.ts` — no docs / Docker references; only usage is `package.json` itself. May still be operationally useful — confirm before pruning.
- **[P2][unused-export] `src/model/registry.ts:buildOllamaRegistry`** — `src/model/registry.ts:103` — only referenced via the dead `require()` branch in `src/model/provider.ts:64`. Once that branch is removed, `buildOllamaRegistry` likely becomes orphaned too; audit after fixing the `require()` issue.
- **[P3][phase-artifact] Test filenames retain abandoned phase numbering** — `test/classifier-phase1.test.ts`, `test/feedback-scorer-phase2.test.ts`, `test/context-fit-phase3.test.ts`, `test/document-atomizer-phase4.test.ts`, `test/worktree-phase5.test.ts`, `test/phase6.test.ts`, `test/phase7.test.ts`, `test/context-pack-phase8.test.ts`, `test/knowledge-safety-phase9.test.ts`, `test/phase10.test.ts` — names persist after Phase 10 wrapped. Rename to feature-based names (e.g., `phase6.test.ts` → `namespace.test.ts`) to stop perpetuating the phase taxonomy.
- **[P3][phase-artifact] "Phase N —" comments in production source** — `src/config.ts:38-42`, `src/security/knowledge-safety.ts:46,50,74,86,91,121,284`, `src/storage/knowledge-namespace.ts:4,53,64,85,103`, `src/model/{ollama,provider}.ts`, `src/ingest/document-atomizer.ts:6,25,176`, `src/retrieval/policy.ts:40,50,54,60,67,81,122,125`, `src/model/registry.ts:99` — purely descriptive phase tags; safe to strip in bulk during a doc-comment pass.
- **[P3][stale-todo] No `TODO/FIXME/HACK` markers in `src/`** — `grep -rn "TODO\|FIXME\|HACK" src/` returns empty. No action — noting because it inverts an expected finding.
- **[P3][duplication] Provider-registry composition logic duplicated** — `src/model/registry.ts:79-` (`buildProviderRegistry`) vs `src/model/registry.ts:103-` (`buildOllamaRegistry`) — both construct `new ProviderRegistry(hash)` and register an embed/rerank capability. Fold into a single factory that takes `providerKind`.

#### Removal batches

1. **Batch 1 — Migration cleanup (P0).** Delete `migrations/002_knowledge_relations.sql`, `migrations/002_knowledge_conflicts.sql`, `migrations/002_agent_sessions.sql`. Verify with `pnpm run migrate` against a fresh Postgres, then `pnpm test:integration`.
2. **Batch 2 — Dormant Phase 4 ingest modules (P1).** Delete `src/ingest/late-chunker.ts` and `src/ingest/contextual-summarizer.ts`; drop the `summarizeSection` / `supportsLongContextEmbed` capability hooks in `src/model/provider.ts`. Verify with `pnpm run build && pnpm test && pnpm run eval:retrieval`.
3. **Batch 3 — Dead `require()` branch + registry consolidation (P1/P3).** Replace `require()` calls in `src/model/provider.ts:57,64` with static imports; merge `buildProviderRegistry` and `buildOllamaRegistry` into one factory. Verify with `pnpm test` and `pnpm run eval:retrieval`.
4. **Batch 4 — npm-script hygiene (P2).** Remove `seed:self`, `backfill:domains`, and verify `import:docs` with owner; delete the matching `scripts/*.ts` files. Verify with `pnpm install --frozen-lockfile && pnpm test`.
5. **Batch 5 — Phase-naming cleanup (P3).** Rename `test/*-phase*.test.ts` files and strip "Phase N —" prefixes from doc comments listed above. Verify with `pnpm test` and `pnpm run eval:retrieval`.

#### Top-priority list

1. Delete `migrations/002_knowledge_relations.sql`, `migrations/002_knowledge_conflicts.sql`, `migrations/002_agent_sessions.sql` — three redundant migrations that are no-ops today but will cause real divergence the moment someone edits one of them by mistake.
2. Remove `src/ingest/late-chunker.ts` and `src/ingest/contextual-summarizer.ts` plus their `ModelProvider` capability hooks — explicit dead modules carried as "future seams".
3. Replace `require()` in `src/model/provider.ts:57,64` with `await import(...)` and consolidate `buildProviderRegistry` / `buildOllamaRegistry`.
4. Prune `seed:self` / `backfill:domains` from `package.json` (and their `scripts/*.ts` files) after confirming nobody runs them.
5. Strip "Phase N" naming from test filenames and source comments to stop new agents from re-introducing phase-shaped thinking.

---

## 4. Consolidated remediation plan

Five waves, dependency-ordered. Each ticket lists fix location, verification command, and rough effort sizing (S = ≤½ day, M = 1–2 days, L = >2 days).

### Wave 1 — Stop the bleed (P0 correctness + security) — 2–3 days

| # | Ticket | Fix location | Verify | Effort |
|---|---|---|---|---|
| 1.1 | Patch worktree `::uuid` leak in `pack_feedback` CTE | `src/storage/postgres-store.ts:1248` — guard `(item->>'knowledgeId')::uuid` with `CASE WHEN ~ '^[0-9a-f-]{36}$' …` | `pnpm test:integration`, repro from saved worktree session | S |
| 1.2 | Memory-store must filter `status='approved'` | `src/storage/memory-store.ts:1205` — add status check to `allowed()` | `pnpm test`, add parity test (W2.4) | S |
| 1.3 | Require API key in production / bind 127.0.0.1 by default | `src/config.ts:52`, `src/index.ts:7`, `src/http/server.ts:794-800` | Manual curl from another host should 401; `pnpm test` | S |
| 1.4 | Strip raw pg / redis messages from HTTP & MCP bodies | `src/errors.ts:101-138` — replace `error.message` with code-only body; keep stack in server logs | `pnpm test` + new test for error-shape | S |
| 1.5 | Wrap `JSON.parse` in MCP frame loop and emit `-32700` | `src/mcp-stdio.ts:28` | `pnpm test` + new fuzz frame test | S |
| 1.6 | Delete 3 redundant `002_` migrations | rm `migrations/002_agent_sessions.sql`, `002_knowledge_conflicts.sql`, `002_knowledge_relations.sql` | Fresh-DB `pnpm run migrate && pnpm test:integration` | S |
| 1.7 | Enforce `eval:retrieval hitRate=1` by default | `scripts/eval-retrieval.ts:239` — set default `failUnderHitRate=1` (or align CLAUDE.md) | `pnpm run eval:retrieval` (must still pass) | S |

### Wave 2 — Coverage of trust-boundary code — 3–4 days

| # | Ticket | Add tests for | Effort |
|---|---|---|---|
| 2.1 | `src/validation.ts` (1285 LOC, untested directly) | Table-driven tests per schema: taskType aliases, numeric bounds, optional defaults, nested label / reference validation | M |
| 2.2 | `src/operations/backup-service.ts` (802 LOC, e2e-only) | Checksum mismatch, partial-write recovery, retention pruning, restore-into-non-empty | M |
| 2.3 | `src/maintenance/service.ts` (no test) | Proposal generation, dry-run vs apply, idempotency, refusal paths | S |
| 2.4 | **Storage parity matrix** — same fixtures against `StorageFactory(memory)` and (postgres, Docker-skip) | M |
| 2.5 | `src/reflection/write-gate.ts` (no test) | Each gate input: low-confidence, negative feedback, missing-context, noisy selection, empty embedding | S |
| 2.6 | `src/retrieval/context-fit.ts` branch gaps | Cases where each of `ready / needs_confirmation / insufficient` is the exact output | S |
| 2.7 | **CLAUDE.md invariant fixtures** | (a) spawn `mcp-stdio.ts` and assert every stdout chunk parses as JSON-RPC; (b) parse `migrations/001_init.sql` and assert `vector(N)` equals `EMBEDDING_DIMENSIONS` | S |

### Wave 3 — Security hardening (P1) — 2–3 days

| # | Ticket | Location | Effort |
|---|---|---|---|
| 3.1 | Replace `formatSqlString` interpolation in graph relations with parameterized `unnest()` / whitelist | `src/storage/postgres-store.ts:2647-2657, 978` | S |
| 3.2 | Drop `/g` flag on PII regexes also used with `.test()`; defensive `pattern.lastIndex = 0` | `src/security/knowledge-safety.ts:228-241, 453-492` | S |
| 3.3 | Add ASIA (STS temp-key) pattern; tighten placeholder allowlist | `src/security/knowledge-safety.ts:115-138` | S |
| 3.4 | Set `server.requestTimeout` / `headersTimeout` (slowloris) | `src/index.ts:7` | S |
| 3.5 | Validate `Content-Type: application/json` on POST routes | `src/http/server.ts:748-775` | S |
| 3.6 | Mix API-key fingerprint into cache key when API-key gating lands (W1.3) | `src/retrieval/service.ts:170, 1426` | S |
| 3.7 | Unicode-normalize + base64-decode candidate text before prompt-injection screening | `src/security/knowledge-safety.ts:186-215` | M |

### Wave 4 — Maintainability split (P1 structural) — 5–7 days

| # | Ticket | Plan | Effort |
|---|---|---|---|
| 4.1 | Split `src/storage/postgres-store.ts` (2746) | `postgres/{knowledge,label,search,feedback,session,backup}-store.ts` + thin facade | L |
| 4.2 | Mirror split for `src/storage/memory-store.ts` (1524) so backends stay structurally symmetric | L |
| 4.3 | Extract collaborators from `RetrievalService` (2072) | `query-rewriter.ts`, `candidate-finder.ts`, `ranker.ts`, `suppression.ts`, `feedback-learning.ts` | L |
| 4.4 | Decompose `src/types.ts` (1987) into per-domain modules with a barrel re-export | M |
| 4.5 | Replace 50 `as` casts (postgres-store) and 12 `as unknown as` (memory-store) with validated `mapRow*` helpers | M |
| 4.6 | Move suppression / fit / fusion magic numbers to `config/retrieval-policy.json` | `service.ts:1781,1793,1807,1827`, `context-fit.ts:212,221,539`, `fusion.ts:75,85` | S |
| 4.7 | Promote suppression-reason strings to a literal-union type | `service.ts:1785`, `context-pack.ts:768,800` | S |

### Wave 5 — Dead-code & cosmetic cleanup (P2/P3) — 1 day

| # | Ticket | Action | Effort |
|---|---|---|---|
| 5.1 | Remove dormant ingest modules | `rm src/ingest/late-chunker.ts src/ingest/contextual-summarizer.ts` + drop matching capability hooks on `ModelProvider` | S |
| 5.2 | Replace CJS `require()` with `await import(...)` and consolidate `buildProviderRegistry` + `buildOllamaRegistry` | `src/model/provider.ts:57,64`, `src/model/registry.ts:103` | S |
| 5.3 | Prune unused npm scripts after confirming with team: `seed:self`, `backfill:domains`, possibly `import:docs` | `package.json:23-25` + matching `scripts/*.ts` | S |
| 5.4 | Rename `test/*-phaseN.test.ts` to feature-based names; strip "Phase N —" comments from sources listed in dead-code audit | S |
| 5.5 | Fold worktree `tryAdd` per-reason buckets so `git_changed` / `root_handoff` aren't starved | `src/retrieval/worktree.ts:235,248` | S |
| 5.6 | Use git `-z` (NUL-separated) status parsing | `src/retrieval/worktree.ts:323` | S |

### Dependency edges

- W1.6 → W4.1 (clean migrations before splitting the store).
- W1.3 → W3.6 (cache-key change depends on API-key gating).
- W2.* → W4.* (have tests in place before structural refactor).
- W4.4 (types split) → W4.1 / W4.2 / W4.3 (extract types first so domain splits don't drag the barrel along).

---

## 5. Top-5 ship-first list

1. **W1.6 — delete the 3 dup `002_` migrations.** Today they are no-ops but a single edit by mistake produces silent schema drift.
2. **W1.3 + W1.4 — close the HTTP boundary** (require API key, bind localhost, strip raw pg messages). Highest blast radius if a Tuberosa instance ever runs on a non-loopback interface.
3. **W1.1 + W1.2 — finish the worktree `::uuid` fix and add `status='approved'` to memory-store.** Both are documented P0s that are still partially live.
4. **W2.4 + W2.7 — storage parity matrix + CLAUDE.md invariant fixtures.** Without these the documented invariants are aspirational, not enforced.
5. **W4.4 — split `types.ts` into per-domain modules.** Every `metadata` field change re-typechecks 36K LOC against one barrel; this is the single biggest tax on the next refactor.

---

## 6. What was *not* changed

No code edits. All five sub-agents ran read-only. The next concrete step is whichever wave is approved for execution — Wave 1 is recommended first (cheap, isolated P0 deletions and small patches before any structural refactor).
