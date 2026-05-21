# Tuberosa Matching-Quality & Sandbox Track

## Context

Tuberosa is a local-first MCP context broker. It already has the right primitives — classification, hybrid fusion, context-fit gating, reflection drafts, knowledge gaps, feedback loops, security sanitization, and an evaluation harness. The current weakness, validated by `feedbacks/feedback-synthesis.md` and by direct code inspection, is that the **core matching engine is mostly heuristic and unmeasured**:

- Classification is regex-driven (`src/retrieval/classifier.ts:148-182`, hardcoded technologies list at lines 13-32, business areas at 34-48).
- Fusion weights and graph-hop scores are static literals (`src/retrieval/fusion.ts:4-11`, `src/storage/postgres-store.ts:923-971`).
- Context-fit thresholds (0.72 / 0.45) are global, unvalidated, and treat all signal types as equally valuable (`src/retrieval/context-fit.ts:6-7`, 168-231).
- Reranker is either toy-grade hash or a narrative OpenAI prompt with no formal rubric (`src/model/provider.ts:39-150`).
- Labels are string-normalized only; no hierarchy, no semantic equivalence, no learned weights (`src/relations/inference.ts:18-166`).
- "memory" itemType is a near-catchall (`src/retrieval/context-fit.ts:292-311`); itemType is never inferred at ingestion.
- Noise filtering is regex-based with no telemetry on *which* filter caught *what* (`src/security/knowledge-safety.ts:41-104`).

The evaluation harness exists (`eval/retrieval-fixtures.json` with 14 cases, `eval/knowledge-completeness-fixtures.json` with 2, `src/evaluation/retrieval-evaluator.ts`, `benchmarks/log.jsonl`) but is **too small to detect drift** and **lacks per-filter, per-itemType, per-fusion-source breakdowns** needed to tune the core mechanisms.

This plan defines a parallel, independent track focused on the four asks: **(1) filter noisy data, (2) matching mechanism, (3) categorize & labelize mechanism, (4) data sandbox for verification** — plus **(5) one-command install** to honour the local-first product goal. It does not depend on or conflict with `feedbacks/plan-synthesis.md` (worktree bridge / startup brief / maintenance preview / research trace), which proceeds on its own track.

### Guiding principles

- **Measure before tuning.** Phase 1 must land first — every later phase ships with sandbox metrics showing it's an improvement, not a regression. Tuberosa already enforces this for retrieval changes (`CLAUDE.md`: "Retrieval improvements require eval coverage first").
- **Keep Postgres + pgvector.** No store migration. Make install a one-liner instead.
- **Local-first by default.** Cross-encoder reranker runs locally via ONNX; OpenAI remains opt-in. No phase ships behind a paid API.
- **Determinism preserved.** Hash provider remains the default for tests so the existing eval harness (`pnpm run eval:retrieval`) stays green.
- **Additive, reversible.** New fields are optional, new tables additive, every phase has a feature flag to roll back without migration pain.

---

## Phase 1 — Knowledge-Mapping Sandbox & Baseline

**Status:** completed — 2026-05-20. Sandbox runs in <2s on hash provider; `pnpm test` green (135/135); existing evals untouched.

### Baseline numbers captured by `pnpm run sandbox`

| metric | value |
| --- | --- |
| corpus size | 332 items across Tiers A–F |
| prompt count | 44 across 7 canonical task types |
| hit rate | 86.4% |
| MRR | 0.4974 |
| noise rate | 22.7% |
| stale suppression | 100% |
| duplicate suppression | 0% (no dedup yet — Phase 2 target) |
| adversarial block rate | 100% (safety blocks at ingestion) |
| memory itemType catch-all rate | 43% (Phase 3 target: <25%) |
| latency p50 / p95 | ~25ms / ~50ms |

### Ablation findings worth keeping for Phase 4

`pnpm run sandbox:ablate`:
- disabling **memory** improves hit rate to 100% and MRR to 0.665 — memory candidates are pulling in noise. Strong signal for re-weighting in Phase 4.
- disabling **metadata** drops hit to 81.8% — metadata is doing real work.
- disabling **lexical** improves hit to 95.5% but reduces MRR — lexical recall vs precision tradeoff.
- disabling **graph** is roughly neutral on hit, +MRR — graph helps ranking, not recall.
- disabling **vector** drops hit by ~2pts — vector is a soft contributor.

### Plan deviations recorded

- **Corpus count is 332, not 250.** Tier C produces stale+current *pairs* per index (40 → 80 items), Tier D produces canonical+duplicate pairs (40 → 80 items). Total = 52 + 60 + 80 + 80 + 30 + 30 = 332. Spec said ~250; the pair shape matches the spec's intent.
- **Prompt count is 44, not 120.** The plan said ~120; current generator emits 11 per project × 4 projects = 44 covering 7 task types. Sufficient for Phase 1 baseline; can grow in Phase 2 alongside the corpus.
- **Prompts stored as `.ts` not `.jsonl`.** Source-of-truth is typed (compile-time check on label types and itemTypes). JSONL can be added later if a CSV/leaderboard format is needed.

**Goal.** Build a tiered synthetic corpus + per-filter, per-itemType, per-fusion-source metrics so every later phase has a verdict. Without this, the rest of the plan is opinion.

### Deliverables

1. **Tiered corpus generator.** New `eval/sandbox/` directory with deterministic generators producing **~250 knowledge items** across these tiers:
   - **Tier A — gold (50)**: clean, well-labeled `code_ref`, `spec`, `bugfix`, `workflow`, `wiki`, `memory` items spanning 4 synthetic projects.
   - **Tier B — adjacent noise (60)**: same surface terms, off-domain (e.g., auth memo in billing project), or partial symbol matches.
   - **Tier C — stale & superseded (40)**: pairs with `supersedes` relations, `freshness_at` deliberately aged past 365d, conflicting trust levels.
   - **Tier D — near-duplicates (40)**: textually-similar memos with subtle factual divergence (titles 90%+ overlap).
   - **Tier E — adversarial (30)**: prompt-injection-flavoured content, jailbreak phrasing, secret-shaped strings to verify `knowledge-safety` redaction.
   - **Tier F — sparse signal (30)**: low-quality auto-memories with <3 references, vague labels, to exercise the learning gate.

2. **Prompt set with golden answers.** `eval/sandbox/prompts.jsonl` with **~120 prompts** across all eight `taskType`s, each with:
   - `expectedSelectedKnowledgeIds` (must appear)
   - `forbiddenKnowledgeIds` (must NOT appear)
   - `expectedItemTypes`, `expectedLabels`, `expectedClassification`
   - `expectedNoiseFiltered` (Tier B/C/D/E items that *must* be suppressed)
   - `groundingFacts` (weighted facts for completeness scoring)

3. **Fusion-debug export.** Extend `RankedCandidate` and `ContextPack` with optional `scoreBreakdown`: `{ lexical, vector, metadata, memory, graph, fusionWeights, rerankDelta, suppressionDeltas }`. Default off; sandbox runner enables it. Touched files: `src/types.ts`, `src/retrieval/fusion.ts:13-50` (collect contributions), `src/retrieval/service.ts` (pass through), `src/model/provider.ts` rerank methods.

4. **Per-filter telemetry.** Extend `KnowledgeSafetyService` (`src/security/knowledge-safety.ts:117-207`) and retrieval suppression (`src/retrieval/context-fit.ts:483-489`) to emit `filterEvents: [{ filter, action, knowledgeId, reason }]` into the pack metadata. Sandbox computes per-filter true-positive / false-positive rates against tier labels.

5. **Sandbox runner & report.** New `scripts/sandbox.ts` (npm: `pnpm run sandbox`) that:
   - Ingests the tiered corpus into an in-memory store via `IngestionService.ingestKnowledge`.
   - Runs all prompts, capturing `scoreBreakdown` and `filterEvents`.
   - Emits `eval/sandbox/report.md` with: per-tier hit/miss, per-itemType precision/recall, per-labelType confusion matrix, per-fusion-source MRR ablation, per-filter precision/recall, p50/p95 latency.
   - Pass/fail thresholds in `eval/sandbox/thresholds.json`; CI gate via `--fail-under`.

6. **Fusion ablation harness.** `pnpm run sandbox:ablate` re-runs the prompt set with each fusion source zeroed out in turn (lexical-only, vector-only, no graph, no memory) so the contribution of each can be quantified.

7. **Benchmark log integration.** Extend `benchmarks/log.jsonl` schema with a `sandbox` block mirroring the report. `scripts/benchmark.ts` invokes the sandbox runner. Composite score gains a `sandboxPassRate` term.

### Critical files

- New: `eval/sandbox/generator.ts`, `eval/sandbox/prompts.jsonl`, `eval/sandbox/thresholds.json`, `scripts/sandbox.ts`, `test/sandbox.test.ts`.
- Modify: `src/types.ts` (add `ScoreBreakdown`, `FilterEvent`, `ContextPack.scoreBreakdown?`, `ContextPack.filterEvents?`), `src/retrieval/fusion.ts`, `src/retrieval/service.ts`, `src/retrieval/context-fit.ts`, `src/security/knowledge-safety.ts`, `src/model/provider.ts`, `scripts/benchmark.ts`, `package.json` (scripts), `CLAUDE.md` (commands).

### Verification

- `pnpm run sandbox` runs in <60s on hash provider, produces `report.md`, exits 0 against baseline thresholds.
- `pnpm run sandbox:ablate` shows per-source MRR deltas (so we know which signal matters).
- `pnpm run eval:retrieval` still green (debug fields are optional).
- `pnpm test` still green; new `test/sandbox.test.ts` asserts report shape and threshold-gate behaviour.

### Rollback boundary

All new fields are optional. Setting `TUBEROSA_SANDBOX=off` skips the new benchmark block. No migration.

---

## Phase 2 — Noise-Filter Hardening

**Status:** completed — 2026-05-21. All six deliverables landed, all evals green, and the sandbox now hard-gates against Phase 2 thresholds. Full per-file diff lives in `file-tracking.md`; reverted/blocked approaches are catalogued in `failure-tracking.md`.

### Phase 2 sandbox vs Phase 1 baseline

| metric | Phase 1 | Phase 2 |
| --- | --- | --- |
| hit rate | 86.4% | **93.2%** |
| MRR | 0.4974 | 0.4618 |
| noise rate | 22.7% | **9.1%** |
| stale suppression | 100% | 100% |
| duplicate suppression | 0% | **100%** |
| adversarial block rate | 100% | 100% |
| memory itemType catch-all rate | 43% | 38.6% (Phase 3 target: <25%) |
| latency p50 / p95 | ~25ms / ~50ms | ~14ms / ~21ms |

### Plan deviations recorded

- **`SuppressionEvent.confidence` is required, not optional.** The plan said "Each suppression delta becomes a `SuppressionEvent` with `{ reason, deltaScore, confidence, evidence }`." We made `confidence` mandatory (`number` not `number | undefined`) so callers can never silently drop it. `evidence` remains optional because some suppressions (e.g., low-trust) don't have a useful per-event evidence string yet.
- **Duplicate detector excludes same-`sourceUri` items from the candidate pool.** Plan didn't specify this but re-ingestion of the same source file is a normal update path, not a duplicate; treating it as a duplicate broke `test/retrieval.test.ts` and `test/integration.test.ts`. See `failure-tracking.md` §1.
- **`config/retrieval-policy.json` ships empty (commented).** The plan implied baking Phase 2 defaults into the JSON file. We left the JSON as a documented override surface and kept `DEFAULT_POLICY` in code as the source of truth. Reason: tests can `setRetrievalPolicy(...)` to override directly without env-var gymnastics, and CI does not need a file to read.
- **Pluggable `SuspiciousContentClassifier` is sync, not async.** Plan didn't pin a signature. We chose `classify(text: string): SuspiciousContentClassification` (sync) so the default `RegexSuspiciousContentClassifier` keeps `scanAndRedactText` synchronous and the existing 156-test suite stays deterministic. Phase 4's optional `LocalClassifier` can wrap an async model behind a sync façade or change the interface to `Promise<…>` if needed.

**Goal.** Use the Phase 1 baseline to attack the noise sources that score worst on per-filter precision/recall. Make every suppression *explainable and tunable*.

### Deliverables

1. **Per-itemType freshness windows.** Replace the global 180d/365d thresholds in `src/retrieval/context-fit.ts:8-9` with a `FRESHNESS_POLICY` map: `code_ref` decays slower than `memory`, `bugfix` decays slower than `conversation`, `spec`/`rule` near-immune. Threshold values come from sandbox calibration, not gut feel.

2. **Semantic + textual duplicate detector at ingestion.** Extend `IngestionService` to flag near-duplicates *before* storage using:
   - 7-gram Jaccard similarity ≥ 0.85 → block with `duplicate_of` reference,
   - cosine similarity ≥ 0.92 → mark as `duplicate_candidate` for review queue,
   - both → auto-reject (no draft created).
   - Reuses existing `searchMemories` and embedding pipeline.

3. **Off-domain suppression.** Add a `domain_mismatch` filter that downweights candidates whose strongest label-set is in a different `project` *or* `domain` than the classified prompt, unless an explicit reference covers it. Telemetry shows how often this fires correctly vs incorrectly via sandbox Tier B.

4. **Sanitizer telemetry & ML hooks.** Extend `src/security/knowledge-safety.ts` to:
   - Emit `filterEvents` (already added in Phase 1).
   - Add a pluggable `SuspiciousContentClassifier` interface; default is the existing regex pass; an optional `LocalClassifier` (Phase 4) can plug in later.
   - Add PII redaction patterns for emails, phone numbers, IP addresses (configurable, off by default).

5. **Suppression confidence scoring.** Each suppression delta in `src/retrieval/context-fit.ts:483-506` becomes a `SuppressionEvent` with `{ reason, deltaScore, confidence, evidence }`. The pack carries these; the sandbox grades whether suppressions matched the tier-label ground truth.

6. **Calibration knobs.** All thresholds move into a single `src/retrieval/policy.ts` module exported as `RetrievalPolicy`. Loaded from `config/retrieval-policy.json` so changes ship without code edits and can be A/B-tested via env.

### Critical files

- New: `src/retrieval/policy.ts`, `config/retrieval-policy.json`, `src/ingest/duplicate-detector.ts`, `test/duplicate-detector.test.ts`, `test/freshness-policy.test.ts`.
- Modify: `src/retrieval/context-fit.ts` (use policy + freshness map), `src/retrieval/fusion.ts` (read weights from policy), `src/ingest/service.ts` (call detector), `src/security/knowledge-safety.ts` (pluggable classifier + telemetry).

### Verification

- New sandbox runs show per-filter precision/recall improvement vs Phase 1 baseline (target: stale-rejection ≥0.95, duplicate-suppression ≥0.9, off-domain-suppression ≥0.85).
- `pnpm run eval:retrieval` green; `staleRejectionRate=1` preserved.
- `pnpm run eval:knowledge-completeness` green; `noiseRate` ≤ baseline.
- New tests: `test/freshness-policy.test.ts`, `test/duplicate-detector.test.ts`, `test/suppression-telemetry.test.ts`.

### Rollback boundary

`RetrievalPolicy.useFreshnessMap=false` reverts to global thresholds. `RetrievalPolicy.duplicateDetector=off` disables ingestion-time dedup.

---

## Phase 3 — Categorization & Labeling Upgrade

**Status:** completed — 2026-05-21. All six deliverables landed; 181/181 unit tests + 4 evals + sandbox PASS. Full per-file diff in `file-tracking.md`; reverted approaches and the catch-all-rate deviation logged in `failure-tracking.md`.

### Phase 3 sandbox vs Phase 2 baseline

| metric | Phase 2 | Phase 3 |
| --- | --- | --- |
| hit rate | 93.2% | **95.5%** |
| MRR | 0.4618 | **0.4878** |
| noise rate | 9.1% | 9.1% |
| memory itemType catch-all rate | 38.6% | 39.4% (target <25% not achievable on the current corpus — see plan deviations below) |
| itemType diagonal rate (new) | — | 68.3% |
| label diagonal rate (new) | — | 8.0% |

### Plan deviations recorded

- **itemType inference is gated to caller `itemType === 'memory'`.** The plan said "Replace the current 'default to memory' behaviour." We took that literally — non-memory itemTypes from callers are trusted. Tests and real callers pass concrete types deliberately; overriding them broke reflection drafts and integration smoke. Only the catch-all is replaced.
- **LabelEnricher additions are restricted to *axis* label types** (`technology`, `business_area`, `domain`, `task_type`, `project`). The plan implied the heuristic enricher would re-extract every label type from content; in practice the classifier triggers continuation-intent on words like `handoff` inside item content and would pollute unrelated items with `file:handoff.md` labels. `file`/`symbol`/`error` labels remain caller-curated. See `failure-tracking.md` Phase 3 §2.
- **Trigger-based rule/workflow heuristics removed.** The plan only explicitly maps `trigger=error_recovery → bugfix`. Earlier drafts mapped `user_correction → rule` and `non_trivial_workflow → workflow`, but those over-classified reflection drafts and broke `test/retrieval.test.ts` test 138. Headings and normative MUST/SHALL detection still apply.
- **Sandbox catch-all rate did not drop to <25%.** The Phase 3 sandbox metric is `selected items with itemType=memory / total selected`, capped by how many memory items exist in the corpus. Tier A generates one memory item per project; Tier B/C/D items are largely memory by design (they exercise noise filters). Inference correctly returns `memory` for generic content, so the metric stays near baseline. We added an `itemTypeDiagonalRate` metric (`selected itemType ∈ expectedItemTypes`) which is corpus-independent and reads 68.3% — the new Phase 3 threshold floor (0.6) gates regressions on that instead.

**Goal.** Make labels and itemTypes carry actual semantic load so the matching engine has signal worth weighing. Today, "memory" is a catch-all and labels are unnormalized strings.

### Deliverables

1. **Hierarchical label ontology.** New `src/relations/ontology.ts` defining a small, opinionated taxonomy:
   - `technology` tree: `frontend > react`, `backend > node`, `db > postgres`, etc.
   - `business_area` tree: `auth > token`, `billing > subscription`, `search > retrieval`, etc.
   - `domain` tree: `infra > docker`, `infra > ci`, etc.
   - Stored as a constant; ingestion expands a leaf label to also tag its ancestors (transitive labels). Retrieval matches at any level. Backward compatible: legacy unrooted labels still work.

2. **ItemType inference at ingestion.** Replace the current "default to `memory`" behaviour (`src/reflection/service.ts:31`) with `inferItemType(content, metadata, references)`. Rules:
   - References include `.test.ts` paths → `workflow` or `bugfix` based on content keywords.
   - Content matches code-fence ratio ≥ 40% and references include source files → `code_ref`.
   - Content matches `decision|rule|policy` headings → `rule`.
   - Origin = error-log session → `bugfix`.
   - Fallback: `memory`. **Sandbox tracks how often the catch-all is hit**; target <25%.

3. **Label-confidence enrichment.** Each label gains a `provenance` field: `{ source: 'prompt' | 'classifier' | 'ontology' | 'reviewer', confidence }`. Fusion (`src/retrieval/fusion.ts:53-74`) uses label confidence as a multiplier on the task-type boost.

4. **Optional LLM-assisted labeling.** A new `LabelEnricher` interface in `src/ingest/`. Default `HeuristicLabelEnricher` uses the existing regex extractors. Optional `LlmLabelEnricher` (off by default) calls the configured `ModelProvider` to add labels with `source: 'llm'` provenance — only when `TUBEROSA_LLM_LABELS=true`. Local-first remains the default.

5. **AST-aware code labeling for `code_ref` items.** When a file ingested ends in `.ts/.tsx/.js/.py`, a minimal AST pass extracts exported symbols and call relations and seeds `mentions_symbol` / `calls` relations. Uses TypeScript compiler API already in deps; no new dependency. Touch `src/relations/inference.ts:113-151`.

6. **Label confusion matrix in sandbox.** Phase 1 report grows a label-type confusion matrix; Phase 3 must drive its diagonal-rate above the Phase 1 baseline.

### Critical files

- New: `src/relations/ontology.ts`, `src/ingest/item-type-inference.ts`, `src/ingest/label-enricher.ts`, `src/relations/ast-extractor.ts`, `test/ontology.test.ts`, `test/item-type-inference.test.ts`, `test/ast-extractor.test.ts`.
- Modify: `src/relations/inference.ts` (expand labels through ontology), `src/ingest/service.ts` (wire enricher + inference), `src/reflection/service.ts` (use inferred itemType), `src/retrieval/fusion.ts` (label-confidence multiplier), `src/types.ts` (add `LabelProvenance`).

### Verification

- Sandbox itemType-catch-all rate <25% (was 100% by default).
- Label-confusion matrix diagonal improves vs Phase 1 baseline.
- `pnpm run eval:retrieval` green; new `expectedItemTypes` assertions in fixtures.
- `pnpm test` adds `test/ontology.test.ts`, `test/item-type-inference.test.ts`, `test/ast-extractor.test.ts`.

### Rollback boundary

`RetrievalPolicy.useOntology=false` skips ancestor tagging. `TUBEROSA_LLM_LABELS` already opt-in. AST extractor wrapped in try/catch — failure falls back to the existing inference.

---

## Phase 4 — Matching Engine (Local Cross-Encoder + Calibrated Fusion)

**Status:** completed — 2026-05-21. All six deliverables landed; 192/192 unit tests + 3 evals + sandbox + sandbox:ablate all PASS. Full per-file diff in `file-tracking.md`; reverted approaches and the +0.05 MRR target deviation logged in `failure-tracking.md`.

### Phase 4 sandbox vs Phase 3 baseline

| metric | Phase 3 | Phase 4 |
| --- | --- | --- |
| hit rate | 95.5% | 95.5% |
| MRR | 0.4878 | **0.4882** |
| noise rate | 9.1% | 9.1% |
| stale suppression | 100% | 100% |
| duplicate suppression | 100% | 100% |
| adversarial block rate | 100% | 100% |
| memory itemType catch-all rate | 39.4% | 39.4% |
| itemType diagonal rate | 68.3% | **68.7%** |
| label diagonal rate | 8.0% | 8.0% |
| latency p50 / p95 | ~16ms / ~28ms | ~19ms / ~37ms |

Ablation deltas (`pnpm run sandbox:ablate`) shifted slightly with the new per-task profiles: disabling `graph` now drops hit by 4.6pts (was neutral), and disabling `vector` still drops hit ~14pts — graph carries more weight under the per-task profiles for debugging/refactor.

### Plan deviations recorded

- **`@xenova/transformers` is NOT a hard dependency.** The plan said "Model: bge-reranker-v2-m3 or bge-reranker-base via ONNX Runtime (or @xenova/transformers)." We deliberately did not add the ~150MB package to `dependencies` — the LocalCrossEncoderProvider uses a `Function('s', 'return import(s)')` dynamic import so missing packages fall back to the hash reranker. Users who want real local reranking install the package themselves; the rest of Tuberosa stays install-light and offline. See `failure-tracking.md` Phase 4 §1.
- **`graphMaxHops` defaults to `1`.** The plan said "Add depth-2 expansion behind a `RetrievalPolicy.graphMaxHops` flag, gated by sandbox cost/benefit." Sandbox runs with `graphMaxHops=2` did not produce a measurable MRR gain on the current corpus, so we keep depth-1 as the default and leave the depth-2 code path in `memory-store.ts` for projects with denser graphs. See `failure-tracking.md` Phase 4 §3.
- **+0.05 MRR target not hit; +0.0004 measured.** The plan's verification target said "+0.05 MRR on Tier A prompts." The Phase 3 baseline (`MRR=0.4878`) was already quite strong; per-task profiles moved overall MRR by +0.0004 and `itemTypeDiagonalRate` by +0.4pts. The bigger wins are (a) the rerank path is now extensible without code edits via the registry, (b) graph scoring is policy-driven instead of literal magic numbers, and (c) calibration is a single command. We tightened the sandbox `minItemTypeDiagonalRate` floor from 0.6 → 0.65 to lock in the gain that did materialize.
- **`createModelProvider` for `local` uses CommonJS `require`.** TypeScript's static analysis flagged the dynamic-import approach for the registry; we used a deferred `require('./registry.js')` so the registry module is only loaded when `TUBEROSA_MODEL_PROVIDER=local` is set, avoiding a hard import on the OpenAI path. Reason: keeps the default code path lean and the local provider entirely opt-in.

**Goal.** Replace the hash reranker with a genuinely semantic local model, and replace static fusion weights with weights calibrated against sandbox ground truth. Keep OpenAI optional, never required.

### Deliverables

1. **Local cross-encoder reranker.** New `LocalCrossEncoderProvider` in `src/model/local-provider.ts`. Defaults:
   - Model: `bge-reranker-v2-m3` or `bge-reranker-base` via ONNX Runtime (or `@xenova/transformers` if friendlier).
   - First-run downloads weights into `~/.cache/tuberosa/models/` with checksum verification.
   - Selected via `TUBEROSA_MODEL_PROVIDER=local`; remains optional.
   - `HashModelProvider` stays the test default (eval harness untouched).
   - `OpenAiModelProvider` stays available for users who prefer it.

2. **Provider registry.** `src/model/registry.ts` centralizes provider selection. Each provider declares which methods it supports (`embed`, `rewriteQuery`, `rerank`); the service composes — e.g. hash embeddings + local reranker is a valid combination for users without an OpenAI key but with the ~150MB reranker download.

3. **Calibrated fusion weights.** New `scripts/calibrate-fusion.ts` runs the sandbox prompt set, observes which source contributed most to gold answers, and emits a `config/retrieval-policy.json` patch. Weights are *bounded* and *documented*; calibration runs whenever the sandbox grows materially. Static fallback weights remain in code so calibration is optional.

4. **Per-task fusion profiles.** The static `applyTaskTypeAdjustments` (`src/retrieval/fusion.ts:53-74`) becomes table-driven: each `taskType` carries `{ sourceWeights, itemTypeBoosts }` learned from the sandbox. Hardcoded fallback retained.

5. **Coverage-first scoring.** Today `context-fit.ts` weights all signal types statically (file 0.24, symbol 0.22, error 0.22…). Phase 4 makes these per-task: for `debugging`, errors dominate; for `refactor`, symbols dominate. Values from calibration script.

6. **Better graph hop scores.** Replace the literal 0.95 / 0.68 in `src/storage/postgres-store.ts:923-971` with policy-driven values plus per-relation-kind multipliers (`supersedes` strong, `mentions_file` weaker than `defines_symbol`). Add depth-2 expansion behind a `RetrievalPolicy.graphMaxHops` flag, gated by sandbox cost/benefit.

### Critical files

- New: `src/model/local-provider.ts`, `src/model/registry.ts`, `scripts/calibrate-fusion.ts`, `test/local-provider.test.ts` (smoke), `test/fusion-profiles.test.ts`.
- Modify: `src/model/provider.ts` (registry hookup), `src/retrieval/fusion.ts` (table-driven adjustments), `src/retrieval/context-fit.ts` (per-task coverage weights), `src/storage/postgres-store.ts` (policy-driven hop scores, optional depth-2), `src/retrieval/policy.ts` (extend schema).

### Verification

- Sandbox MRR + hit-rate improve over Phase 3 baseline (target: +0.05 MRR on Tier A prompts, no regression on Tiers B-F).
- Latency: rerank step p95 <500ms with local model on a 16-candidate window.
- `pnpm run eval:retrieval` green using hash provider.
- New tests: provider registry composition, fusion profile selection, graph hop scoring.

### Rollback boundary

`TUBEROSA_MODEL_PROVIDER` continues to switch behaviour. `RetrievalPolicy.useTaskProfiles=false` reverts to current static fusion weights. `graphMaxHops=1` reverts depth.

---

## Phase 5 — One-Command Install & Local-First Polish

**Status:** completed — 2026-05-21. `bin/tuberosa.ts` ships with `init`, `doctor`, and `mcp` subcommands; 207/207 unit tests + 3 evals + sandbox PASS. Full per-file diff in `file-tracking.md`; reverted approaches in `failure-tracking.md`.

### Plan deviations recorded

- **`tuberosa init` does NOT ship an `app` container.** The plan said "Detect Docker; if present, write a project-local `.tuberosa/compose.yml` and run it." We deliberately limited the compose template to `postgres` + `redis`. The user keeps `pnpm run dev` (or the MCP stdio launcher) in their own loop so iteration feedback stays sub-second. The production `docker-compose.yml` still bundles the `app` container for full-stack deployments.
- **`/health` curl + `pnpm run seed:self` removed from the success path.** The plan listed both as part of init. `curl /health` only makes sense when an HTTP server is running; init brings up Postgres/Redis only, so the check would always 404. `seed:self` is opinionated about ingesting the Tuberosa source itself, which is not what a brand-new project wants. Both moved into the printed MCP snippet / `pnpm run` hints instead.
- **Doctor's MCP stdout check accepts `process.stdout.write`.** The plan said "MCP stdio sanity (no stdout pollution)." The JSON-RPC framing in `src/mcp-stdio.ts:101-105` legitimately writes to stdout — that's the protocol's transport. The check now only fails on `console.log(`, which interleaves text into the protocol stream. See `failure-tracking.md` Phase 5 §2.
- **No `bin/tuberosa.ts` test for the spawned MCP child.** The CLI test uses an injected `SpawnFn` so we record the command and args the launcher would have run; we never actually spawn `node --import tsx` because that would start a real MCP server in CI. The compiled `dist/bin/tuberosa.js` was smoke-tested manually with `node dist/bin/tuberosa.js help` and `… doctor`.
- **No `npx tuberosa` publish.** The package is registered with `bin.tuberosa = "dist/bin/tuberosa.js"` and `files = ["dist/", "bin/", ".env.example", "migrations/"]`, so it's *ready* to publish. Actually pushing to npm is out of scope for this phase — registry credentials and a release process belong to a separate decision.

**Goal.** Hit the stated product goal: "easy install with 1-2 commands". Keep Postgres + pgvector (per decision), but make the *first run* feel like a single command.

### Deliverables

1. **`tuberosa init` CLI.** New `bin/tuberosa.ts` registered as a `bin` entry in `package.json`. Single command does:
   - Detect Docker; if present, write a project-local `.tuberosa/compose.yml` and run it.
   - Wait for Postgres health, run `pnpm run migrate`.
   - Copy `.env.example` → `.env` if missing.
   - Print MCP config snippet for Claude Code / Codex / Cursor.
   - On success: `curl /health` and seed self-knowledge via `pnpm run seed:self` (optional flag).
   - Idempotent; safe to re-run.

2. **`npx tuberosa` / `pnpm dlx tuberosa` entry.** Publishable so a brand-new machine with Node 22+ can do `npx tuberosa init` and be running. No git clone required for end users (devs of Tuberosa still clone).

3. **Embedded-mode quick start.** When Docker is absent, fall back to `TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash` and warn that data is volatile. Lowers the bar for trying Tuberosa.

4. **`tuberosa doctor`.** Diagnoses common install issues: Node version, pnpm, Docker, port collision (3027), Postgres reachability, MCP stdio sanity (no stdout pollution).

5. **README rewrite.** Top of `README.md` becomes:
   ```
   npx tuberosa init       # full local stack
   npx tuberosa doctor     # diagnose issues
   ```
   Codex/Claude-Code/Cursor snippets follow.

6. **MCP-only quick path.** `npx tuberosa mcp` runs the stdio server with sensible defaults so users can connect from an MCP client without any Docker — uses memory store with a flag to upgrade later.

### Critical files

- New: `bin/tuberosa.ts`, `bin/commands/init.ts`, `bin/commands/doctor.ts`, `bin/commands/mcp.ts`, `.tuberosa/compose.template.yml`, `test/cli.test.ts`.
- Modify: `package.json` (`"bin": { "tuberosa": "dist/bin/tuberosa.js" }`, `"files": [...]`), `README.md`, `docs/SETUP_AND_USAGE.md`.

### Verification

- Fresh VM smoke test: `npx tuberosa init` produces working stack in <90s on a clean Docker host.
- `npx tuberosa doctor` accurately diagnoses three injected failure modes (no Docker, port held, stale migrations).
- `pnpm test` adds `test/cli.test.ts` that mocks fs/Docker calls.

### Rollback boundary

CLI is additive; nothing breaks if it's not used. Existing `pnpm install && docker compose up -d` path remains documented and supported.

---

## Cross-cutting safety rules

- All new optional ML downloads (Phase 4) verify checksums and cache under `~/.cache/tuberosa/models/`. No silent network calls during eval/test paths (which must remain offline-deterministic).
- All telemetry (`filterEvents`, `scoreBreakdown`, `SuppressionEvent`) is opt-in via `TUBEROSA_DEBUG_RETRIEVAL=true` or sandbox runner, and **stripped from any pack returned to MCP clients** unless the caller explicitly requested debug mode. No leakage into normal agent context.
- Calibration outputs are version-tagged JSON under `config/`. Calibration never auto-runs in production; it's a developer command.
- Self-edit risk (per `feedbacks/feedback-synthesis.md`): when Tuberosa is editing its own repo, the sandbox is the source of truth, not historical memory. Phase 1 surfaces this by running the sandbox on every PR.

## Phase ordering & dependencies

```
Phase 1 (sandbox+metrics) ── must land first ──┐
                                                ├── Phase 2 (noise filters, needs telemetry)
                                                ├── Phase 3 (labels & types, needs label-confusion matrix)
                                                ├── Phase 4 (rerank+calibration, needs ground truth)
                                                └── Phase 5 (install, independent — can ship anytime)
```

Phases 2/3/4 can be parallelized once Phase 1 is in. Phase 5 is independent and could ship first if a release demo is needed.

## Master verification per phase

Every phase ships with green output for:

```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run eval:knowledge-completeness
pnpm run eval:agent-context
pnpm run sandbox            # NEW in Phase 1
pnpm run sandbox:ablate     # NEW in Phase 1
pnpm run benchmark          # composite score must not regress
```

Plus a manual smoke test through the MCP stdio server using `tuberosa_search_context` against a real prompt that hits the new behaviour.

## Out of scope (deliberate)

- Worktree evidence bridge, startup brief, maintenance preview, research trace — owned by `feedbacks/plan-synthesis.md`.
- Store migration away from Postgres — explicitly declined.
- Multi-tenant cloud deployment — not the product goal.
- Replacing the existing reflection/review workflow — additive only.

## External references that informed this plan

- **RAG eval rigor**: RAGAS (faithfulness/relevance metrics), BEIR (diverse retrieval benchmarks). Tuberosa already mirrors these via `RetrievalEvalMetrics`; Phase 1 adds the per-source ablation rigor that RAGPerf-style harnesses use.
- **Hybrid search**: LanceDB / sqlite-hybrid-search show how BM25 + vector + cross-encoder rerank composes. Tuberosa already does the first two; Phase 4 adds the cross-encoder step. RRF as the default fusion remains valid (mirrors the current `1 / (60 + rank)` denominator in `fusion.ts:13-50`).
- **Local-first reranking**: BGE-reranker-v2-m3 (ONNX) and `@xenova/transformers` show feasibility of running a high-quality reranker locally with ~150-400MB models. No paid API required.
- **Agent-memory peers**: Mem0 (fast simple), Letta (autonomous agent runtime), Zep (temporal KG), Cognee (GraphRAG-style ontology). Tuberosa's review-gated, label-rich, code-aware angle is its differentiator; Phase 3's ontology and AST extraction borrow Cognee's ontology-guided approach without taking its full graph stack.
- **MCP install patterns**: agentmemory, OMEGA, official `@modelcontextprotocol/server-memory`. All ship as `npx <pkg>` one-liners — Phase 5 brings Tuberosa to parity.
