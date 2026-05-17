# Tuberosa Handoff

Date: 2026-05-17

## Goal We Are Working Toward

Tuberosa is a local-first context broker for agentic AI tools. It should retrieve the right project and user knowledge before agents start work, preserve provenance through labels, references, scores, context packs, feedback, sessions, backups, graph relations, error incidents, and review decisions, and turn durable lessons into reviewed reflection memories so future agents avoid repeated mistakes.

Current roadmap state:

- Phase 0 through Phase 6 are complete.
- Phase 7 Knowledge Organization Graph remains in progress.
- Recent work added a full error-log agent workflow on top of the filesystem-backed incident journal:
  - collect/retrieve compact incident context
  - cluster recurring incidents by fingerprint
  - create pending reflection drafts from selected logs
  - guide an agent to fix an incident
  - record structured resolution evidence after verification
- Raw error logs remain physical journals, not searchable knowledge. Durable lessons still become searchable only through reviewed and approved reflection drafts.

## Current State Of The Code

Phase 7 graph and reflection review work is still present:

- `knowledge_relations` storage, inference, graph-aware retrieval expansion, operations APIs, organization exports, backup coverage, and tests are implemented.
- Pending reflection review tools are implemented:
  - `tuberosa_list_reflection_drafts`
  - `tuberosa_get_reflection_draft`
  - `tuberosa_review_reflection_draft`
- Startup migration preflight is implemented through `TUBEROSA_AUTO_MIGRATE=true` by default.

Error-log collection and transformation is now implemented:

- `ErrorLogService.collectLogs()` reuses the physical journal scan with broader filters and pagination.
- `ErrorLogInsightService` now provides:
  - compact summaries without raw stack/message detail
  - category/severity/status/file/symbol/error/tag rollups
  - fingerprint clusters for recurring incidents
  - an `agentBrief` for AI agents
  - reflection draft creation from explicit `errorLogIds`
  - structured incident resolution with root cause, fix summary, changed files, verification commands, notes, metadata, and optional reflection linkage
- HTTP routes added:
  - `GET /operations/error-logs/collection`
  - `POST /operations/error-logs/reflection-drafts`
  - `POST /operations/error-logs/:id/resolve`
- MCP tools added:
  - `tuberosa_collect_error_logs`
  - `tuberosa_create_error_log_reflection_draft`
  - `tuberosa_resolve_error_log`
- MCP prompts added:
  - `tuberosa_review_error_logs`
  - `tuberosa_fix_error_log`
- CLI commands added through `pnpm run error-logs`:
  - `collect`, `list`, and `get` inspect filesystem-backed incidents without requiring HTTP/MCP
  - `draft` creates a pending reflection draft from selected error-log ids
  - `resolve` records root cause, fix summary, changed files, verification commands, and optional reflection linkage

Graph-aware context-fit signals are now implemented:

- Retrieval annotates graph-expanded candidates with anchored file, symbol, and error signals covered by seed candidates.
- Context-fit scoring now gives graph-expanded candidates explicit `graph connection` reasons.
- Candidate fit reasons can include `connected file:...`, `connected symbol:...`, `connected error:...`, `connected session:...`, and `connected incident lesson`.
- Aggregate context fit can count graph-connected anchored signals as covered, so one-hop related knowledge explains why it belongs in the pack.

Latest verification passed:

```bash
pnpm run build
pnpm test
git diff --check
```

Targeted tests also passed:

```bash
node --test --import tsx test/error-log.test.ts
node --test --import tsx test/api-boundary.test.ts
node --test --import tsx test/operations.test.ts
```

Latest follow-up verification after adding the error-log CLI:

```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run test:integration
git diff --check
pnpm run error-logs --help
pnpm run error-logs list --project tuberosa --limit 2
```

`pnpm run error-logs ...` required running outside the sandbox because `tsx` could not open its IPC socket inside the sandbox (`listen EPERM /tmp/tsx-1000/...pipe`). The CLI itself passed after escalation.

Latest follow-up verification after adding graph-aware context-fit signals:

```bash
node --test --import tsx test/retrieval.test.ts
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run test:integration
git diff --check
```

## Files Actively Edited

Files actively edited for the error-log workflow and graph-aware context-fit work:

- `docs/FLOW_LOGIC.md`
- `docs/SETUP_AND_USAGE.md`
- `handoff.md`
- `scripts/error-logs.ts`
- `src/app.ts`
- `src/error-log/insights.ts`
- `src/error-log/service.ts`
- `src/http/server.ts`
- `src/mcp/server.ts`
- `src/retrieval/context-fit.ts`
- `src/retrieval/service.ts`
- `src/types.ts`
- `src/validation.ts`
- `test/api-boundary.test.ts`
- `test/error-log.test.ts`
- `test/flow-regression.test.ts`
- `test/operations.test.ts`
- `test/retrieval.test.ts`

Previously active broader Phase 7 files are still in the worktree history/context and should be reviewed before commit:

- `.env.example`
- `docs/AGENT_CONTEXT_ROADMAP.md`
- `migrations/001_init.sql`
- `migrations/002_agent_sessions.sql`
- `migrations/002_knowledge_relations.sql`
- `scripts/eval-retrieval.ts`
- `src/cache.ts`
- `src/config.ts`
- `src/ingest/service.ts`
- `src/operations/backup-service.ts`
- `src/operations/service.ts`
- `src/reflection/service.ts`
- `src/relations/inference.ts`
- `src/retrieval/context-pack.ts`
- `src/retrieval/fusion.ts`
- `src/retrieval/service.ts`
- `src/storage/memory-store.ts`
- `src/storage/postgres-store.ts`
- `src/storage/store.ts`
- several existing tests under `test/`

## Everything Tried That Failed

Failures or corrections during this latest error-log workflow:

- First full `pnpm test` after adding collection failed in `test/error-log.test.ts`. The duplicate-fingerprint fixture did not include the same stack top frame, so the two intended duplicate incidents were treated as separate fingerprints. The fixture was corrected by adding the same stack frame to the second incident.
- A GitNexus exploration MCP call was cancelled by the environment earlier, so codebase understanding continued through direct source inspection and Tuberosa context lookup.
- No current verification command is failing.

Older known failures that remain useful context:

- Earlier Phase 7 graph work initially failed build due to narrow TypeScript inference in `src/relations/inference.ts`; fixed by building a typed `RelationSeed[]`.
- Graph expansion initially appeared in debug but was filtered during context-pack assembly; fixed with a narrow graph-evidence allowance.
- Reflection review build/tests initially failed around optional rubric metadata and prompt expectations; validation now compacts undefined fields and tests include the pending-reflection prompt.
- Local Postgres access from sandboxed commands can still fail with `connect EPERM 127.0.0.1:5432` unless local-network access is approved. This is an environment permission issue, not an application schema issue.

## Improvement Plan And Next Step

Recommended next steps:

1. Review the full worktree diff before commit because this branch contains multiple Phase 7 slices plus the new error-log workflow.
2. Run the broader verification set before handoff/commit if time allows:
   ```bash
   pnpm run build
   pnpm test
   pnpm run eval:retrieval
   pnpm run test:integration
   git diff --check
   ```
3. Consider adding context-search enrichment from selected error-log summaries, without making raw logs searchable durable knowledge.
4. Add stale relation cleanup for archived sources and re-ingested non-atomic documents.
5. Add richer relation-path debug output beyond the current `graph` candidate stage.

Suggested manual smoke after starting the app:

```bash
curl 'http://localhost:3027/operations/error-logs/collection?project=tuberosa&status=open&limit=10'
curl -X POST http://localhost:3027/operations/error-logs/<error-log-id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"rootCause":"...","resolutionSummary":"...","changedFiles":[],"verificationCommands":["pnpm test"]}'
pnpm run error-logs collect --project tuberosa --status open --brief
pnpm run error-logs resolve <error-log-id> --root-cause "..." --summary "..." --verification-command "pnpm test"
```
