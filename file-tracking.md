# File Tracking — roadmap-claude.md Implementation

Tracks every file created or modified per phase. Updated as work progresses.

## Phase 1 — Knowledge-Mapping Sandbox & Baseline

Status: **completed** 2026-05-20

### Created
- `file-tracking.md` (this file)
- `failure-tracking.md`
- `eval/sandbox/generator.ts` — deterministic tiered corpus generator (6 tiers, ~332 items, 4 synthetic projects, mulberry32 PRNG)
- `eval/sandbox/prompts.ts` — golden prompt set (44 prompts × 7 task types, expectedSelected/forbidden/expectedNoiseFiltered/groundingFacts)
- `eval/sandbox/thresholds.json` — Phase 1 baseline thresholds (any regression fails CI)
- `eval/sandbox/report.md` — auto-generated Markdown report (produced by `pnpm run sandbox`)
- `scripts/sandbox.ts` — sandbox runner with `--ablate`, `--fail-under`, `--json`, `--seed`, `--report`, `--thresholds`
- `test/sandbox.test.ts` — 6 tests: corpus determinism, tier coverage, supersedes relations, prompt validity, task-type coverage, adversarial detection

### Modified
- `roadmap-claude.md` — Phase 1 status + baseline numbers + ablation findings + plan deviations
- `src/types.ts` — added `FusionContribution`, `FusionContributionStage`, `ScoreBreakdown`, `SuppressionReason`, `SuppressionEvent`, `FilterEventKind`, `FilterEvent`; extended `RetrievalDebugTrace` with `fusionBreakdown?`, `filterEvents?`, `suppressionEvents?`; added `ContextSearchInput.disabledSources?`
- `src/retrieval/fusion.ts` — added optional `{ collectBreakdown: true }` overload returning per-candidate per-source contributions
- `src/retrieval/service.ts` — threaded `disabledSources` through `rankCandidates`; wired debug builder to capture fusion breakdown, rerank scores, fit scores, suppression events, safety filter events; refactored `applyFeedbackSummary` and `applyIntentSuppression` to optionally emit `SuppressionEvent`
- `src/retrieval/debug.ts` — added `recordFusionBreakdown`, `recordRerankScores`, `recordFitScores`, `recordFilterEvent`, `recordSuppressionEvent`; trace now carries the new fields
- `src/security/knowledge-safety.ts` — added `SafetySanitizeOptions.onFilterEvent`; `sanitizeSearchCandidates`/`sanitizeContextPack`/`sanitizeSearchCandidate` emit `FilterEvent` for retrieval-time blocks and redactions
- `scripts/benchmark.ts` — added `SandboxBlock` and `runSandbox()`; composite score gains a 10% sandbox slice when available; report prints sandbox metrics block
- `package.json` — added `sandbox` and `sandbox:ablate` scripts
- `CLAUDE.md` — documented the new `pnpm run sandbox` and `pnpm run sandbox:ablate` commands

### Verification
- `pnpm run build` — green
- `pnpm test` — 135/135 green
- `pnpm run eval:retrieval` — 14/14 cases pass, all metrics at 100%
- `pnpm run eval:knowledge-completeness` — 100% pass rate
- `pnpm run eval:agent-context` — pass
- `pnpm run sandbox` — thresholds: PASS; report written to `eval/sandbox/report.md`
- `pnpm run sandbox:ablate` — 5 ablation rows printed (lexical, vector, metadata, memory, graph each disabled)

## Phase 2 — Noise-Filter Hardening

Status: **completed** 2026-05-21. All Phase 2 deliverables landed; 156/156 unit tests green; `pnpm run eval:retrieval`, `eval:knowledge-completeness`, `eval:agent-context`, and `pnpm run sandbox` all PASS.

### Created
- `src/retrieval/policy.ts` — `RetrievalPolicy` interface + `DEFAULT_POLICY` with knobs for freshness windows per `KnowledgeItemType`, source weights, hard-signal boost, task→itemType boosts, duplicate detector thresholds, PII redaction toggles, domain-mismatch magnitudes, per-source `suppressionEnabled` flags; `loadRetrievalPolicy`, `getRetrievalPolicy`, `setRetrievalPolicy`, `resetRetrievalPolicyCache`, `freshnessWindowFor` helpers.
- `src/ingest/duplicate-detector.ts` — 7-gram Jaccard + cosine duplicate detection; decisions are `allow`/`flag`/`block`/`reject`; respects `RetrievalPolicy.duplicateDetector === 'off'`; excludes incoming `sourceUri` from candidate pool so re-ingestion of the same source updates instead of being blocked.
- `config/retrieval-policy.json` — documented override surface; defaults to empty (DEFAULT_POLICY active).
- `test/duplicate-detector.test.ts` — 6 tests covering allow/block/reject paths, identical re-ingest, off-switch behaviour, and `assertNotDuplicate` throwing `DuplicateIngestionError`.
- `test/freshness-policy.test.ts` — 4 tests covering per-itemType windows, fallback to global window when `useFreshnessMap=false`, and `ContextFitEvaluator` differential treatment by itemType (code_ref current vs memory stale at the same age).
- `test/suppression-telemetry.test.ts` — 6 tests covering domain_mismatch suppression event emission with `confidence` + `evidence`, the `suppressionEnabled.domainMismatch=false` rollback path, the pluggable `SuspiciousContentClassifier` interface, and policy-gated PII redaction (active when `piiRedaction.emails=true`, dormant by default).
- `test/retrieval-policy.test.ts` — 4 tests covering DEFAULT_POLICY shape, per-itemType freshness completeness for all 8 itemTypes, JSON override merging via `TUBEROSA_RETRIEVAL_POLICY`, and graceful fallback when the override path is missing.

### Modified
- `src/types.ts` — `SuppressionEvent` gained a required `confidence: number` field (Phase 2.5 spec).
- `src/retrieval/service.ts` — `applyIntentSuppression` rewritten to emit explicit `SuppressionEvent`s with `reason`/`deltaScore`/`confidence`/`evidence` for each cause (superseded relations, stale freshness, candidate-side feedback, evidence mismatch, domain mismatch); honours `RetrievalPolicy.suppressionEnabled.*` toggles per reason; uses `policy.domainMismatch.{mismatchPenalty,matchBoost}` instead of hardcoded magnitudes; `applyFeedbackSummary` now emits `feedbackSuppressionConfidence` derived from negative-feedback counts; `isStaleCandidate` consults `freshnessWindowFor(policy, itemType)` instead of a global 365-day boundary; added `staleFreshnessConfidence` that scales with overshoot ratio past `staleDays`. Removed the old string-based `mapSuppressionReason` indirection.
- `src/retrieval/context-fit.ts` — already routed `freshnessAdjustment` through `freshnessWindowFor` in Phase 1; Phase 2 hooks the per-itemType windows everywhere (no behaviour change here; verified by the new freshness test).
- `src/security/knowledge-safety.ts` — added `SuspiciousContentClassifier` interface, `RegexSuspiciousContentClassifier` default implementation, `KnowledgeSafetyServiceOptions { classifier?, policyAccessor? }` constructor surface; PII patterns for emails/phones/IPv4 redact only when the corresponding `RetrievalPolicy.piiRedaction.*` flag is true; `scanAndRedactText` delegates classification to the pluggable classifier; `redactSecretPatterns` accepts extra patterns so PII patterns piggy-back on the existing redaction pipeline.
- `src/ingest/service.ts` — wires `DuplicateDetector` (constructed if not supplied) into `ingestKnowledge`; `applyDuplicateFlag` marks `metadata.duplicateCandidate` when the detector returns `flag`; rejection/block surface as `DuplicateIngestionError` from `assertNotDuplicate`.
- `eval/sandbox/thresholds.json` — Phase 2 tighter thresholds: `minHitRate` 0.7→0.85, `maxNoiseRate` 0.35→0.20, `minDuplicateSuppressionRate` 0.0→0.9, new `duplicate` filter precision floor 0.9.
- `test/retrieval.test.ts` — one assertion changed from exact `'freshness:stale'` match to a `startsWith('freshness:stale')` check so it accepts the new `freshness:stale:<itemType>` label format.

### Phase 2 sandbox vs Phase 1 baseline (`pnpm run sandbox`)
| metric | Phase 1 baseline | Phase 2 |
| --- | --- | --- |
| hit rate | 86.4% | **93.2%** |
| MRR | 0.4974 | 0.4618 |
| noise rate | 22.7% | **9.1%** |
| stale suppression | 100% | 100% |
| duplicate suppression | 0% | **100%** |
| adversarial block rate | 100% | 100% |
| memory itemType catch-all rate | 43% | 38.6% (Phase 3 target) |
| latency p50 / p95 | ~25ms / ~50ms | ~14ms / ~21ms |

### Verification
- `pnpm run build` — green
- `pnpm test` — 156/156 green (was 135 in Phase 1; +21 from new tests)
- `pnpm run eval:retrieval` — 14/14 cases pass, all metrics at 100%
- `pnpm run eval:knowledge-completeness` — 100% pass rate, 0% noise
- `pnpm run eval:agent-context` — pass
- `pnpm run sandbox` — thresholds: PASS
- `pnpm run sandbox:ablate` — ablation runs show per-source MRR deltas consistent with Phase 1 findings

### Rollback boundary
- `RetrievalPolicy.useFreshnessMap=false` reverts to a single global 180/365-day window.
- `RetrievalPolicy.duplicateDetector='off'` disables ingestion-time dedup (returns `allow` for everything).
- `RetrievalPolicy.suppressionEnabled.<reason>=false` disables that specific suppression event (no penalty applied, no event emitted).
- `RetrievalPolicy.piiRedaction.*=false` (the default) keeps email/phone/IP through unchanged.

## Phase 3 — Categorization & Labeling Upgrade

Status: **completed** 2026-05-21. All six deliverables landed; 181/181 unit tests green; `pnpm run eval:retrieval` / `eval:agent-context` / `eval:knowledge-completeness` / `pnpm run sandbox` / `pnpm run sandbox:ablate` all PASS.

### Created
- `src/relations/ontology.ts` — hierarchical taxonomies for `technology`, `business_area`, and `domain` axes; `expandOntologyValue`, `expandLabelsThroughOntology`, `isOntologyMatch`, `ontologyAxisFromLabelType` helpers; ancestor expansion returns closest-first ordering so callers can attenuate by index.
- `src/ingest/item-type-inference.ts` — `inferItemType(content, metadata, references, hint)` decides `bugfix` / `workflow` / `rule` / `spec` / `code_ref` / `conversation` / `memory`. Rules in priority order: error-recovery trigger or `error_log` origin → bugfix; `tests/*` references → workflow (or bugfix on root-cause keywords); rule/policy/decision heading or normative MUST/SHALL → rule; workflow heading → workflow; spec heading or `specs/`/`requirements/` path → spec; ≥40% code-fence ratio with code refs → code_ref; conversation heading → conversation; non-memory hint → hint; otherwise memory.
- `src/ingest/label-enricher.ts` — `LabelEnricher` interface; `HeuristicLabelEnricher` (default) classifies title+summary+content and tags labels with `provenance.source='classifier'`; `LlmLabelEnricher` is gated by `TUBEROSA_LLM_LABELS=true` and is wired but inert until a real provider is plugged in; `mergeLabels` keeps the highest-confidence provenance per (type,value) key.
- `src/relations/ast-extractor.ts` — TypeScript compiler-API extractor for `.ts/.tsx/.js/.mjs/.cjs` sources; returns `{exportedSymbols, calls}`; `relationsFromAst` converts them into `mentions_symbol` (exports) and `depends_on` (call expressions) relations; parse failures swallow back to empty. Stop-word list filters `console`, `setTimeout`, etc.
- `test/ontology.test.ts` — 9 tests covering axis lookup, ancestor resolution, ordering, enabled-flag rollback, non-ontology pass-through, and `isOntologyMatch` directional checks.
- `test/item-type-inference.test.ts` — 10 tests covering bugfix triggers, test-reference branching, rule headings/MUST language, workflow headings, spec headings, code-fence + code refs, conversation headings, hint fallback, and the memory catch-all.
- `test/ast-extractor.test.ts` — 7 tests covering supported extensions, exported declarations (function/class/interface/type/enum/var), call expressions + stop-word filtering, parse-error tolerance, relations conversion, and `pickAstSourceFromReferences`.

### Modified
- `src/types.ts` — added `LabelProvenanceSource` union (`prompt | classifier | ontology | reviewer | llm | ast | heuristic`), `LabelProvenance { source, confidence }`, optional `LabelInput.provenance`.
- `src/retrieval/policy.ts` — extended `RetrievalPolicy` with `useOntology`, `useItemTypeInference`, `useAstExtractor` (all default true). `mergePolicy` preserves them across JSON overrides.
- `src/retrieval/fusion.ts` — task-type boost scales by `labelConfidenceMultiplier(candidate, classified)` so high-confidence task_type labels amplify the bonus and low-confidence labels attenuate it.
- `src/retrieval/classifier.ts` — `hasDomainMismatch` now uses `isOntologyMatch('domain', label, classified.domain)` so an ancestor-tagged domain label still counts as a match (no false-positive mismatch when the candidate is tagged with a more general domain).
- `src/relations/inference.ts` — `KnowledgeRelationInference.infer` merges the AST-extracted relations from `extractAstSymbols` for supported file types; failures fall back to the original regex inference; gated by `RetrievalPolicy.useAstExtractor`.
- `src/ingest/service.ts` — `IngestionService` now runs `inferItemType` (only when the caller passed the catch-all `memory` type, so explicit non-memory itemTypes are trusted), runs the `LabelEnricher` chain (restricted to *axis* labels — technology/business_area/domain/task_type/project — so caller-curated file/symbol/error labels still dominate), and expands ontology ancestors before storage.
- `src/reflection/service.ts` — `createDraft` calls `inferItemType` to fill the itemType when the caller didn't provide one (preserves `'memory'` catch-all behaviour for callers who explicitly request it).
- `scripts/sandbox.ts` — added `itemTypeDiagonalRate`, `itemTypeConfusion`, `labelDiagonalRate`, `labelConfusion` to `SandboxRunMetrics`; threshold gates `minItemTypeDiagonalRate` and `minLabelDiagonalRate`; report and CLI summary print both diagonal rates.
- `eval/sandbox/thresholds.json` — tightened Phase 3 baselines: `minHitRate` 0.85→0.9, `minMRR` 0.4→0.45, added `minItemTypeDiagonalRate=0.6` and `minLabelDiagonalRate=0.05`.

### Phase 3 sandbox vs Phase 2 baseline (`pnpm run sandbox`)
| metric | Phase 2 | Phase 3 |
| --- | --- | --- |
| hit rate | 93.2% | **95.5%** |
| MRR | 0.4618 | **0.4878** |
| noise rate | 9.1% | 9.1% |
| stale suppression | 100% | 100% |
| duplicate suppression | 100% | 100% |
| adversarial block rate | 100% | 100% |
| memory itemType catch-all rate | 38.6% | 39.4% (Phase 3 target <25% not achievable on the current corpus shape — see roadmap deviation) |
| itemType diagonal rate (new) | — | 68.3% |
| label diagonal rate (new) | — | 8.0% |
| latency p50 / p95 | ~14ms / ~21ms | ~16ms / ~28ms |

### Verification
- `pnpm run build` — green
- `pnpm test` — 181/181 green (Phase 2: 156; +25 from new tests across ontology, item-type-inference, ast-extractor)
- `pnpm run eval:retrieval` — 14/14 cases pass, all metrics at 100%
- `pnpm run eval:knowledge-completeness` — 100% pass rate, 0% noise
- `pnpm run eval:agent-context` — pass
- `pnpm run sandbox` — thresholds: PASS with new `minItemTypeDiagonalRate` and `minLabelDiagonalRate` floors

### Rollback boundary
- `RetrievalPolicy.useOntology=false` skips ancestor tagging at ingest + ontology-aware domain match at retrieval.
- `RetrievalPolicy.useItemTypeInference=false` keeps the caller's itemType verbatim.
- `RetrievalPolicy.useAstExtractor=false` (and try/catch around the parser) reverts to the regex-based inference.
- `TUBEROSA_LLM_LABELS=true` is the only switch that enables the LLM enricher; it ships inert.

## Phase 4 — Matching Engine (Local Cross-Encoder + Calibrated Fusion)
Status: not started

## Phase 5 — One-Command Install & Local-First Polish
Status: not started
