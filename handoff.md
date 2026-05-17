# Tuberosa Handoff

Date: 2026-05-17

## Goal We Are Working Toward

Tuberosa is a local-first context broker for agentic AI tools. It should retrieve the right project and user knowledge before agents start work, preserve provenance through labels, references, scores, context packs, feedback, sessions, backups, graph relations, error incidents, and review decisions, and turn durable lessons into reviewed reflection memories so future agents avoid repeated mistakes.

Current roadmap state:

- Phase 0 through Phase 6 are complete.
- Phase 7 Knowledge Organization Graph core work is now complete.
- Remaining Phase 7 follow-ups are optional hardening and product polish, such as CLI commands for organization exports and context-search enrichment from selected error-log summaries.
- Raw error logs remain physical journals, not searchable durable knowledge. Durable lessons still become searchable only through reviewed and approved reflection drafts.

## Current State Of The Code

Implemented Phase 7 and adjacent memory/review work:

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

Recent error-log workflow work:

- `ErrorLogService.collectLogs()` scans the filesystem-backed incident journal with filters and pagination.
- `ErrorLogInsightService` provides compact incident summaries, rollups, fingerprint clusters, an agent brief, reflection-draft creation from selected log ids, and structured resolution metadata.
- HTTP routes exist for collection, reflection draft creation, and resolution:
  - `GET /operations/error-logs/collection`
  - `POST /operations/error-logs/reflection-drafts`
  - `POST /operations/error-logs/:id/resolve`
- MCP tools/prompts exist for reviewing and fixing error logs.
- CLI commands exist through `pnpm run error-logs`:
  - `collect`, `list`, `get`
  - `draft`
  - `resolve`

Recent graph-aware context-fit work:

- Retrieval annotates graph-expanded candidates with anchored file, symbol, and error signals covered by seed candidates.
- Context-fit scoring gives graph-expanded candidates explicit `graph connection` reasons.
- Candidate fit reasons can include `connected file:...`, `connected symbol:...`, `connected error:...`, `connected session:...`, and `connected incident lesson`.
- Aggregate context fit can count graph-connected anchored signals as covered, so one-hop related knowledge explains why it belongs in the pack.
- Graph debug candidates now include `graphPaths` with the relation id, relation type, source knowledge id, target kind/value/id, confidence, and whether the candidate came from a direct target signal, outbound seed edge, or inbound seed edge.

Latest stale relation cleanup work:

- Re-ingesting an atomized file as a single document now deletes previous atom records and their inferred atom relations.
- Re-ingesting an atomized file still removes deleted section atoms and cascades their relations.
- Archiving or blocking a knowledge item removes inferred relations from or to that item while preserving manually curated relations.

Latest verification passed:

```bash
node --test --import tsx test/retrieval.test.ts
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run test:integration
git diff --check
```

The `pnpm run error-logs --help` and `pnpm run error-logs list --project tuberosa --limit 2` smoke checks passed earlier, but required running outside the sandbox because `tsx` could not open its IPC socket inside the sandbox (`listen EPERM /tmp/tsx-1000/...pipe`).

## Files Actively Edited

The current worktree contains the stale-relation/debug updates plus earlier Phase 7/error-log work. Files worth reviewing before a commit:

- `docs/AGENT_CONTEXT_ROADMAP.md`
- `docs/FLOW_LOGIC.md`
- `docs/SETUP_AND_USAGE.md`
- `handoff.md`
- `package.json`
- `scripts/error-logs.ts`
- `src/ingest/service.ts`
- `src/error-log/insights.ts`
- `src/retrieval/debug.ts`
- `src/retrieval/context-fit.ts`
- `src/retrieval/service.ts`
- `src/storage/memory-store.ts`
- `src/storage/postgres-store.ts`
- `src/types.ts`
- `test/retrieval.test.ts`

Earlier Phase 7 slices also touched or depend on:

- `.env.example`
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
- `src/storage/memory-store.ts`
- `src/storage/postgres-store.ts`
- `src/storage/store.ts`
- several tests under `test/`

## Everything Tried That Failed

Recent failures or corrections:

- The first full `pnpm test` after adding error-log collection failed in `test/error-log.test.ts`. The duplicate-fingerprint fixture did not include the same stack top frame, so the two intended duplicate incidents were treated as separate fingerprints. The fixture was corrected by adding the same stack frame to the second incident.
- A GitNexus exploration MCP call was cancelled by the environment earlier, so codebase understanding continued through direct source inspection and Tuberosa context lookup.
- `pnpm run error-logs ...` failed inside the sandbox with `listen EPERM /tmp/tsx-1000/...pipe`; rerunning outside the sandbox passed. This is a sandbox/tsx IPC limitation, not a CLI behavior failure.
- No current verification command is failing.

Older useful failures:

- Earlier Phase 7 graph work initially failed build due to narrow TypeScript inference in `src/relations/inference.ts`; fixed by building a typed `RelationSeed[]`.
- Graph expansion initially appeared in debug but was filtered during context-pack assembly; fixed with a narrow graph-evidence allowance.
- Reflection review build/tests initially failed around optional rubric metadata and prompt expectations; validation now compacts undefined fields and tests include the pending-reflection prompt.
- Local Postgres access from sandboxed commands can still fail with `connect EPERM 127.0.0.1:5432` unless local-network access is approved. This is an environment permission issue, not an application schema issue.

## Improvement Plan And Next Step

Recommended next steps:

1. Review the full worktree diff before commit because this branch contains multiple Phase 7 slices plus the error-log workflow.
2. Re-run the standard verification set before commit:
   ```bash
   pnpm run build
   pnpm test
   pnpm run eval:retrieval
   pnpm run test:integration
   git diff --check
   ```
3. Consider CLI commands for organization exports if HTTP export shape is accepted.
4. Consider context-search enrichment from selected error-log summaries, while preserving the rule that raw error logs are not searchable durable knowledge.
5. Move into Phase 8 retrieval quality hardening if Phase 7 export polish is sufficient.

Suggested manual smoke after starting the app:

```bash
curl 'http://localhost:3027/operations/error-logs/collection?project=tuberosa&status=open&limit=10'
pnpm run error-logs collect --project tuberosa --status open --brief
pnpm run error-logs resolve <error-log-id> --root-cause "..." --summary "..." --verification-command "pnpm test"
```
