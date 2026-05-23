# Tuberosa Improvement Roadmap (from agent-trial harness analysis)

Drafted 2026-05-23 alongside `eval/agent-trials/`. This document lists what the trial harness has already surfaced from a static read of the code, plus the improvement work it justifies. Every item cites the file and line that motivates it.

The order is by impact, not by ease.

---

## P0 — Correctness bugs blocking the harness today

### P0.1 Worktree-synthetic-ID leaks into Postgres uuid casts

**Symptom**: `tuberosa_search_context` (and `tuberosa_start_session`) fail with `MCP error -32603: invalid input syntax for type uuid: "worktree:<sha>"` whenever the trial harness or any agent invokes them from a cwd that triggers a worktree candidate.

**Where**: `src/retrieval/worktree.ts:168` mints `knowledgeId = "worktree:" + sha256(file.rel)` (intentional — synthetic, never persisted). Two pg paths already filter these correctly (`src/storage/postgres-store.ts:386` for `listKnowledgeRelations`, `:1139` for `recordFeedback`), but at least one path — likely `createContextQuery`, `createKnowledgeGap`, `createLearningProposal`, or `recordAgentContextDecision` — is missing the same `isPersistedKnowledgeId`/`filterPersistedKnowledgeIds` guard.

**Fix**:
1. Add a single chokepoint: a wrapper around every `pool.query(... $N::uuid ...)` call that asserts (or filters) the parameter is a real UUID, with `worktree:` and any future synthetic-id prefix on a deny-list.
2. Or, more durable: introduce a `KnowledgeId` opaque type with `PersistedKnowledgeId` and `SyntheticKnowledgeId` branches. The Postgres store accepts only the former; the worktree provider returns the latter; fusion/context-pack carry both but boundary code coerces or drops.

**Fixture**: add a fixture case that explicitly seeds a worktree candidate and verifies `tuberosa_search_context` returns 200, not a UUID error.

---

### P0.2 MCP error path leaks raw SQL messages to clients

**Symptom**: The above bug returns the Postgres driver's verbatim error string. That's a defense-in-depth issue (SQL implementation detail leak) and an agent-UX issue (the agent can't categorize the failure to recover).

**Where**: `src/mcp/server.ts` `maybeCaptureMcpError` + the JSON-RPC error wrap.

**Fix**: Map storage errors to a small set of typed MCP error codes (`storage_unavailable`, `invalid_input`, `safety_blocked`, `internal_error`) and log the raw message only to the error log, not to the client.

---

## P1 — Grounding & hallucination resistance

### P1.1 Per-claim provenance in pack items (replace freeform matchReasons)

**Why**: The trial debater can't reliably attribute a hallucination to a pack item because `RankedCandidate.matchReasons` is freeform strings ("file:X", "memory match"). The child worker is supposed to cite `pack:<itemId>` for every fact — but it has no way to cite *which sentence* of the item, and the mother can't verify the citation against the source.

**Where**: `src/retrieval/fusion.ts:180-229` (`matchReasons`), and the `RankedCandidate` shape in `src/types.ts`.

**Fix**: Add `claims: Array<{ id: string; text: string; sourceUri: string; line?: number; supportType: 'exact' | 'paraphrase' | 'inference' }>` to each pack item, derived during chunking/atomization (atomizer already splits by heading — extend it to also extract one-sentence claims with their line numbers). Match reasons stay as a compact summary; `claims` are what citers can point at.

**Fixture**: extend `eval/retrieval-fixtures.json` to assert that every essential item exposes at least one `claim` with a verifiable `sourceUri+line`.

---

### P1.2 Confidence interval, not point estimate

**Why**: `confidence = topScore * 0.56 + classifier.confidence * 0.16 + density * 0.08 + fitScore * 0.2` (capped 0.99) at `src/retrieval/context-pack.ts:78`. Agents downstream treat 0.83 vs 0.71 as meaningfully different, but the formula's component variance isn't surfaced.

**Where**: `assembleContextPack` in `src/retrieval/context-pack.ts`.

**Fix**: Compute `confidenceLow / confidenceHigh` by varying inputs ±1 σ (e.g., assume rerank scores have 0.05 noise, fit scores 0.07) and report the band. Agents that see `confidence: 0.72 ± 0.18` will know to confirm; agents seeing `0.72 ± 0.03` will proceed.

**Fixture**: an eval case where the same prompt is run twice with different rejection sets; the interval should shrink as evidence stabilizes.

---

### P1.3 Retrieval-time contradiction detection (cross-candidate)

**Why**: `KnowledgeStore.detectConflicts` is offline and review-only. At retrieval time an agent can receive both a stale memory and a current wiki in `essential` with no warning. Case 02 (`02-stale-memory-debate.md`) targets exactly this.

**Where**: After `fuseCandidates` and before `ContextFitEvaluator.evaluate` in `src/retrieval/service.ts`. The conflict-detection logic already exists; lift it into a pass that runs on the top-12 candidates.

**Fix**:
1. Add `ContextFit.contradictions: Array<{ left: knowledgeId; right: knowledgeId; field: 'summary'|'reference'|'behavior'; explanation: string }>`.
2. When contradictions are found among `essential` candidates, downgrade `fitStatus` to `needs_confirmation` and add a `taskBrief.warning: "pack contains conflicting items: see contextFit.contradictions"`.
3. Optionally suppress one side automatically if its trust level or freshness is much lower — but keep both visible.

**Fixture**: seed two contradictory items in the eval fixture and assert `contextFit.contradictions.length === 1` and `fitStatus === 'needs_confirmation'`.

---

### P1.4 Evidence cards on each candidate

**Why**: Mother judges grade "did fusion rank the right item top?" but the *reason* isn't easy to read out. `RankedCandidate.fitReasons` and `matchReasons` are scattered.

**Where**: Same place as P1.1; merge match reasons + fit reasons + suppression reasons into a single typed `EvidenceCard` per candidate.

**Fix**: `evidence: { directHits: { files, symbols, errors }; signals: { freshness, trust, feedback, graph }; suppressions: [...]; supportType: 'strong'|'moderate'|'weak'; humanSummary: string }`. The human summary is what `taskBrief` already calls `usefulnessReason`; standardize the structure.

---

## P2 — Feedback loop quality

### P2.1 Outcome-based feedback type

**Why**: Today's 11 feedback types (`src/types.ts`, `FEEDBACK_TYPES`) measure *selection* (selected, rejected, stale, noisy, missing) but not *outcome*. The trial harness produces a strong signal — "child succeeded / partially / failed" — that has nowhere to go.

**Where**: Extend `FEEDBACK_TYPES` and `recordFeedbackLearning` in `src/retrieval/service.ts:295`.

**Fix**: Add `solved_with_pack`, `solved_despite_pack`, `failed_with_pack`. The first boosts the pack's items in future ranking (stronger than `selected`); the second is neutral with a note; the third triggers a learning proposal of type `outcome_failure_review`.

---

### P2.2 Negative-example fixtures (`mustNotInfluence`)

**Why**: Every fixture lists `expectedKnowledgeIds`. Add `mustNotInfluenceKnowledgeIds` — items that, if they appear in any section of the pack, fail the case. This catches noise-leak regressions in policy changes.

**Where**: `eval/retrieval-fixtures.json` schema + `src/evaluation/retrieval-evaluator.ts:65-82`.

**Fix**: Add the field to `RetrievalEvalCase` and grade as a hard fail if a `mustNotInfluence` id appears anywhere in `sections.*.items`.

---

### P2.3 Debate-agent feedback channel

**Why**: When the debater finds an inter-pack contradiction, that finding should persist as a `knowledge_conflict` for review — not just live in the report file.

**Where**: `tuberosa_feedback_context` in `src/mcp/server.ts:200` + `recordFeedback` in `src/retrieval/service.ts:282`.

**Fix**: Accept an optional `contradictionMap: Array<{ leftId, rightId, claim_left, claim_right, actual_truth }>` on the feedback input and forward it into `createKnowledgeConflict`. Keep the existing single-id `rejectedKnowledgeIds` path.

---

## P3 — Use Tuberosa effectively (configuration & defaults)

### P3.1 Task-adaptive `deepContextBudget`

**Why**: `TUBEROSA_DEEP_CONTEXT_BUDGET` defaults to 60000 tokens. For a refactor or single-file debug task that's wasteful; for an architecture-exploration task it's tight. Children currently can't reason about whether `deepContext` is worth reading.

**Where**: `src/retrieval/context-pack.ts` `DEFAULT_DEEP_CONTEXT_BUDGET = 60_000`.

**Fix**: Per-task-type defaults (e.g., `refactor: 15k`, `debugging: 30k`, `implementation: 30k`, `exploration: 60k`, `planning: 45k`). Override by env var still works.

---

### P3.2 Explicit pack-acceptance step

**Why**: Phase 10 introduced `tuberosa_record_context_decision` precisely to make agents acknowledge the pack. But many agents skip it because nothing forces them to. The trial harness child worker is the right pattern: it *must* report per-item utility before its solution counts.

**Where**: Update `tuberosa_start_session` response semantics in `src/mcp/server.ts:297` so the returned `policy` is `must_record_decision_before_finish` whenever `contextFit.fitStatus !== 'ready'`. Then `tuberosa_finish_session` rejects the outcome if no decision was recorded in that case.

**Fix**: Strict mode in agent-session compliance. Today `sessionCompliance` is recorded as metadata but not enforced. Make `finish_session` fail (with a clear instruction) if compliance is missing for a non-ready pack.

---

### P3.3 Configurable "evidence-first" mode for review/planning tasks

**Why**: `assembleContextPack` orders `directTaskEvidence > priorLessons > workflow > adjacent`, which is right for implementation/debugging. For review and planning tasks, the right order is often inverted — workflow/spec items first, code refs second.

**Where**: `prioritizeUsefulCandidates` in `src/retrieval/context-pack.ts`.

**Fix**: Per-task-type evidence ordering. Use the existing `taskType` to switch the ordering tuple. Surface as `policy.contextOrdering[taskType]`.

---

## P4 — Product surfaces (mid-term)

### P4.1 Bake the agent-trial harness into Tuberosa as a first-class operation

**Why**: The whole framework lives outside Tuberosa today (in `eval/agent-trials/`). Promote it to `tuberosa_run_trial` and `tuberosa_collect_trial_findings` so any user can run it from MCP.

**Where**: New `src/operations/agent-trial-service.ts` + MCP tool registrations.

**Fix**: An end-to-end CLI/MCP tool that takes a case file, runs pack→child→debater→mother, persists artifacts to the store, and feeds findings into existing review queues. Trials become a measurable layer alongside `eval:retrieval`.

---

### P4.2 Score-component visibility in the workbench UI

**Why**: Mother judges find a recurring root cause: "fusion ranked X too low because hardSignalBoost didn't apply." But there's no UI that shows *why* a candidate landed at rank 5 instead of rank 1.

**Where**: `src/workbench/` views.

**Fix**: Per-candidate inspector that shows `ScoreBreakdown.contributions` (each source's `sourceWeight × 1/(k+rank)` term), feedback deltas, suppression deltas, and the final score formula. Today this is captured in `debug.recordScoreBreakdown` but not rendered.

---

### P4.3 Standing "contradiction watch" review queue

**Why**: Inter-pack contradictions detected by P1.3 deserve a review surface, same as `knowledge_gaps` and `learning_proposals`.

**Where**: `src/operations/service.ts` + workbench.

**Fix**: New `contradiction_watch` queue. Each entry pairs two knowledge ids, the disagreeing claims, the contexts they showed up in, and a reviewer action (resolve, supersede, dismiss).

---

## How to use Tuberosa more effectively today (no code changes needed)

Even before any of the above ships, agents using Tuberosa today can improve their hit rate by following this discipline:

1. **Always start with `tuberosa_start_session`** when the task is non-trivial. The session pack carries `policy` and `taskBrief` that bare `tuberosa_search_context` does not.
2. **Inspect `contextFit.fitStatus` before reading items**. If `insufficient`, the right move is a clarifying question, not reading optional items.
3. **Use `noiseTolerance: "strict"`** for refactor/review/answer tasks. Reserve `balanced` for exploration/planning.
4. **Cap `tokenBudget`** to the work surface (1500–2500 for refactor, 3000–5000 for debug, 6000+ only when you genuinely need wide context).
5. **Record decisions**. `tuberosa_record_context_decision` with `selected_but_noisy` or `too_much_adjacent_context` is the only way Tuberosa learns what's actually useful per project.
6. **Finish sessions**. Auto-learning only fires on `tuberosa_finish_session` — without it, lessons evaporate.
7. **Verify before reflecting**. The reflection write-gate is deterministic, but a noisy `reflectionDraft` still wastes review time. Reflect only when the lesson is concrete and grounded in real diffs or commits.
8. **Use `bypassCache: true` only when debugging retrieval**. Cache hits are correct; they're not the source of stale context.

---

## Eval-coverage checklist (what fixtures are missing)

The mother judge proposes new fixtures across the cases above. Consolidated list:

- [ ] Worktree synthetic-ID propagation (P0.1)
- [ ] Per-claim citation in every essential item (P1.1)
- [ ] Confidence interval shrinks with evidence (P1.2)
- [ ] Retrieval-time contradiction surfaces in `contextFit.contradictions` (P1.3)
- [ ] `solved_with_pack` feedback raises future ranking of those items (P2.1)
- [ ] `mustNotInfluenceKnowledgeIds` enforced (P2.2)
- [ ] Refactor task's optional section ≤ 2 items in strict mode (matches `03-noisy-optional-section.md`)
- [ ] Stale memory suppressed or flagged when current wiki disagrees (matches `02-stale-memory-debate.md`)
- [ ] Debugging task ranks bugfix memory above generic wiki (matches `01-classifier-edge-case.md`)
