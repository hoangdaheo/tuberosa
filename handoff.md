# Tuberosa Handoff

Date: 2026-05-19

## Goal We Are Working Toward

Tuberosa is a local-first context broker and learning layer for AI agents. The goal is that a normal user can prompt an AI agent naturally, the agent can ask Tuberosa for the right project context, record whether the context was useful or wrong, and let Tuberosa learn durable lessons from the session without the user memorizing special query or reflection prompts.

The active direction remains Phase 9 Retrieval Quality Hardening from `docs/AGENT_CONTEXT_ROADMAP.md`.

- Agents should enrich vague prompts with project, cwd, files, symbols, errors, recent selected sessions, and handoff or roadmap context.
- `tuberosa_finish_session` should be able to extract useful learning from the conversation and session evidence.
- Auto-approved memory must be strict, grounded, safe, deduplicated, and reviewable.
- Bad or weak auto-memory must be easy for agents to find, filter, and clean up.
- Missing-context and negative-feedback learning are still in progress.

## Current State Of The Code

Implemented in previous sessions (see previous handoff for full history):

- Automatic session learning wired into `AgentSessionService.finishSession`.
- Reviewable negative-feedback learning records (proposals and gaps) via `RetrievalService`.
- Operations API for `GET/PATCH /operations/knowledge-gaps` and `GET/PATCH /operations/learning-proposals`.
- Auto-memory cleanup and review filters.
- Storage/backup support for review tables (`knowledge_gaps`, `learning_proposals`).

Implemented in this session:

- **Learning proposal approval hardening.**
  - `OperationsService.updateLearningProposal()` now strips client-supplied `metadata.approvalAction` on approval, so callers cannot fake the server-owned idempotency marker and bypass the concrete approval mutation.
  - Approval action failures now propagate instead of being saved as `{ action: "error" }` in `approvalAction`; this keeps failed approvals retryable.
  - `supersedes` approval now reuses an existing candidate→affected `supersedes` relation when retrying, preventing duplicate relation edges after partial failures.
  - Knowledge status updates now throw a clear error if the affected knowledge id no longer exists.
  - `test/operations.test.ts` covers client metadata bypass attempts and retry after a simulated approval failure.

- **MCP finish-session schema hardening.**
  - The previous session log showed two failed `tuberosa_finish_session` calls caused by malformed arguments: a reflection draft without `triggerType`, then a free-form `outcome` string instead of the required enum.
  - Runtime validation was correct, but the MCP `tools/list` schema was too loose (`outcome` was just `string`, and nested `reflectionDraft` was unconstrained).
  - `src/mcp/server.ts` now advertises enum values for `tuberosa_finish_session.outcome`, `reflectionDraft.triggerType`, and `reflectionDraft.itemType`; nested reflection drafts also declare required `title`, `summary`, `content`, and `triggerType`.
  - `tuberosa_reflect` now advertises the same `triggerType` and `itemType` enums.
  - `test/api-boundary.test.ts` verifies the finish-session tool schema exposes those constraints.

- **Previous Phase 9 retrieval fixture work remains in place.**

- **Eval fixture relations support.**
  - New `RetrievalEvalRelation` type and `KnowledgeRelationCreator` interface in `retrieval-evaluator.ts`.
  - `RetrievalEvalFixture` now supports an optional `relations` array.
  - `seedRelations()` private method creates relations using the eval ID index before running cases.
  - `fixture-loader.ts` parses and validates the `relations` array.
  - Both `scripts/eval-retrieval.ts` and `test/evaluation.test.ts` now pass `store` as the 4th constructor argument to supply a relation creator.

- **Two new hard retrieval eval cases.**
  - `superseded-workflow-demoted`: verifies that a `supersedes` relation + freshness demotion prevents the old deployment runbook from appearing in top-K when the current runbook is queried.
  - `conflicting-memories-freshness`: verifies that a stale low-trust rate-limit policy is demoted below the current policy even when both match the same query topic.

- **Bug fix: `isGraphEvidence` threshold bypass for superseded candidates.**
  - Root cause: the `supersedes` graph edge caused the legacy item to appear as a `seed_outbound` graph candidate with rawScore≥0.45, bypassing the `filterAcceptedCandidates` score threshold entirely.
  - Fix: `isGraphEvidence` in `context-pack.ts` now returns false when the candidate carries a `suppression:superseded:*` match reason.
  - This keeps the original graph evidence behavior (bypass threshold for fresh, related graph items) while correctly applying the anchored threshold (0.6) to superseded items found via graph traversal.

- **`eval/retrieval-fixtures.json` extended.**
  - Added 4 new knowledge items: `current-deploy-runbook`, `legacy-deploy-runbook`, `current-rate-limit-policy`, `legacy-rate-limit-policy`.
  - Added `relations` array with two `supersedes` entries.
  - Added 2 new eval cases.

## Files Actively Edited

- `src/evaluation/retrieval-evaluator.ts`
  - Adds `KnowledgeRelationCreator` interface, `RetrievalEvalRelation` type, `relations` field in fixture, `seedRelations()` method, 4th constructor param.
- `src/evaluation/fixture-loader.ts`
  - Adds `parseRelation()` and parses `relations` array in `parseRetrievalEvalFixture`.
- `src/retrieval/context-pack.ts`
  - `isGraphEvidence` now excludes candidates with `suppression:superseded:*` match reason.
- `src/operations/service.ts`
  - Hardened learning-proposal approval idempotency, retry behavior, and supersedes relation reuse.
- `src/mcp/server.ts`
  - Tightened finish-session and reflection tool schemas so agents see valid outcome/trigger/item enums before calling.
- `eval/retrieval-fixtures.json`
  - 4 new knowledge items, 2 supersedes relations, 2 new eval cases.
- `test/operations.test.ts`
  - Added regression coverage for approvalAction spoofing and retryable approval failures.
- `test/api-boundary.test.ts`
  - Added MCP schema regression coverage for finish-session outcome and reflection draft enums.
- `scripts/eval-retrieval.ts`
  - Passes `store` as 4th arg to `RetrievalEvaluator`.
- `test/evaluation.test.ts`
  - Passes `store` as 4th arg to `RetrievalEvaluator`.
- `docs/AGENT_CONTEXT_ROADMAP.md`
  - Marks Phase 9 supersession/conflict eval work as started.
- `handoff.md`
  - Updated to reflect current state.

## Everything Tried That Failed Or Needed Correction

- First approach: exclude `supersedes` from `seed_outbound` graph traversal in memory-store and postgres-store.
  - Broke the existing test "intent suppression demotes superseded workflows" which expected the legacy item to appear via graph traversal.
  - Reverted, replaced with the `isGraphEvidence` check instead.

## Verification Already Run

Latest checks passed:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/api-boundary.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/operations.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
git diff --check
```

Notes:

- `eval:retrieval` passes all 9 cases (7 original + 2 new) with 100% on all metrics.
- `pnpm test` passes all test files.
- `eval:agent-context` may need to run outside the sandbox because `tsx` can hit `listen EPERM` on its IPC pipe under `/tmp`; rerun with escalation if that happens.

## Improve Plan And Next Steps

Continue Phase 9 from `docs/AGENT_CONTEXT_ROADMAP.md`.

Recommended next steps:

1. **Expand proposal approval actions.**
   - Approved `supersedes` proposal already creates or reuses the actual `supersedes` relation and marks affected knowledge `needs_review`.
   - Approved `auto_memory_cleanup` already marks affected knowledge `needs_review`.
   - Remaining: decide a reviewed metadata shape for `missing_label`/`missing_reference` proposals, then apply labels/references to the affected knowledge when that structured suggestion is present.
   - Keep `metadata.approvalAction` server-owned; do not let clients supply or overwrite it.

2. **Complete auto-memory cleanup actions.**
   - `auto_memory_cleanup` proposal approval → mark affected knowledge as `needs_review`, `archived`, or superseded.

3. **Add missing-context and graph-expanded eval fixtures.**
   - `missing_context` feedback creates knowledge-gap records (regression fixture).
   - Graph-expanded case where a graph-related current item beats a stale semantic match.

4. **Provider-backed reranking.**
   - Prompts that prefer evidence coverage over generic similarity.

5. **Richer context-pack explanations.**
   - Each item clearly shows: exact match, graph relation, feedback, freshness, stale risk, supersession.

## Notes For The Next Agent

- Do not ignore `handoff.md`; this file is part of the Phase 9 continuation retrieval strategy.
- Do not auto-trust raw conversation as memory. Keep learning grounded, labeled, referenced, and reviewable.
- Do not create a separate v2 effort. Continue Phase 9 Retrieval Quality Hardening.
- Prefer existing abstractions: `AgentSessionService`, `ReflectionService`, `RetrievalService`, `KnowledgeStore`, review filters, feedback events, reflection drafts, and knowledge relations.
- The `isGraphEvidence` fix in `context-pack.ts` is the correct approach for suppressed-but-graph-traversed candidates. Do not reintroduce the `seed_outbound` exclusion in the stores.
