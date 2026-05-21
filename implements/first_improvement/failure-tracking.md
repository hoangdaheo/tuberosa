# Failure Tracking — roadmap-claude.md Implementation

Records every attempted approach that failed, was reverted, or required a workaround. Each entry: phase, deliverable, what was tried, why it failed, the fix or workaround.

## Phase 1 — Knowledge-Mapping Sandbox & Baseline

### 1. Threshold for `duplicateSuppressionRate` initially set to 0.5
- **Where:** `eval/sandbox/thresholds.json`
- **Tried:** Setting `minDuplicateSuppressionRate: 0.5` per the original draft thresholds.
- **Why it failed:** Tuberosa currently has no ingestion-time deduplicator. Tier D pairs both pass through and both rank. Baseline duplicate-suppression rate is 0.0%; the threshold was Phase 2 aspirational, not Phase 1 measurable.
- **Fix:** Lowered to `0.0` for Phase 1 baseline; Phase 2 (Noise-Filter Hardening) will introduce the duplicate detector and raise this threshold to ≥0.9.

### 2. Adversarial block rate computed at 300%
- **Where:** `scripts/sandbox.ts` — `adversarialBlocked` counter
- **Tried:** Incrementing `metrics.adversarialBlocked` both when an ingest-time safety block fired AND when an adversarial item appeared in a prompt's `expectedNoiseFilteredSandboxIds` and was not selected.
- **Why it failed:** `adversarialExpected` only counts per-prompt expectations (denominator), but `adversarialBlocked` was being incremented globally per ingest event AND per-prompt. Numerator > denominator → 300%.
- **Fix:** Track `ingestionBlockedSandboxIds: Set<string>` separately; for each per-prompt expected adversarial item, count it as blocked if either it was blocked at ingest OR the retrieval didn't select it.

### 3. First ablation pass produced identical hit rates across sources
- **Where:** `scripts/sandbox.ts` — `runAblation` + `adjustForAblation`
- **Tried:** Running the regular `searchContext` then post-hoc filtering the debug-trace `fusionBreakdown.contributions` to drop the disabled source.
- **Why it failed:** Post-hoc filtering only edits the *report* of what ran. The actual fusion already happened with all 5 sources, and the final ranking was already produced. Hit rate and MRR were invariant.
- **Fix:** Added `ContextSearchInput.disabledSources?: CandidateSource[]` to the public type, threaded it through `RetrievalService.searchContext → rankCandidates`, and zeroed the listed candidate groups *before* `fuseCandidates`. Now ablation produces real per-source MRR deltas (e.g., disabling `memory` improves hit from 86.4% → 100%).

### 4. Adversarial Tier E items couldn't be ingested at all
- **Where:** `scripts/sandbox.ts` — `ingestFixture`
- **Tried:** Passing adversarial knowledge straight into `IngestionService.ingestKnowledge`. First run threw `KnowledgeSafetyError: Prompt-injection instruction tried to override prior instructions.`
- **Why it failed:** The existing `KnowledgeSafetyService` correctly blocks prompt-injection content at ingestion. That's the *desired* defensive behaviour — but it crashed the sandbox runner before any metrics could be collected.
- **Fix:** Wrapped each `ingestion.ingestKnowledge` call in try/catch. Blocked items are recorded as `FilterEvent { filter: 'safety_block_ingest', action: 'excluded', ... }`. They count toward `adversarialBlocked` (numerator) and toward per-filter precision (because they correctly fired on Tier E content). Test `test/sandbox.test.ts:54` asserts the adversarial tier still contains injection language for future regression detection.

## Phase 2 — Noise-Filter Hardening

### 1. Duplicate detector blocked legitimate re-ingestion of the same source file
- **Where:** `src/ingest/duplicate-detector.ts` — `collectCandidates`; failures showed up as `test/retrieval.test.ts:875` ("atomic markdown re-ingestion updates sections and deletes stale atoms") and `test/integration.test.ts:112` (Postgres store retrieval round-trip).
- **Tried:** Loading all approved knowledge for the project into the candidate pool, including items with the same `sourceUri`.
- **Why it failed:** Re-ingesting a file (the normal update path — markdown atomizer re-emits the same sections, integration tests re-seed the same corpus) is supposed to update the stored knowledge, not be rejected as a duplicate. With every approved item in the pool, the 100%-textual-match between the incoming chunk and its own stored copy tripped both Jaccard and cosine thresholds → `Auto-reject: textual and semantic duplicate of …`.
- **Fix:** Filter out items with matching `sourceUri` in `collectCandidates`. Duplicate detection now applies only across distinct source URIs, which is the semantic intent: catch *new* knowledge that duplicates *existing* knowledge.

### 2. SuppressionEvent emission silently dropped after the refactor
- **Where:** `src/retrieval/service.ts` — initial rewrite of `applyIntentSuppression`.
- **Tried:** Building the suppression `events` array inside `intentSuppressionAdjustment` and emitting events from `applyIntentSuppression` only when the aggregate `score < 0`.
- **Why it failed:** `applyIntentSuppression` early-returns when `adjustment.score === 0`. After the rewrite that gate also blocked iteration over `adjustment.events`, so domain-mismatch and superseded events were never delivered to `onSuppression` even though the underlying conditions fired.
- **Fix:** Changed the early-return guard to `adjustment.score === 0 && adjustment.events.length === 0` so per-cause events still emit when the score happens to net to zero. Also moved per-event `deltaScore` and `confidence` into each `Omit<SuppressionEvent, 'knowledgeId'>` so the caller never has to back-compute them from a shared aggregate.

### 3. domain_mismatch suppression test reported zero candidates
- **Where:** `test/suppression-telemetry.test.ts:53` — first iteration of the domain_mismatch test.
- **Tried:** Seeding the memory store with `store.upsertKnowledge(input, [])` (no chunks), then expecting retrieval to surface the candidate so the domain mismatch could fire.
- **Why it failed:** `MemoryKnowledgeStore.searchLexical`/`searchVector`/`searchMemories` rank by chunks. Without chunks, nothing is searchable; the candidate never reached the suppression stage; `pack.debug.suppressionEvents` was an empty array; the assertion fired.
- **Fix:** Switched the seed path to `IngestionService.ingestKnowledge(input)` which chunks the content end-to-end. With chunks present, the lexical + memory candidate surfaces, the suppression path fires, the test passes.

### 4. Per-itemType freshness test mis-picked an "aging" day count
- **Where:** `test/freshness-policy.test.ts:65` — first iteration of the differential-itemType test.
- **Tried:** Using a single 245-day-old `freshnessAt` for both a `code_ref` and a `memory` candidate, expecting code_ref to be current and memory to be stale.
- **Why it failed:** `memory` policy in DEFAULT_POLICY has `currentDays=120, staleDays=300`. 245 days falls into the *aging* band (120 < days ≤ 300), not stale. The missing-signal label was `freshness:aging:memory`, not `freshness:stale:memory`, so the `startsWith('freshness:stale')` assertion failed.
- **Fix:** Use distinct freshness dates per candidate — 250 days for code_ref (current under `currentDays=270`) and 320 days for memory (past `staleDays=300`). This is what the spec intent was: prove the policy treats item types asymmetrically, not that a single day count straddles two windows.

### 5. retrieval.test.ts assertion for `freshness:stale` broke on the per-itemType label
- **Where:** `test/retrieval.test.ts:1472` — `'context fit penalizes stale and rejected candidates'`.
- **Tried:** Kept the assertion `fittedStale?.fitMissingSignals?.includes('freshness:stale')` as written. The Phase 1 commit had already changed the label to `freshness:stale:<itemType>` (commit 726acf7), so the exact-match assertion was broken before Phase 2 even started.
- **Why it failed:** `Array.prototype.includes` is exact; `'freshness:stale'` is no longer present, only `'freshness:stale:bugfix'`.
- **Fix:** Switched the assertion to `fittedStale?.fitMissingSignals?.some((signal) => signal.startsWith('freshness:stale'))` so it accepts both legacy and new label formats. The fix is recorded here because the failure surfaced *during* Phase 2 verification.

## Phase 3 — Categorization & Labeling Upgrade

### 1. itemType inference overrode caller-provided itemTypes
- **Where:** `src/ingest/service.ts` — `refineInput`. Surfaced as failures in `test/retrieval.test.ts:1914` ("reflection drafts are reviewable and approval creates searchable memory") and `test/flow-regression.test.ts:201` ("FLOW_LOGIC smoke").
- **Tried:** Running `inferItemType` on every ingest regardless of the caller's `input.itemType`, then preferring the inferred type with `inferredItemType?.itemType ?? input.itemType`.
- **Why it failed:** Tests and callers explicitly pass concrete itemTypes (`memory`, `workflow`, `code_ref`); overriding them with content-driven inference broke deliberate categorization (e.g., a `triggerType:user_correction` lesson was reclassified as `rule` even though the test corpus relies on its `memory` shape, and a `triggerType:manual` reflection was reclassified as `wiki` because it referenced `docs/FLOW_LOGIC.md`).
- **Fix:** Gate inference to `input.itemType === 'memory'` — i.e., only replace the catch-all. This matches the plan literal ("Replace the current 'default to memory' behaviour"). Non-memory caller types are trusted.

### 2. LabelEnricher leaked file labels onto unrelated items, breaking the continuation eval
- **Where:** `src/ingest/service.ts` — `refineInput` running `HeuristicLabelEnricher`. Surfaced as `test/evaluation.test.ts:48` failure on `continuation-handoff` (docker-migration-memory appeared in the result set).
- **Tried:** Letting the heuristic enricher append every classifier-derived label (file/symbol/error/business_area/technology) to ingested items.
- **Why it failed:** Content like *"This memory is not the current continuation handoff"* triggers `isContinuationIntent` inside the classifier, which inserts `handoff.md` and `docs/AGENT_CONTEXT_ROADMAP.md` into the *files* list. The enricher then attached `file:handoff.md` labels to unrelated items, polluting the metadata search and making docker-migration-memory rank when the continuation prompt fired.
- **Fix:** Restrict enricher-derived additions to *axis* label types (`technology`, `business_area`, `domain`, `task_type`, `project`). `file`, `symbol`, `error` labels remain caller-curated only. Plan deviation recorded: enricher is conservative; file/symbol/error are not auto-extracted by the enricher pass.

### 3. Trigger-based rule/workflow heuristics fired too eagerly
- **Where:** `src/ingest/item-type-inference.ts` first draft.
- **Tried:** Mapping `triggerType:user_correction` → `rule` and `triggerType:non_trivial_workflow` → `workflow`.
- **Why it failed:** Reflection drafts set `triggerType:user_correction` for many "this is how you handle X" lessons that callers want stored as `memory`, not `rule`. The heuristic over-classified, breaking `test/retrieval.test.ts` test 138.
- **Fix:** Removed `RULE_TRIGGER_TYPES` and `WORKFLOW_TRIGGER_TYPES`. Only `BUGFIX_TRIGGER_TYPES` (error_recovery) remains — that one is explicit in the plan. Headings + normative-language detection still apply.

### 4. Spec heading test failed because `specs/` directory was misclassified as a test path
- **Where:** `src/ingest/item-type-inference.ts` — `TEST_FILE_REGEX`.
- **Tried:** `(?:^|\/)(?:tests?|__tests__|spec|specs)\/`.
- **Why it failed:** `spec`/`specs` also names *specification* directories (e.g., `specs/retrieval.md`). The test regex incorrectly matched those, sending spec files into the workflow branch (`testRefs → workflow`).
- **Fix:** Narrowed to `(?:^|\/)(?:tests?|__tests__)\/`. Spec directories are handled by `SPEC_FILE_REGEX` only.

### 5. Spec-file regex required a leading slash
- **Where:** `src/ingest/item-type-inference.ts` — `SPEC_FILE_REGEX`.
- **Tried:** `\/(?:specs?|requirements?|design|rfcs?)\/`.
- **Why it failed:** Common references like `specs/retrieval.md` (no leading slash) didn't match, so spec detection silently dropped.
- **Fix:** Anchored to `(?:^|\/)…\/` so both leading-slash and bare-relative paths match.

### 6. Ontology ancestor ordering reversed by `walkOntology` traversal
- **Where:** `src/relations/ontology.ts` — `expandOntologyValue`.
- **Tried:** Returning the parent chain in `walkOntology` accumulation order (`['db', 'postgres']` for leaf `pgvector`).
- **Why it failed:** The expansion code attenuated weights by index — index 0 was meant to be the *closest* ancestor (postgres), but the accumulator produced root-first ordering (db). The test `expandLabelsThroughOntology adds ancestor labels with reduced weight…` failed because `db.weight` came out larger than `postgres.weight`.
- **Fix:** Reverse the ancestor chain before returning, so index 0 is the immediate parent. Attenuation now matches intent: closer ancestor gets higher weight.

### 7. AST extractor failed type-check on `ts.canHaveModifiers(VariableStatement)`
- **Where:** `src/relations/ast-extractor.ts`.
- **Tried:** Calling `hasExportModifier(node)` directly on `VariableStatement` nodes.
- **Why it failed:** TypeScript's `Declaration` type doesn't include `VariableStatement` (only its declarations are), so the function signature mismatched.
- **Fix:** Added a generic `hasModifier(node: ts.Node, kind)` helper that guards on `ts.canHaveModifiers` and reuses for both declaration nodes and variable statements.

### Plan deviation — sandbox itemType catch-all rate stayed at 39.4%, not <25%
- The plan target was "<25% catch-all rate" for the sandbox. With the inference + ontology + AST extractor wired, the rate moved from 38.6% → 39.4%.
- **Why:** The sandbox corpus generator deliberately emits 1/6 of Tier A gold items + most of Tier B/C/D adjacent/stale/duplicate items as `memory` to exercise the noise filters. Those memory items have generic content with no rule/workflow/spec/code signals, so `inferItemType` correctly falls back to `memory`. The metric measures *what fraction of selected items are memory* — capped by the corpus shape, not by inference accuracy.
- **Fix:** Recorded the discrepancy in `roadmap-claude.md` Phase 3 deviations. Phase 4 (calibrated fusion) is a more direct lever for reducing memory-item dominance in selections. The new `itemTypeDiagonalRate` metric (68.3%) is a corpus-independent measure of categorization accuracy; the threshold floor in `eval/sandbox/thresholds.json` now uses that.

## Phase 4 — Matching Engine

### 1. `@xenova/transformers` as a hard dependency would have made install brittle
- **Where:** `src/model/local-provider.ts` initial draft.
- **Tried:** Adding `@xenova/transformers` to `dependencies` so the local cross-encoder could import it statically.
- **Why it failed:** The package is ~150MB on first model fetch and pulls in `onnxruntime-node`, which has platform-specific binaries (`linux-arm64`, `darwin-x64`, etc.). On a fresh CI runner without network access (or behind a corporate proxy) `pnpm install` would fail outright, breaking every Tuberosa contributor who doesn't actually want local reranking. Even with the package installed, the test suite must remain offline-deterministic — pulling weights at runtime is incompatible with `pnpm test`.
- **Fix:** LocalCrossEncoderProvider uses a `Function('s', 'return import(s)')` dynamic-import indirection so missing packages or model caches fall back to the existing hash reranker. Users who want real local reranking install `@xenova/transformers` themselves. Tests inject a `LocalCrossEncoderScorer` to verify the rank-blending logic without touching the package. Documented in `roadmap-claude.md` Phase 4 plan deviation §1.

### 2. CommonJS `require` chosen over dynamic `import()` for the registry hookup
- **Where:** `src/model/provider.ts` — `createModelProvider`.
- **Tried:** Importing `buildProviderRegistry` statically at the top of `provider.ts`.
- **Why it failed:** A static import meant the registry module (and its transitive imports of `local-provider.ts`) loaded on every Tuberosa startup, including OpenAI and hash paths where the registry isn't needed. That re-introduced the heavy dependency the lazy loader was designed to dodge.
- **Fix:** Inside the `config.modelProvider === 'local'` branch, deferred `require('./registry.js')`. Comes with an ESLint suppression; the import is only resolved when `TUBEROSA_MODEL_PROVIDER=local`.

### 3. `graphMaxHops=2` did not produce a measurable MRR gain on the current sandbox corpus
- **Where:** `src/storage/memory-store.ts` — `searchGraphRelations` depth-2 frontier.
- **Tried:** Enabling `graphMaxHops=2` by default to expand graph candidates two hops out.
- **Why it failed:** The synthetic sandbox graph has shallow relations (Tier A items have direct references to Tier B/C items; depth-2 doesn't reach more gold answers). Enabling depth-2 added 6-9ms p50 latency without moving hit/MRR. The plan called for "gated by sandbox cost/benefit" — the cost showed, the benefit did not.
- **Fix:** Keep `graphMaxHops=1` as the default; leave the depth-2 code path in place so projects with denser graphs can flip the flag. Documented in `roadmap-claude.md` Phase 4 plan deviation §2.

### 4. Per-task source-weight deltas had to stay small to keep eval:retrieval green
- **Where:** `src/retrieval/policy.ts` — `DEFAULT_POLICY.taskProfiles`.
- **Tried:** Larger deltas (±0.1 to ±0.2) on `taskProfiles.<taskType>.sourceWeights` to drive a visible MRR gain.
- **Why it failed:** Even a 0.1 delta flipped 2 of the 14 eval:retrieval fixture cases (`symbol-paywall-modal` and `selected-feedback-paywall`) — task profiles tuned for the sandbox were not safe on the existing fixtures.
- **Fix:** Capped initial per-task deltas to ±0.06. The calibration script (`scripts/calibrate-fusion.ts`) produces larger values bounded into `[0.7, 1.4]`, but those are only applied when the user explicitly runs calibration and writes them to `config/retrieval-policy.json` — never as code defaults.

### 5. Sandbox `minMRR` threshold could not be raised
- **Where:** `eval/sandbox/thresholds.json`.
- **Tried:** Raising `minMRR` from 0.45 → 0.5 to lock in the per-task profile gain.
- **Why it failed:** Phase 4 measured MRR is 0.4882, only +0.0004 over Phase 3. Tightening to 0.5 would make the sandbox fail. The plan's +0.05 MRR target was not achievable on this corpus shape — the Phase 3 baseline was already near-ceiling for the synthetic fixtures.
- **Fix:** Left `minMRR=0.45` as the floor. Tightened `minItemTypeDiagonalRate` from 0.6 → 0.65 instead, since that metric moved 68.3% → 68.7% — the more durable signal that per-task profiles actually re-weighted ranking.

## Phase 5 — One-Command Install

### 1. ES-module entrypoint detection initially used `require.main === module`
- **Where:** `bin/tuberosa.ts` — `isMainModule()`.
- **Tried:** `if (require.main === module) { runCli(...) }` — the standard CommonJS idiom.
- **Why it failed:** The repo is `"type": "module"`; `require` is not defined and the file would never run as an entrypoint. Also, when the test imports `dispatch` from the module, the CLI side-effect would still fire under any heuristic that compares filesystem paths.
- **Fix:** `isMainModule()` compares `import.meta.url` against `new URL(\`file://${process.argv[1]}\`).href`, plus a `.endsWith('/bin/tuberosa.{ts,js}')` fallback. This survives `tsx bin/tuberosa.ts`, `node dist/bin/tuberosa.js`, and `import { dispatch } from '../bin/tuberosa.js'` without invoking the CLI in tests.

### 2. Doctor's MCP stdout check flagged the JSON-RPC framing writer as a problem
- **Where:** `bin/commands/doctor.ts` — `checkMcpStdio`. Surfaced when smoke-testing `node dist/bin/tuberosa.js doctor` against this checkout.
- **Tried:** Regex `/console\.log\(|process\.stdout\.write\(/` to enforce CLAUDE.md's rule that the MCP entrypoint must not write to stdout.
- **Why it failed:** The MCP protocol's transport *requires* `process.stdout.write` to emit JSON-RPC frames (`src/mcp-stdio.ts:101-105`). The check fired against legitimate framing code and reported a fail every single time, even on a clean repo.
- **Fix:** Narrowed the regex to `/console\.log\(/`. That call is never the right one inside the MCP path because it concatenates a newline and interleaves text into the protocol stream. `process.stdout.write` with explicit framing is allowed. Plan deviation recorded in `roadmap-claude.md` Phase 5 deviation §3.

### 3. `npx tuberosa init` initially tried to also bring up the `app` container
- **Where:** `bin/commands/compose-template.ts` — earlier draft mirrored `docker-compose.yml` 1:1.
- **Tried:** Including the `app` and `worker` services so `init` produced a fully running HTTP server.
- **Why it failed:** The `app` container builds the user's checkout image, which takes 60-90s on a cold Docker host and breaks if the user is still editing. The plan's success criterion was "<90s on a clean Docker host," and the build alone consumed that budget. Worse, the `app` would race the user's own `pnpm run dev`, holding port 3027.
- **Fix:** Trimmed the template to `postgres` + `redis` only. `init` brings up the data stores; the user runs `pnpm run dev` (or `npx tuberosa mcp`) in their own terminal. Plan deviation recorded in `roadmap-claude.md` Phase 5 deviation §1.

### 4. `curl /health` and `pnpm run seed:self` were removed from the success path
- **Where:** `bin/commands/init.ts` — `printSuccess`.
- **Tried:** Verifying init by hitting `http://127.0.0.1:3027/health` and offering to run `pnpm run seed:self`.
- **Why it failed:** With the `app` container removed (failure §3), nothing listens on 3027 yet — the curl would always return connection-refused. `seed:self` ingests the Tuberosa source itself, which is exactly wrong for any project that uses Tuberosa as a dependency.
- **Fix:** Replaced the post-install verification with a printed MCP snippet and a pointer to `pnpm run dev`. Users who want self-seeding still have `pnpm run seed:self` available.

### 5. `tuberosa mcp` initially spawned `pnpm run mcp`
- **Where:** `bin/commands/mcp.ts` — first draft.
- **Tried:** Wrapping `pnpm run mcp` so the existing npm script handled all the env wiring.
- **Why it failed:** `pnpm run` prints a one-line banner (`> tuberosa@0.1.0 mcp …`) to stdout before invoking the child. That banner corrupts the very first MCP JSON-RPC frame the client reads. Same root cause as failure §2.
- **Fix:** `mcp` resolves the entrypoint directly (`dist/src/mcp-stdio.js` preferred, else `src/mcp-stdio.ts` via tsx) and spawns `node` with stdio inheritance. No pnpm banner, no shell wrapper.
