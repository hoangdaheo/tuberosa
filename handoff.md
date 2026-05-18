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

- **Reviewed missing label/reference proposal actions.**
  - `OperationsService.updateLearningProposal()` now supports a reviewed metadata shape for label/reference proposal approval:
    - `metadata.suggestedLabels` for `missing_label` proposals.
    - `metadata.suggestedReferences` for `missing_reference` proposals.
  - Approving `missing_label` merges reviewed labels into the affected knowledge without duplicating existing labels with the same normalized type/value.
  - Approving `missing_reference` merges reviewed references into the affected knowledge without duplicating existing type/URI/line/commit matches.
  - If a label/reference proposal has no structured suggestion, approval preserves the previous fallback behavior and marks affected knowledge `needs_review`.
  - Malformed structured suggestions fail validation and keep approval retryable because `metadata.approvalAction` is still only written after the concrete action succeeds.
  - `test/operations.test.ts` covers label/reference application and dedupe behavior.

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

- **Missing-context and graph-expanded retrieval eval coverage.**
  - `RetrievalEvaluator` now supports an optional `expectedKnowledgeGap` assertion on feedback events.
  - `missing_context` eval feedback now verifies an open knowledge-gap record with expected prompt, reason, missing signals, and context-pack linkage.
  - Added a graph-expanded retrieval fixture where `src/api/media-upload.ts` / `MediaUploadHandler` pulls in the related current image intake policy through a one-hop `depends_on` relation.
  - Added an insufficient-fit missing-context case and a graph-expanded media-policy case to `eval/retrieval-fixtures.json`.

- **Provider-backed reranking prompt hardening.**
  - `src/model/provider.ts` now has an evidence-first OpenAI rerank system prompt that explicitly prefers concrete evidence coverage over generic semantic similarity.
  - OpenAI rerank payloads now include structured candidate evidence: exact file/symbol/error matches, technology and business-area matches, task/project match, required evidence-type coverage, graph paths, feedback metadata when present, freshness, and stale/suppression risk signals.
  - Hash-mode reranking behavior remains unchanged.
  - `test/model-provider.test.ts` covers the provider rerank prompt and structured payload contract without network calls.

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
  - Added 7 new knowledge items total across this Phase 9 fixture work: deploy runbooks, rate-limit policies, and media upload/image intake policy records.
  - Added `relations` array with two `supersedes` entries and one `depends_on` entry.
  - Added 4 new eval cases total: superseded workflow demotion, conflicting freshness, missing-context insufficient fit, and graph-expanded media policy.
  - Added `missing_context` feedback fixture coverage that asserts a matching knowledge-gap record is created.

## Files Actively Edited

- `src/evaluation/retrieval-evaluator.ts`
  - Adds `KnowledgeRelationCreator` interface, `RetrievalEvalRelation` type, `relations` field in fixture, `seedRelations()` method, 4th constructor param.
  - Adds `KnowledgeGapReader` and `expectedKnowledgeGap` feedback assertions for missing-context eval coverage.
- `src/evaluation/fixture-loader.ts`
  - Adds `parseRelation()` and parses `relations` array in `parseRetrievalEvalFixture`.
  - Parses `expectedKnowledgeGap` on feedback events.
- `src/retrieval/context-pack.ts`
  - `isGraphEvidence` now excludes candidates with `suppression:superseded:*` match reason.
- `src/operations/service.ts`
  - Hardened learning-proposal approval idempotency, retry behavior, and supersedes relation reuse.
  - Applies reviewed `metadata.suggestedLabels` and `metadata.suggestedReferences` for `missing_label`/`missing_reference` approvals.
- `src/mcp/server.ts`
  - Tightened finish-session and reflection tool schemas so agents see valid outcome/trigger/item enums before calling.
- `src/model/provider.ts`
  - Adds `OPENAI_RERANK_SYSTEM_PROMPT` and `buildOpenAiRerankPayload()` with structured evidence fields for provider reranking.
- `eval/retrieval-fixtures.json`
  - 7 new knowledge items, 2 supersedes relations, 1 depends_on relation, 4 new eval cases, and missing-context gap assertion coverage.
- `test/model-provider.test.ts`
  - Verifies provider rerank prompt wording and payload evidence fields.
- `test/operations.test.ts`
  - Added regression coverage for approvalAction spoofing, retryable approval failures, and reviewed label/reference application.
- `test/api-boundary.test.ts`
  - Added MCP schema regression coverage for finish-session outcome and reflection draft enums.
- `scripts/eval-retrieval.ts`
  - Passes `store` as 4th arg to `RetrievalEvaluator`.
- `test/evaluation.test.ts`
  - Passes `store` as 4th arg to `RetrievalEvaluator`.
- `docs/AGENT_CONTEXT_ROADMAP.md`
  - Marks Phase 9 supersession/conflict eval work as started.
  - Marks reviewed missing-label/reference approval actions as started and lists the next remaining priorities.
- `docs/FLOW_LOGIC.md`
  - Documents concrete `missing_label` and `missing_reference` approval behavior.
- `docs/SETUP_AND_USAGE.md`
  - Documents `metadata.suggestedLabels` and `metadata.suggestedReferences`.
  - Notes provider rerank sends compact evidence fields to the model.
- `docs/FLOW_LOGIC.md`
  - Documents the evidence-first provider rerank prompt and payload signals.
- `handoff.md`
  - Updated to reflect current state.

## Everything Tried That Failed Or Needed Correction

- First approach: exclude `supersedes` from `seed_outbound` graph traversal in memory-store and postgres-store.
  - Broke the existing test "intent suppression demotes superseded workflows" which expected the legacy item to appear via graph traversal.
  - Reverted, replaced with the `isGraphEvidence` check instead.

## Verification Already Run

Latest checks for this continuation passed:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/model-provider.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/evaluation.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/operations.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
git diff --check
```

Previous session checks also passed before this continuation:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/api-boundary.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
```

Notes:

- `eval:retrieval` passes all 11 cases (7 original + 4 hard Phase 9 cases) with 100% on all metrics.
- `pnpm test` passes all test files.
- `eval:agent-context` may need to run outside the sandbox because `tsx` can hit `listen EPERM` on its IPC pipe under `/tmp`; rerun with escalation if that happens.

## Improve Plan And Next Steps

Continue Phase 9 from `docs/AGENT_CONTEXT_ROADMAP.md`.

Recommended next steps:

1. **Expand proposal approval actions.**
   - Approved `supersedes` proposal already creates or reuses the actual `supersedes` relation and marks affected knowledge `needs_review`.
   - Approved `auto_memory_cleanup` already marks affected knowledge `needs_review`.
   - Done: approved `missing_label` proposals merge reviewed `metadata.suggestedLabels` into affected knowledge.
   - Done: approved `missing_reference` proposals merge reviewed `metadata.suggestedReferences` into affected knowledge.
   - Keep `metadata.approvalAction` server-owned; do not let clients supply or overwrite it.

2. **Complete auto-memory cleanup actions.**
   - `auto_memory_cleanup` proposal approval → mark affected knowledge as `needs_review`, `archived`, or superseded.

3. **Missing-context and graph-expanded eval fixtures.**
   - Done: `missing_context` feedback creates knowledge-gap records (regression fixture).
   - Done: graph-expanded case where a graph-related current item beats stale legacy context.

4. **Provider-backed reranking.**
   - Done: prompts and candidate payloads prefer evidence coverage over generic similarity.

5. **Richer context-pack explanations.**
   - Each item clearly shows: exact match, graph relation, feedback, freshness, stale risk, supersession.

## Notes For The Next Agent

- Do not ignore `handoff.md`; this file is part of the Phase 9 continuation retrieval strategy.
- Do not auto-trust raw conversation as memory. Keep learning grounded, labeled, referenced, and reviewable.
- Do not create a separate v2 effort. Continue Phase 9 Retrieval Quality Hardening.
- Prefer existing abstractions: `AgentSessionService`, `ReflectionService`, `RetrievalService`, `KnowledgeStore`, review filters, feedback events, reflection drafts, and knowledge relations.
- The `isGraphEvidence` fix in `context-pack.ts` is the correct approach for suppressed-but-graph-traversed candidates. Do not reintroduce the `seed_outbound` exclusion in the stores.
