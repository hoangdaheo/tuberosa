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
Status: not started

## Phase 3 — Categorization & Labeling Upgrade
Status: not started

## Phase 4 — Matching Engine (Local Cross-Encoder + Calibrated Fusion)
Status: not started

## Phase 5 — One-Command Install & Local-First Polish
Status: not started
