# Tuberosa Knowledge-Quality Overhaul — Detailed Plan

## Context

Tuberosa already has the right core shape: classify → search (lexical/vector/metadata/memory/graph) → fuse → rerank → context-fit → context-pack. The current weakness is **not** missing features — it's that **knowledge quality is undermeasured and several pipeline stages have known gaps** that the deterministic fixture is too small to catch:

- **Classifier verb noise** — `Analyze`, `Investigate`, `Improve` leak into the symbols set (`src/retrieval/classifier.ts:544-675`), polluting downstream matching.
- **Domain inferred but not labelled** — `inferDomain` produces a field but `labelsFromClassification` never emits it (`classifier.ts:114-147`).
- **Query rewrite augments without validating** — `applyQueryRewrite` (`service.ts:108`) merges new terms into the old ones with no check that the rewrite improved retrieval; no caching of rewrite outcomes.
- **Fusion divisor hardcoded** — `(60 + rank)` in `fusion.ts` is not tunable per task; the calibrator only tunes weights, not k.
- **Feedback aggregates but doesn't move scores** — 11 feedback types exist, `KnowledgeFeedbackSummary` counts them, but **no per-knowledge penalty is applied during fusion**. Rejected memories keep ranking high until someone manually marks them stale.
- **Suppression penalties cumulate linearly without normalization** — a candidate hit by stale + rejected + domain-mismatch can drop >0.5 with no clipping (`service.ts:1457-1592`).
- **Context-fit computed late** — `fitStatus` is set after rerank; rerank failures bubble up silently and trust decays to 0 with no fallback.
- **Worktree is not a first-class source** — live files / prompt-named files / current handoff have no producer in `KnowledgeStore`; durable memory competes with itself instead of with live truth.
- **Atomizer loses cross-chunk context** — `document-atomizer.ts` splits Markdown by heading with no breadcrumb prefix; a chunk reading "this section adds X" is unmoored after embedding.
- **Eval coverage is shallow** — fixture has ~14 cases (`eval/retrieval-fixtures.json`), no entity-recall, no noise-sensitivity, no per-task-type taxonomy, no feedback-→-ranking regression case.

**Intended outcome:** Tuberosa becomes measurably better at putting **on-point** evidence in front of fresh agents while staying **offline-capable**, **backwards-compatible at the MCP surface**, and **dependency-light by default**. Every phase below ships the regression fixture FIRST, then the fix. Eval stays green at every step.

---

## Why not just integrate Mem0?

Mem0 is great but conflicts with all four locked-in constraints: it's Python-first (no Node SDK), calls GPT-4o-mini on every memory write (not offline), requires Neo4j (heavy infra), duplicates Tuberosa's vector store, overrides the review-gated trust model, and is shaped for chat memory not project knowledge. **We borrow the patterns (4-way write gate, time-stamped edges, entity-centric expansion) but implement them locally with vector cosine + label/reference overlap — no LLM call, no Neo4j.**

---

## Current quality assessment (baseline before any change)

| Dimension | Current state | Evidence |
|---|---|---|
| **Helpfulness** | Moderate. Hash reranker is a placeholder; `bge-reranker-v2-m3` only loads with `TUBEROSA_MODEL_PROVIDER=local`. Most users run pure hash. | `local-provider.ts:52`, `provider.ts:31-47` |
| **Coverage** | 5 sources fused (metadata, lexical, vector, memory, graph). **No worktree source.** Classifier emits domain field but not as label, so domain-scoped retrieval underperforms. | `fusion.ts`, `classifier.ts:114-147` |
| **Completeness ratio** | Feedback aggregates exist (`KnowledgeFeedbackSummary`) but don't feed back into fused score. Stale/rejected items ride along until manually superseded. | `service.ts:1386-1592` |
| **Effectiveness (measured)** | `pnpm run eval:retrieval` passes at 100% on 14 hand-picked cases. Sandbox adds tiered corpus + ablation. **No entity recall, no noise-sensitivity, no CoIR-style task taxonomy.** | `eval/retrieval-fixtures.json`, `scripts/sandbox.ts` |
| **Rewrite flow** | Conditional on OpenAI provider (`provider.ts:123-159`); augments lexical query, doesn't replace, doesn't validate. No diverse-angle prompts. No gating on confidence. | `service.ts:105-129` |
| **Categorization** | Item types: spec/workflow/memory/bugfix/code_ref/rule/wiki/conversation. Labels: technology/business_area/task_type/file/symbol/project. **Domain inferred from `src/X/` but not emitted as label.** No label provenance/confidence. | `classifier.ts`, `relations/inference.ts` |
| **Knowledge safety** | Secrets + prompt-injection blocked at ingestion. **False-positive rate unmeasured** — regex `api[_-]?key\s*[:=]` matches legitimate config keys. | `security/knowledge-safety.ts:60-100` |

---

## Approach

Ten phases, each independently mergeable, each behind a flag if behavior changes externally. Pre-commit invariant for every phase:

```bash
pnpm run build && pnpm test && pnpm run eval:retrieval && pnpm run sandbox
```

Each phase **adds the regression fixture before** writing the fix, so the test goes red → green inside the same PR.

---

## Phase 0 — Evaluation expansion (foundation; everything else depends on this)

**Why first:** every later phase claims to improve quality. We need metrics that can prove or disprove that, beyond the 14-case fixture.

**Status: ✅ DONE (2026-05-21)**

**Implemented:**
- ✅ New fixture: `eval/context-mapping-fixtures.json` — 12 approved knowledge items + 3 distractors + 2 feedback events + 3 relations + 7 cases spanning all four taxons.
- ✅ New evaluator: `src/evaluation/context-mapping-evaluator.ts` — computes Context Precision @ k, Context Recall, Context Entities Recall, Noise Sensitivity, Direct-evidence Placement, Fit Calibration, Forbidden-item Rate, plus CoIR-style per-taxon breakdowns. Deterministic — no LLM calls, hash provider only.
- ✅ New fixture loader: `src/evaluation/context-mapping-fixture-loader.ts` — parallel to the existing retrieval-fixtures loader; validates the taxon enum.
- ✅ New script: `scripts/eval-context-mapping.ts` and npm script `pnpm run eval:context-mapping` with `--write-baseline` plus six threshold flags (`--fail-under-precision`, `--fail-under-recall`, `--fail-under-entities-recall`, `--fail-under-noise-sensitivity`, `--fail-under-fit-calibration`, `--fail-over-forbidden-rate`).
- ✅ Extended `eval/retrieval-fixtures.json`: every existing case now has `taxon` + `expectedEntities` fields.
- ✅ Baseline captured: `eval/baseline-context-mapping.json` — current hash-provider numbers are now the reference for every subsequent phase.

**Baseline numbers (2026-05-21, hash provider):**

| Metric | All cases | nl_to_code | code_to_code | text_to_text_doc | hybrid |
|---|---|---|---|---|---|
| Context Precision @ 5 | 25.7% | 20% | 40% | 20% | 40% |
| Context Recall | 100% | 100% | 100% | 100% | 100% |
| Context Entities Recall | 100% | 100% | 100% | 100% | 100% |
| Noise Sensitivity | 71.4% | 50% | 100% | 66.7% | 100% |
| Direct-evidence Placement | 100% | 100% | 100% | 100% | 100% |
| Fit Calibration | 100% | 100% | 100% | 100% | 100% |
| Forbidden-item Rate | 16.7% | 0% | n/a | 33.3% | 0% |

**What this confirms about the current state:** precision and noise resistance are the weakest dimensions today. Adjacent-but-unrelated workflow docs (`current-deploy-runbook`, `current-rate-limit-policy`) flood the top-5 even when the query is about something else; semantically-similar distractors leak into top-5 on 28.6% of cases; one legacy item (`legacy-deploy-runbook`) bubbles up alongside its supersession. These are precisely the failure modes Phases 1, 2, 4, and 5 will attack.

**Deviations from the original Phase 0 spec (recorded here so they aren't lost):**
- **Worktree field in the fixture schema:** the spec listed `worktree` as a top-level fixture field (current/changed/missing files). It is **omitted from this iteration** because the worktree provider doesn't land until Phase 5 and parsing fields no producer consumes invites schema drift. When Phase 5 ships, add the field to `ContextMappingFixture` + loader + evaluator alongside the worktree-precedence metric.
- **Noise-sensitivity implementation:** spec said "inject N distractor chunks per case; fitStatus must degrade to `needs_confirmation`". Implemented as a **single-pass case evaluation** where distractors are seeded once into the store, and the metric measures whether they leak into top-K. FitStatus degradation under noise is **not** measured per-case yet — adding a second-pass run with a noise-amplified prompt was deferred to keep the runner offline-fast (one pass per case, no re-seeding). Re-evaluate once Phase 3 ships the structured `fitDiagnostics`.
- **`taxon` + `expectedEntities` on `RetrievalEvalCase` type:** the JSON fields are present on every case in `eval/retrieval-fixtures.json`, but the existing `RetrievalEvalCase` TypeScript type and `fixture-loader.ts` were **deliberately not extended**. They're documentation-only data, ready for the phase that actually consumes them (Phase 1 for the classifier hygiene work; Phase 5 for worktree). The legacy loader silently ignores unknown JSON fields, so `pnpm run eval:retrieval` stays green without churn.
- **CoIR taxonomy coverage:** only 7 cases across 4 taxons in this fixture (2/1/3/1). Sufficient for baseline measurement but thin. When Phase 1 lands (classifier verb hygiene + domain labels) and we want stronger per-taxon signal, expand to ~16 cases (4 per taxon) so per-taxon deltas are meaningful.

**Files added:**
- `src/evaluation/context-mapping-evaluator.ts` (~420 lines)
- `src/evaluation/context-mapping-fixture-loader.ts` (~175 lines)
- `scripts/eval-context-mapping.ts` (~230 lines)
- `eval/context-mapping-fixtures.json` (7 cases)
- `eval/baseline-context-mapping.json` (locked baseline metrics)

**Files modified:**
- `package.json` — added `eval:context-mapping` script.
- `eval/retrieval-fixtures.json` — added `taxon` + `expectedEntities` on every case (data-only, no type/loader changes).
- `implements/enhance_rewrite/tuberosa-enhance-knowledge-quality.md` — this status block.

**Verification (all green):**
- `pnpm run build` ✅
- `pnpm test` ✅ — 224/224 pass
- `pnpm run eval:retrieval` ✅ — hit@5 100%, MRR 1.0, all classification rates 100%
- `pnpm run eval:agent-context` ✅
- `pnpm run eval:context-mapping` ✅ — runs, prints metrics, writes baseline

**Tried but not done (deliberate carry-overs):**
- A "noise variant" second pass per case to measure fitStatus degradation under injected distractors — deferred until Phase 3's `fitDiagnostics` block lands so the assertion has structured signal to bind to.
- Extending `RetrievalEvalCase` to type-check `taxon`/`expectedEntities` — deferred to the first phase that consumes the fields programmatically (likely Phase 1).
- The `--fail-*` threshold flags exist but are **not wired into CI yet**; the baseline file is the regression reference. Wire thresholds once Phase 1's targets are agreed on.

---

## Phase 1 — Classifier + label hygiene (cheap, high signal)

**Why:** noise at the front of the pipeline poisons every downstream stage. Roadmap explicitly flagged this.

**Changes:**
- `src/retrieval/classifier.ts`:
  - Expand `SYMBOL_STOP_WORDS` with a vetted list of task verbs (the roadmap's `Analyze | Answer | Investigate | Improve | Implement | Fix | Add | Refactor | Review | Audit | Map | Trace | Plan | Build | Test | Verify` and conjugations). Stopwords apply **unless** the term arrives via the `symbols:` input parameter (then user-supplied wins).
  - Emit `domain` as a first-class label in `labelsFromClassification`, with `provenance: 'inferred'` and `confidence: 0.7`.
  - Add label-provenance metadata to every emitted label: `explicit | inferred | reviewed | feedback_proposed | worktree_detected`. Persisted in `labels[].metadata.provenance`.
- `src/types.ts`: add `provenance` and `confidence` to `KnowledgeLabel`.
- `src/storage/postgres-store.ts` + `memory-store.ts`: persist label provenance/confidence (no migration needed — store in existing `metadata` JSONB).

**Fixtures added before code:**
- "Investigate the auth flow" → `Investigate` MUST NOT appear in classified symbols.
- Prompt mentioning a file under `src/retrieval/` → emitted labels MUST include `{ type: 'domain', value: 'retrieval' }`.

**Verification:** `pnpm run eval:context-mapping` — direct-evidence placement rate strictly improves on the "domain mismatch" cases.

---

## Phase 2 — Feedback → ranking translation (closes the loop)

**Why:** the system already collects 11 feedback types but doesn't act on them at retrieval time. Memories stay high-ranked even after multiple rejections.

**Changes:**
- New module `src/retrieval/feedback-scorer.ts`:
  - `computeFeedbackPenalty(summary: KnowledgeFeedbackSummary, now: Date): number` — returns a multiplicative factor in `[0.3, 1.0]`.
  - Exponential decay: recent rejections weigh more than ones from months ago (`weight = exp(-Δdays / 60)`).
  - Distinct contributions per type: `rejected`/`stale` damage the score harder than `selected_but_noisy`; `selected` and `too_much_adjacent_context` weakly raise it.
  - Output is a **factor**, not an additive delta — applied before clip so cumulative penalties damp asymptotically toward the floor (avoids the current unbounded subtraction issue in `service.ts:1457-1592`).
- Apply in `src/retrieval/fusion.ts` `fuseCandidates`: after RRF aggregation, multiply each candidate's `fusedScore` by its feedback factor. This puts feedback **before rerank** so the reranker sees corrected ordering.
- Refactor `applyIntentSuppression` in `service.ts`: convert linear `-0.28 / -0.14 / -0.10` subtractions to multiplicative damping with a hard floor at 0.1. Remove the order-dependent cumulation bug noted in the exploration.

**Fixtures added before code:**
- Knowledge K with 3 `rejected` feedback events in the last 7 days ranks **below** an otherwise-identical knowledge K' with 0 feedback for the same query.
- Knowledge K hit by stale + rejected + domain-mismatch retains `finalScore >= 0.1` (does not negative-spiral).

**Verification:** `pnpm run eval:context-mapping` — forbidden-item rate strictly drops. `pnpm run eval:retrieval` stays green.

---

## Phase 3 — Context-fit hardening

**Why:** `fitStatus` is currently computed after rerank with no fallback. A reranker exception silently produces `insufficient` even when fused scores were strong.

**Changes:**
- `src/retrieval/service.ts`: wrap rerank in a try/catch that, on failure, falls back to the fused ordering and emits `fitStatus: 'needs_confirmation'` with `fitReasons: [..., 'reranker_unavailable']` instead of letting trust collapse.
- `src/retrieval/context-fit.ts`:
  - Add `worktreeMatchScore` placeholder (set to 0 here; populated in Phase 5).
  - Recompute `fitScore` as `0.55 × topCandidate + 0.20 × avg(top3) + 0.15 × coverage + 0.10 × worktreeMatchScore` (weights configurable in `config/retrieval-policy.json`).
  - Emit a structured `fitDiagnostics` block alongside `fitReasons` so the workbench can show *why* fit landed where it did.

**Fixtures added before code:**
- Rerank-throws case → `fitStatus === 'needs_confirmation'`, candidates still returned in fused order.
- Same-fused-score-but-no-rerank case → `fitDiagnostics.contributors` lists `top1`, `top3_avg`, `coverage` with numbers.

**Verification:** unit test added to `test/context-fit.test.ts`. Sandbox latency unchanged.

---

## Phase 4 — Chunk-level context (Anthropic + Jina patterns, fully offline)

**Why:** this is the **single biggest measured uplift available** that we haven't done yet. Anthropic's published numbers: −49% retrieval failures from contextual embeddings + BM25 alone, stacking to −67% with rerank. The breadcrumb variant is **free** (no LLM call) — late chunking and LLM-summarized context are progressive enhancements.

**Changes:**
- `src/ingest/document-atomizer.ts`:
  - For each atomized section, prepend a **breadcrumb prefix** to the indexable text: `<file-path> > <h1> > <h2> > <h3>\n\n<atom body>`. Heuristic-only; zero LLM.
  - The breadcrumb is indexed (FTS + embedding) but **not** stored in `content` — it lives in `contextualContent`, which the retriever already prefers over raw content.
- Optional: `src/ingest/contextual-summarizer.ts` — when a model provider exposes a cheap rewrite/summary capability (existing `rewriteQuery` slot, future ollama summary), generate a 1-sentence "what is this section about" summary for top-level docs only. Behind `TUBEROSA_CONTEXTUAL_PREFIX_LLM=true` flag, default off.
- `src/ingest/late-chunker.ts` (new, optional path): when a long-context embedder is configured (e.g., future ollama embed model with 8k+ context), embed the full doc once, pool per-section ranges, write per-atom vectors. Length-gated: skip for docs < ~2k tokens.
  - Provider-capability check via a new `ModelProvider.supportsLongContextEmbed?: () => boolean` opt-in flag. Default `false` → atomizer keeps current behavior.

**Fixtures added before code:**
- A query naming a parent doc topic (e.g., "phase 4 reranker policy") retrieves the right atom even when the atom body itself doesn't repeat the parent title.
- Late-chunker fixture (run only when provider supports it): pooled-span vector beats per-atom embedding on cross-reference resolution.

**Verification:** Context Entities Recall in `eval:context-mapping` strictly improves; `eval:retrieval` stays green. Sandbox latency must stay within 1.15× of baseline (breadcrumb prefix is the only mandatory cost and it's pure-string).

---

## Phase 5 — Worktree evidence provider (roadmap Phase 2)

**Why:** for continuation/self-edit tasks, the **current worktree** is the truest evidence and currently has no producer. Durable memory wins disputes against live truth — backwards.

**Changes:**
- New module `src/retrieval/worktree.ts`:
  - Bounded, sanitized read of: `git status --porcelain`, prompt-named files that exist on disk, `*.md` handoff files at repo root (e.g., `integrate-reranking.md`, `roadmap-codex.md`), recently-edited files (mtime within configurable window).
  - Output shape mirrors `SearchCandidate` so it slots into fusion without special-casing.
  - Respects size caps (`TUBEROSA_MAX_INGEST_CONTENT_BYTES`); skips binary, redacts secrets via existing `knowledge-safety` pipeline.
- `src/storage/store.ts` + memory + postgres: new `CandidateSource` value `'worktree'`. **No new table** — worktree is read-through, never persisted. The store interface gets an optional `searchWorktree?` method, populated only when worktree provider is wired in.
- `src/retrieval/service.ts`: add worktree as a 6th parallel search source, **only when** the active task type is `implementation | debugging | refactor | review | exploration` and the prompt names files OR the session has `cwd` set. Skipped for `planning | testing` unless explicitly requested.
- `config/retrieval-policy.json`: `sourceWeights.worktree = 1.30` (highest), with a `taskProfiles.continuation.worktree += 0.05` boost.
- `src/retrieval/context-fit.ts`: populate the `worktreeMatchScore` placeholder from Phase 3 — non-zero only when worktree files matched prompt's named files.
- Config: `TUBEROSA_WORKTREE_ENABLED=true` (default), `TUBEROSA_WORKTREE_MAX_FILES=50`, `TUBEROSA_WORKTREE_MAX_MTIME_AGE_HOURS=72`.

**Fixtures added before code:**
- Prompt names `integrate-reranking.md` (file exists in worktree, not yet ingested) → it appears in the `essential` bucket via the worktree source.
- Worktree contradicts an approved memory (e.g., approved memory says file at path X has function `foo`; worktree shows the file deletes `foo`) → worktree wins for continuation tasks; memory flagged as `potentially_stale`.

**Verification:** `eval:context-mapping` gets a "worktree precedence" metric (% of cases where worktree-matched files outrank conflicting memory). MCP backwards-compatibility maintained because no tool surface changed — worktree is additive to existing fusion.

---

## Phase 6 — Memory architecture (Mem0-style + Letta + LangGraph patterns, offline)

**Why:** unify the three patterns from the research digest into Tuberosa's existing review-gated model. Result: less memory churn, no LLM dependency, durable provenance.

**Changes:**

### 6a — Namespaced memory scope (LangGraph pattern)
- Add `namespace: { project: string; kind: string; agent?: string }` field to `Knowledge` records (defaults: `kind='reflection' | 'wiki' | …` derived from itemType; `agent` optional, only set when written from an agent-session learning path).
- Expose `namespace` as a search filter on `tuberosa_search_context` (optional param, backwards-compatible).
- `src/storage/postgres-store.ts` migration `migrations/00X_knowledge_namespace.sql` — add column with backfill (no breaking schema change, default = derived).

### 6b — Local-heuristic write gate (Mem0 pattern, NO LLM call)
- New module `src/reflection/write-gate.ts`:
  - On reflection finalization, compute against existing approved memories in the same namespace:
    - **Vector cosine similarity** of summary embedding vs top-K nearest.
    - **Label overlap** Jaccard (file/symbol/error labels).
    - **Reference overlap** Jaccard (file refs / commit refs).
    - **Recency** of the closest match.
  - Decision tree (purely deterministic):
    - `cosine >= 0.92 && labelOverlap >= 0.7` → **NOOP** (suggest skipping; existing memory covers this).
    - `cosine >= 0.80 && labelOverlap >= 0.5` and new content adds non-overlapping facts → **UPDATE** (propose merge / supersedes).
    - `cosine >= 0.80` and new content contradicts (e.g., references different file path for the same symbol) → **DELETE / supersede** (propose marking old one `superseded_by`).
    - Otherwise → **ADD**.
  - **Decision feeds the existing review gate** — it never auto-mutates, only sets `proposalType` on the draft so reviewers see the recommendation. Trust model preserved.
- Wire into `src/agent-session/service.ts` learning gate (`evaluateGates` around line 413) — write-gate decision becomes a new gate signal alongside safety/duplicate/evidence/usefulness.

### 6c — Time-stamped edge validity (Mem0g pattern)
- `src/relations/inference.ts`: every inferred relation gets `metadata.validFrom: ISO timestamp` (creation time, already implicit). Add `metadata.validUntil` set when a `supersedes` relation is created or feedback flags the relation stale.
- `src/retrieval/service.ts` `searchGraphRelations`: filter out relations with `validUntil < now` from expansion.
- No new table.

### 6d — Entity-centric graph expansion
- `src/retrieval/service.ts` `searchGraphRelations`: use classifier-extracted `files` and `symbols` as graph seeds (in addition to the current top-fused-IDs seed set). For each extracted entity, query `relations` where `source_uri` or `target_uri` matches the entity, expand 1 hop. Dedup against top-fused expansion.
- Bounded: ≤ 8 seeds, ≤ 16 expanded relations per query (current caps preserved).

**Fixtures added before code:**
- Reflection that duplicates an approved memory's summary by ≥ 0.92 cosine + ≥ 0.7 label overlap → write-gate decision is `NOOP`.
- Reflection that adds new facts to an existing memory's topic → decision is `UPDATE`.
- Reflection contradicting an approved memory's reference path → decision is `DELETE/supersede` with the conflict captured in metadata.
- Relation with `validUntil < now` does NOT contribute to graph expansion in the next search.
- Classifier extracts symbol `PaywallModal` not present in top-fused candidates; graph-expansion produces a related `bugfix` memory referencing that symbol.

**Verification:** `eval:context-mapping` gets a "memory churn rate" metric (reflections accepted as ADD vs UPDATE vs NOOP vs DELETE over a synthetic stream). Goal: ≤ 60% ADD over 100 synthetic reflections (down from ~100% today).

---

## Phase 7 — Gated query rewrite + RRF k calibration

**Why:** the 2026 Dell production paper showed unconditional query rewrite costs latency for ~zero gain post-reranker. The right policy is **gated rewrite** when initial retrieval is unconfident, plus making RRF's k tunable per task type.

**Changes:**
- `src/retrieval/service.ts`:
  - **Pre-search confidence probe** — run a fast lexical+vector pass (top-5 only, no graph/memory/worktree) and compute `probeConfidence = top1.fusedScore`. If `probeConfidence >= 0.65` → skip `rewriteQuery` entirely. If below → fire rewrite.
  - When rewrite fires, use a **diverse-angle prompt** template instead of paraphrase: ask the rewriter for variants framed as different task types ("how does X work" / "where is X used" / "what depends on X"). The result populates `exactTerms` for OR-style FTS expansion.
- `src/retrieval/fusion.ts`: `RRF_K` becomes `policy.rrf.k` (configurable). Add `policy.rrf.kByTaskType` overrides — e.g., `debugging: 30` (sharper top-rank advantage where exact-error matches must dominate), `planning: 80` (smoother curve).
- `config/retrieval-policy.json`: new `rrf` section with `k: 60` default and per-task overrides.
- `scripts/calibrate-fusion.ts`: grid-search **k** alongside source weights. Emit `rrf.k` and `rrf.kByTaskType` patches in the calibration output.

**Fixtures added before code:**
- Confident query (top1 fused ≥ 0.7) → `rewriteQuery` is NOT called (assert via spy/mock provider).
- Low-confidence query → rewrite fires AND the resulting `exactTerms` contains task-perspective variants, not paraphrases.
- Sandbox calibration produces a non-default `k` for at least one task type.

**Verification:** sandbox latency p50 strictly decreases (rewrites skipped on confident queries). `eval:retrieval` stays green. Calibrator now writes both weights and k.

---

## Phase 8 — Brief groundedness + classification guard rails

**Why:** the assembled context pack includes a `taskBrief` synthesized from candidate evidence. If any sentence isn't traceable to a knowledge ID, the agent inherits a hallucination.

**Changes:**
- `src/retrieval/context-pack.ts`: tag each `taskBrief.actionItems[]` and any synthesized `reviewTargets` with `evidenceIds: string[]`. Currently this is partial — make it complete.
- New guard in `assembleContextPack`: assert every brief sentence has at least one `evidenceId` resolving to a candidate in the pack. If not → drop the sentence; log to `fitDiagnostics.brief_warnings`.
- Add `responseRelevancy`-style check (deterministic): for every action item, the referenced candidate's title/content/labels must overlap with the action item's keywords by ≥ 1 token. Otherwise → drop.

**Fixtures added before code:**
- Brief that mentions a file path NOT in any pack candidate → guarded out, warning emitted.
- Brief whose action item's referenced ID is in candidates but with zero token overlap → guarded out.

**Verification:** `eval:context-mapping` adds a "brief groundedness" metric (% of brief sentences with valid evidence). Target: 100%.

---

## Phase 9 — Knowledge-safety false-positive measurement

**Why:** the regex patterns in `knowledge-safety.ts` (e.g., `api[_-]?key\s*[:=]`) are broad. Legitimate config files get redacted unnecessarily, losing useful knowledge. No metric exists for this today.

**Changes:**
- New fixture `eval/safety-fixtures.json`:
  - True positives: PEM keys, GitHub tokens, AWS AKIA, real API secrets in commits.
  - True negatives: TypeScript types like `apiKey?: string`, function param `apiKey: string`, comments like `// pass api key`, env-example placeholder values.
  - Edge cases: JSON schema descriptions, JSDoc examples.
- New evaluator `src/evaluation/safety-evaluator.ts` and script `pnpm run eval:safety`. Outputs precision / recall / F1 per pattern.
- `src/security/knowledge-safety.ts`: tighten patterns based on evaluator results (e.g., require non-trivial value after `=`/`:`; ignore TypeScript type-annotation context). Maintain ≥ 0.95 recall on true positives while raising precision above current baseline.

**Verification:** `eval:safety` script lands with a baseline + thresholds. Future pattern changes can't regress precision/recall silently.

---

## Phase 10 — Preview-first maintenance (roadmap Phase 6)

**Why:** Phase 6 produces UPDATE / DELETE / supersede proposals. They need a review surface. Sourcegraph Batch Changes is the right interaction model — preview first, apply after review.

**Changes:**
- New MCP tool `tuberosa_propose_maintenance` — generates preview batches:
  - Duplicate memories (Phase 6a clustering output).
  - Stale relations (`validUntil < now`).
  - Superseded reflections (`DELETE` decisions from Phase 6b).
  - Weak / unreviewed labels (`provenance: 'inferred'` with `confidence < 0.5`).
- New MCP tool `tuberosa_apply_maintenance` — applies an approved batch. Idempotent. Always behind a review (workbench UI link).
- Workbench: surface pending maintenance previews next to pending reflection drafts.
- Auto-apply: NEVER. Always reviewer-gated.

**Fixtures added before code:**
- A synthetic corpus with 5 duplicate memories and 3 stale relations → `propose_maintenance` returns a preview with exactly 5+3 items.
- `apply_maintenance` mutates only the records listed in the preview; un-approved drafts untouched.

**Verification:** integration test in `test/maintenance.test.ts`. MCP surface stays backwards-compatible (two NEW tools, no changes to existing ones).

---

## Cross-cutting: feature flags

Every phase that changes external behavior ships behind an env flag, all defaulting to **on** **only after** the phase's fixtures are green and its sandbox numbers beat baseline. Flags:

| Phase | Flag | Default |
|---|---|---|
| 1 | `TUBEROSA_DOMAIN_LABELS_ENABLED` | `true` |
| 2 | `TUBEROSA_FEEDBACK_PENALTY_ENABLED` | `true` |
| 4 | `TUBEROSA_CONTEXTUAL_PREFIX_ENABLED` | `true` (breadcrumb only) |
| 4 | `TUBEROSA_CONTEXTUAL_PREFIX_LLM` | `false` |
| 4 | `TUBEROSA_LATE_CHUNKING_ENABLED` | `false` (needs long-context embedder) |
| 5 | `TUBEROSA_WORKTREE_ENABLED` | `true` |
| 6 | `TUBEROSA_MEMORY_NAMESPACE_ENABLED` | `true` |
| 6 | `TUBEROSA_WRITE_GATE_ENABLED` | `true` |
| 7 | `TUBEROSA_REWRITE_GATING_ENABLED` | `true` |

All MCP tool signatures remain backwards-compatible: new params are optional with safe defaults.

---

## Files modified or created (representative paths, not exhaustive)

**New:**
- `src/evaluation/context-mapping-evaluator.ts`
- `src/retrieval/feedback-scorer.ts`
- `src/retrieval/worktree.ts`
- `src/reflection/write-gate.ts`
- `src/ingest/late-chunker.ts` (optional path)
- `src/ingest/contextual-summarizer.ts` (optional path)
- `src/evaluation/safety-evaluator.ts`
- `scripts/eval-context-mapping.ts`
- `scripts/eval-safety.ts`
- `eval/context-mapping-fixtures.json`
- `eval/safety-fixtures.json`
- `eval/baseline-context-mapping.json`
- `migrations/00X_knowledge_namespace.sql`
- `migrations/00Y_label_provenance.sql` (storage-side support for Phase 1)

**Modified:**
- `src/retrieval/classifier.ts` — verb stopwords, domain label, label provenance
- `src/retrieval/fusion.ts` — feedback factor, tunable RRF k
- `src/retrieval/service.ts` — rewrite gating, rerank fallback, worktree wiring, suppression damping
- `src/retrieval/context-fit.ts` — fit score reweight, worktreeMatchScore, fitDiagnostics
- `src/retrieval/context-pack.ts` — brief groundedness guard
- `src/ingest/document-atomizer.ts` — breadcrumb prefix
- `src/relations/inference.ts` — time-stamped edges
- `src/agent-session/service.ts` — write-gate signal in evaluateGates
- `src/security/knowledge-safety.ts` — tightened patterns
- `config/retrieval-policy.json` — rrf section, worktree weight, taskProfiles updates
- `src/types.ts` — new fields (label provenance, namespace, fitDiagnostics)
- `src/mcp/server.ts` — new optional tools (propose/apply maintenance)
- `.env.example` — all new flags documented
- `CLAUDE.md` — note the new eval commands

---

## Verification

For **each phase**, before marking it complete:

```bash
pnpm install
pnpm run build
pnpm test
pnpm run eval:retrieval              # must stay green (existing fixture)
pnpm run eval:context-mapping        # NEW — added in Phase 0
pnpm run eval:agent-context          # must stay green
pnpm run eval:safety                 # NEW — added in Phase 9
pnpm run sandbox                     # latency p50/p95 within 1.2× baseline
pnpm run sandbox:ablate              # per-source ablation deltas reasonable
```

For **the full overhaul**, success criteria measured against `eval/baseline-context-mapping.json`:

- **Context Precision @ 5** strictly improves (target +15% absolute).
- **Context Entities Recall** strictly improves (target +20% absolute from Phase 4 alone).
- **Noise Sensitivity** — fitStatus correctly degrades on ≥ 95% of injected-distractor cases.
- **Forbidden-item rate** strictly drops (target halve).
- **Brief groundedness** at 100%.
- **Memory churn** ≤ 60% ADD on synthetic stream (down from ~100%).
- **Worktree precedence** ≥ 90% on continuation cases.
- **Sandbox latency p50** stays within 1.2× baseline; **p95** within 1.5×.

For **MCP smoke**, after each phase:

```bash
# start MCP with the new flags off → behavior unchanged
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory pnpm run dev
# then with flags on → run a known prompt and inspect tuberosa_search_context output
```

---

## What's deliberately out of scope

- **External vector DB** (Pinecone / Qdrant / Weaviate) — pgvector is sufficient at current scale; revisit only if `eval:context-mapping` proves a scale bottleneck.
- **OpenAI-mandatory features** — every phase has an offline path. OpenAI provider stays optional.
- **Mem0 / Neo4j integration** — borrowing patterns only (see "Why not just integrate Mem0?" section).
- **Workbench UI redesign** — this plan only adds two new tools and surfaces existing ones; full workbench orchestration deferred to a follow-up.
- **Multi-tenant auth** — Tuberosa stays local-first; auth/tenancy out of scope here.

---

## Order of execution (recap)

1. **Phase 0** — eval expansion (foundation).
2. **Phase 1** — classifier + label hygiene.
3. **Phase 2** — feedback → ranking.
4. **Phase 3** — context-fit hardening.
5. **Phase 4** — contextual prefix + late chunking (biggest measured uplift).
6. **Phase 5** — worktree provider.
7. **Phase 6** — memory architecture (namespaces, write-gate, time-stamped edges, entity expansion).
8. **Phase 7** — gated rewrite + RRF k calibration.
9. **Phase 8** — brief groundedness.
10. **Phase 9** — safety FP measurement.
11. **Phase 10** — preview-first maintenance.

Phases 0-3 are the foundation. After Phase 4 there's a meaningful, ship-able improvement on its own — could pause there and re-prioritize. Phases 5-10 deepen the system further but each remains optional and independently mergeable.
