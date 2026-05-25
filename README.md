# Tuberosa

Tuberosa is a **local-first context broker** for coding agents. It sits between an agent (Claude Code, Codex, Copilot, Cursor…) and your project knowledge: it retrieves the right references for a task, captures reviewed lessons from each session, and feeds both back into future runs so agents stop repeating the same mistakes.

```
 ┌──────────┐   tuberosa_search_context    ┌──────────────────┐
 │  Agent   │ ───────────────────────────▶ │  Tuberosa (MCP)  │
 │ (Claude, │ ◀── ranked context pack ──── │  HTTP + stdio    │
 │  Codex)  │                              └────────┬─────────┘
 └──────────┘                                       │
                                          Postgres+pgvector
                                          Redis cache
                                          .tuberosa/current/ mirror
```

Two surfaces:

- **MCP stdio** — first-class integration for agents.
- **HTTP API** on `:3027` — ingestion, retrieval, feedback, reflection review, ops.

Storage: Postgres + pgvector for durable knowledge / chunks / labels / references / embeddings; Redis for short-lived pack caching; a `.tuberosa/current/` markdown mirror for human-readable inspection.

---

## When to use it

Use Tuberosa whenever an agent needs project-specific context *before or during* work:

| Need | Example knowledge that lives in Tuberosa |
|---|---|
| Code references | "`PaywallSelectionModal` lives in `src/components/paywall-selection-modal.tsx`" |
| Operating knowledge | "Run `pnpm run eval:retrieval` before changing fusion weights" |
| Bug fixes | "Stale embeddings cause `vector dimension mismatch` — re-run migrate after dimension change" |
| Reflection memory | "When refactoring auth, also update the worker — it has its own DB pool" |

Every returned item carries `labels`, `references`, `score`, `matchReasons`, and provenance — never opaque blobs.

---

## Quick start

One command brings up Postgres + Redis + migrations, or falls back to embedded mode without Docker.

```bash
npx tuberosa init      # full local stack via Docker (or --no-docker for embedded)
npx tuberosa doctor    # diagnose Node / pnpm / Docker / port / Postgres / MCP issues
npx tuberosa mcp       # run the MCP stdio server with embedded-mode defaults
```

`init` is idempotent: it writes `.tuberosa/compose.yml`, brings the stack up, waits for Postgres health, runs migrations, and copies `.env.example → .env` if missing. Safe to re-run.

### Smoke test — no Docker, no dependencies

```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run dev
curl http://localhost:3027/health
```

Memory mode loses data on exit. Useful for poking around the API.

### Full local stack — Docker

```bash
corepack enable
pnpm install
docker compose up --build -d
curl http://localhost:3027/health
```

Expected:

```json
{
  "ok": true,
  "service": "tuberosa",
  "store": "postgres",
  "durability": "persistent",
  "backupDir": ".tuberosa/backups",
  "cache": "redis",
  "modelProvider": "hash"
}
```

Stop the stack: `docker compose down` (add `-v` to wipe Postgres data).

---

## How it works

The request path:

```
1. Agent calls tuberosa_search_context (MCP) or POST /context/search (HTTP).
2. classifyQuery extracts: project, taskType, files, symbols, errors,
                          technologies, business areas, exact terms, lexical query.
3. In parallel:
     - searchMetadata  (labels, refs, title, summary)
     - searchLexical   (Postgres FTS or in-memory token match)
     - searchVector    (pgvector cosine similarity)
     - searchMemories  (approved memory/workflow/rule/bugfix)
   Then graph relation expansion seeded from those hits.
4. fuseCandidates  — weighted reciprocal-rank fusion across all five lists.
5. Rerank          — deterministic hash reranker (default) or OpenAI/Ollama.
6. Ranking adjusts — feedback deltas + stale/superseded/evidence-mismatch penalties.
7. context-fit     — emits ready | needs_confirmation | insufficient + missing signals.
8. assemble        — split into essential / supporting / optional within tokenBudget.
9. (layered mode)  — expand selected ids into deepContext from full chunks.
```

The hybrid design matters because **exact symbols, file paths, and error codes carry as much signal as semantic similarity** in code work.

### A minimal end-to-end example

```bash
# 1. Ingest one knowledge item
curl -sX POST http://localhost:3027/knowledge -H 'Content-Type: application/json' -d '{
  "project": "newsletter-app",
  "sourceType": "manual",
  "sourceUri": "docs/paywall.md",
  "itemType": "wiki",
  "title": "Newsletter paywall workflow",
  "content": "PaywallSelectionModal must preserve selected product ids across edits.",
  "labels": [
    { "type": "business_area", "value": "paywall", "weight": 1 },
    { "type": "symbol",        "value": "PaywallSelectionModal", "weight": 1 }
  ],
  "references": [{ "type": "file", "uri": "src/components/paywall-selection-modal.tsx" }]
}'

# 2. Search
curl -sX POST http://localhost:3027/context/search -H 'Content-Type: application/json' -d '{
  "project": "newsletter-app",
  "prompt": "Update PaywallSelectionModal for newsletter paywall flow",
  "files":  ["src/components/paywall-selection-modal.tsx"],
  "symbols":["PaywallSelectionModal"],
  "taskType": "implementation"
}'

# 3. After working, mark the item as useful (or stale, irrelevant, missing_context)
curl -sX POST http://localhost:3027/context/feedback -H 'Content-Type: application/json' -d '{
  "contextPackId": "<id-from-step-2>",
  "project": "newsletter-app",
  "feedbackType": "selected"
}'
```

---

## Core concepts (with examples)

### Knowledge item

The atomic stored unit. Required fields: `project`, `sourceType`, `sourceUri`, `itemType`, `title`, `content`.

| `itemType`     | When to use                                          |
|----------------|------------------------------------------------------|
| `code_ref`     | A piece of source code / file you want surfaced      |
| `wiki`         | Free-form documentation, runbooks                    |
| `spec`         | Specs, requirements docs                             |
| `workflow`     | Procedural how-to (e.g. "release checklist")         |
| `rule`         | Hard project rule (e.g. "MCP stdout is JSON-RPC only") |
| `bugfix`       | Specific bug + fix pairing                           |
| `memory`       | Reflection memory (usually written via reflection drafts, not directly) |
| `conversation` | Captured chat / decision thread                      |

### Label

A typed signal that boosts metadata matching. The fixed `type` axes:

```jsonc
{ "type": "file",          "value": "src/retrieval/fusion.ts", "weight": 1.0 }
{ "type": "symbol",        "value": "fuseCandidates",          "weight": 0.9 }
{ "type": "error",         "value": "ECONNREFUSED",            "weight": 0.8 }
{ "type": "technology",    "value": "postgres",                "weight": 0.7 }
{ "type": "business_area", "value": "paywall",                 "weight": 1.0 }
{ "type": "domain",        "value": "retrieval",               "weight": 1.0 }
{ "type": "task_type",     "value": "debugging",               "weight": 0.8 }
{ "type": "project",       "value": "tuberosa",                "weight": 1.0 }
```

### Reference

Where a knowledge item points to in your world:

```jsonc
{ "type": "file",         "uri": "src/retrieval/service.ts", "lineStart": 142, "lineEnd": 178 }
{ "type": "url",          "uri": "https://docs.../pgvector" }
{ "type": "commit",       "uri": "abc1234", "metadata": { "repo": "tuberosa" } }
{ "type": "tool",         "uri": "tuberosa_search_context" }
{ "type": "conversation", "uri": "session:91b70c51-…" }
```

### Ingestion mode

`POST /ingest/files` accepts `mode: "document" | "atomic"` (default `document`):

- **document** — file is chunked but stays one logical item. Best for code.
- **atomic** — Markdown is split into headed sections, each becoming its own knowledge item. Best for long docs.

Mode is also inferable: Markdown defaults to `wiki` + atomic; spec-like paths to `spec`; everything else to `code_ref`.

### Context pack

The shortlist returned to the agent. Shape:

```jsonc
{
  "id":         "<context-pack-id>",
  "confidence": 0.92,
  "classified": { "files": [...], "symbols": [...], "businessAreas": [...] },
  "contextFit": { "status": "ready" | "needs_confirmation" | "insufficient",
                  "score":  0.98,
                  "missingSignals": [] },
  "sections": {
    "essential":  [ /* items the agent should read first */ ],
    "supporting": [ /* helpful but secondary */ ],
    "optional":   [ /* nice-to-have */ ]
  },
  "deepContext": { /* present in layered mode */ }
}
```

Each item lists `matchReasons` (`vector match`, `symbol:fuseCandidates`, `feedback:selected:3`, `boost:domain_match:retrieval`, …) so retrieval is fully auditable.

### Context-fit signals

`contextFit.status` drives agent behavior:

- `ready` — confident shortlist, agent can proceed.
- `needs_confirmation` — show shortlist to the user first.
- `insufficient` — ask the user for the listed `missingSignals` (a file, symbol, error, doc, intent) before proceeding.

### Agent session lifecycle

Auditable, per-task:

```
tuberosa_start_session
        │
        ▼
tuberosa_record_context_decision   ← selected / rejected / stale / irrelevant /
        │                            missing_context / selected_but_noisy / ...
        ▼
tuberosa_append_session_note       ← optional post-hoc notes
        │
        ▼
tuberosa_finish_session            ← outcome=completed|failed|blocked|cancelled
                                     auto-extracts a reflection draft unless
                                     learningMode="off" or you pass one explicitly
```

### Reflection memory

A *reviewed* lesson from a session. Lifecycle:

```
finish_session ──▶ reflection draft (pending)
                          │
                          ├─ approve  ──▶ stored as itemType="memory" (searchable)
                          ├─ reject   ──▶ archived, never injected
                          └─ needs_changes ──▶ author edits, re-submits
```

Drafts are **never** injected into context until approved — that's the safety boundary that keeps low-quality lessons from polluting future retrieval.

---

## Configuration

Copy `.env.example → .env`. The variables that actually matter:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3027` | HTTP port. |
| `DATABASE_URL` | `postgres://tuberosa:tuberosa@localhost:5432/tuberosa` | |
| `POSTGRES_PASSWORD` | `tuberosa` | Used by Docker Compose. Change outside local dev. |
| `REDIS_URL` | `redis://localhost:6379` | |
| `TUBEROSA_STORE` | `postgres` | `postgres` or `memory`. |
| `TUBEROSA_CACHE` | `redis` | `redis`, `memory`, or `none`. MCP stdio defaults this to `memory` so clients can init without Redis. |
| `TUBEROSA_AUTO_MIGRATE` | `true` | Run migrations on app start. |
| `TUBEROSA_MODEL_PROVIDER` | `hash` | `hash`, `openai`, or `ollama`. |
| `TUBEROSA_CONTEXT_MODE` | `layered` | `layered` adds deep-context expansion; `compact` is shortlist only. |
| `TUBEROSA_DEEP_CONTEXT_BUDGET` | `60000` | Tokens. Clamped 30k–100k. |
| `CONTEXT_CACHE_TTL_SECONDS` | `300` | Context-pack cache TTL. |
| `TUBEROSA_PHYSICAL_MIRROR_ENABLED` | `true` | Sync DB to `.tuberosa/current/` for inspection. |
| `TUBEROSA_API_KEY` | _empty_ | If set, all routes except `/health` need `Authorization: Bearer <key>`. |
| `OPENAI_API_KEY` | _empty_ | Needed when `TUBEROSA_MODEL_PROVIDER=openai`. |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Must match `EMBEDDING_DIMENSIONS`. |
| `EMBEDDING_DIMENSIONS` | `1536` | Must equal the `vector(N)` column in `migrations/001_init.sql`. |

For backup tuning, error-log capture, request-size limits, and physical-mirror tuning, see `.env.example` — every tunable is documented there.

> ⚠️ Changing `EMBEDDING_DIMENSIONS` requires a new migration. The pgvector column dimension and the embedding length must agree.

Ollama reranker example (already in `.env.example`):

```bash
TUBEROSA_MODEL_PROVIDER=ollama
TUBEROSA_OLLAMA_URL=http://localhost:11434
TUBEROSA_OLLAMA_RERANK_MODEL=dengcao/Qwen3-Reranker-0.6B
```

---

## MCP

Run the stdio server:

```bash
pnpm run mcp                    # in the checkout
# or
npx tuberosa mcp                # from anywhere
```

> The MCP process writes **only JSON-RPC** to stdout. Diagnostics go to stderr.

### Tools

**Retrieval**
| Tool | Purpose |
|---|---|
| `tuberosa_search_context` | Classify a task and return a ranked context pack. |
| `tuberosa_get_context_pack` | Fetch a full pack by id after a shortlist is accepted. |

**Session lifecycle**
| Tool | Purpose |
|---|---|
| `tuberosa_start_session` | Begin an auditable agent session with initial context + policy. |
| `tuberosa_record_context_decision` | Record selected / rejected / stale / irrelevant / missing / noisy context. |
| `tuberosa_capture_learning_signal` | Capture a tip/decision/mistake/verification/file_change/preference mid-session. |
| `tuberosa_append_session_note` | Append a post-finish note or context-quality feedback to a session. |
| `tuberosa_finish_session` | Finish a session; auto-extract or accept an explicit reflection draft. |

**Reflection review**
| Tool | Purpose |
|---|---|
| `tuberosa_reflect` | Create a reviewable reflection draft. |
| `tuberosa_list_reflection_drafts` | List pending drafts. |
| `tuberosa_get_reflection_draft` | Fetch one draft. |
| `tuberosa_review_reflection_draft` | Approve / reject / mark needs-changes. |

**Feedback & quality**
| Tool | Purpose |
|---|---|
| `tuberosa_feedback_context` | Record selected/rejected/stale/irrelevant/missing/noisy feedback. |
| `tuberosa_collect_context_quality_feedback` | Collect noisy or missing-context feedback with linked review actions. |
| `tuberosa_get_workbench_summary` | Local V1 workbench: review queues, health, recent sessions, risky memories. |

**Maintenance**
| Tool | Purpose |
|---|---|
| `tuberosa_propose_maintenance` | Propose dedup / re-link / re-classify maintenance work. |
| `tuberosa_apply_maintenance`   | Apply a proposed maintenance plan. |

**Error logs**
| Tool | Purpose |
|---|---|
| `tuberosa_record_error_log` | Capture a filesystem-backed incident. |
| `tuberosa_list_error_logs` / `tuberosa_get_error_log` | Browse incidents. |
| `tuberosa_collect_error_logs` | Aggregate a set for review. |
| `tuberosa_update_error_log` / `tuberosa_resolve_error_log` | Update or close an incident. |
| `tuberosa_create_error_log_reflection_draft` | Turn a resolved incident into a reflection draft. |

### Resource templates

```
tuberosa://packs/{id}
tuberosa://knowledge/{id}
tuberosa://error-logs/{id}
tuberosa://error-logs/{id}/markdown
```

### Prompts

```
tuberosa_bootstrap_session
tuberosa_reflect_after_task
tuberosa_review_pending_reflections
tuberosa_capture_error_for_later
tuberosa_review_error_logs
tuberosa_fix_error_log
```

### Recommended agent workflow

```
1. tuberosa_start_session (or tuberosa_search_context)
2. Inspect contextFit + actionableMissingSignals.
   - status=ready              → proceed
   - status=needs_confirmation → confirm shortlist with user
   - status=insufficient       → ask user for missing signals
3. tuberosa_get_context_pack (if you only got a shortlist)
4. Do the work.
5. tuberosa_record_context_decision (selected / stale / etc.)
6. tuberosa_finish_session  → reflection draft is queued for review
```

### Client snippets

**Claude Code** — project-scoped:

```bash
claude mcp add --transport stdio --scope project tuberosa -- \
  pnpm --silent --dir <repo-path> run mcp
```

Add this to your `CLAUDE.md`:

```text
Before non-trivial implementation, debugging, review, or planning in this repo,
call tuberosa_start_session (or tuberosa_search_context) with project, cwd, prompt,
contextMode="layered", noiseTolerance="strict", includeDeepContext=true.
Inspect contextFit and taskBrief, record a context decision, and finish meaningful
sessions with tuberosa_finish_session.
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.tuberosa]
command = "npx"
args    = ["tuberosa", "mcp"]
```

Attach to a durable Postgres checkout instead:

```toml
[mcp_servers.tuberosa]
command = "/usr/bin/zsh"
args    = ["-lc", "cd <repo-path> && node --import tsx src/mcp-stdio.ts"]
```

**GitHub Copilot** (VS Code Agent mode) — `.vscode/mcp.json`:

```json
{ "servers": { "tuberosa": { "type": "stdio", "command": "pnpm",
                             "args": ["--dir", "<repo-path>", "run", "mcp"] } } }
```

**Debug with MCP Inspector**:

```bash
npx @modelcontextprotocol/inspector pnpm --silent --dir <repo-path> run mcp
```

---

## HTTP API

All endpoints return JSON. Health is unauthenticated; everything else requires `Authorization: Bearer $TUBEROSA_API_KEY` if you set the key.

### Knowledge

| Method | Path | Use |
|---|---|---|
| `POST` | `/knowledge` | Add one item (full schema). |
| `GET`  | `/knowledge?project=<p>&q=<q>&limit=<n>` | List. `limit` capped at 100. |
| `GET`  | `/knowledge/{id}` | Fetch one. |
| `PATCH`| `/knowledge/{id}` | Update fields. |
| `POST` | `/ingest/files` | Bulk file ingestion (chunks + atomizes). |

### Context

| Method | Path | Use |
|---|---|---|
| `POST` | `/context/search` | Run retrieval. Pass `"debug": true` for per-stage candidates and timings. |
| `GET`  | `/context/packs/{id}` | Fetch a stored pack. |
| `POST` | `/context/feedback` | `selected` / `rejected` / `stale` / `irrelevant` / `missing_context`. Rejected/stale/irrelevant triggers a one-shot retry excluding `rejectedKnowledgeIds`. |

### Agent sessions

```
POST /agent-sessions                       — start
GET  /agent-sessions                       — list
GET  /agent-sessions/{id}                  — read
POST /agent-sessions/{id}/context-decisions
POST /agent-sessions/{id}/context-decision (alias)
POST /agent-sessions/{id}/learning-signals
POST /agent-sessions/{id}/finish
POST /agent-sessions/{id}/notes
```

### Reflection drafts

```
POST /reflection-drafts                       — create
GET  /reflection-drafts                       — list
GET  /reflection-drafts/{id}                  — read
PATCH /reflection-drafts/{id}                 — edit
POST /reflection-drafts/{id}/review           — approve | reject | needs_changes
POST /reflection-drafts/{id}/approve          — shortcut
GET  /reflection-drafts/{id}/recommendation   — write-gate recommendation
```

Valid `triggerType`: `complex_task_success`, `error_recovery`, `user_correction`, `non_trivial_workflow`, `manual`.

### Operations (admin / maintenance)

```
GET  /operations/relations                  — knowledge graph relations
POST /operations/relations                  — add
DELETE/PATCH/GET /operations/relations/{id}

GET  /operations/conflicts                  — detected conflicts
POST /operations/conflicts/detect
POST /operations/conflicts/{id}             — resolve

GET  /operations/knowledge-gaps             — missing-coverage items
GET  /operations/learning-proposals
POST /operations/learning-proposals/{id}    — accept/reject

GET  /operations/organization/project-map
GET  /operations/organization/knowledge-graph.jsonl
GET  /operations/organization/readable-summary

GET  /operations/context-quality
GET  /operations/workbench/summary
GET  /operations/catchup

POST /operations/error-logs                 — record
GET  /operations/error-logs                 — list
POST /operations/error-logs/collection
POST /operations/error-logs/reflection-drafts
POST /operations/error-logs/{id}/resolve
GET/PATCH /operations/error-logs/{id}

POST /operations/import-files               — bulk import
POST /operations/cleanup                    — run cleanup pass
GET  /operations/backups                    — list backups
POST /operations/backups                    — create
GET  /operations/backups/status
POST /operations/backups/prune
```

### Add-a-knowledge-item example

```bash
curl -sX POST http://localhost:3027/knowledge -H 'Content-Type: application/json' -d '{
  "project": "newsletter-app",
  "sourceType": "manual",
  "sourceUri": "docs/paywall.md",
  "itemType": "wiki",
  "title": "Newsletter paywall workflow",
  "summary": "How paywall selection should behave.",
  "content": "PaywallSelectionModal must keep selected product ids stable across edits.",
  "trustLevel": 80,
  "labels":     [ { "type": "business_area", "value": "paywall", "weight": 1 } ],
  "references": [ { "type": "file", "uri": "src/components/paywall-selection-modal.tsx" } ]
}'
```

### Bulk-ingest example

```bash
curl -sX POST http://localhost:3027/ingest/files -H 'Content-Type: application/json' -d '{
  "project": "newsletter-app",
  "mode":    "document",
  "files": [
    { "path": "src/components/paywall-selection-modal.tsx",
      "content": "export function PaywallSelectionModal() { return null; }" }
  ]
}'
```

Inference rules when you omit `itemType`:

- `*.md`, `docs/**` → `wiki`
- `specs/**`, `*-spec.*` → `spec`
- everything else → `code_ref`

### Self-ingest the repo

```bash
pnpm run seed:self
# or, for full coverage (all src/ + docs/ recursive):
node --import tsx scripts/seed-tuberosa-knowledge.ts
```

The extended seed wraps each file in its own try/catch — `IngestionService.ingestFiles` is sequential and would otherwise abort the whole batch on a single rejected file.

---

## Common commands

```bash
pnpm run build           # TypeScript + workbench build
pnpm test                # full unit suite
pnpm run dev             # HTTP server in watch mode (port 3027)
pnpm run mcp             # MCP stdio server
pnpm run migrate         # apply SQL migrations
pnpm run worker          # worker process

pnpm run eval:retrieval         # deterministic retrieval quality eval
pnpm run eval:agent-context     # session compliance eval
pnpm run eval:knowledge-completeness
pnpm run eval:context-mapping
pnpm run eval:safety

pnpm run sandbox                # synthetic corpus + golden prompts
pnpm run sandbox:ablate         # ablate each retrieval source in turn
pnpm run calibrate-fusion       # emit a calibrated retrieval-policy.json patch

pnpm run test:integration       # Docker-gated Postgres+Redis tests (skips if down)
pnpm run context-quality -- --project tuberosa
pnpm run workbench
pnpm run error-logs
pnpm run backup / restore
```

Older Node in your shell? Either `nvm use` or prefix:

```bash
PATH=/home/<you>/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```

---

## Retrieval evaluation

Run **before** changing classifier, fusion weights, reranker, or context-pack assembly:

```bash
pnpm run eval:retrieval
pnpm run eval:retrieval -- --top-k 3
pnpm run eval:retrieval -- --json
pnpm run eval:retrieval -- --fixture eval/retrieval-fixtures.json --fail-under-hit-rate 0.95
```

The fixture seeds an in-memory store, runs each prompt through the real ingestion + retrieval services, and reports hit rate, MRR, precision@k, stale rejection, unexpected-result avoidance, and exact file/symbol/error classification.

**Rule:** don't add heuristics or weight tweaks without a fixture case that would fail without the change. Matching improves through measured retrieval quality, not manual weights.

---

## Integration tests

```bash
pnpm run test:integration
```

Probes Postgres + Redis first; skips (doesn't fail) if the stack is down. Defaults:

```bash
TUBEROSA_INTEGRATION_DATABASE_URL=postgres://tuberosa:tuberosa@localhost:5432/tuberosa
TUBEROSA_INTEGRATION_REDIS_URL=redis://localhost:6379
```

The Postgres test applies migrations, seeds a unique project, exercises pgvector + FTS, and records context-pack feedback. The Redis test verifies JSON set/get/delete through the cache abstraction.

---

## Security

- **Secrets** are redacted from content before storage *and* from search prompts before embedding (`src/security/knowledge-safety.ts`).
- **Prompt-injection** patterns are blocked at ingestion.
- **Retrieved candidates** are re-sanitized before being returned, so legacy unsafe knowledge can't be injected.
- **Self-ingestion gotcha:** the security module's own pattern strings will trip its own guard. Skip `src/security/knowledge-safety.ts` in self-seed scripts.
- Set `TUBEROSA_API_KEY` to require `Authorization: Bearer <key>` on every HTTP route except `/health`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node:sqlite` or pnpm fails on Node 20 | `nvm use` then `corepack enable && pnpm install`. `.nvmrc` pins 22.21.1. |
| pnpm tries to use a global store | `pnpm config set store-dir .pnpm-store --location project && pnpm install`. |
| Docker app exits during migration | `docker compose logs --no-color app worker` then `docker compose up --build -d`. |
| `curl localhost:3027` fails in a sandbox | Run from an env allowed to bind/access local ports. |
| `vector dimension mismatch` errors | `EMBEDDING_DIMENSIONS` must equal the `vector(N)` in `migrations/001_init.sql`. Changing it needs a new migration. |
| OpenAI embeddings fail | Verify `TUBEROSA_MODEL_PROVIDER=openai`, `OPENAI_API_KEY` set, model dimensions match `EMBEDDING_DIMENSIONS` and the pgvector column. |
| MCP client sees no tools | Use absolute repo path, check the command's `PATH` for Node/pnpm, verify with MCP Inspector, ensure stdout is JSON-RPC only. |
| `DuplicateIngestionError` on re-ingest | Expected — `DuplicateDetector` auto-rejects textual + semantic duplicates. Treat as skip. |

---

## Roadmap

**Near term**
- Expand README + examples as the canonical setup/API doc (this file).
- More real-project regression cases in retrieval eval fixtures.
- Admin/debug workbench UI for browsing, search testing, reflection approval, and source-level retrieval debug traces.

**Mid term**
- `tuberosa ingest --project <p> --path <repo-or-docs>` CLI.
- GitNexus / Graphify import adapters.
- Provider-backed query rewriting + reranking on by default.
- Replace minimal MCP JSON-RPC impl with the official TypeScript MCP SDK if stricter client compat is required.

**Later**
- Remote MCP transport with auth for hosted agents.
- Multi-user / project permissions.
- Observability traces (retrieval stages, embedding cost, reranking cost, latency).
- Prompt / version management for search + reflection templates.

---

## Further reading

- Project intent and design notes — [docs/tuberosa-project.md](docs/tuberosa-project.md)
- Model Context Protocol — https://modelcontextprotocol.io/docs/sdk
- MCP Inspector — https://modelcontextprotocol.io/docs/tools/inspector
- Claude Code MCP — https://code.claude.com/docs/en/mcp
- GitHub Copilot MCP — https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/extend-cloud-agent-with-mcp
- pgvector HNSW — https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes
- Langfuse evals — https://langfuse.com/docs
