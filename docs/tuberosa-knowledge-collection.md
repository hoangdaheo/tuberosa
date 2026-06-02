# Tuberosa Knowledge Collection

Status: created 2026-06-02 from current repo docs, source files, Tuberosa atlas, and MCP tool checks.

Purpose: give a future engineer or agent a simple way to understand Tuberosa and work safely. This is not a full code audit. It is a project map, a flow map, and a set of working rules.

Important note: GitNexus was stale during this pass. `npx gitnexus analyze` was run but exited non-zero without useful output. Treat GitNexus graph data as not trusted until it is refreshed.

## Fast Summary

Tuberosa is a local-first context broker for coding agents.

It does three main jobs:

1. Find the right project knowledge for the current agent task.
2. Record what context the agent used and whether it was useful.
3. Turn useful lessons into reviewed memory so future agents repeat fewer mistakes.

The main product path is:

```text
agent prompt
-> MCP tool or HTTP route
-> RetrievalService.searchContext
-> classify prompt signals
-> search metadata, lexical, vector, memories, worktree, atoms, user style, conventions
-> fuse and rerank candidates
-> check context fit
-> build context pack
-> agent records decision
-> finish session
-> reflection draft or atom learning
```

## How To Start Work

Use this order before substantial work:

1. Read `docs/tuberosa-project.md` for product intent.
2. Read `docs/superpowers/NEXT-SESSION-PROMPT.md` for current work state. There is no root `handoff.md` right now.
3. Start a Tuberosa session or search context. If fit is weak, do not rely on the pack.
4. Read current source files directly for the area you will touch.
5. For code edits, run GitNexus impact on the symbol before editing when GitNexus is fresh.
6. Run the correct verification commands for the changed area.
7. Record context feedback and finish the Tuberosa session.

## Current Project State

Labels:
- `project:tuberosa`
- `type:project_state`
- `domain:handoff`
- `domain:knowledge_book`

Facts:
- The current active work is "Project Knowledge-Book" phases 3, 4a, and 4b.
- Phase 1 and Phase 2 are described as shipped in `docs/superpowers/NEXT-SESSION-PROMPT.md`.
- The approved design is `docs/superpowers/specs/2026-05-31-project-knowledge-book-design.md`.
- The next work should start with `docs/superpowers/plans/2026-05-31-project-knowledge-book-phase3-handbook-view.md`.
- `tuberosa_get_atlas` showed `conventions.md` is empty.
- `tuberosa_atom_graph_density` showed 0 atoms and 0 atom edges in the current Tuberosa store.
- `tuberosa_bootstrap_handbook` can assemble deterministic evidence for handbook conventions, but the calling agent must write the actual convention drafts.

Risk:
- Do not assume project conventions already exist in Tuberosa. They need reviewable drafts and human approval.

## Main Areas

### App Composition

Labels:
- `domain:app`
- `file:src/app.ts`
- `symbol:createAppServices`

Purpose:
`createAppServices()` is the composition root. HTTP, MCP, worker, and tests use the same service wiring.

Key files:
- `src/app.ts`
- `src/config.ts`
- `src/index.ts`
- `src/mcp-stdio.ts`
- `src/worker.ts`

Main services:
- config
- store
- cache
- model provider
- safety
- ingestion
- retrieval
- reflection
- agent sessions
- operations
- maintenance
- curation

Working rule:
When adding a new service, wire it once in `createAppServices()` and reuse that service from HTTP, MCP, worker, or tests.

### HTTP Surface

Labels:
- `domain:http`
- `file:src/http/server.ts`
- `technology:node`

Purpose:
The HTTP API serves retrieval, sessions, knowledge CRUD, reflection review, operations, backups, error logs, imports, exports, and maintenance.

Key file:
- `src/http/server.ts`

Important behavior:
- `/health` is public.
- Other routes use `TUBEROSA_API_KEY` if set.
- Routes are defined in `createRoutes()`.
- Route input goes through validators in `src/validation.ts`.
- Errors map through `src/errors.ts`.

When adding a route:
1. Add a route in `createRoutes()`.
2. Validate the body or query.
3. Call a service method.
4. If taking a filesystem path, use safe path confinement.
5. Add a test.

### MCP Surface

Labels:
- `domain:mcp`
- `file:src/mcp/server.ts`
- `file:src/mcp/tool-definitions.ts`
- `file:src/mcp-stdio.ts`

Purpose:
The MCP stdio server is the first-class agent integration.

Key files:
- `src/mcp-stdio.ts`
- `src/mcp/server.ts`
- `src/mcp/tool-definitions.ts`
- `src/mcp/helpers.ts`
- `src/mcp/prompts.ts`

Important behavior:
- `src/mcp-stdio.ts` reads JSON-RPC frames from stdin.
- It writes JSON-RPC only to stdout.
- Diagnostics must go to stderr.
- MCP stdio defaults `TUBEROSA_CACHE=memory` if not set.
- One JSON-RPC frame is capped at 16 MiB.

When adding a tool:
1. Add the schema in `src/mcp/tool-definitions.ts`.
2. Add a `case` in `callTool()` in `src/mcp/server.ts`.
3. Validate arguments with helpers or validators.
4. Return `toolJson(...)`.
5. Add tests through `handleMcpRequest`.

Hard rule:
Never add `console.log` or any stdout diagnostic in MCP stdio code. It can break clients.

### Retrieval

Labels:
- `domain:retrieval`
- `business_area:search`
- `file:src/retrieval/service.ts`
- `symbol:RetrievalService`
- `symbol:searchContext`

Purpose:
Retrieval is the core product path. It decides what context an agent should read for a task.

Key files:
- `src/retrieval/service.ts`
- `src/retrieval/classifier.ts`
- `src/retrieval/fusion.ts`
- `src/retrieval/context-fit.ts`
- `src/retrieval/context-pack.ts`
- `src/retrieval/policy.ts`
- `config/retrieval-policy.json`

Flow:
1. Redact unsafe search input.
2. Preprocess long prompts.
3. Classify files, symbols, errors, task type, tech, business areas, and exact terms.
4. Optionally rewrite query only when the probe is weak.
5. Search these lanes in parallel:
   - metadata
   - lexical
   - memory
   - vector
   - worktree
   - atoms
   - user style
   - conventions
6. Expand graph relations and atom graph hits.
7. Fuse candidates with weighted reciprocal rank fusion.
8. Rerank with the model provider.
9. Apply feedback, stale, superseded, and intent suppression.
10. Evaluate context fit.
11. Assemble essential, supporting, and optional sections.
12. In layered mode, add deep context chunks.

Important behavior:
- User-style atoms intentionally bypass the project namespace filter.
- Team/project convention atoms also bypass namespace filter so team rules can surface.
- Convention candidates are pinned to the front of `essential`, max 5.
- `noiseTolerance:"strict"` drops weak candidates.
- `debug:true` skips cache and returns stage diagnostics.

Verification:
- Any classifier, fusion, rerank, context-fit, context-pack, or retrieval policy change must run `pnpm run eval:retrieval`.
- Add a fixture before adding a retrieval heuristic.
- Do not lower eval thresholds to pass.

Known current gotcha:
The classifier can treat capitalized plain words as symbols. In this session it extracted `Fully`, `English`, and `Cover` from a plain-language request. This caused an off-target context pack. When a pack looks wrong, record feedback and read source directly.

### Knowledge Ingestion

Labels:
- `domain:ingestion`
- `file:src/ingest/service.ts`
- `symbol:IngestionService`

Purpose:
Ingestion stores knowledge items, labels, references, chunks, embeddings, and inferred relations.

Key files:
- `src/ingest/service.ts`
- `src/ingest/document-atomizer.ts`
- `src/ingest/duplicate-detector.ts`
- `src/ingest/item-type-inference.ts`
- `src/ingest/label-enricher.ts`
- `src/relations/inference.ts`
- `src/relations/ontology.ts`

Flow:
1. Check content size limit.
2. Sanitize knowledge input.
3. Infer item type if needed.
4. Enrich labels.
5. Reject duplicates.
6. Build chunks and embeddings.
7. Upsert knowledge.
8. Replace inferred relations.
9. In atomic mode, clean stale file atoms.

Important behavior:
- `ingestFiles()` is sequential. One file error is captured in the result and does not stop every later file.
- `DuplicateIngestionError` should usually be treated as a skip.
- The security module can reject itself during self-ingest because it contains blocked patterns.

### Storage

Labels:
- `domain:storage`
- `technology:postgres`
- `file:src/storage/store.ts`
- `file:src/storage/postgres-store.ts`
- `file:src/storage/memory-store.ts`

Purpose:
The storage layer is the source of truth interface. Postgres is durable. Memory store is used for tests and embedded flows.

Key files:
- `src/storage/store.ts`
- `src/storage/postgres-store.ts`
- `src/storage/memory-store.ts`
- `src/storage/factory.ts`
- `src/storage/migrations.ts`
- `migrations/*.sql`

Main tables:
- `projects`
- `knowledge_items`
- `knowledge_sources`
- `labels`
- `knowledge_labels`
- `knowledge_references`
- `knowledge_chunks`
- `knowledge_relations`
- `reflection_drafts`
- `context_queries`
- `context_packs`
- `feedback_events`
- `agent_sessions`
- `agent_context_decisions`
- `knowledge_atoms`
- `source_files`
- `sync_runs`
- `atlas_runs`

Working rules:
- Add store methods to `KnowledgeStore`.
- Implement both Postgres and memory stores.
- Keep edge behavior the same in both stores.
- If a query casts IDs to `uuid`, protect it from non-UUID worktree IDs.
- Do not create a table named `references`; SQL reserves that word. Use `knowledge_references`.

Verification:
- Storage changes need `pnpm run build`, `pnpm test`, and usually `pnpm run test:integration`.
- Use parity tests when memory and Postgres behavior can drift.

### Agent Sessions

Labels:
- `domain:agent-session`
- `file:src/agent-session/service.ts`
- `symbol:AgentSessionService`

Purpose:
Agent sessions audit the whole task: starting context, context decisions, learning signals, notes, final outcome, and possible learning draft.

Key files:
- `src/agent-session/service.ts`
- `src/agent-session/research-trace.ts`
- `src/operations/session-replay.ts`
- `src/types/session.ts`

Flow:
1. `startSession` calls retrieval.
2. It creates an active session with the initial context pack id.
3. The agent records context decisions.
4. The agent can capture learning signals or notes.
5. `finishSession` computes compliance and research trace.
6. It may create a reflection draft or auto-approved memory depending on gates.
7. It extracts atoms if the model provider supports atom extraction.
8. It routes user preference signals.
9. It may return a curation nudge when many un-curated atoms exist.

Important behavior:
- `startSession` returns policy: proceed, confirm, or request missing signals.
- It also returns handbook status.
- Current handbook status is empty for this project.

Verification:
- Run `pnpm run eval:agent-context` after changes to session lifecycle or session MCP tools.

### Reflection Memory

Labels:
- `domain:reflection`
- `file:src/reflection/service.ts`
- `symbol:ReflectionService`

Purpose:
Reflection memory turns useful lessons into reviewed drafts. Drafts are not trusted context until approved.

Key files:
- `src/reflection/service.ts`
- `src/reflection/write-gate.ts`
- `src/reflection/recommendation.ts`
- `src/agent-session/service.ts`

Flow:
1. Create draft manually with `tuberosa_reflect` or automatically on session finish.
2. Sanitize content and labels.
3. Search similar memories.
4. Compute write-gate result.
5. Store draft pending review.
6. On approval:
   - normal drafts become `itemType:"memory"` knowledge
   - convention drafts become `type:"convention"` atoms

Working rule:
Do not treat raw session text as durable memory. Use reviewable drafts.

### Atoms, User Style, And Conventions

Labels:
- `domain:atoms`
- `domain:user-style`
- `domain:conventions`
- `file:src/types/atoms.ts`
- `file:src/atoms/critic.ts`
- `file:src/user-style/conflict-resolver.ts`

Purpose:
Atoms are small claims with evidence and triggers. User-style atoms are personal cross-project rules. Convention atoms are project or team rules that can be pinned in context packs.

Atom types:
- `fact`
- `procedure`
- `decision`
- `gotcha`
- `convention`

Atom scopes:
- `project`
- `user`
- `team`

Important behavior:
- `scope:"user"` can cross project boundaries.
- `scope:"team"` was added for Knowledge-Book.
- `personal_workflow` beats project rules.
- Project rules beat team rules and normal personal coding preferences.
- Convention atoms are rendered into atlas `conventions.md`.

Current state:
- This project currently has no atoms and no conventions in the Tuberosa store.

### Curation And Handbook

Labels:
- `domain:curation`
- `domain:atlas`
- `domain:knowledge_book`
- `file:src/curation/service.ts`
- `file:src/atlas/service.ts`

Purpose:
The Knowledge-Book feature makes project conventions readable and retrievable.

Key files:
- `src/curation/service.ts`
- `src/curation/bootstrap-extract.ts`
- `src/curation/cluster.ts`
- `src/atlas/service.ts`
- `src/atlas/builders.ts`

Mechanisms:
- `tuberosa_bootstrap_handbook` gathers deterministic evidence.
- The calling agent distills that evidence into convention drafts.
- `tuberosa_propose_curation` clusters un-curated atoms.
- `AtlasService` builds `project-map.md`, `flows.md`, `commands.md`, `risks.md`, `open-gaps.md`, and `conventions.md`.

Important limit:
Tuberosa has no internal text-generation seam for this. The calling agent does the writing. Tuberosa only stores and gates the result.

### Source Sync, Atlas, Bootstrap, Export

Labels:
- `domain:source-sync`
- `domain:atlas`
- `domain:export`
- `file:src/source-sync/service.ts`
- `file:src/bootstrap/service.ts`
- `file:src/export/exporter.ts`

Purpose:
These systems keep project knowledge aligned with files, make it readable, and package it for another person or machine.

Source sync behavior:
- Added files are ingested.
- Changed files are re-ingested.
- Renamed files are re-pointed.
- Deleted files are archived only after confirmation.
- The git hook never archives deleted knowledge.

Atlas behavior:
- Derived from store data.
- Deterministic.
- Never authoritative.
- Failure to regenerate is non-fatal.

Export behavior:
- Writes atoms, knowledge, edges, chunks, user-style, and manifest.
- Redacts secrets before writing.
- Export/import paths are confined to configured base directories.

### Security

Labels:
- `domain:security`
- `file:src/security/knowledge-safety.ts`
- `file:src/security/safe-paths.ts`

Purpose:
Keep unsafe text out of durable knowledge and returned context.

Important behavior:
- Secrets are redacted.
- Prompt-injection and malware-like patterns can be blocked.
- Search input is redacted before retrieval.
- Knowledge input is sanitized before label enrichment.
- Reflection drafts are sanitized before storage.
- Retrieved candidates are sanitized before returning.
- Export/import filesystem paths are confined.

Verification:
- Security checks need focused tests.
- Run `pnpm run eval:safety` when changing redaction or blocking logic.

### Model Providers

Labels:
- `domain:model`
- `file:src/model/provider.ts`
- `file:src/model/factory.ts`

Purpose:
Model providers give embeddings, query rewrite, rerank, optional atom extraction, optional atom utility judgment, and optional prompt intent extraction.

Providers:
- `hash`: deterministic, no API key, used in tests.
- `openai`: embeddings, rewrite, rerank, optional judgments.
- `local`: registry-backed local provider.
- `ollama`: local Ollama provider.

Important behavior:
- Hash provider has no real LLM reasoning.
- If OpenAI settings are not present, provider methods fall back or return no rewrite.
- Do not add product logic that requires model text generation unless the interface is extended and evals are updated.

## Common Workflows

### Add A Retrieval Signal

Labels:
- `workflow:retrieval_change`
- `task_type:implementation`

Steps:
1. Add or update a failing case in `eval/retrieval-fixtures.json`.
2. Run `pnpm run eval:retrieval` and confirm the expected failure.
3. Change classifier, policy, fusion, or context fit logic.
4. Run `pnpm run eval:retrieval` again.
5. Run `pnpm run build` and `pnpm test`.

### Add A Store Method

Labels:
- `workflow:storage_change`
- `task_type:implementation`

Steps:
1. Add method to `src/storage/store.ts`.
2. Implement in `src/storage/postgres-store.ts`.
3. Implement in `src/storage/memory-store.ts`.
4. Add or update migrations if schema changes.
5. Add tests for both memory and Postgres behavior when possible.
6. Run `pnpm run build`, `pnpm test`, and `pnpm run test:integration`.

### Add An MCP Tool

Labels:
- `workflow:mcp_change`
- `task_type:implementation`

Steps:
1. Add tool schema to `src/mcp/tool-definitions.ts`.
2. Add `case` in `src/mcp/server.ts`.
3. Use validation helpers.
4. Return JSON with `toolJson`.
5. Test through `handleMcpRequest`.
6. Confirm no stdout diagnostics.

### Add An HTTP Route

Labels:
- `workflow:http_change`
- `task_type:implementation`

Steps:
1. Add route to `createRoutes()` in `src/http/server.ts`.
2. Validate request body or query.
3. Use app services.
4. Map errors through existing error classes.
5. If using paths, use safe path helpers.
6. Add route tests.

### Add A Convention

Labels:
- `workflow:knowledge_book`
- `task_type:knowledge_curation`

Steps:
1. Gather evidence with `tuberosa_bootstrap_handbook` or `tuberosa_propose_curation`.
2. Distill one simple rule per topic.
3. Create a reflection draft with `metadata.convention=true`.
4. Include `scope`, `category`, `steps`, `trigger`, and evidence references.
5. Leave it pending review unless the user explicitly approves it.
6. After approval, it becomes a convention atom and can appear in `conventions.md`.

## Verification Matrix

Use this before handing off changes:

| Change area | Minimum checks |
|---|---|
| Docs only | `git diff --check` |
| TypeScript code | `pnpm run build`, `pnpm test`, `git diff --check` |
| Retrieval, classifier, fusion, rerank, context pack | `pnpm run eval:retrieval`, `pnpm run build`, `pnpm test`, `git diff --check` |
| Agent session lifecycle | `pnpm run eval:agent-context`, `pnpm run build`, `pnpm test`, `git diff --check` |
| Reflection or knowledge completeness | `pnpm run eval:knowledge-completeness`, `pnpm run build`, `pnpm test`, `git diff --check` |
| Safety | `pnpm run eval:safety`, `pnpm run build`, `pnpm test`, `git diff --check` |
| Storage, migrations, cache, Docker | `pnpm run test:integration`, `pnpm run build`, `pnpm test`, `git diff --check` |
| Export/import or filesystem paths | focused export/import tests, safe-path tests, `pnpm run build`, `pnpm test`, `git diff --check` |

Do not run multiple `pnpm` commands at the same time.

## Important Commands

Build and test:

```bash
pnpm run build
pnpm test
pnpm run test:integration
```

Retrieval and context evals:

```bash
pnpm run eval:retrieval
pnpm run eval:agent-context
pnpm run eval:knowledge-completeness
pnpm run eval:context-mapping
pnpm run eval:safety
```

Dev servers:

```bash
pnpm run dev
pnpm run mcp
pnpm run worker
```

Data and operations:

```bash
pnpm run migrate
pnpm run seed:self
pnpm run backup
pnpm run restore
pnpm run context-quality -- --project tuberosa
pnpm run error-logs
```

If Node is wrong, prefix commands with:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH
```

## Knowledge Labels To Use Later

Use these labels when creating new Tuberosa knowledge:

Area labels:
- `domain:app`
- `domain:http`
- `domain:mcp`
- `domain:retrieval`
- `domain:ingestion`
- `domain:storage`
- `domain:agent-session`
- `domain:reflection`
- `domain:atoms`
- `domain:user-style`
- `domain:conventions`
- `domain:curation`
- `domain:atlas`
- `domain:source-sync`
- `domain:export`
- `domain:operations`
- `domain:security`
- `domain:model`

Task labels:
- `task_type:exploration`
- `task_type:implementation`
- `task_type:debugging`
- `task_type:refactor`
- `task_type:review`
- `task_type:testing`
- `task_type:planning`

Technology labels:
- `technology:typescript`
- `technology:node`
- `technology:postgres`
- `technology:pgvector`
- `technology:redis`
- `technology:mcp`
- `technology:docker`
- `technology:openai`
- `technology:ollama`

Evidence labels:
- `file:<repo-relative-path>`
- `symbol:<function-or-class-name>`
- `error:<exact-error-code-or-message>`

Quality labels:
- `knowledge_kind:rule`
- `knowledge_kind:workflow`
- `knowledge_kind:gotcha`
- `knowledge_kind:code_ref`
- `knowledge_kind:project_state`

## Gotchas

1. Root `handoff.md` is missing. Use `docs/superpowers/NEXT-SESSION-PROMPT.md`.
2. GitNexus is stale right now. Refresh it before symbol impact work.
3. Tuberosa context search can return weak packs for broad plain-English requests. Check `contextFit`.
4. MCP stdout must stay JSON-RPC only.
5. Do not store secrets or prompt-injection content as knowledge.
6. `EMBEDDING_DIMENSIONS` must match `vector(1536)` unless a migration changes it.
7. The security module can block self-ingest of its own pattern text.
8. Memory store and Postgres store must stay behavior-compatible.
9. Source sync archives deleted-file knowledge only after confirmation.
10. The atlas is derived. It is useful, but it is not the source of truth.
11. Reflection drafts are not searchable memory until approved.
12. Current conventions are empty, so future agents will not get project rules from the convention lane yet.

## Source References Used

Main docs:
- `docs/tuberosa-project.md`
- `docs/superpowers/NEXT-SESSION-PROMPT.md`
- `README.md`
- `wiki/02-architecture.md`
- `wiki/03-knowledge-model.md`
- `wiki/04-retrieval-pipeline.md`
- `wiki/05-agent-session-lifecycle.md`
- `wiki/06-reflection-memory.md`
- `wiki/07-atoms-and-user-style.md`
- `wiki/13-operations-runbook.md`
- `wiki/14-development-and-extension.md`
- `wiki/15-source-lifecycle-sync.md`
- `wiki/16-project-atlas.md`
- `wiki/17-bootstrap-and-export-v2.md`

Main source:
- `src/app.ts`
- `src/http/server.ts`
- `src/mcp/server.ts`
- `src/mcp/tool-definitions.ts`
- `src/mcp-stdio.ts`
- `src/retrieval/service.ts`
- `src/retrieval/context-pack.ts`
- `src/ingest/service.ts`
- `src/storage/store.ts`
- `src/agent-session/service.ts`
- `src/reflection/service.ts`
- `src/curation/service.ts`
- `src/curation/bootstrap-extract.ts`
- `src/atlas/service.ts`
- `src/atlas/builders.ts`
- `src/source-sync/service.ts`
- `src/export/exporter.ts`
- `src/security/knowledge-safety.ts`
- `src/model/provider.ts`
- `src/model/factory.ts`
- `src/types/atoms.ts`

Main schema:
- `migrations/001_init.sql`
- `migrations/005_knowledge_atoms.sql`
- `migrations/010_user_style_atoms.sql`
- `migrations/011_source_files.sql`
- `migrations/012_atlas_runs.sql`
- `migrations/013_team_scope.sql`
