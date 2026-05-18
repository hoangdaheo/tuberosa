# Tuberosa Handoff

Date: 2026-05-19

## Goal We Are Working Toward

Tuberosa is a local-first context broker and learning layer for AI agents. The goal is that a normal user can prompt an agent naturally, the agent can ask Tuberosa for the right project context, record whether the context was useful or wrong, and let Tuberosa learn durable reviewed lessons without the user memorizing special prompts.

The active direction is still `docs/AGENT_CONTEXT_ROADMAP.md`, with Phase 9 mostly hardened and Phase 10 now in progress:

- Phase 9: make continuation, stale-memory suppression, supersession, missing-context learning, and graph-expanded retrieval reliable.
- Phase 10: make returned context more useful at task start by reducing adjacent noise, improving startup orientation, and making item explanations actionable.

## Current State Of The Code

Implemented before this handoff:

- Agent session workflow, context compliance metadata, and one-call layered context are in place.
- Retrieval has deterministic structured intent, continuation anchors, graph expansion, stale/superseded suppression, conflict records, knowledge gaps, and learning proposals.
- Negative feedback creates reviewable `learning_proposals` and `knowledge_gaps` rather than mutating trusted knowledge directly.
- Provider-backed reranking now uses an evidence-first prompt and structured evidence payload.
- Retrieval eval fixtures cover superseded workflows, conflicting freshness, missing-context gaps, and graph-expanded media policy.

Implemented in the latest work:

- **Reviewed learning proposal approval actions.**
  - `supersedes` approval creates or reuses a `supersedes` relation and marks affected knowledge `needs_review`.
  - `missing_label` approval can merge reviewed `metadata.suggestedLabels`.
  - `missing_reference` approval can merge reviewed `metadata.suggestedReferences`.
  - `auto_memory_cleanup` approval now supports reviewed `metadata.cleanupAction`:
    - default or `"needs_review"` marks affected auto-memory `needs_review`.
    - `"archive"` marks affected auto-memory `archived`.
    - `"supersede"` plus `metadata.supersedingKnowledgeId` creates or reuses a `supersedes` relation from the reviewed replacement to the affected auto-memory, then marks the affected auto-memory `needs_review`.
  - `metadata.approvalAction` stays server-owned. Client-supplied values are stripped, and failed approval actions remain retryable.

- **MCP schema and `taskType` smoothing.**
  - User feedback: the failed `tuberosa_start_session` call with `taskType: "development"` should have been prevented or smoothed by the agent-facing contract.
  - `src/mcp/server.ts` now advertises canonical enum values for startup/search `taskType`, `contextMode`, feedback types, learning mode, reflection draft status, and finish/reflection enums from exported validation constants.
  - `src/validation.ts` normalizes common `taskType` aliases before dispatch:
    - `development`, `coding` -> `implementation`
    - `bug`, `bugfix`, `bug_fix`, `investigation` -> `debugging`
  - `test/api-boundary.test.ts` covers both the advertised schemas and runtime alias normalization for `tuberosa_search_context` and `tuberosa_start_session`.

- **Roadmap/docs update.**
  - `docs/AGENT_CONTEXT_ROADMAP.md` now captures the schema mismatch as Phase 10 feedback and marks enum-schema/alias smoothing as started.
  - `docs/SETUP_AND_USAGE.md` documents valid `taskType` values and alias behavior.
  - `docs/FLOW_LOGIC.md` and `docs/SETUP_AND_USAGE.md` document reviewed proposal approval behavior.

- **Phase 10 context-usefulness slice.**
  - `assembleContextPack()` now annotates returned items with `evidenceCategory`, `evidenceStrength`, `usefulnessReason`, and item-level `actionableMissingSignals`.
  - Pack assembly now orders `directTaskEvidence` ahead of `priorLessons`, `workflowGuidance`, and `adjacentContext` before section budgets are applied.
  - Context packs now include an `orientation` block with inferred task, workflow stage, task type, recommended files, likely surfaces, likely Tuberosa verification commands, missing-signal buckets, and notes.
  - MCP shortlist output now exposes the new orientation and item usefulness fields.
  - Classifier/continuation hygiene now suppresses generic roadmap/meta words such as `Before`, `Added`, `Updated`, `Verified`, `Tuberosa`, `Agent`, and `Context`; all-caps document identifiers with underscores are not surfaced as symbols/errors; `next` requires stronger Next.js evidence before being treated as technology.
  - Tests cover direct-evidence ordering, startup orientation, missing-signal buckets, MCP projection, and noisy roadmap symbol/technology suppression.

## Files Actively Edited

- `src/operations/service.ts`
  - Approval idempotency hardening.
  - Concrete approval actions for `supersedes`, `missing_label`, `missing_reference`, and `auto_memory_cleanup`.
- `src/mcp/server.ts`
  - MCP tool schemas now use exported validation constants for agent-facing enums.
  - MCP shortlist output exposes `orientation`, pack-level `actionableMissingSignals`, and item usefulness fields.
- `src/validation.ts`
  - Exports canonical enum constants used by MCP schemas.
  - Normalizes common `taskType` aliases.
- `src/types.ts`
  - Adds Phase 10 context-usefulness and orientation response types.
- `src/retrieval/classifier.ts`
  - Filters generic roadmap/meta words and all-caps document identifiers from weak symbol/error evidence.
- `src/retrieval/context-pack.ts`
  - Adds usefulness categorization, direct-evidence ordering, orientation construction, and actionable missing-signal buckets.
- `src/retrieval/debug.ts`
  - Includes usefulness fields in retrieval debug candidates.
- `src/retrieval/service.ts`
  - Carries usefulness fields into deep context and tightens continuation symbol/error hygiene.
- `test/operations.test.ts`
  - Covers approvalAction spoofing, retryable failures, label/reference approval actions, and auto-memory cleanup actions.
- `test/api-boundary.test.ts`
  - Covers finish/reflection schema enums, startup/search taskType enum schemas, feedback enum schemas, and `development` taskType alias normalization.
  - Covers MCP projection of orientation and item usefulness fields.
- `test/retrieval.test.ts`
  - Covers Phase 10 item categorization/direct-evidence ordering, startup orientation, actionable missing signals, and classifier signal hygiene.
- `src/evaluation/retrieval-evaluator.ts`
  - Supports fixture relations and expected knowledge-gap assertions.
- `src/evaluation/fixture-loader.ts`
  - Parses fixture relations and expected knowledge-gap feedback assertions.
- `src/retrieval/context-pack.ts`
  - Keeps `isGraphEvidence` from bypassing thresholds for candidates carrying `suppression:superseded:*`.
- `src/model/provider.ts`
  - Adds evidence-first OpenAI rerank prompt and structured evidence payload builder.
- `eval/retrieval-fixtures.json`
  - Adds hard Phase 9 fixtures for supersession, conflicts, missing-context gaps, and graph expansion.
- `docs/AGENT_CONTEXT_ROADMAP.md`
  - Tracks Phase 9 completion work and Phase 10 context-usefulness next steps.
- `docs/FLOW_LOGIC.md`
  - Documents feedback learning and proposal approval flow.
- `docs/SETUP_AND_USAGE.md`
  - Documents proposal review metadata, provider rerank evidence payloads, and taskType schema/alias behavior.
- `handoff.md`
  - This updated handoff.

## Everything Tried That Failed Or Needed Correction

- Initial MCP startup in the prior task used `taskType: "development"`.
  - Runtime validation rejected it because canonical task types are `debugging`, `implementation`, `refactor`, `review`, `planning`, `exploration`, `testing`, and `unknown`.
  - Fix: MCP schemas now expose the enum, and validation normalizes common aliases such as `development`.

- Earlier `tuberosa_finish_session` attempts failed with malformed arguments.
  - One call omitted required `reflectionDraft.triggerType`.
  - Another used a free-form `outcome` string instead of the required enum.
  - Fix: finish/reflection MCP schemas now expose outcome, trigger type, and item type enums with nested required fields.

- First attempted supersession fix excluded `supersedes` from `seed_outbound` graph traversal.
  - That broke the existing test expecting legacy knowledge to remain visible through graph traversal.
  - Fix: keep graph traversal intact and make `isGraphEvidence` return false for candidates carrying a superseded suppression reason, so normal score thresholds still apply.

- `pnpm run eval:agent-context` failed inside the sandbox with `listen EPERM` on a `/tmp/tsx-*` IPC pipe.
  - This matches the known handoff note.
  - Rerunning outside the sandbox with escalation passed.

- During this handoff update, `handoff.md` appeared empty in the working tree while the index still contained the previous handoff.
  - Corrected by rewriting `handoff.md` from the loaded roadmap, current diffs, and current session state rather than reverting user or staged changes.

## Verification Already Run

Latest checks for this continuation passed:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/retrieval.test.ts test/api-boundary.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
git diff --check
git diff --cached --check
```

Earlier checks for retrieval fixture/provider work also passed:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/model-provider.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/evaluation.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
```

Notes:

- `eval:retrieval` passes all 11 cases with 100% on the reported metrics.
- `pnpm test` passes all current test files.
- Re-run `pnpm run eval:agent-context` with escalation if `tsx` hits `/tmp` IPC `EPERM`.

## Audit Plan For Previous Changes

Before building the next feature, audit the current changes in this order:

1. **Working-tree hygiene.**
   - Run `git status --short` and distinguish staged work from unstaged continuation work.
   - Do not accidentally revert staged changes from prior work.

2. **MCP schema contract audit.**
   - Inspect `tools/list` output for `tuberosa_search_context`, `tuberosa_start_session`, `tuberosa_record_context_decision`, `tuberosa_feedback_context`, and `tuberosa_finish_session`.
   - Confirm enum fields in schemas match exported constants in `src/validation.ts`.
   - Confirm runtime alias normalization still preserves canonical stored `taskType`.

3. **Learning proposal approval audit.**
   - Review `OperationsService.updateLearningProposal()` for idempotency: no action should re-run after `metadata.approvalAction` exists.
   - Confirm malformed label/reference/cleanup metadata fails before writing `approvalAction`.
   - Confirm retry behavior after partial failure does not duplicate `supersedes` relations.

4. **Retrieval behavior audit.**
   - Run `pnpm run eval:retrieval` after any future ranking, context-pack explanation, signal hygiene, or retrieval fixture change.
   - Specifically verify superseded graph candidates remain thresholded by `isGraphEvidence`.

5. **Agent compliance audit.**
   - Run `pnpm run eval:agent-context` after any session, MCP startup, context-decision, or finish-session schema change.
   - If sandboxed `tsx` fails with `/tmp` IPC `EPERM`, rerun with escalation and record it.

6. **Docs and handoff audit.**
   - Confirm `docs/AGENT_CONTEXT_ROADMAP.md`, `docs/FLOW_LOGIC.md`, `docs/SETUP_AND_USAGE.md`, and `handoff.md` describe the same behavior.
   - Keep examples aligned with canonical enum values and reviewed-memory safety rules.

## Improve Plan And Next Steps

Roadmap-informed next work should continue Phase 10 Agent Context Usefulness Hardening.

Recommended next steps:

1. **Cap and tune prior lessons.**
   - Normal startup packs should include the most useful 3-6 prior lessons and demote weakly related selected memories unless debug/deep context asks for more.
   - The first slice already distinguishes direct evidence, prior lessons, workflow guidance, and adjacent context; tune limits only after checking real Tuberosa startup output.

2. **Enrich context-pack explanations further.**
   - Current `usefulnessReason` is compact and category-based.
   - Next pass should explicitly call out freshness/stale risk, supersession, graph-path contribution, and feedback contribution when those signals are present.

3. **Add context-quality feedback metadata.**
   - Use existing feedback/session decision metadata to record useful-but-noisy, too much adjacent context, missing startup orientation, missing current handoff, and missing verification commands.
   - Do not create another review queue until there is evidence the existing feedback model cannot handle it.

4. **Verification for the next implementation.**
   - Always run `pnpm run build`, targeted tests, `pnpm test`, and `git diff --check`.
   - Also run `pnpm run eval:retrieval` for ranking/context-pack/signal changes.
   - Also run `pnpm run eval:agent-context` for MCP/session/startup changes.

## Notes For The Next Agent

- Start by calling Tuberosa and recording the selected context decision; this repo uses Tuberosa as its own continuation workflow.
- Read `docs/AGENT_CONTEXT_ROADMAP.md`, `handoff.md`, and `tuberosa-project.md` before substantial work.
- Do not auto-trust raw conversation as memory. Keep learning grounded, labeled, referenced, and reviewable.
- Do not create a separate v2 effort. Continue Phase 9/Phase 10 from the roadmap.
- Prefer existing abstractions: `AgentSessionService`, `RetrievalService`, `ReflectionService`, `KnowledgeStore`, review filters, feedback events, reflection drafts, and knowledge relations.
- Keep changes surgical. The next implementation should likely touch retrieval/context-pack assembly and tests, not broad storage or schema migrations.
