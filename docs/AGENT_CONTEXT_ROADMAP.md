# Tuberosa Agent Context Roadmap

This roadmap turns Tuberosa from a retrieval service into a systematic second brain for AI agents. Each phase should be shippable on its own and verified before the next phase starts.

The main priorities are stable API boundaries, better context-quality evaluation, agent-session collaboration, feedback-driven learning, operational review tools, and recoverable durable knowledge.

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

Status: Done on 2026-05-16.

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

Status: Done on 2026-05-16.

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

Status: Done on 2026-05-16.

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

Status: Done on 2026-05-16.

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

Status: Done on 2026-05-17.

Current baseline:

- Optional provider-backed query rewriting is available through `OPENAI_REWRITE_MODEL`.
- Optional provider-backed reranking is available through `OPENAI_RERANK_MODEL`.
- Hash reranking remains the deterministic default for tests and local/offline mode.
- `eval/retrieval-fixtures.json` includes expected fit status, selected IDs, rejected IDs, and confidence thresholds.
- `pnpm run eval:retrieval` reports selected coverage, confidence threshold pass rate, and context-fit pass rates.

Ongoing rule:

- Require `pnpm run eval:retrieval` before and after any ranking change.

Acceptance:

- Provider-backed mode improves eval quality without breaking hash-mode tests.
- Retrieval debug shows rewrite/rerank inputs and decisions without storing verbose debug data.

## Phase 6: Backup Sync And Disaster Recovery

Status: Done on 2026-05-17.

Goal: make Postgres and the physical backup folder work as a reliable recovery system, not only manual snapshots.

Completed work:

- Scheduled backups are owned by the long-running HTTP app process and use configurable interval, startup delay, retention count, and retention age.
- Backup catalog and health are visible through HTTP and CLI, including latest backup, row counts, age, source store, manifest version, and scheduler status.
- Backup verification reads table JSONL files back from disk, validates manifest/table coverage, checks row counts and checksums, and requires retrieval-critical tables.
- Restore dry-run and replace restore run verification and schema/embedding preflight before touching the store.
- Important mutations can request throttled write-through backups, including approved reflections and bulk/import file operations.
- Retention pruning deletes only verified complete backup directories and keeps the latest backup plus the latest successful backup.
- New backup manifests include per-table SHA-256 checksums, app version or commit when available, schema version, embedding dimensions, and model provider metadata.
- Recovery runbooks document dry-run restore, replace restore, fresh-machine restore, and embedding dimension mismatch handling.
- Exact Postgres `pg_dump`/`pg_restore` remains a future optional mode for full database disaster recovery, separate from portable JSONL backups.

Completed surfaces:

- HTTP `GET /operations/backups/status`
- HTTP `POST /operations/backups/:id/verify`
- HTTP `POST /operations/backups/prune`
- CLI `pnpm run backup --status`
- CLI `pnpm run backup --list`
- CLI `pnpm run backup --verify <backup-id-or-path>`
- CLI `pnpm run backup --prune`

Acceptance:

- Done: a local stack can automatically create backups from the HTTP app without user-triggered CLI or HTTP calls.
- Done: backup health is visible through HTTP and CLI without reading files manually.
- Done: a corrupt, incomplete, or schema-incompatible backup fails verification before restore.
- Done: retention pruning is deterministic and covered by memory-mode tests.
- Done: restore dry-run and replace restore continue to preserve retrievable chunks and embeddings.
- Done: manual JSONL backup and restore commands remain backward compatible.

## Phase 7: Knowledge Organization Graph

Status: Core done on 2026-05-18; optional polish remains.

Goal: organize knowledge in a way that agents can navigate by task relevance, provenance, and relationships instead of relying only on flat search results or folder paths.

Design principle:

- Postgres remains the source of truth.
- The physical folder remains a backup/export/recovery layer.
- Folder trees are useful for provenance and human inspection.
- Graph relations are useful for connected task context.
- Retrieval indexes are what agents consume directly through context packs.

Recommended model:

- Keep the existing hierarchy:
  - project
  - source
  - knowledge item
  - chunk
  - label
  - reference
- Add explicit `knowledge_relations` records for connections between knowledge items, files, symbols, errors, sessions, and external references.
- Start with a controlled relation taxonomy:
  - `contains`
  - `references`
  - `mentions_file`
  - `mentions_symbol`
  - `resolves_error`
  - `supersedes`
  - `depends_on`
  - `related_to`
  - `derived_from_session`
- Generate read-only organization exports:
  - `project-map.json`
  - `knowledge-graph.jsonl`
  - `readable-summary.md`
- Keep generated exports separate from backups. Backups are for recovery; organization exports are for inspection, debugging, and external tools.

Planned work:

- Add relation storage and validators without making graph edges required for basic ingestion.
- Infer first-pass relations during ingestion from labels, references, file paths, symbols, errors, source URI, section path, and reflection provenance.
- Add operations endpoints to list, inspect, create, update, and delete relations.
- Add graph expansion to retrieval:
  - exact file/symbol/error matches first
  - one-hop related knowledge second
  - optional two-hop expansion only when debug or explicit mode is enabled
- Done: add graph-aware context-fit signals showing which files, symbols, errors, sessions, and incident lessons are connected.
- Done: add debug trace fields explaining why related knowledge entered a context pack, including relation id, type, direction reason, source knowledge, and target.
- Done: add HTTP endpoints for project maps, graph JSONL, and readable summaries.
- Done: add `pnpm run organization` CLI commands for project maps, knowledge graph JSONL, and readable summaries.
- Done: add stale relation cleanup when document atoms are re-ingested, when an atomized file is re-ingested as a single document, and when knowledge is archived or blocked.
- Add a pending reflection review workflow for agents and users:
  - MCP tools to list pending reflection drafts, inspect a draft, and record review decisions.
  - Review decisions should support approve, reject, and needs-changes style outcomes.
  - Review output should include a compact evaluation rubric for accuracy, usefulness, scope, privacy/safety, labels, references, and duplicate risk.
  - Add a prompt that asks the user to evaluate pending drafts before they become searchable memory.
  - Keep approval explicit; drafts must never become searchable memory only because an agent created them.
- Keep graph traversal bounded so weakly related knowledge does not flood agent context.

Acceptance:

- Agents can receive context that includes directly matched knowledge plus clearly explained one-hop related knowledge.
- Users can inspect a project map without reading raw database rows.
- Retrieval debug shows relation paths used to include graph-expanded candidates.
- Re-ingesting an atomic document removes stale atom relations.
- Agents can list pending reflection drafts through MCP, present them for user review, and record approve/reject/needs-changes decisions.
- Reflection draft review includes enough evaluation detail to explain why a memory was approved, rejected, or sent back for changes.
- Approved reflection memories remain explicitly user-reviewed before they become searchable knowledge.
- Generated organization exports are reproducible and are not treated as the runtime source of truth.
- Existing search, backup, restore, and reflection flows continue to work when no relations exist.

## Phase 8: Agent Context Compliance And Evaluation

Status: Done on 2026-05-18.

Goal: make Tuberosa context retrieval an auditable agent workflow instead of an optional best-effort habit.

Problem this phase addresses:

- Agents can skip `tuberosa_search_context` or `tuberosa_start_session` and still complete work, which defeats the purpose of Tuberosa as the context broker.
- Existing MCP prompts recommend fetching context, but there is no measurable compliance signal proving the agent did it.
- Retrieval eval measures whether Tuberosa can find useful knowledge, not whether agents actually ask for and evaluate that knowledge before working.
- Context fit can say `needs_confirmation` or `insufficient`, but agents are not required to record whether they selected, rejected, bypassed, or reported missing context.

Policy:

- First version is warn-and-record, not a hard gate.
- The canonical auditable startup path is `tuberosa_start_session`.
- Direct `tuberosa_search_context` remains supported for manual or lightweight use, but does not prove session compliance by itself.
- Agents may bypass context only by recording an explicit bypass reason.

Planned work:

- Update the MCP bootstrap prompt to prefer `tuberosa_start_session` before work and reserve `tuberosa_search_context` for direct/manual lookup.
- Add context compliance metadata to agent sessions without a schema migration:
  - `compliant`: session has context and a selected context decision
  - `needs_decision`: context was fetched but no decision was recorded
  - `missing_context_recorded`: context was insufficient and the agent recorded `missing_context`
  - `bypassed`: agent supplied a context bypass reason
  - `non_compliant`: no context evidence and no bypass reason
- Add compliance output to session policy and finish results so agents see explicit warnings before ending work.
- Add optional `contextBypassReason` to session finish input.
- Keep finish non-blocking, but persist non-compliance in session metadata for review.
- Add `pnpm run eval:agent-context` to evaluate agent workflow compliance separately from retrieval quality.
- Add agent-context eval cases:
  - start session, select context, finish as compliant
  - start session, finish without decision, warn as `needs_decision`
  - insufficient context plus `missing_context` decision, record as handled
  - explicit bypass reason, record as `bypassed`
  - direct search only, confirm it is unaudited and not counted as compliant session work
- Update setup and usage docs with the expected agent startup flow:
  1. call `tuberosa_start_session`
  2. inspect `contextFit`
  3. record `selected`, `rejected`, `stale`, `irrelevant`, or `missing_context`
  4. finish the session with compliance evidence or a bypass reason

Acceptance:

- Agents receive explicit runtime warnings when they did not record context use.
- Compliance evidence is stored with the session.
- Eval fails if the standard session workflow can skip context without warning.
- Existing `tuberosa_search_context` behavior remains backward compatible.
- Compliance eval is separate from retrieval eval so retrieval quality and agent behavior can regress independently.

## Phase 8.5: One-Call Layered Context For Agents

Goal: keep the auditable context workflow, but make the common "agent starts work and needs enough detail now" path one tool call instead of a search call followed by a pack fetch.

Status: Done on 2026-05-18.

Problem this phase addresses:

- Layered context exists, but normal use can still require two MCP calls:
  1. `tuberosa_search_context` to get the shortlist and fit policy.
  2. `tuberosa_get_context_pack` to fetch expanded `deepContext.sections`.
- The two-step flow is useful for manual review and low-confidence searches, but it is expensive and easy for agents to handle inconsistently.
- For `fitStatus: ready`, Tuberosa already has enough confidence to return a working pack directly.
- Agents should not need to understand Tuberosa internals just to get the context they need before coding.

Recommended design:

- Keep the existing two-step flow for careful review, manual inspection, and backward compatibility.
- Add an explicit one-call option to `tuberosa_search_context`, for example:
  - `includeDeepContext: true`
  - or `autoFetch: true`
  - or a dedicated higher-level tool such as `tuberosa_get_working_context`
- When `contextMode: "layered"` and `fitStatus: "ready"`, return the compact shortlist plus full `deepContext.sections` in the same response.
- When `fitStatus: "needs_confirmation"`, return compact shortlist by default and include deep context only if the caller explicitly requested it with `includeDeepContext: true`.
- When `fitStatus: "insufficient"`, keep the response compact and tell the agent what signals are missing; do not spend deep-context budget on weak matches by default.
- Keep `tuberosa_get_context_pack` as the reload/audit tool for a known pack id.
- Keep `tuberosa_start_session` as the canonical auditable startup path, but allow it to use the same one-call layered behavior internally when the pack is ready.

Recommended response shape:

```json
{
  "contextPackId": "...",
  "confidence": 0.82,
  "contextFit": {
    "fitStatus": "ready",
    "fitScore": 0.77,
    "fitReasons": ["covered project:tuberosa", "covered task:implementation"],
    "missingSignals": []
  },
  "sections": [
    { "name": "essential", "items": [] },
    { "name": "supporting", "items": [] },
    { "name": "optional", "items": [] }
  ],
  "deepContext": {
    "mode": "layered",
    "budget": 60000,
    "sections": [
      { "name": "essential", "items": [] },
      { "name": "supporting", "items": [] },
      { "name": "optional", "items": [] }
    ]
  },
  "instruction": "Use this context before working and record the context decision."
}
```

Implementation notes:

- Avoid duplicating assembly logic. The search path should assemble one context pack, persist it once, and decide how much of that pack to return.
- Keep normal shortlist fields compact. Large chunk-expanded text belongs under `deepContext`, not duplicated into the compact `sections`.
- Add a `deepContextReturned` or similar boolean in debug/metadata so audits can distinguish "deep context exists" from "deep context was actually returned to the agent".
- Token budget should remain explicit and clamped. The default can stay `TUBEROSA_DEEP_CONTEXT_BUDGET=60000`.
- The MCP prompt should recommend the one-call layered option for normal startup, and reserve the two-step pattern for low-confidence or human-reviewed context selection.
- This is not a replacement for context compliance. Agents still need to record `selected`, `missing_context`, `rejected`, `stale`, or a bypass reason.

Acceptance:

- Done: a ready layered search can return enough detail for an agent in one MCP call when `includeDeepContext: true`.
- Done: the returned response preserves both compact shortlist review and expanded chunk-backed detail.
- Done: `needs_confirmation` defaults to compact output, and `insufficient` does not return deep context even when requested.
- Done: `tuberosa_get_context_pack` remains useful for reload, audit, and manual inspection.
- Done: agent-session startup can use the same one-call return control while compliance decisions remain explicit.
- Done: MCP boundary tests cover ready, needs-confirmation, insufficient, session startup, and backward-compatible compact output.

## Phase 9: Retrieval Quality Hardening

Status: Done on 2026-05-19.

Goal: make Tuberosa reliable for vague, continuation-style, and high-risk agent tasks where flat semantic search can return plausible but wrong context.

Problems this phase addresses:

- Vague prompts such as "continue the backup work" do not carry enough exact file, symbol, or error signals.
- Vector search can promote semantically similar but stale or unrelated memories.
- Classification is heuristic and misses implied intent, workflow stage, and previous-session context.
- Feedback changes ranking but does not yet create missing labels, relations, or supersession decisions.
- Conflicting knowledge is not modeled strongly enough; newer or approved knowledge does not explicitly supersede old memories.
- Context fit can say "insufficient", but the system does not always explain what knowledge should be created or linked next.

Planned work:

- Add a query understanding layer that produces structured retrieval intent:
  - task goal
  - workflow stage
  - implied files, symbols, domains, and recent session references
  - required evidence types, such as spec, bugfix, workflow, or code reference
  - uncertainty reasons
- Done: deterministic classification emits `classified.intent` with task goal, workflow stage, implied files/symbols/domains, recent selected-session references for continuation prompts, required evidence types, and uncertainty reasons.
- Add continuation-aware retrieval using agent sessions, latest context decisions, recent reflection drafts, and handoff-style knowledge.
  - Done: vague continuation prompts anchor to `handoff.md`, and roadmap/phase continuation prompts also anchor to `docs/AGENT_CONTEXT_ROADMAP.md`.
  - Done: file paths are stripped before symbol/error extraction, so roadmap file anchors do not create fake signals such as `AGENT_CONTEXT_ROADMAP`.
  - Done: vague continuation prompts can use bounded file, symbol, and error hints from recent sessions that recorded a `selected` context decision.
  - Done: continuation hints preserve explicit user-provided signals first and only add bounded inferred signals after them.
  - Done: continuation hints use explicitly selected pack ids only, so a rejected initial pack does not leak signals when a retry pack was selected.
- Done: reflection draft suggested labels are normalized before approval paths can turn them into durable memory, including generic continuation-word filtering and ambiguous `go`/`rest` technology cleanup that preserves explicit Go/REST evidence.
- Next implementation priority: use deterministic structured retrieval intent to drive stale-memory suppression, conflict/supersession review, and missing-context knowledge-gap records.
- Add stale-memory suppression that combines freshness, feedback, supersession relations, and context-fit mismatch before final ranking.
  - Done: ranking applies deterministic intent-aware suppression after rerank and feedback adjustment. It demotes stale weak-evidence candidates, prior stale/rejected/irrelevant feedback, evidence-type mismatches, and knowledge targeted by `supersedes` relations before context-fit assembly.
- Add explicit conflict and supersession handling:
  - `supersedes` relation support in ranking
  - Done: candidates superseded by a `supersedes` relation are demoted and annotated with a suppression match reason.
  - conflict detection for knowledge with overlapping labels/references but contradictory summaries or freshness
  - review queue for unresolved conflicts
  - Done: deterministic conflict records persist in `knowledge_conflicts`, with an operations detector for overlapping file/symbol/error/reference evidence plus opposing summary language or freshness signals.
  - Done: unresolved conflicts are listable and reviewable through operations endpoints, and reviewers can mark them resolved or dismissed without automatically creating supersession edges.
- Add provider-backed reranking prompts that prefer evidence coverage over generic semantic similarity.
  - Done: OpenAI reranking uses an evidence-first system prompt and structured candidate evidence payload with exact file/symbol/error/domain matches, required evidence types, graph paths, feedback metadata when present, freshness, and stale/suppression risk signals.
- Add negative feedback learning:
  - rejected or stale context can propose missing labels, missing relations, or supersession edges
  - Done: rejected/irrelevant/stale feedback creates open `learning_proposals` review records instead of mutating labels, relations, or rankings directly.
  - Done: stale feedback proposes `supersedes` review actions, while rejected/irrelevant feedback proposes relation/label/reference review.
  - Done: negative feedback against auto-approved session memory creates an `auto_memory_cleanup` proposal for operational review.
  - Done: approved `missing_label` proposals can merge reviewed `metadata.suggestedLabels` into affected knowledge labels.
  - Done: approved `missing_reference` proposals can merge reviewed `metadata.suggestedReferences` into affected knowledge references.
  - Done: label/reference proposal approval falls back to marking affected knowledge `needs_review` when no structured suggestion is present, and keeps `metadata.approvalAction` server-owned.
  - Done: approved `auto_memory_cleanup` proposals can apply reviewed cleanup actions: mark auto-memory `needs_review`, archive it, or create a reviewed `supersedes` relation before marking it `needs_review`.
  - missing-context feedback can create reviewable "knowledge gap" records
  - Done: missing-context feedback creates open `knowledge_gaps` records with project, prompt, classified intent, missing signals, context pack, feedback, and session provenance when available.
  - Done: retrieval eval fixtures assert that `missing_context` feedback creates a matching open knowledge-gap record.
- Add retrieval fallback policy:
  - exact anchored search first
  - relation expansion second
  - provider rewrite/rerank third
  - ask for clarification when required evidence is missing
- Add continuation-friendly one-call behavior:
  - ready layered context can be returned directly to the agent
  - low-confidence continuation prompts still ask for confirmation or clarification
  - context pack explanations should make it obvious whether deep context was returned or only available for follow-up fetch
- Add context-pack explanations that tell agents:
  - why each item was included
  - what important evidence is missing
  - whether any returned item may be stale, weakly related, or superseded
- Expand retrieval evaluation fixtures with hard cases:
  - vague continuation prompts
  - Done: stale semantically similar memory fixture verifies current anchored migration-lock code context beats a stale migration-lock memory.
  - conflicting memories
  - Done: superseded workflows eval fixture verifies that a `supersedes` relation demotes the legacy workflow when the current one is in the context.
  - Done: conflicting-freshness eval fixture verifies that a stale low-trust policy is demoted below the current one when both share the same topic.
  - Done: `isGraphEvidence` threshold bypass is suppressed for graph candidates that carry a `supersedes` suppression reason, so a superseded item reachable via graph traversal is still filtered by the anchored score threshold.
  - Done: eval fixture `relations` support is available in `RetrievalEvaluator` via a `KnowledgeRelationCreator` interface and `seedRelations` seeding step.
  - Done: missing-context eval fixture covers insufficient fit plus the created knowledge-gap record and expected missing signals.
  - Done: graph-expanded retrieval eval fixture covers a one-hop `depends_on` relation where a file/symbol-matched API entrypoint brings in the related current policy while stale legacy policy stays out.

- Done: context-pack explanations now mention exact file/symbol/error evidence, graph relation paths, feedback contribution, freshness or stale risk, and supersession suppression when those signals are present.

Acceptance:

- Vague continuation prompts retrieve recent session, handoff, and related workflow context when available.
- Stale semantically similar memories do not outrank fresh exact or graph-related context.
- Superseded knowledge is demoted or excluded unless explicitly requested for history.
- Missing-context feedback creates actionable review records instead of only lowering confidence.
- Retrieval debug explains whether ranking was driven by exact match, rewrite, graph relation, feedback, freshness, or fallback.
- Eval fixtures cover the known failure mode where an unrelated Docker migration memory beat backup or roadmap context.
- Hash-mode tests remain deterministic; provider-mode behavior is covered with mocked responses.

## Phase 10: Agent Context Usefulness Hardening

Status: Done on 2026-05-19.

Goal: make Tuberosa's returned context more useful to agents at task start by improving first-pass orientation, not by returning more context.

Problem this phase addresses:

- Context packs can be technically relevant but still contain adjacent noise that distracts from the current task.
- Previously selected workflow memories can outrank direct task evidence when the agent really needs current handoff, roadmap, files, symbols, and verification guidance.
- Agents need concise explanations of why each item was included, what evidence is still missing, and what local files or symbols to inspect next.
- Feedback can say a pack was selected or rejected, but it does not yet capture quality signals such as "useful but noisy" or "missing verification commands."
- Current output can include noisy inferred symbols from documentation or filenames, such as all-caps doc basenames or generic words like "Implemented" and "Added".
- Current output can misclassify ordinary roadmap words such as "next" as technologies.
- Continuation output does not yet provide a compact "recommended next code path" that tells the agent which local files, tests, or review queues to inspect first.

Session feedback from 2026-05-19:

- Tuberosa returned the right class of knowledge for Phase 9 continuation work: current handoff/roadmap-oriented memories, prior continuation retrieval lessons, graph-expansion lessons, and workflow guidance.
- The context was still noisier than ideal. Adjacent backup, migration, and scheduler memories appeared in supporting context for a roadmap-feedback task even though the immediate action was mostly documentation and session review.
- Signal hygiene still needs work. A prompt such as "Before ending the session..." produced generic symbols like `Before` and `Tuberosa`; previous continuation prompts also exposed words like `Added`, `Updated`, `Verified`, and `Next` as symbols or technologies.
- For a new task, Tuberosa should provide an explicit startup orientation: what local files to read first, why those files matter, which prior lessons are direct evidence, which items are only adjacent, and what verification commands are likely relevant.
- Agents need a first-class way to report context as "selected but noisy" or "selected but missing orientation" so useful packs can still produce improvement signals without being marked rejected.
- Agent-facing tool schemas should prevent avoidable startup mistakes. A session-start call with `taskType: "development"` failed because the runtime validator knew the enum but the MCP schema advertised a plain string.

Session feedback from Phase 10 continuation on 2026-05-19:

- Did Tuberosa feed appropriate knowledge?
  - Mostly yes. It retrieved current handoff/roadmap direction, continuation-retrieval lessons, graph-expansion lessons, and the user correction to query Tuberosa before Tuberosa work.
  - It still over-selected adjacent prior memories about backups, migrations, schedulers, and old MCP startup issues because those memories had high selected-feedback counts and broad symbols such as `Tuberosa`, `MCP`, `Agent`, and `Context`.
  - The pack was usable, but the agent had to manually separate direct evidence from prior lessons and adjacent memories. That manual separation should be Tuberosa's job.
- What should Tuberosa do when an agent approaches a new task?
  - Start with a compact orientation: inferred task, workflow stage, confidence, recommended files/docs to read first, likely implementation surface, likely verification commands, and unclear or missing signals.
  - Prioritize direct task evidence first: user-named files, handoff/roadmap docs for continuation, current source/test surfaces, exact symbols, exact errors, and high-confidence graph links.
  - Include prior lessons only after direct evidence, and label whether each lesson is a directly relevant prior lesson, general workflow guidance, or adjacent context.
  - If the task is vague, use recent selected sessions and handoff anchors, but clearly mark inferred context and ask for clarification when required evidence is missing.
- What improved through this task?
  - Done: context packs expose item-level `evidenceCategory`, `evidenceStrength`, `usefulnessReason`, and actionable missing-signal buckets.
  - Done: pack assembly sorts direct task evidence ahead of prior lessons, workflow guidance, and adjacent context before section budgeting.
  - Done: context packs include an `orientation` block with recommended files, likely surfaces, verification commands, missing-signal buckets, and uncertainty notes.
  - Done: MCP shortlist output exposes the new orientation and usefulness fields.
  - Done: classifier and continuation-signal hygiene suppress generic roadmap/meta words and avoid treating `next` as Next.js technology without stronger evidence.
- Remaining post-v1 polish:
  - Build a review workspace for context-quality feedback instead of relying only on API/MCP reports.
  - Clean up historical memories that still encode old roadmap ceilings through reviewed stale/supersedes workflows.
  - Revisit automatic session-memory approval policy against the original reviewed-memory intent.

Planned work:

- Add a context-pack usefulness layer that categorizes returned items:
  - `directTaskEvidence`: exact file, symbol, error, handoff, roadmap, or active-task matches.
  - `priorLessons`: selected memories directly tied to the task.
  - `workflowGuidance`: general project workflow rules.
  - `adjacentContext`: lower-priority related memories.
- Done: returned items include `evidenceCategory`, `evidenceStrength`, `usefulnessReason`, and item-level `actionableMissingSignals` derived from existing match, fit, feedback, and graph signals.
- Done: direct task evidence ranks above prior lessons, workflow guidance, and adjacent context during pack assembly.
- Done: normal startup packs cap `priorLessons` (default 6) and `adjacentContext` (default 4) categories during assembly. Debug retrieval and expanded deep-context budgets relax or uncap the limits, and pack-level confidence is computed from the prioritized list before capping so presentation does not regress confidence.
- Add new-task orientation behavior:
  - summarize the inferred task and confidence in one compact block
  - list files/docs the agent should load before editing, such as `handoff.md`, `tuberosa-project.md`, and roadmap files when applicable
  - list the most likely implementation or documentation surface
  - list likely verification commands or explain why verification is unclear
  - distinguish direct evidence from adjacent memories
- Done: context packs include an `orientation` block with inferred task, workflow stage, task type, recommended files, likely surfaces, likely Tuberosa verification commands, missing-signal buckets, and uncertainty notes.
- Add signal hygiene before presenting context:
  - suppress generic documentation words as symbols unless backed by code references
  - treat file basenames and all-caps document identifiers as file evidence, not symbol or error evidence, when they came from paths
  - Done: MCP schemas advertise canonical `taskType`, `contextMode`, feedback, learning, and reflection status enums from validation constants, and runtime validation normalizes common `taskType` aliases such as `development` to `implementation`.
  - Done: classifier and continuation-signal filters suppress generic roadmap/meta symbols such as `Before`, `Added`, `Updated`, `Verified`, `Tuberosa`, `Agent`, and `Context`.
  - Done: all-caps document identifiers with underscores, such as `AGENT_CONTEXT_ROADMAP` and `FLOW_LOGIC`, are filtered from symbol/error evidence while their `.md` paths remain file evidence.
  - Done: sequencing word `next` is no longer classified as Next.js technology unless stronger framework evidence is present.
- Add a compact orientation block for continuation/startup output:
  - recommended files to inspect first
  - likely implementation surface
  - likely verification commands
  - known doc or handoff gaps to ignore or clarify
- Add compact item explanations using existing retrieval signals:
  - why the item was included
  - evidence strength
  - freshness or stale risk
  - graph or feedback contribution
  - missing evidence, when applicable
- Done: MCP shortlist output surfaces the usefulness fields from pack assembly alongside existing match reasons and fit reasons.
- Group missing signals into actionable buckets:
  - files to inspect
  - symbols to inspect
  - docs or handoff gaps
  - unclear project or task intent
- Done: pack-level and item-level missing signals are grouped into `files`, `symbols`, `errors`, `docs`, `intent`, and `other`.
- Record optional context-quality feedback through existing feedback or session-decision metadata:
  - useful direct evidence
  - too much adjacent noise
  - useful but noisy
  - missing startup orientation
  - missing current handoff
  - missing verification commands
  - missing file or symbol references
- Done: first-class context-quality feedback types are now accepted by HTTP `/context/feedback`, MCP `tuberosa_feedback_context`, agent context decisions, and the new `tuberosa_append_session_note` tool:
  - `selected_but_noisy` keeps the pack `selected`, contributes a smaller ranking boost via `selectedNoisyCount`, and does not trigger retry.
  - `selected_but_noisy` is treated as a selected session decision for compliance and learning-pack selection.
  - `too_much_adjacent_context` creates a `missing_relation` learning proposal so reviewers can tighten labels/relations without retrying or boosting ranking.
  - `missing_orientation`, `missing_current_handoff`, and `missing_verification_commands` create `knowledge_gaps` review records with the specific feedback type captured in `metadata.feedbackType`.
  - `missing_orientation`, `missing_current_handoff`, and `missing_verification_commands` satisfy missing-context session compliance instead of leaving the session as undecided.
- Done: reflection-draft label/reference review is now supported via `PATCH /reflection-drafts/:id` (and `ReflectionService.updateDraft`). Reviewed labels run through the existing noisy-symbol/ambiguous-technology filter and through secret redaction, and references are persisted alongside the draft before approval.
- Done: a new `POST /agent-sessions/:id/notes` HTTP endpoint and `tuberosa_append_session_note` MCP tool append post-finish notes to `agent_sessions.metadata.notes`. When a `feedbackType` is supplied, the note is paired with a regular feedback event tagged `metadata.agentSessionId` and `metadata.postFinishNote: true` for downstream learning and audits.
- Done: context-quality feedback is reviewable through HTTP `GET /operations/context-quality` and MCP `tuberosa_collect_context_quality_feedback`, linking feedback to packs, sessions, adjacent items, open knowledge gaps, open learning proposals, and suggested review actions.
- Done: `usefulnessReason` now includes exact evidence, graph paths, feedback history, freshness/stale risk, and supersession suppression where present.

Acceptance:

- A new agent starting a Tuberosa task receives current handoff or roadmap context and the most relevant prior lessons without unrelated workflow memory dominating the pack.
- The output does not present generic roadmap/documentation words as important symbols or technologies unless there is concrete code evidence.
- Continuation output includes a concise next-step orientation that points the agent to the most likely local files and verification checks.
- Vague new-task output tells the agent which project files to load first and clearly separates direct evidence from adjacent memory.
- Each returned item explains why it was included in terms an agent can act on.
- Missing signals tell the agent what to inspect locally or ask the user next.
- Existing retrieval, feedback, session compliance, and deep-context behavior remain backward compatible.
- Agent feedback about useful but noisy context can be recorded and later used to improve ranking.

## Public API And Type Changes

- Add optional `contextFit` metadata to context pack responses.
- Add optional candidate fit reasons in MCP shortlist output.
- Add new session endpoints and MCP tools in Phase 2.
- Add `metadata.taxonomy` for knowledge and reflection memories in Phase 3.
- Add backup health, verification, and retention endpoints in Phase 6.
- Add relation inspection, graph export, and project-map endpoints in Phase 7.
- Add context compliance metadata and finish-session bypass reason support in Phase 8.
- Add one-call layered context return controls in Phase 8.5.
- Add knowledge-gap and conflict-review records in Phase 9.
- Add optional context-usefulness fields in Phase 10, such as `evidenceCategory`, `usefulnessReason`, `evidenceStrength`, and `actionableMissingSignals`.
- Add context-quality operations report fields in the post-v1 baseline, such as linked feedback records, adjacent item summaries, open gaps/proposals, and suggested review actions.
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
- Phase 6: backup scheduler, verification, retention, and restore preflight tests in memory mode plus Postgres integration coverage when Docker is available.
- Phase 7: relation inference, stale relation cleanup, graph export determinism, and graph-expanded retrieval tests.
- Phase 8: agent-context compliance eval for selected decisions, missing-context handling, bypasses, direct-search-only non-compliance, and finish warnings.
- Phase 8.5: one-call layered context tests for ready, needs-confirmation, insufficient, and backward-compatible two-step behavior.
- Phase 9: hard retrieval eval fixtures for vague continuation, stale semantic matches, supersession, conflict review, missing-context learning, and fallback policy.
- Phase 10: context-usefulness tests for item categorization, direct-evidence ranking over adjacent memories, explanation fields, actionable missing signals, context-quality feedback metadata, and context-quality operations reports.

## Assumptions

- Keep local-first operation excellent, but do not treat single-user or MCP-only usage as a product ceiling after the v1 roadmap.
- Frontend, workspace, hosted, collaboration, and richer agent-review experiences are valid post-v1 directions when they preserve reviewed memory, safety, provenance, and context-fit discipline.
- Do not add a validation dependency in Phase 0 unless local validators become too complex.
- Existing ingestion dedupe and atomic stale cleanup work is the baseline.
- The phase order described this v1 roadmap. After Phase 10, use it as historical baseline and plan the next product increment around user value, not as a restriction against creative Tuberosa work.
