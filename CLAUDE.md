# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Tuberosa MCP startup rule

For any non-trivial implementation, debugging, review, or planning task in this repo, call Tuberosa before reading or editing code.

If the `tuberosa_*` tools are deferred, load them first with ToolSearch/select for:

- `tuberosa_start_session`
- `tuberosa_record_context_decision`
- `tuberosa_finish_session`
- `tuberosa_search_context`
- `tuberosa_get_context_pack`
- `tuberosa_get_workbench_summary`

Then call `tuberosa_start_session` with:

- `project: "tuberosa"`
- `cwd: "/home/nash/tuberosa"`
- the user's prompt as `prompt`
- `contextMode: "layered"`
- `noiseTolerance: "strict"`
- `includeDeepContext: true`
- known `files`, `symbols`, and `errors` when the prompt names them

Inspect `contextFit`, `orientation`, and `taskBrief` before proceeding. Record a `selected`, `selected_but_noisy`, `rejected`, `stale`, `irrelevant`, or `missing_context` decision with `tuberosa_record_context_decision` before substantive work. Finish meaningful sessions with `tuberosa_finish_session`.

If ToolSearch says no matching `tuberosa_*` tools exist, or the MCP server disconnects, state that explicitly in the response and continue from direct repo evidence. Do not rationalize skipping Tuberosa as a product judgment unless the tool call was actually attempted or the task is trivial.

## Commands

```bash
pnpm install              # Install dependencies (requires Node 22+, pnpm 11+)
pnpm run build            # TypeScript compile to dist/
pnpm test                 # Full unit test suite (all test/*.test.ts)
pnpm run dev              # HTTP server in watch mode (port 3027)
pnpm run migrate          # Apply SQL migrations to Postgres
pnpm run eval:retrieval   # Deterministic retrieval quality eval (must pass before merging retrieval changes)
pnpm run eval:agent-context # Agent session compliance eval
pnpm run sandbox          # Knowledge-mapping sandbox: tiered synthetic corpus + golden prompts + per-source ablation. Emits eval/sandbox/report.md.
pnpm run sandbox:ablate   # Sandbox with per-source ablation rows (lexical/vector/metadata/memory/graph each disabled in turn)
pnpm run calibrate-fusion # Phase 4: re-run the sandbox and emit a calibrated config/retrieval-policy.json patch (sourceWeights + per-task profiles)
pnpm run test:integration # Docker-gated Postgres + Redis integration tests (skips if stack is down)
```

Run a single test file:
```bash
node --test --import tsx test/retrieval.test.ts
```

Node version: `.nvmrc` pins `22.21.1`. If the shell uses an older version, prefix commands:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```

Docker stack (Postgres + Redis + HTTP server with auto-migration):
```bash
docker compose up --build -d
docker compose down -v    # also removes Postgres data
```

Local no-dependency mode (no Postgres, no Redis, data lost on exit):
```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run dev
```

## Architecture

Tuberosa is a local-first MCP context broker. It retrieves ranked project knowledge for coding agents and stores reviewed reflection memories so future agents avoid repeating mistakes.

### Two entry points

- **`src/index.ts`** — HTTP server (`src/http/server.ts`). All REST endpoints live here.
- **`src/mcp-stdio.ts`** — MCP stdio server (`src/mcp/server.ts`). Exposes retrieval, agent-session, reflection-review, feedback, and error-log tools, including `tuberosa_search_context`, `tuberosa_start_session`, `tuberosa_record_context_decision`, `tuberosa_finish_session`, and `tuberosa_append_session_note`. The MCP entry point defaults `TUBEROSA_CACHE=memory` so clients can initialize without Redis.

### Retrieval pipeline (`src/retrieval/`)

The core flow in `RetrievalService.searchContext` (`src/retrieval/service.ts`):

1. **Classify** (`classifier.ts`) — extract project, task type, files, symbols, errors, technologies, business areas from the prompt.
2. **Query rewrite** (`model/provider.ts`) — optional OpenAI-backed expansion of the lexical query.
3. **Parallel search** — metadata labels/references, Postgres FTS (`searchLexical`), pgvector (`searchVector`), approved-memory (`searchMemories`) run concurrently; then graph relation expansion (`searchGraphRelations`) uses seed IDs from those results.
4. **Fuse** (`fusion.ts`) — weighted reciprocal-rank fusion across all five candidate lists.
5. **Rerank** (`model/provider.ts`) — deterministic hash reranker (default) or OpenAI structured-output reranker.
6. **Ranking adjustments** (`service.ts`) — apply feedback score deltas and intent-suppression penalties (stale, superseded, evidence mismatch).
7. **Context fit** (`context-fit.ts`) — emit `ready/needs_confirmation/insufficient` and list missing signals.
8. **Assemble** (`context-pack.ts`) — split into `essential/supporting/optional` sections within token budget.
9. **Deep context** (layered mode) — expand selected knowledge IDs into full chunks up to `deepContextBudget`.

### Storage (`src/storage/`)

`KnowledgeStore` interface (`store.ts`) has two implementations:

- `PostgresKnowledgeStore` (`postgres-store.ts`) — production store with pgvector, FTS, graph relations, and all tables.
- `MemoryKnowledgeStore` (`memory-store.ts`) — in-process test/dev store; same interface, no persistence.

`StorageFactory` (`factory.ts`) selects the implementation based on `TUBEROSA_STORE`. A Redis or in-memory cache wraps the store for repeated context lookups (`src/cache.ts`).

### Model provider (`src/model/provider.ts`)

`ModelProvider` interface: `embed`, `rewriteQuery`, `rerank`.

- `HashModelProvider` — deterministic, no API key, used in all tests.
- `OpenAiModelProvider` — embeddings via `/v1/embeddings`, rewrite/rerank via `/v1/responses` with structured JSON output schemas.

Selected by `TUBEROSA_MODEL_PROVIDER` env var.

### Ingestion (`src/ingest/`)

`IngestionService` chunks content, embeds each chunk, infers knowledge relations (`relations/inference.ts`), and upserts to the store. Large Markdown files are atomized into headed sections first (`document-atomizer.ts`). File ingestion infers `itemType` from the file path (`.md` → `wiki`, spec-like → `spec`, otherwise `code_ref`).

### Agent session lifecycle (`src/agent-session/`)

`tuberosa_start_session` → `tuberosa_record_context_decision` → `tuberosa_finish_session`. On finish, an automatic learning gate decides whether to auto-approve a reflection memory or leave it as a reviewable draft.

### Security (`src/security/knowledge-safety.ts`)

Secrets are redacted from content before storage and from search prompts before embedding. Prompt-injection patterns are blocked at ingestion. Retrieved candidates are sanitized before returning.

### Physical mirror

When `TUBEROSA_PHYSICAL_MIRROR_ENABLED=true`, every write to Postgres is debounced and synced to `.tuberosa/current/` as human-readable `.md` and `.jsonl` files. The MCP server also exposes these as resources.

## Key constraints

**Retrieval eval must be green.** Run `pnpm run eval:retrieval` before any change to classifier, fusion weights, reranking, context-pack assembly, or context-fit logic. The eval fixture (`eval/retrieval-fixtures.json`) asserts `hitRate=1`, `staleRejectionRate=1`, and all exact classification rates at 1. Do not adjust thresholds to make tests pass — fix the logic.

**Embedding dimensions must be consistent.** `EMBEDDING_DIMENSIONS` in config must match the `vector(N)` column dimension in `migrations/001_init.sql`. The default is 1536 (matching `text-embedding-3-small`). Changing dimensions requires a new migration.

**MCP stdout is protocol-only.** The MCP stdio process must write only JSON-RPC frames to stdout. Do not add any `console.log` or `process.stdout.write` calls in the MCP code path; use `stderr` for diagnostics.

**Retrieval improvements require eval coverage first.** Do not add heuristics or weight tweaks without a fixture case that would fail without the change.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **tuberosa** (7126 symbols, 15564 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/tuberosa/context` | Codebase overview, check index freshness |
| `gitnexus://repo/tuberosa/clusters` | All functional areas |
| `gitnexus://repo/tuberosa/processes` | All execution flows |
| `gitnexus://repo/tuberosa/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
