# Tuberosa Handoff — Claude Session

Date: 2026-05-18

## Goal We Are Working Toward

Tuberosa is a local-first context broker and learning layer for AI agents. A normal user prompts their agent naturally; the agent asks Tuberosa for project context, records whether the context was useful or wrong, and Tuberosa learns durable lessons from the session automatically.

The active direction is **Phase 9: Retrieval Quality Hardening** from `docs/AGENT_CONTEXT_ROADMAP.md`. The focus this session was implementing hard retrieval eval cases — specifically superseded-workflow demotion and freshness-based conflict resolution — and fixing the graph evidence bypass that caused superseded items to leak through the anchored score filter.

---

## Current State Of The Code

### Completed In Previous Sessions

- Structured retrieval intent (`classified.intent` with task goal, workflow stage, required evidence types, etc.)
- Continuation anchors for `handoff.md` and `docs/AGENT_CONTEXT_ROADMAP.md`
- Intent-aware stale suppression: demotes stale-freshness items, prior feedback, superseded items, and evidence-type mismatches
- Conflict detection records (`knowledge_conflicts` table), listable/reviewable via operations API
- Automatic session learning in `AgentSessionService.finishSession` with strict auto-approval gates
- Reviewable negative-feedback proposals (`learning_proposals`) and knowledge gaps (`knowledge_gaps`)
- Operations API: `GET/PATCH /operations/knowledge-gaps`, `GET/PATCH /operations/learning-proposals`
- Auto-memory cleanup filters (`review=auto_memory`, `review=risky_auto_memory`)
- Backup support for both review tables

### Completed In This Session

1. **Eval fixture relations support**
   - `KnowledgeRelationCreator` interface and `RetrievalEvalRelation` type added to `src/evaluation/retrieval-evaluator.ts`
   - `RetrievalEvalFixture.relations?: RetrievalEvalRelation[]` field added
   - `seedRelations()` private method seeds relations (using eval ID → store ID index) before running cases
   - `src/evaluation/fixture-loader.ts` parses and validates the `relations` array via `parseRelation()`
   - `scripts/eval-retrieval.ts` and `test/evaluation.test.ts` now pass `store` as the 4th `RetrievalEvaluator` constructor argument

2. **Two new hard retrieval eval cases** in `eval/retrieval-fixtures.json`
   - `superseded-workflow-demoted`: anchored by `files=["docs/deployment/runbook.md"]`, expects `current-deploy-runbook` in top-K and forbids `legacy-deploy-runbook`; backed by a `supersedes` relation + stale freshness
   - `conflicting-memories-freshness`: anchored by `files=["docs/api/rate-limit.md"]`, expects `current-rate-limit-policy` and forbids `legacy-rate-limit-policy`; backed by a `supersedes` relation + stale freshness + low trust

3. **Bug fix: `isGraphEvidence` threshold bypass for superseded graph candidates**
   - File: `src/retrieval/context-pack.ts`
   - Root cause: the `supersedes` relation from current→legacy creates a `seed_outbound` graph path to legacy, giving it `rawScore = 0.68 × confidence ≥ 0.45`. The old `isGraphEvidence` bypassed the `filterAcceptedCandidates` anchored score threshold (0.6) entirely for any graph candidate meeting the rawScore minimum.
   - Fix: `isGraphEvidence` now also checks `!candidate.matchReasons.some(r => r.startsWith('suppression:superseded:'))`. If the candidate was suppressed due to supersession (by `applyIntentSuppression`), it does NOT bypass the threshold.
   - This preserves the original graph evidence boost for fresh, non-superseded graph items while correctly applying the 0.6 anchored threshold to superseded ones.

4. **Fixture extended** with 4 knowledge items and 2 `supersedes` relations in `eval/retrieval-fixtures.json`

---

## Files Actively Edited

| File | Change |
|---|---|
| `src/evaluation/retrieval-evaluator.ts` | `KnowledgeRelationCreator` interface, `RetrievalEvalRelation` type, `relations` on fixture, `seedRelations()`, 4th constructor param |
| `src/evaluation/fixture-loader.ts` | `parseRelation()`, `relations` array in `parseRetrievalEvalFixture` |
| `src/retrieval/context-pack.ts` | `isGraphEvidence` — excludes candidates with `suppression:superseded:*` in matchReasons |
| `eval/retrieval-fixtures.json` | 4 new knowledge items, 2 `supersedes` relations, 2 new eval cases |
| `scripts/eval-retrieval.ts` | Pass `store` as 4th arg to `RetrievalEvaluator` |
| `test/evaluation.test.ts` | Pass `store` as 4th arg to `RetrievalEvaluator` |
| `docs/AGENT_CONTEXT_ROADMAP.md` | Phase 9 supersession/eval items marked Started |
| `handoff.md` | Updated to reflect current session state |

---

## Everything Tried That Failed Or Needed Correction

### First fix attempt: exclude `supersedes` from `seed_outbound` in the stores

- Changed `memory-store.ts` to skip `relation.relationType !== 'supersedes'` in the graph traversal `seed_outbound` branch.
- Changed `postgres-store.ts` to add `AND kr.relation_type <> 'supersedes'` to the SQL.
- **Result:** broke the existing test `intent suppression demotes superseded workflows` (retrieval.test.ts line 1222). That test creates a 2-item store with no anchors, and it relies on the legacy item appearing via `seed_outbound` graph traversal (which is then suppressed but still visible in the result). Without the graph traversal, the legacy item still appeared via vector/lexical search but the threshold math was unreliable at scale.
- **Reverted both store changes.** The correct fix was in `context-pack.ts`, not in the stores.

### Scoring analysis that informed the fix

- Max pre-suppression `rerankScore` for `legacy-deploy-runbook` (trust=80): `0.62 + 0.28 + 0.08 = 0.98`
- Suppression applied: `-0.252` (superseded, confidence=0.9) + `-0.14` (stale freshness >365d) = `-0.392`
- Max post-suppression: `0.98 - 0.392 = 0.588 < 0.6` (anchored threshold)
- So a purely semantic path would filter it — but the `isGraphEvidence` bypass let it through regardless.

---

## Verified Working

All checks pass as of this session:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test                  # 70/70 pass
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration  # 3/3 pass
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval    # 9/9 cases, 100% all metrics
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
git diff --check
```

---

## Audit Plan For Previous Changes

Before extending or merging this work, audit in this order:

### 1. `isGraphEvidence` fix audit (`src/retrieval/context-pack.ts`)

- Confirm superseded graph candidates are filtered in anchored queries (files/symbols/errors present): `superseded-workflow-demoted` and `conflicting-memories-freshness` eval cases cover this.
- Confirm non-superseded graph candidates still bypass the threshold as before: the existing graph-relation tests in `test/retrieval.test.ts` cover this.
- Confirm the fix does NOT affect candidates that are stale-only (no supersedes): stale suppression uses reason `suppression:freshness:stale`, not `suppression:superseded:*`.
- Confirm the fix does NOT affect candidates suppressed by prior feedback: those use `suppression:prior feedback:stale/rejected/irrelevant`.
- Run `pnpm run eval:retrieval` and confirm `unexpected avoidance = 100%`.

### 2. Eval fixture relations audit (`src/evaluation/retrieval-evaluator.ts`, `src/evaluation/fixture-loader.ts`)

- Confirm `seedRelations` runs after `seedFeedback` and before case evaluation.
- Confirm that if `relations` is absent from the fixture, no error is thrown and no relation creator is required.
- Confirm that if `relations` is present but no relation creator is configured, a clear error is thrown.
- Confirm that eval IDs not found in the index throw a descriptive error.
- Confirm the `confidence` default of `0.8` when not specified in the fixture.

### 3. Fixture content audit (`eval/retrieval-fixtures.json`)

- Confirm `current-deploy-runbook` and `legacy-deploy-runbook` have different `sourceUri` values (different file labels): current=`docs/deployment/runbook.md`, legacy=`docs/deployment/legacy-runbook.md`. This ensures the query signal `docs/deployment/runbook.md` does NOT appear in legacy's candidate text, which is what makes `hasHardSignalEvidence` return false for legacy.
- Confirm same pattern for rate-limit items.
- Confirm that `relations` confidence values (0.9) produce suppression of `-Math.min(0.28, 0.18 + 0.9×0.08) = -0.252`.
- Confirm all 9 cases pass with `pnpm run eval:retrieval`.

### 4. Operations API audit (`src/operations/service.ts`, `test/operations.test.ts`)

- Confirm `runProposalApprovalAction` handles `supersedes`, `auto_memory_cleanup`, `missing_label`, `missing_reference` proposal types.
- Confirm the idempotency guard (`metadata.approvalAction`) prevents double-application.
- Confirm `GET /operations/learning-proposals` and `GET /operations/knowledge-gaps` return records created from negative feedback.
- Run `node --test --import tsx test/operations.test.ts`.

### 5. Full regression audit

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
git diff --check
```

---

## Improved Plan — Next Steps

From `docs/AGENT_CONTEXT_ROADMAP.md` Phase 9 remaining work, in priority order:

### Step 1: Proposal approval actions (highest value, roadmap priority)

Current state: `learning_proposals` are created, reviewable, and can be status-updated (`approved`, `dismissed`, `needs_changes`). But approval is review-only — it does not apply any mutation.

Next:
- `PATCH /operations/learning-proposals/:id` with `{ decision: "approved" }` should execute the concrete action depending on `proposalType`:
  - `supersedes` → call `store.createKnowledgeRelation({ relationType: 'supersedes', ... })` using the proposal's `affectedKnowledgeIds`
  - `missing_label` → call `store.patchKnowledge(id, { labels: [...existing, newLabel] })`
  - `missing_reference` → same pattern for references
  - `auto_memory_cleanup` → call `store.patchKnowledge(id, { status: 'needs_review' })` or set `metadata.archived = true`
- Guard with `metadata.approvalAction` idempotency key.
- Add a test in `test/operations.test.ts` covering each mutation type.
- Keep default behavior review-only: `approved` status alone does not mutate until an explicit action handler runs.

### Step 2: Auto-memory cleanup actions

- Currently `auto_memory_cleanup` proposals are created when auto-approved session memory gets stale/rejected/irrelevant feedback.
- On approval: mark the affected knowledge as `needs_review`, or set `metadata.archived = true` and exclude it from retrieval (`filterAcceptedCandidates` already skips `status !== 'approved'`).
- Add test coverage for the full round-trip: auto-approve → negative feedback → proposal created → proposal approved → knowledge excluded.

### Step 3: Missing-context and graph-expanded eval fixtures

Two eval cases still unimplemented from the roadmap:

**Case A: missing-context gap creation**
- Seed knowledge that does NOT cover a specific file/symbol.
- Query with that file/symbol.
- Record `missing_context` feedback.
- Assert that a `knowledge_gaps` record was created with the right project, prompt, and missing signals.
- This requires a fixture that tests the feedback flow, not just retrieval quality; it may need a separate eval harness or an extended `feedbackEvents` fixture model.

**Case B: graph-expanded retrieval beats stale semantic**
- Ingest a current item with graph relations pointing to the query target.
- Ingest a stale item with high semantic similarity to the query but no graph link.
- Assert the graph-related current item ranks above the stale semantic match.
- This is the "graph beats stale" hard case — currently partially covered by `stale-semantic-memory` but only for freshness, not graph expansion.

### Step 4: Context-pack explanations (agent UX)

Roadmap item: tell agents WHY each item was included and what evidence is missing.

- Add a `reasons` or `explanation` field per section item in the MCP `tuberosa_get_context_pack` output.
- Surface suppression reasons, match reasons, and graph paths clearly.
- Make `deepContextReturned` vs `deepContextAvailable` explicit in normal output.
- Ensure `fitMissingSignals` is always surfaced to agents when `fitStatus !== 'ready'`.

### Step 5: Provider-backed reranking

Roadmap item: prompts that prefer evidence coverage over generic similarity.

- Add an `OpenAiRerankProvider` that sends a prompt like "Rank these by evidence coverage for: {task}".
- Gate behind `modelProvider === 'openai'` config flag.
- Hash-mode tests stay deterministic (no change needed).
- Add eval fixture for provider-reranked cases (mock the provider response).

### Step 6: Retrieval fallback policy

Roadmap item: exact anchored search first → relation expansion → provider rewrite/rerank → clarification.

- Currently this is partially implemented: anchored queries use threshold 0.6, non-anchored use 0.35.
- Add explicit fallback tiers in `searchContext`: if anchored pack has no essential items, retry with graph expansion only.
- If graph expansion also fails, emit a `fitStatus: 'insufficient'` pack with a clear `missingSignals` list.
- The agent should use `missingSignals` to ask the user for clarification, not silently use weak context.

---

## Notes For The Next Agent

- `handoff.md` is the Phase 9 continuation anchor — always read it first.
- `isGraphEvidence` in `context-pack.ts` is the correct fix for the superseded graph bypass. Do not move this logic back into the stores.
- Do not treat the v1 roadmap as a creative ceiling. Use it as baseline context, then plan the next Tuberosa product increment around user value.
- The eval fixture `relations` mechanism (`seedRelations`, `KnowledgeRelationCreator`) is the right pattern for all future relation-dependent eval cases.
- Prefer `unexpectedKnowledgeIds` (natural suppression test) over `rejectedKnowledgeIds` (pre-filter test) when the goal is to verify that the retrieval pipeline itself demotes an item.
