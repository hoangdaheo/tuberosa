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

- Add optional provider-backed query rewriting.
- Add optional provider-backed reranking.
- Keep hash reranking as deterministic default for tests and local/offline mode.
- Expand `eval/retrieval-fixtures.json` with expected fit status, selected IDs, rejected IDs, and confidence thresholds.
- Require `pnpm run eval:retrieval` before and after any ranking change.

Acceptance:

- Provider-backed mode improves eval quality without breaking hash-mode tests.
- Retrieval debug shows rewrite/rerank inputs and decisions without storing verbose debug data.

## Phase 6: Backup Sync And Disaster Recovery

Goal: make Postgres and the physical backup folder work as a reliable recovery system, not only manual snapshots.

Current baseline:

- Postgres is the runtime source of truth.
- `TUBEROSA_BACKUP_DIR` stores portable JSONL snapshots with `manifest.json` plus table-level files.
- Backups include `knowledge_chunks` and embeddings so restored knowledge remains retrievable.
- Restore is currently a destructive replace operation guarded by dry-run and `replace: true`.

Planned work:

- Add scheduled backups with configurable interval, startup delay, retention count, and retention age.
- Add a backup catalog/status endpoint that reports latest backup, row counts, age, source store, manifest version, and health.
- Add backup verification that reads a backup back from disk, validates manifest/table coverage, checks row counts, and verifies required retrieval tables are present.
- Add restore preflight checks that compare backup schema/table versions with the running app before allowing replace restore.
- Add optional write-through backup after important mutations, such as approved reflections or bulk imports, with throttling so normal ingestion is not slowed by disk writes.
- Add retention pruning that deletes only complete backup directories with valid manifests and never deletes the latest successful backup.
- Add backup integrity metadata:
  - checksum per JSONL file
  - app version or commit when available
  - schema/migration version
  - embedding dimensions and model provider metadata
- Add recovery runbooks for:
  - dry-run restore
  - replace restore
  - restoring on a fresh machine
  - handling embedding dimension mismatch
- Keep exact Postgres `pg_dump`/`pg_restore` as a future optional mode for full database disaster recovery, separate from portable JSONL backups.

Acceptance:

- A local stack can automatically create backups without user-triggered CLI or HTTP calls.
- Backup health is visible through HTTP and CLI without reading files manually.
- A corrupt, incomplete, or schema-incompatible backup fails verification before restore.
- Retention pruning is deterministic and covered by tests.
- Restore dry-run and replace restore continue to preserve retrievable chunks and embeddings.
- Manual JSONL backup and restore commands remain backward compatible.

## Phase 7: Knowledge Organization Graph

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
- Add graph-aware context-fit signals showing which files, symbols, errors, and sessions are connected.
- Add debug trace fields explaining why related knowledge entered a context pack.
- Add export commands and HTTP endpoints for project maps and graph JSONL.
- Add stale relation cleanup when document atoms are re-ingested or sources are archived.
- Keep graph traversal bounded so weakly related knowledge does not flood agent context.

Acceptance:

- Agents can receive context that includes directly matched knowledge plus clearly explained one-hop related knowledge.
- Users can inspect a project map without reading raw database rows.
- Retrieval debug shows relation paths used to include graph-expanded candidates.
- Re-ingesting an atomic document removes stale atom relations.
- Generated organization exports are reproducible and are not treated as the runtime source of truth.
- Existing search, backup, restore, and reflection flows continue to work when no relations exist.

## Phase 8: Retrieval Quality Hardening

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
- Add continuation-aware retrieval using agent sessions, latest context decisions, recent reflection drafts, and handoff-style knowledge.
- Add stale-memory suppression that combines freshness, feedback, supersession relations, and context-fit mismatch before final ranking.
- Add explicit conflict and supersession handling:
  - `supersedes` relation support in ranking
  - conflict detection for knowledge with overlapping labels/references but contradictory summaries or freshness
  - review queue for unresolved conflicts
- Add provider-backed reranking prompts that prefer evidence coverage over generic semantic similarity.
- Add negative feedback learning:
  - rejected or stale context can propose missing labels, missing relations, or supersession edges
  - missing-context feedback can create reviewable "knowledge gap" records
- Add retrieval fallback policy:
  - exact anchored search first
  - relation expansion second
  - provider rewrite/rerank third
  - ask for clarification when required evidence is missing
- Add context-pack explanations that tell agents:
  - why each item was included
  - what important evidence is missing
  - whether any returned item may be stale, weakly related, or superseded
- Expand retrieval evaluation fixtures with hard cases:
  - vague continuation prompts
  - stale semantically similar memories
  - conflicting memories
  - superseded workflows
  - missing-context retry behavior
  - graph-expanded retrieval

Acceptance:

- Vague continuation prompts retrieve recent session, handoff, and related workflow context when available.
- Stale semantically similar memories do not outrank fresh exact or graph-related context.
- Superseded knowledge is demoted or excluded unless explicitly requested for history.
- Missing-context feedback creates actionable review records instead of only lowering confidence.
- Retrieval debug explains whether ranking was driven by exact match, rewrite, graph relation, feedback, freshness, or fallback.
- Eval fixtures cover the known failure mode where an unrelated Docker migration memory beat backup or roadmap context.
- Hash-mode tests remain deterministic; provider-mode behavior is covered with mocked responses.

## Public API And Type Changes

- Add optional `contextFit` metadata to context pack responses.
- Add optional candidate fit reasons in MCP shortlist output.
- Add new session endpoints and MCP tools in Phase 2.
- Add `metadata.taxonomy` for knowledge and reflection memories in Phase 3.
- Add backup health, verification, and retention endpoints in Phase 6.
- Add relation inspection, graph export, and project-map endpoints in Phase 7.
- Add knowledge-gap and conflict-review records in Phase 8.
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
- Phase 8: hard retrieval eval fixtures for vague continuation, stale semantic matches, supersession, conflict review, missing-context learning, and fallback policy.

## Assumptions

- Keep Tuberosa local-first and single-user for now.
- Do not add a frontend in this roadmap; expose admin/review capability through HTTP first.
- Do not add a validation dependency in Phase 0 unless local validators become too complex.
- Existing ingestion dedupe and atomic stale cleanup work is the baseline.
- Phases should be implemented in order, and each phase should be merged only after its tests pass.
