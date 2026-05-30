# Tuberosa

Tuberosa is a **local-first context broker** for coding agents. It sits between an agent (Claude Code, Codex, Copilot, Cursor…) and your project knowledge: it retrieves the right references for a task, captures reviewed lessons from each session, and feeds both back into future runs so agents stop repeating the same mistakes.

```
 ┌──────────┐   tuberosa_search_context   ┌──────────────────────────┐
 │  Agent   │ ──────────────────────────▶ │  Tuberosa                │
 │ (Claude, │ ◀── ranked context pack ─── │   ├─ MCP stdio            │
 │  Codex,  │                             │   ├─ HTTP API  :3027     │
 │  Cursor) │                             │   └─ MCP / HTTP surfaces │
 └──────────┘                             └────────────┬─────────────┘
                                                       │
                                       ┌───────────────┼───────────────┐
                                       ▼               ▼               ▼
                                 Postgres+pgvector   Redis     .tuberosa/current/
                                 (durable store)    (cache)    (markdown mirror)
```

Two surfaces:

- **MCP stdio** — first-class integration for agents.
- **HTTP API** on `:3027` — ingestion, retrieval, feedback, reflection review, session lifecycle, ops, export/import bundles, and atoms.

Storage: Postgres + pgvector for durable knowledge / atoms / chunks / labels / references / embeddings; Redis for short-lived pack caching; a `.tuberosa/current/` Markdown mirror for human-readable inspection; `.tuberosa/backups/` for periodic snapshots.

---

## When to use it

Use Tuberosa whenever an agent needs project-specific context *before or during* work:

| Need | Example knowledge that lives in Tuberosa |
|---|---|
| Code references | "`PaywallSelectionModal` lives in `src/components/paywall-selection-modal.tsx`" |
| Operating knowledge | "Run `pnpm run eval:retrieval` before changing fusion weights" |
| Bug fixes | "Stale embeddings cause `vector dimension mismatch` — re-run migrate after dimension change" |
| Reflection memory | "When refactoring auth, also update the worker — it has its own DB pool" |
| Knowledge atoms | "PaywallSelectionModal preserves selected product ids across edits" (claim + evidence + trigger + verification) |
| User style | Personal coding preferences that follow you across projects |

Every returned item carries `labels`, `references`, `score`, `matchReasons`, and provenance — never opaque blobs.

---

## Quick start

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

> Full installation walkthrough: [wiki/01-getting-started.md](wiki/01-getting-started.md).

---

## How retrieval works

When an agent asks Tuberosa for context, the request walks through a short pipeline. Each step has one job:

| # | Step | What it does |
|---|---|---|
| 1 | **Receive** | `tuberosa_search_context` (MCP) or `POST /context/search` (HTTP). |
| 2 | **Classify** | Pull task signals from the prompt: project, task type, files, symbols, error codes, technologies, business areas, exact terms. |
| 3 | **Rewrite (only if needed)** | Probe first. If top results look strong, skip the rewrite. Otherwise ask the model for a better-angled query, reusing the probe's embedding. |
| 4 | **Search in parallel** | Labels & references, full-text search, vector similarity, approved memories — then expand through the knowledge/atom graph from the best hits. |
| 5 | **Fuse** | Weighted reciprocal-rank fusion across all five lists. |
| 6 | **Rerank** | Re-order the top slice (hash by default, or OpenAI / Ollama). |
| 7 | **Adjust** | Boost items with positive feedback; penalize stale, superseded, evidence-mismatched. |
| 8 | **Check fit** | `ready` / `needs_confirmation` / `insufficient` + list any missing signals. `noiseTolerance="strict"` drops weak items here. |
| 9 | **Assemble** | Split survivors into `essential` / `supporting` / `optional` within the token budget. |
| 10 | **(Layered mode) Deep context** | Expand chosen items into full chunks, up to `deepContextBudget`. |

Two flags change the path:

- `"bypassCache": true` — skip the Redis pack cache and re-run the pipeline.
- `"debug": true` — also skip the cache, plus return per-stage candidates and timings.

**Why hybrid?** In code work, an exact symbol name, file path, or error code is just as strong a signal as semantic similarity. Tuberosa weights both instead of picking one.

> Pipeline deep dive (fusion weights, fit thresholds, layered mode internals): [wiki/04-retrieval-pipeline.md](wiki/04-retrieval-pipeline.md).

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

## Two knowledge layers

Tuberosa has two complementary representations:

### 1. Knowledge items (documents)

The original unit: a `code_ref` / `wiki` / `spec` / `workflow` / `rule` / `bugfix` / `memory` / `conversation` row. Best for stable references — files, runbooks, specs.

### 2. Knowledge atoms (claims)

A finer-grained, claim-shaped unit introduced with the atom system. An atom is:

```jsonc
{
  "id": "<uuid>",
  "project": "tuberosa",
  "claim": "MCP stdout is reserved for JSON-RPC; diagnostics go to stderr",
  "type": "convention",                 // fact | procedure | decision | gotcha | convention
  "tier": "verified",                   // draft | verified | canonical
  "status": "active",                   // active | legacy_archived | superseded | archived
  "scope": "project",                   // project | user
  "evidence":     [ { "kind": "file", "path": "src/mcp-stdio.ts" } ],
  "trigger":      { "files": ["src/mcp/server.ts"], "symbols": ["console.log"] },
  "verification": { "command": "pnpm test" },
  "pitfalls":     ["A stray console.log breaks every MCP client."],
  "links":        [ { "toAtomId": "<other>", "kind": "refines", "confidence": 0.8 } ]
}
```

Atoms move from `draft` → `verified` → `canonical` through a write-gate (dedup, decay, critic). They support a graph of typed links (`supersedes`, `refines`, `depends_on`, `co_changes_with`, `related_to`) that the retrieval pipeline traverses for impact propagation.

> Full atom guide (tiers, critic, archival, impact analysis): [wiki/07-atoms-and-user-style.md](wiki/07-atoms-and-user-style.md).

### 3. User-style atoms (cross-project)

A subset of atoms with `scope: "user"` that follow a person across projects. Two priorities:

- `personal_workflow` — overrides project conventions (e.g. "I always use `pnpm`").
- `coding_preference` — yields to project conventions when they conflict.

Recorded via `tuberosa_record_user_style` or `POST /user-style-atoms`.

---

## Core building blocks (quick reference)

### Knowledge item

Required fields: `project`, `sourceType`, `sourceUri`, `itemType`, `title`, `content`. Full guide: [wiki/03-knowledge-model.md](wiki/03-knowledge-model.md).

### Label

Typed signal that boosts metadata matching:

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

### Context pack

The shortlist returned to the agent:

```jsonc
{
  "id":         "<context-pack-id>",
  "confidence": 0.92,
  "classified": { "files": [...], "symbols": [...], "businessAreas": [...] },
  "contextFit": { "status": "ready" | "needs_confirmation" | "insufficient",
                  "score":  0.98,
                  "missingSignals": [] },
  "sections": {
    "essential":  [ /* read first */ ],
    "supporting": [ /* helpful but secondary */ ],
    "optional":   [ /* nice-to-have */ ]
  },
  "deepContext": { /* present in layered mode */ }
}
```

Each item lists `matchReasons` (`vector match`, `symbol:fuseCandidates`, `feedback:selected:3`, `boost:domain_match:retrieval`, …) so retrieval is fully auditable.

### Context-fit signals

`contextFit.status` drives agent behavior:

- `ready` — confident shortlist, proceed.
- `needs_confirmation` — show shortlist to the user first.
- `insufficient` — ask the user for the listed `missingSignals` before proceeding.

### Agent session lifecycle

Auditable, per-task:

```
tuberosa_start_session
        │
        ▼
tuberosa_record_context_decision   ← selected / rejected / stale / irrelevant /
        │                            missing_context / selected_but_noisy / ...
        ▼
tuberosa_capture_learning_signal   ← optional mid-session signals
        │
        ▼
tuberosa_append_session_note       ← optional post-hoc notes
        │
        ▼
tuberosa_finish_session            ← outcome=completed|failed|blocked|cancelled
                                     auto-extracts a reflection draft unless
                                     learningMode="off" or you pass one explicitly
```

Full lifecycle: [wiki/05-agent-session-lifecycle.md](wiki/05-agent-session-lifecycle.md).

### Reflection memory

A *reviewed* lesson from a session:

```
finish_session ──▶ reflection draft (pending)
                          │
                          ├─ approve  ──▶ stored as itemType="memory" (searchable)
                          ├─ reject   ──▶ archived, never injected
                          └─ needs_changes ──▶ author edits, re-submits
```

Drafts are **never** injected into context until approved — the safety boundary that keeps low-quality lessons out of retrieval. Full guide: [wiki/06-reflection-memory.md](wiki/06-reflection-memory.md).

### Project export / import bundles

A `.tuberosa-pack` directory bundles atoms (Markdown + YAML front-matter), knowledge items, edges (`edges.jsonl`), user-style entries, and a self-hashed `manifest.json`. Round-trippable; conflict-aware on import.

```bash
# Export (HTTP)
curl -sX POST http://localhost:3027/operations/export-pack -d '{"project":"tuberosa","out":"snapshot-1"}'
# Import (HTTP) with dry-run + review-on-conflict
curl -sX POST http://localhost:3027/operations/import-pack -d '{"from":"snapshot-1","dryRun":true,"onConflict":"review"}'
```

Both endpoints (and the MCP equivalents `tuberosa_export_pack` / `tuberosa_import_pack`) confine the path to `TUBEROSA_EXPORT_BASE_DIR` / `TUBEROSA_IMPORT_BASE_DIR` (defaults `.tuberosa/exports` / `.tuberosa/imports`). Full guide: [wiki/08-export-import-bundle.md](wiki/08-export-import-bundle.md).

---

## Configuration

Copy `.env.example → .env`. The variables that matter most:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3027` | HTTP port. |
| `DATABASE_URL` | `postgres://tuberosa:tuberosa@localhost:5432/tuberosa` | |
| `POSTGRES_PASSWORD` | `tuberosa` | Change outside local dev. |
| `REDIS_URL` | `redis://localhost:6379` | |
| `TUBEROSA_STORE` | `postgres` | `postgres` or `memory`. |
| `TUBEROSA_CACHE` | `redis` | `redis`, `memory`, or `none`. MCP stdio defaults to `memory`. |
| `TUBEROSA_AUTO_MIGRATE` | `true` | Run migrations on app start. |
| `TUBEROSA_MODEL_PROVIDER` | `hash` | `hash`, `openai`, or `ollama`. |
| `TUBEROSA_CONTEXT_MODE` | `layered` | `layered` adds deep-context expansion; `compact` is shortlist only. |
| `TUBEROSA_DEEP_CONTEXT_BUDGET` | `60000` | Tokens. Clamped 30k–100k. |
| `CONTEXT_CACHE_TTL_SECONDS` | `300` | Context-pack cache TTL. |
| `TUBEROSA_PHYSICAL_MIRROR_ENABLED` | `true` | Sync DB to `.tuberosa/current/`. |
| `TUBEROSA_API_KEY` | _empty_ | If set, all routes except `/health` require `Authorization: Bearer <key>`. |
| `TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK` | `false` | When `true` and no key is set, non-loopback requests are refused. |
| `TUBEROSA_EXPORT_BASE_DIR` | `.tuberosa/exports` | Confines `tuberosa_export_pack` / `/operations/export-pack` outputs. |
| `TUBEROSA_IMPORT_BASE_DIR` | `.tuberosa/imports` | Confines `tuberosa_import_pack` / `/operations/import-pack` inputs. |
| `OPENAI_API_KEY` | _empty_ | Needed when `TUBEROSA_MODEL_PROVIDER=openai`. |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Must match `EMBEDDING_DIMENSIONS`. |
| `EMBEDDING_DIMENSIONS` | `1536` | Must equal the `vector(N)` column in `migrations/001_init.sql`. |

For backup tuning, error-log capture, request-size limits, and physical-mirror tuning, see `.env.example` and [wiki/11-configuration.md](wiki/11-configuration.md).

> ⚠️ Changing `EMBEDDING_DIMENSIONS` requires a new migration. The pgvector column dimension and the embedding length must agree.

---

## MCP

Run the stdio server:

```bash
pnpm run mcp                    # in the checkout
# or
npx tuberosa mcp                # from anywhere
```

> The MCP process writes **only JSON-RPC** to stdout. Diagnostics go to stderr.

### Tool catalogue (33 tools, summary)

**Retrieval** — `tuberosa_search_context`, `tuberosa_get_context_pack`.

**Session lifecycle** — `tuberosa_start_session`, `tuberosa_record_context_decision`, `tuberosa_capture_learning_signal`, `tuberosa_append_session_note`, `tuberosa_finish_session`.

**Reflection review** — `tuberosa_reflect`, `tuberosa_list_reflection_drafts`, `tuberosa_get_reflection_draft`, `tuberosa_review_reflection_draft`.

**Feedback & quality** — `tuberosa_feedback_context`, `tuberosa_collect_context_quality_feedback`.

**Atoms & graph** — `tuberosa_atom_gate_stats`, `tuberosa_atom_graph_density`, `tuberosa_predict_impact`, `tuberosa_resurrect_atom`.

**Project bundles** — `tuberosa_export_pack`, `tuberosa_import_pack`, `tuberosa_list_atom_import_conflicts`, `tuberosa_resolve_atom_import_conflict`.

**User style** — `tuberosa_record_user_style`, `tuberosa_list_user_style`.

**Maintenance** — `tuberosa_propose_maintenance`, `tuberosa_apply_maintenance`.

**Error logs** — `tuberosa_record_error_log`, `tuberosa_list_error_logs`, `tuberosa_get_error_log`, `tuberosa_collect_error_logs`, `tuberosa_update_error_log`, `tuberosa_resolve_error_log`, `tuberosa_create_error_log_reflection_draft`.

Full reference (arguments, examples): [wiki/09-mcp-reference.md](wiki/09-mcp-reference.md).

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

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.tuberosa]
command = "npx"
args    = ["tuberosa", "mcp"]
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

## HTTP API (summary)

All endpoints return JSON. Health is unauthenticated; everything else requires `Authorization: Bearer $TUBEROSA_API_KEY` if you set the key.

| Concern | Sample routes |
|---|---|
| Knowledge | `POST /knowledge`, `GET /knowledge`, `GET /knowledge/{id}`, `PATCH /knowledge/{id}`, `POST /ingest/files`, `GET /labels` |
| Context | `POST /context/search`, `GET /context/packs[/{id}]`, `POST /context/feedback`, `GET /feedback-events` |
| Atoms | `POST /atoms/{id}/resurrect` |
| User style | `POST /user-style-atoms`, `GET /user-style-atoms[/{id}]` |
| Sessions | `POST /agent-sessions`, `GET /agent-sessions[/{id}]`, `…/context-decisions`, `…/learning-signals`, `…/finish`, `…/notes` |
| Reflection | `POST /reflection-drafts`, `GET /reflection-drafts[/{id}]`, `…/review`, `…/approve`, `…/recommendation` |
| Relations | `GET/POST /operations/relations`, `GET/PATCH/DELETE /operations/relations/{id}` |
| Conflicts | `GET /operations/conflicts`, `POST /operations/conflicts/detect`, `POST /operations/conflicts/{id}` |
| Atom graph | `GET /operations/atom-gate/stats`, `GET /operations/atom-graph/density`, `GET /operations/organization/atom-graph.jsonl`, `POST /operations/atom-graph/impact` |
| Export/import | `POST /operations/export-pack`, `POST /operations/import-pack`, `GET /operations/atom-import-conflicts[/{id}]`, `POST /operations/atom-import-conflicts/{id}/resolve` |
| Organization | `GET /operations/organization/{project-map,knowledge-graph.jsonl,readable-summary}` |
| Quality / sessions | `GET /operations/context-quality`, `GET /operations/session/{id}/replay`, `GET /operations/catchup` |
| Maintenance | `GET /operations/learning-proposals`, `POST /operations/learning-proposals/{id}`, `POST /operations/maintenance/{preview,apply}`, `POST /operations/cleanup`, `GET/PATCH /operations/knowledge-gaps[/{id}]` |
| Error logs | `POST /operations/error-logs`, `GET /operations/error-logs[/{id}]`, `POST /operations/error-logs/collection`, `POST /operations/error-logs/reflection-drafts`, `POST /operations/error-logs/{id}/resolve` |
| Backups / import-files | `POST /operations/import-files`, `GET/POST /operations/backups`, `GET /operations/backups/status`, `POST /operations/backups/prune` |

Full table with bodies and responses: [wiki/10-http-api-reference.md](wiki/10-http-api-reference.md).

### Self-ingest the repo

```bash
pnpm run seed:self
# or, for full coverage (all src/ + docs/ recursive):
node --import tsx scripts/seed-tuberosa-knowledge.ts
```

The extended seed wraps each file in its own try/catch — `IngestionService.ingestFiles` is sequential and would otherwise abort the whole batch on a single rejected file. The security module's pattern strings trip its own guard, so the seed skips `src/security/knowledge-safety.ts`.

---

## Common commands

```bash
pnpm run build           # TypeScript compile
pnpm test                # full unit suite (586 tests, ~13s)
pnpm run dev             # HTTP server in watch mode (port 3027)
pnpm run mcp             # MCP stdio server
pnpm run migrate         # apply SQL migrations
pnpm run worker          # worker process

pnpm run eval:retrieval              # deterministic retrieval quality eval
pnpm run eval:agent-context          # session compliance eval
pnpm run eval:knowledge-completeness
pnpm run eval:context-mapping
pnpm run eval:safety

pnpm run sandbox                # synthetic corpus + golden prompts
pnpm run sandbox:ablate         # ablate each retrieval source in turn
pnpm run calibrate-fusion       # emit a calibrated retrieval-policy.json patch

pnpm run test:integration       # Docker-gated Postgres+Redis tests (skips if down)
pnpm run context-quality -- --project tuberosa
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

Probes Postgres + Redis first; skips (doesn't fail) if the stack is down. The Postgres test applies migrations, seeds a unique project, exercises pgvector + FTS, and records context-pack feedback. The Redis test verifies JSON set/get/delete through the cache abstraction.

---

## Security

- **Secrets** are redacted from content before storage *and* from search prompts before embedding (`src/security/knowledge-safety.ts`).
- **Prompt-injection** patterns are blocked at ingestion.
- **Retrieved candidates** are re-sanitized before being returned.
- **Path confinement** (Phase 1, 2026-05-29): every export/import path on both HTTP and MCP is canonicalized through `assertSafeBundlePath` against `TUBEROSA_EXPORT_BASE_DIR` / `TUBEROSA_IMPORT_BASE_DIR`. Absolute paths, `..` segments, NUL bytes, and symlink escapes are rejected.
- **Self-ingestion gotcha:** the security module's own pattern strings will trip its own guard. Skip `src/security/knowledge-safety.ts` in self-seed scripts.
- Set `TUBEROSA_API_KEY` to require `Authorization: Bearer <key>` on every HTTP route except `/health`.

Full threat model and known limits: [wiki/12-security-model.md](wiki/12-security-model.md). Latest audit: [docs/audit-specs/SECURITY_AUDIT_2026-05-28.md](docs/audit-specs/SECURITY_AUDIT_2026-05-28.md).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node:sqlite` or pnpm fails on Node 20 | `nvm use` then `corepack enable && pnpm install`. `.nvmrc` pins 22.21.1. |
| pnpm tries to use a global store | `pnpm config set store-dir .pnpm-store --location project && pnpm install`. |
| Docker app exits during migration | `docker compose logs --no-color app worker` then `docker compose up --build -d`. |
| App refuses to start: "Refusing to start: TUBEROSA_HTTP_HOST=0.0.0.0 …" | Set `TUBEROSA_API_KEY` (recommended) or set `TUBEROSA_HTTP_HOST=127.0.0.1`. |
| `/operations/export-pack` returns 400 "absolute path is not allowed" | Use a path relative to `TUBEROSA_EXPORT_BASE_DIR` (default `.tuberosa/exports`). |
| `curl localhost:3027` fails in a sandbox | Run from an env allowed to bind/access local ports. |
| `vector dimension mismatch` errors | `EMBEDDING_DIMENSIONS` must equal the `vector(N)` in `migrations/001_init.sql`. |
| OpenAI embeddings fail | Verify `TUBEROSA_MODEL_PROVIDER=openai`, `OPENAI_API_KEY` set, model dimensions match. |
| MCP client sees no tools | Use absolute repo path, check the command's `PATH` for Node/pnpm, verify with MCP Inspector, ensure stdout is JSON-RPC only. |
| `DuplicateIngestionError` on re-ingest | Expected — `DuplicateDetector` auto-rejects textual + semantic duplicates. Treat as skip. |

Operations runbook: [wiki/13-operations-runbook.md](wiki/13-operations-runbook.md).

---

## Roadmap

**Near term**
- Phase 2+ of the security remediation: retrieval/redaction hardening, storage `::uuid` guards, FS hardening, MCP input hardening, HTTP hygiene (one plan per subsystem under `docs/superpowers/plans/`).
- More real-project regression cases in retrieval eval fixtures.

**Mid term**
- `tuberosa ingest --project <p> --path <repo-or-docs>` CLI.
- GitNexus / Graphify import adapters.
- Provider-backed query rewriting + reranking on by default.

**Later**
- Remote MCP transport with auth for hosted agents.
- Multi-user / project permissions.
- Observability traces (retrieval stages, embedding cost, reranking cost, latency).

---

## Documentation map

| Doc | Use for |
|---|---|
| **README.md** (this file) | One-page overview. |
| [wiki/01-getting-started.md](wiki/01-getting-started.md) | Install, first ingest/search/feedback, first agent session. |
| [wiki/02-architecture.md](wiki/02-architecture.md) | Components and where they live in `src/`. |
| [wiki/03-knowledge-model.md](wiki/03-knowledge-model.md) | Knowledge items, labels, references, relations. |
| [wiki/04-retrieval-pipeline.md](wiki/04-retrieval-pipeline.md) | The 10-step pipeline in depth. |
| [wiki/05-agent-session-lifecycle.md](wiki/05-agent-session-lifecycle.md) | Sessions, decisions, learning signals, finish. |
| [wiki/06-reflection-memory.md](wiki/06-reflection-memory.md) | Draft → reviewed memory flow, write-gate. |
| [wiki/07-atoms-and-user-style.md](wiki/07-atoms-and-user-style.md) | Atom tiers, critic, archival, impact analysis, user-style layer. |
| [wiki/08-export-import-bundle.md](wiki/08-export-import-bundle.md) | `.tuberosa-pack` format, conflict resolution, base-dir confinement. |
| [wiki/09-mcp-reference.md](wiki/09-mcp-reference.md) | Every MCP tool with arguments and examples. |
| [wiki/10-http-api-reference.md](wiki/10-http-api-reference.md) | Full HTTP route reference. |
| [wiki/11-configuration.md](wiki/11-configuration.md) | Every env var documented. |
| [wiki/12-security-model.md](wiki/12-security-model.md) | Threat model, redaction, prompt-injection, path confinement, residual risks. |
| [wiki/13-operations-runbook.md](wiki/13-operations-runbook.md) | Backups, mirror, evals, integration tests, common ops. |
| [wiki/14-development-and-extension.md](wiki/14-development-and-extension.md) | Sandbox, calibrate-fusion, adding tools/routes, hooks. |
| [docs/tuberosa-project.md](docs/tuberosa-project.md) | Project intent and original design notes. |
| [docs/audit-specs/SECURITY_AUDIT_2026-05-28.md](docs/audit-specs/SECURITY_AUDIT_2026-05-28.md) | Latest security audit. |

External references:

- Model Context Protocol — https://modelcontextprotocol.io/docs/sdk
- MCP Inspector — https://modelcontextprotocol.io/docs/tools/inspector
- Claude Code MCP — https://code.claude.com/docs/en/mcp
- GitHub Copilot MCP — https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/extend-cloud-agent-with-mcp
- pgvector HNSW — https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes
