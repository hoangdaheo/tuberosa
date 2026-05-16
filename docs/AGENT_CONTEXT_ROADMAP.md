# Tuberosa Agent Context Roadmap

This roadmap turns Tuberosa from a retrieval service into a systematic second brain for AI agents. Each phase should be shippable on its own and verified before the next phase starts.

The main priorities are stable API boundaries, better context-quality evaluation, agent-session collaboration, feedback-driven learning, and operational review tools.

## Phase 0: API Boundary And Exception Foundation

Goal: make HTTP and MCP inputs safe, predictable, and easier for agents to use.

Status: Done on 2026-05-16.

- Add shared runtime validators for HTTP and MCP inputs without adding a new production dependency.
- Validate `KnowledgeInput`, file ingestion input, context search input, feedback input, and reflection draft input.
- Add typed app errors: validation, not found, safety blocked, ingestion limit, model provider, store, and cache.
- Normalize HTTP error responses and MCP JSON-RPC tool errors.
- Keep existing response bodies backward compatible.

Acceptance:

- Malformed HTTP and MCP inputs return structured errors.
- Existing valid requests still pass.
- Unsafe knowledge still returns safety-specific errors.

## Phase 1: Context Fit Evaluation

Goal: make appropriate knowledge explicit instead of relying only on final rank and confidence.

- Add a `ContextFitEvaluator` after rerank and before context-pack assembly.
- Evaluate candidate coverage for project, files, symbols, errors, task type, trust level, freshness, safety, and prior feedback.
- Add pack-level fit metadata:
  - `fitStatus`: `ready`, `needs_confirmation`, or `insufficient`
  - `fitScore`
  - `fitReasons`
  - `missingSignals`
- Add candidate-level fit reasons to debug output and normal MCP shortlist output.
- If fit is insufficient, return a pack that clearly tells the agent to ask a clarifying question instead of overusing weak context.

Acceptance:

- Exact file, symbol, and error matches produce stronger fit.
- Stale or rejected items are penalized.
- Sparse searches can still return best effort, but with `needs_confirmation` or `insufficient`.

## Phase 2: Agent Collaboration Harness

Goal: make agents collaborate with Tuberosa through a session workflow, not isolated tool calls.

- Add agent session storage:
  - session id, project, cwd, prompt, agent name/tool, status, created/finished timestamps
  - selected, rejected, missing, or stale context pack decisions
  - final outcome and reflection draft links
- Add HTTP endpoints:
  - `POST /agent-sessions`
  - `POST /agent-sessions/:id/context-decision`
  - `POST /agent-sessions/:id/finish`
- Add MCP tools:
  - `tuberosa_start_session`: creates a session and returns context shortlist plus policy
  - `tuberosa_record_context_decision`: records selected, rejected, missing, or stale context
  - `tuberosa_finish_session`: records outcome and optionally creates reflection draft
- Keep existing MCP tools working for direct/manual use.

Acceptance:

- An agent can start, receive context, record the selected pack, finish, and draft a memory.
- Rejected context triggers retry behavior through the existing retrieval feedback path.
- Sessions provide an audit trail of what context influenced the agent.

## Phase 3: Feedback-Driven Learning And Knowledge Taxonomy

Goal: make the system learn from use without automatically trusting raw conversation.

- Use feedback history in retrieval scoring:
  - selected context gives a modest boost
  - stale, rejected, and irrelevant context apply penalties
  - missing-context events are stored for review
- Add metadata-based taxonomy for knowledge:
  - `project_fact`
  - `domain_rule`
  - `workflow`
  - `user_preference`
  - `incident_lesson`
  - `code_reference`
- Keep taxonomy in `metadata.taxonomy` for this phase to avoid an early schema migration.
- Add reflection draft fields linking lessons to agent session, context pack, trigger, and references.
- Keep approval required before any reflection becomes searchable memory.

Acceptance:

- Selected feedback improves later ranking in eval fixtures.
- Stale feedback prevents old context from winning.
- Approved memories preserve taxonomy and session provenance.

## Phase 4: Knowledge Review And Operations

Goal: give users and admins a way to inspect and maintain the second brain.

- Add read/update endpoints for:
  - knowledge atoms
  - labels
  - safety status
  - reflection drafts
  - context packs
  - feedback events
  - agent sessions
- Add stale/orphan cleanup behavior for old context queries, packs, feedback rows, and unused sources.
- Add CLI importer for repo docs and local knowledge files.
- Keep the first version API-only; frontend/admin UI can be a later layer.

Acceptance:

- User can list questionable knowledge and safety metadata.
- User can inspect why a context pack was returned.
- Importer can refresh docs without creating stale duplicates.

## Phase 5: Provider-Backed Retrieval Intelligence

Goal: improve quality while keeping deterministic local behavior.

- Add optional provider-backed query rewriting.
- Add optional provider-backed reranking.
- Keep hash reranking as deterministic default for tests and local/offline mode.
- Expand `eval/retrieval-fixtures.json` with expected fit status, selected IDs, rejected IDs, and confidence thresholds.
- Require `pnpm run eval:retrieval` before and after any ranking change.

Acceptance:

- Provider-backed mode improves eval quality without breaking hash-mode tests.
- Retrieval debug shows rewrite/rerank inputs and decisions without storing verbose debug data.

## Public API And Type Changes

- Add optional `contextFit` metadata to context pack responses.
- Add optional candidate fit reasons in MCP shortlist output.
- Add new session endpoints and MCP tools in Phase 2.
- Add `metadata.taxonomy` for knowledge and reflection memories in Phase 3.
- Keep existing endpoints and MCP tools backward compatible.

## Test Plan

Run for each phase:

```bash
pnpm run build
pnpm test
git diff --check
```

Additional checks:

- Phase 0: HTTP/MCP validation tests and typed error tests.
- Phase 1: retrieval tests for fit scoring, low-confidence behavior, and debug trace output.
- Phase 2: integration tests for agent session lifecycle and context decisions.
- Phase 3: retrieval eval before and after feedback scoring changes.
- Phase 4: integration tests for cleanup/import behavior.
- Phase 5: retrieval eval in hash mode, plus provider-mode tests with mocked model responses.

## Assumptions

- Keep Tuberosa local-first and single-user for now.
- Do not add a frontend in this roadmap; expose admin/review capability through HTTP first.
- Do not add a validation dependency in Phase 0 unless local validators become too complex.
- Existing ingestion dedupe and atomic stale cleanup work is the baseline.
- Phases should be implemented in order, and each phase should be merged only after its tests pass.
