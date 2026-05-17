# Tuberosa Handoff

Date: 2026-05-17

## Goal We Are Working Toward

Tuberosa is a local-first context broker for agentic AI tools. It should retrieve the right project and user knowledge before agents start work, preserve provenance through labels, references, scores, context packs, feedback, sessions, backups, graph relations, error incidents, and review decisions, and turn durable lessons into reviewed reflection memories so future agents avoid repeated mistakes.

The current work is still on the phase-integration track. Do not treat the v2 context-depth/mirror concerns as a separate project. They are the active Phase 8/9 hardening slice on top of the completed Phase 7 organization graph work.

Current roadmap state:

- Phase 0 through Phase 6 are complete.
- Phase 7 Knowledge Organization Graph core work is complete.
- Phase 8/9 context hardening is in progress:
  - layered deep context packs
  - agent context compliance metadata
  - live readable physical mirror under `.tuberosa/current`
  - mirror correctness and write optimization
- Remaining Phase 7 follow-ups are optional polish, not blockers for Phase 8/9:
  - CLI commands for organization exports
  - context-search enrichment from selected error-log summaries
- Raw error logs remain physical journals, not searchable durable knowledge. Durable lessons become searchable only through reviewed and approved reflection drafts.

The specific user concern driving the current slice:

- Context packs were too short for agents to continue complex work.
- Agents could skip Tuberosa or finish without proving context was selected, missing, or intentionally bypassed.
- `.tuberosa` physical data could drift behind live Postgres.
- Mirror sync must stay readable and current without becoming too expensive as history grows.

## Current State Of The Code

Phase 7 graph/memory/review foundation is implemented:

- `knowledge_relations` storage, migrations, memory/Postgres implementations, backup/restore coverage, validators, and operations APIs are implemented.
- Relation inference runs during ingestion from labels, references, source URI, metadata source paths, section paths, and agent-session provenance.
- Retrieval performs bounded graph expansion after metadata, lexical, memory, and vector candidate discovery.
- Context-pack assembly allows strong graph-evidence candidates through anchored thresholds, so one-hop related knowledge can reach agents without weakening semantic thresholds globally.
- Organization export surfaces exist for project maps, graph JSONL, and readable summaries.
- Pending reflection review tools are implemented:
  - `tuberosa_list_reflection_drafts`
  - `tuberosa_get_reflection_draft`
  - `tuberosa_review_reflection_draft`
- Startup migration preflight is implemented through `TUBEROSA_AUTO_MIGRATE=true` by default.

Error-log workflow is implemented:

- `ErrorLogService.collectLogs()` scans the filesystem-backed incident journal with filters and pagination.
- `ErrorLogInsightService` provides compact incident summaries, rollups, fingerprint clusters, an agent brief, reflection-draft creation from selected log ids, and structured resolution metadata.
- HTTP routes exist for collection, reflection draft creation, and resolution:
  - `GET /operations/error-logs/collection`
  - `POST /operations/error-logs/reflection-drafts`
  - `POST /operations/error-logs/:id/resolve`
- MCP tools/prompts exist for reviewing and fixing error logs.
- CLI commands exist through `pnpm run error-logs`:
  - `collect`
  - `list`
  - `get`
  - `draft`
  - `resolve`

Graph-aware context fit is implemented:

- Retrieval annotates graph-expanded candidates with anchored file, symbol, and error signals covered by seed candidates.
- Context-fit scoring gives graph-expanded candidates explicit `graph connection` reasons.
- Candidate fit reasons can include `connected file:...`, `connected symbol:...`, `connected error:...`, `connected session:...`, and `connected incident lesson`.
- Aggregate context fit can count graph-connected anchored signals as covered, so one-hop related knowledge explains why it belongs in the pack.
- Graph debug candidates include `graphPaths` with relation id, relation type, source knowledge id, target kind/value/id, confidence, and whether the candidate came from a direct target signal, outbound seed edge, or inbound seed edge.

Stale relation cleanup is implemented:

- Re-ingesting an atomized file as a single document deletes previous atom records and their inferred atom relations.
- Re-ingesting an atomized file removes deleted section atoms and cascades their relations.
- Archiving or blocking a knowledge item removes inferred relations from or to that item while preserving manually curated relations.

Phase 8/9 context-depth and compliance work is implemented:

- Retrieval defaults to layered context packs.
- `ContextSearchInput` supports `contextMode` and `deepContextBudget`.
- `TUBEROSA_CONTEXT_MODE=layered` and `TUBEROSA_DEEP_CONTEXT_BUDGET=60000` are documented.
- Compact `essential/supporting/optional` sections remain for shortlist review.
- `deepContext` expands selected knowledge from `knowledge_chunks` without the compact `2800/3600` character truncation.
- Deep context budget defaults to `60000` and is clamped to `30000..100000`.
- Memory and Postgres stores implement `listKnowledgeChunks(knowledgeIds)`.
- Agent session finish persists `metadata.contextCompliance`.
- `tuberosa_finish_session` accepts `contextBypassReason`.
- Compliance statuses are:
  - `compliant`
  - `needs_decision`
  - `missing_context_recorded`
  - `bypassed`
  - `non_compliant`
- `pnpm run eval:agent-context` checks the compliance workflow.

Physical mirror support is implemented and debounce-optimized:

- `.tuberosa/current` is a generated readable mirror of live DB state and is ignored by git.
- The mirror writes JSONL tables plus readable Markdown:
  - `knowledge.md`
  - `reflection-drafts.md`
  - `context-packs.md`
  - `agent-sessions.md`
- Mirror sync requests are fired after context search, context feedback, agent session start, context decision, session finish, knowledge ingestion/update, relation create/update/delete, file import/ingest, reflection create/update/review/approve, error-log reflection draft creation, cleanup, and backup restore.
- Mirror writes are serialized/coalesced while a sync is in flight.
- If a second request arrives during an active sync, the drain loop performs a second latest-state write after the active write finishes.
- Automatic `requestPhysicalMirror(reason)` calls use a timer debounce controlled by `TUBEROSA_PHYSICAL_MIRROR_DEBOUNCE_MS`, default `500`.
- Manual `syncPhysicalMirror(reason)` bypasses debounce and runs immediately.
- `BackupService.close()` clears pending mirror timers and flushes pending mirror work.
- Failed mirror writes clean up their temp directory.
- Context-pack Markdown rendering supports both Postgres nested `pack` rows and memory-store direct pack rows.

Important current limitation:

- Every mirror sync still exports all backup tables and writes all JSONL/Markdown. This is acceptable for small local data, especially with debounce, but dirty-table tracking or partial mirror writes may be useful later if real data volume makes full mirror writes too expensive.

## Files Actively Edited

Current Phase 8/9 context-depth, compliance, and mirror files:

- `src/types.ts`
- `src/config.ts`
- `src/validation.ts`
- `src/retrieval/context-pack.ts`
- `src/retrieval/service.ts`
- `src/storage/store.ts`
- `src/storage/memory-store.ts`
- `src/storage/postgres-store.ts`
- `src/agent-session/service.ts`
- `src/operations/backup-service.ts`
- `src/operations/service.ts`
- `src/app.ts`
- `src/http/server.ts`
- `src/mcp/server.ts`

Tests and eval:

- `test/retrieval.test.ts`
- `test/operations.test.ts`
- `test/api-boundary.test.ts`
- `test/config.test.ts`
- `test/agent-session.test.ts`
- `test/evaluation.test.ts`
- `test/flow-regression.test.ts`
- `test/integration.test.ts`
- `scripts/eval-agent-context.ts`
- `scripts/eval-retrieval.ts`

Docs/config:

- `.env.example`
- `.gitignore`
- `README.md`
- `docs/SETUP_AND_USAGE.md`
- `handoff.md`
- `handoff-ver2.md`
- `package.json`

Earlier Phase 7 slices also touched or depend on:

- `docs/AGENT_CONTEXT_ROADMAP.md`
- `docs/FLOW_LOGIC.md`
- `scripts/error-logs.ts`
- `scripts/eval-retrieval.ts`
- `src/cache.ts`
- `src/ingest/service.ts`
- `src/error-log/insights.ts`
- `src/reflection/service.ts`
- `src/relations/inference.ts`
- `src/retrieval/context-fit.ts`
- `src/retrieval/debug.ts`
- `src/retrieval/fusion.ts`
- migrations under `migrations/`
- several tests under `test/`

Generated/local data:

- `.tuberosa/current/` is generated and ignored by git.
- `.tuberosa/backups/` and `.tuberosa/error-logs/` are ignored because they can contain private project knowledge.

Note:

- `AGENTS.md` is currently modified in the worktree, but it was not edited as part of the Phase 8/9 audit-fix session. Treat it as an existing/user-side change unless confirmed otherwise.

## Everything Tried That Failed

Recent failures or corrections:

- GitNexus MCP `list_repos` was cancelled by the environment during audit, so code review continued through direct source inspection and tests.
- `pnpm run eval:agent-context` failed inside the sandbox with `listen EPERM /tmp/tsx-1000/...pipe`. This is the known `tsx` IPC sandbox limitation. Rerunning with approved escalation passed.
- The first focused `test/operations.test.ts` run after adding mirror coverage failed because `context-packs.md` did not include the prompt for memory-store exports. Root cause: the Markdown renderer assumed Postgres rows had a nested `pack` object, while memory-store backup rows are direct pack objects. Fixed with `nestedOrRowRecord()`.
- Manual mirror sync previously failed inside the sandbox with `connect EPERM 127.0.0.1:5432`. This is local Postgres network sandboxing. Rerunning with approved escalation passed.
- The first full `pnpm test` after adding physical mirror calls failed in `test/api-boundary.test.ts` because fake `operations` mocks did not include `requestPhysicalMirror`. Fixed by updating test fakes.
- Earlier `pnpm test` after adding error-log collection failed in `test/error-log.test.ts`. The duplicate-fingerprint fixture did not include the same stack top frame, so the two intended duplicate incidents were treated as separate fingerprints. The fixture was corrected.

Older useful failures:

- Earlier Phase 7 graph work initially failed build due to narrow TypeScript inference in `src/relations/inference.ts`; fixed by building a typed `RelationSeed[]`.
- Graph expansion initially appeared in debug but was filtered during context-pack assembly; fixed with a narrow graph-evidence allowance.
- Reflection review build/tests initially failed around optional rubric metadata and prompt expectations; validation now compacts undefined fields and tests include the pending-reflection prompt.

No current verification command is failing after the latest audit fixes. The only repeat failure is the known sandbox `tsx` IPC limitation for `pnpm run eval:agent-context`; rerun outside the sandbox or with approved escalation.

## Verification Already Run

These passed after the latest audit fixes:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
git diff --check --cached && git diff --check
```

Focused checks also passed:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/retrieval.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/operations.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/api-boundary.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --import tsx test/operations.test.ts
```

Earlier smoke checks passed:

```bash
pnpm run error-logs --help
pnpm run error-logs list --project tuberosa --limit 2
```

Those error-log CLI checks required running outside the sandbox because `tsx` could not open its IPC socket inside the sandbox.

Latest debounce-slice verification also passed:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
git diff --check
```

`pnpm run eval:agent-context` still hits the known sandbox `tsx` IPC `listen EPERM /tmp/tsx-1000/...pipe` failure inside the sandbox; rerunning outside the sandbox with approval passed.

## Continue From Here

The next agent should continue the same Phase 8/9 integration slice. Do not restart from Phase 7 or split this into a separate v2 project.

Recommended next step:

1. Improve continuation-aware retrieval for handoff-style work.
   - The latest Tuberosa session retrieved a loosely relevant pack first and missed `handoff.md`, `src/config.ts`, and `test/operations.test.ts`.
   - The later targeted layered search returned a useful backup-scheduler memory and valid `deepContext.sections`, but still missed the config/test files.
   - Consider using recent session/handoff signals more strongly, and consider indexing or linking handoff-style docs as first-class continuation context.

2. Normalize pending reflection draft labels before approval.
   - Draft `a6ff6e04-e1b3-4527-81ce-bff14626f6f9` was reviewed and marked `needs_changes`.
   - Accuracy, usefulness, scope, references, privacy, and duplicate risk passed.
   - Labels need cleanup because suggested labels included noisy generic values such as `The`, `rest`, and `go`.

3. Optional later hardening.
   - Add supersession/conflict handling so newer memories can suppress stale ones.
   - Add a CLI command for physical mirror sync/status.
   - Add a human-friendly context-pack inspection command that prints compact plus deep context together.
   - Consider dirty-table tracking and partial mirror writes only if real data volume makes full mirror writes too expensive.

Before accepting or committing, rerun:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
git diff --check --cached && git diff --check
```
