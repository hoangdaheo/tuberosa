# Flow Intent Audit

This audit maps `tuberosa-project.md` intent to the current implementation after the Phase 10 and ops-first follow-up work.

## Startup And Session Compliance

Author intent:

- Agents should start a session or search context before substantial work.
- They should inspect context fit, record a context decision, and finish with compliance evidence or a bypass reason.

Implementation:

- `AgentSessionService` backs HTTP `/agent-sessions`, `/context-decision`, `/finish`, and `/notes`.
- MCP exposes `tuberosa_start_session`, `tuberosa_record_context_decision`, `tuberosa_finish_session`, and `tuberosa_append_session_note`.
- Session finish records compliance states: compliant, needs decision, missing context recorded, bypassed, or non-compliant.
- `selected_but_noisy` counts as selected for compliance; missing-orientation/current-handoff/verification feedback counts as handled missing context.

Audit note:

- This matches the intended workflow. The remaining product gap is ergonomic, not architectural: agents still need a review surface or guided workspace to make the policy hard to skip.

## Retrieval And Context Fit

Author intent:

- Retrieval should prefer exact evidence, current handoffs, selected session context, reviewed memories, graph-related knowledge, freshness, and feedback.
- It should demote stale, rejected, irrelevant, superseded, weakly related, or evidence-poor knowledge.

Implementation:

- `RetrievalService` classifies prompts, adds continuation provenance, runs metadata/lexical/memory/vector/graph search, fuses, reranks, applies feedback/suppression, evaluates fit, and assembles packs.
- `ContextFitEvaluator` emits pack and candidate fit reasons/missing signals.
- Context packs include orientation, evidence categories, evidence strength, actionable missing signals, and enriched usefulness reasons.
- Usefulness reasons now mention exact evidence, graph paths, feedback contribution, freshness/stale risk, and supersession suppression when present.

Audit note:

- The flow matches the intent for backend behavior. Future tuning should remain eval-driven and avoid changing ranking from operations feedback without review.

## Feedback, Retry, And Learning Proposals

Author intent:

- Users or agents must be able to correct wrong context.
- Missing-context feedback should become actionable review work, not just a score penalty.
- Rejected/stale/irrelevant context should reduce future ranking and propose reviewed improvements.

Implementation:

- Feedback supports selected, rejected, irrelevant, stale, missing_context, selected_but_noisy, too_much_adjacent_context, missing_orientation, missing_current_handoff, and missing_verification_commands.
- Rejected, irrelevant, and stale feedback retry with rejected knowledge excluded.
- Missing-context-style feedback creates `knowledge_gaps`.
- Negative/noisy feedback creates `learning_proposals`.
- `GET /operations/context-quality` and `tuberosa_collect_context_quality_feedback` link quality feedback to packs, sessions, adjacent items, open gaps/proposals, missing signals, and suggested actions.

Audit note:

- The actionable backend loop exists. The missing piece is a human workbench that lets reviewers complete the loop without manual HTTP/MCP calls.

## Reflection Review And Auto-Learning

Author intent:

- Reflection memories should be reviewable drafts first.
- Approved reflections become searchable; unreviewed drafts should not influence retrieval as trusted memory.
- Tuberosa should not automatically trust raw conversation.

Implementation:

- Manual reflections are pending drafts until approval.
- Reflection drafts can be listed, inspected, patched for labels/references, approved, rejected, or marked needs_changes over HTTP and MCP.
- Session finish can create auto-learning candidates. Strong, compliant, grounded candidates may be auto-approved; weaker candidates stay reviewable or are rejected.
- Negative feedback on auto-approved session memory creates `auto_memory_cleanup` proposals.

Audit note:

- Manual reflection review matches the author intent.
- Auto-approved session memory is the main policy tension. It is gated and auditable, but it is still a deliberate deviation from the strict "approval before searchable memory" reading. Keep it visible in review surfaces and revisit whether auto-approval should default to draft-only.

## Graph, Operations, And Recovery

Author intent:

- Graph relations should be controlled and reviewable.
- Physical exports should support backup, recovery, inspection, and handoff, not become the runtime authority.

Implementation:

- Knowledge relations support controlled relation types and are exposed through operations endpoints.
- Retrieval uses bounded graph expansion and shows graph paths in debug/usefulness signals.
- Conflicts, gaps, proposals, feedback events, packs, sessions, drafts, labels, and knowledge are reviewable through operations APIs.
- Organization exports are available over HTTP and `pnpm run organization`: project map, knowledge graph JSONL, and readable summary.
- Backups and physical mirror remain separate from organization exports.

Audit note:

- This matches the local-first and reviewable-graph intent. The next improvement is operational UX rather than schema work.

## Safety, Local-First, And Non-Goals

Author intent:

- Tuberosa should stay local-first and provider-pluggable.
- It should not replace code search, GitNexus, Graphify, or a human-maintained wiki.
- It should avoid storing secrets, raw private conversation, and prompt-injection content as trusted knowledge.
- It should select enough relevant context, not flood the agent.

Implementation:

- Memory and Postgres stores share `KnowledgeStore`; Redis is optional; hash models remain deterministic defaults.
- OpenAI rewrite/rerank/embedding is optional and isolated behind `ModelProvider`.
- Safety scanning/redaction runs before ingestion and before retrieval output.
- Context packs are compact by default; deep context and debug diagnostics require explicit options.
- Operations exports are read-only inspection aids.

Audit note:

- The implementation remains aligned. Post-v1 product work can be richer, but should keep these non-goals as guardrails.
