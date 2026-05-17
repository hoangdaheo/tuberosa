# Tuberosa Handoff

Date: 2026-05-17

## Goal We Are Working Toward

Tuberosa is a local-first context broker for agentic AI tools. It should retrieve the right project/user knowledge before an agent starts work, preserve provenance through labels/references/scores/context packs/feedback/sessions/backups, and turn durable lessons into reviewed reflection memories so future agents avoid repeated mistakes.

The current roadmap state is:

- Phase 0 through Phase 6 are complete.
- Phase 7 Knowledge Organization Graph has been started in this session.
- The first Phase 7 slice is implemented and verified: relation storage, relation inference, operations APIs, organization exports, graph-aware retrieval expansion, backup coverage, and focused tests.
- Phase 7 is not complete yet. Remaining work should stay scoped to graph relation cleanup, richer graph-aware fit signals, and export/CLI refinements before moving to Phase 8.

## Current State Of The Code

Phase 6 is implemented and verified:

- Backup lifecycle logic lives in `src/operations/backup-service.ts`.
- `OperationsService` is back to a thin operations facade and delegates backup behavior to `BackupService`.
- The HTTP app process owns scheduled backups. `createAppServices()` constructs services but does not start timers; `src/index.ts` starts scheduled backups after the HTTP server listens.
- Backups still use portable JSONL under `TUBEROSA_BACKUP_DIR` with `manifest.json` plus table-level files.
- New backup manifests include per-table SHA-256 checksums, source store, schema version, app version or commit when available, embedding dimensions, and model provider metadata.
- Restore dry-run and replace restore run verification and schema/embedding preflight before the store is touched.
- Backup status, verification, and retention are exposed through HTTP and CLI.
- Write-through backup hooks exist for approved reflections and bulk/import file operations, throttled by config.
- Retention pruning is deterministic, prunes only verified complete backup directories, and keeps the latest backup plus the latest successful backup.
- Recovery runbooks are documented in `docs/SETUP_AND_USAGE.md`.
- `docs/AGENT_CONTEXT_ROADMAP.md` now marks Phase 6 as done on 2026-05-17.

Phase 7 first slice is implemented:

- Relation domain types were added for the controlled taxonomy from the roadmap.
- Storage contract now supports relation CRUD, inferred relation replacement, graph relation search, and organization exports.
- Memory and Postgres stores implement `knowledge_relations`.
- `migrations/002_knowledge_relations.sql` adds the durable relation table for existing databases; `migrations/001_init.sql` was updated for fresh installs.
- Ingestion now infers read-only relations from labels, references, source URI, atomic source metadata, section path, and agent session provenance.
- HTTP operations endpoints now expose relation list/get/create/update/delete and organization export surfaces:
  - `GET /operations/relations`
  - `POST /operations/relations`
  - `GET /operations/relations/:id`
  - `PATCH /operations/relations/:id`
  - `DELETE /operations/relations/:id`
  - `GET /operations/organization/project-map`
  - `GET /operations/organization/knowledge-graph.jsonl`
  - `GET /operations/organization/readable-summary`
- Retrieval now adds bounded graph candidates after metadata/lexical/memory/vector searches and records a `graph` debug stage.
- Context-pack assembly allows strong graph-evidence candidates through anchored thresholds so one-hop related knowledge can reach agents without weakening semantic thresholds globally.
- Backup/restore export includes `knowledge_relations`.

Verification run after the Phase 7 first slice:

```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run test:integration
git diff --check
```

All passed.

Verification run after the Phase 6 implementation:

```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run test:integration
git diff --check
```

All passed.

## Files Actively Edited

Phase 6 implementation files:

- `.env.example`
- `docs/AGENT_CONTEXT_ROADMAP.md`
- `docs/FLOW_LOGIC.md`
- `docs/SETUP_AND_USAGE.md`
- `scripts/backup.ts`
- `scripts/eval-retrieval.ts`
- `src/app.ts`
- `src/config.ts`
- `src/http/server.ts`
- `src/index.ts`
- `src/operations/backup-service.ts`
- `src/operations/service.ts`
- `src/types.ts`
- `src/validation.ts`
- `test/agent-session.test.ts`
- `test/api-boundary.test.ts`
- `test/evaluation.test.ts`
- `test/flow-regression.test.ts`
- `test/integration.test.ts`
- `test/operations.test.ts`
- `test/retrieval.test.ts`
- `handoff.md`

Phase 7 first-slice files:

- `migrations/001_init.sql`
- `migrations/002_knowledge_relations.sql`
- `src/http/server.ts`
- `src/ingest/service.ts`
- `src/operations/backup-service.ts`
- `src/operations/service.ts`
- `src/relations/inference.ts`
- `src/retrieval/context-pack.ts`
- `src/retrieval/fusion.ts`
- `src/retrieval/service.ts`
- `src/storage/memory-store.ts`
- `src/storage/postgres-store.ts`
- `src/storage/store.ts`
- `src/types.ts`
- `src/validation.ts`
- `test/integration.test.ts`
- `test/operations.test.ts`
- `test/retrieval.test.ts`

`handoff.md` is untracked in the current worktree and was rewritten at the end of the session as the handoff note.

## Everything Tried That Failed

Verification failures in the Phase 7 first slice:

- First `pnpm run build` failed because `src/relations/inference.ts` used a `flatMap` shape that TypeScript inferred too narrowly. Rewrote label inference to build a typed `RelationSeed[]`.
- First `pnpm test` failed because graph expansion appeared in debug but context-pack assembly filtered the one-hop candidate under anchored thresholds. Added a narrow graph-evidence allowance based on graph raw score.

No verification command is currently failing.

Design issues found and corrected before handoff:

- First pass put too much backup lifecycle code directly in `OperationsService`. This was refactored into `src/operations/backup-service.ts` so `OperationsService` remains a readable orchestration facade.
- First pass started scheduled backups from `createAppServices()`. That would affect CLI, MCP stdio, tests, and worker processes that also construct app services. The scheduler start was moved to `src/index.ts`, so only the long-running HTTP app owns the scheduled timer.
- First pass had the manual `pnpm run backup` path pass `prune: true`, which could unexpectedly prune during a normal manual backup command. That was changed so manual backup remains backward compatible; pruning is explicit through `pnpm run backup --prune` or scheduled retention.

Tuberosa MCP context retrieval was used at session start. It returned useful backup-related memories but missed several target files, so it was recorded as selected only as supporting memory and local source inspection remained the source of truth.

## Improvement Plan And Next Step

Immediate next step:

- Review and commit the Phase 6 plus Phase 7 first-slice changes, including the new relation migration and `src/relations/inference.ts`.

Recommended pre-commit command set:

```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run test:integration
git diff --check
```

Next Phase 7 implementation steps:

1. Add stale relation cleanup for archived sources and re-ingested non-atomic documents where manual/inferred relation behavior needs a clearer policy.
2. Add graph-aware context-fit signals that explicitly report connected files, symbols, errors, and sessions.
3. Consider CLI commands for organization exports if the HTTP export shape is accepted.
4. Add richer relation-path debug output beyond the current `graph` candidate stage.
5. Keep Phase 8 retrieval-quality hardening out of this phase unless explicitly redirected.
