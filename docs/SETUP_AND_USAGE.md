# Tuberosa Setup And Usage

This guide is the operator and developer setup file for Tuberosa. Use it when installing the project, running the local stack, wiring an agent through MCP, exercising the HTTP API, or running QA checks before handoff.

## 1. Purpose

Tuberosa is a local-first context broker for agentic AI tools. It stores project knowledge, retrieves the right context for a task, records feedback when context is wrong, and turns reviewed reflection drafts into searchable memory.

The main runtime surfaces are:

- MCP stdio server for coding agents.
- HTTP API for ingestion, retrieval, feedback, and reflection review.
- Postgres plus pgvector for durable storage.
- Redis for context-pack caching.
- Hash model provider for deterministic local development.
- Optional OpenAI embedding provider when `OPENAI_API_KEY` is configured.

## 2. Requirements

- Node.js `22.13` or newer.
- pnpm `11.1.2` or newer.
- Docker Compose for the full Postgres and Redis stack.
- Optional `OPENAI_API_KEY` for OpenAI embeddings.

The repo pins Node in `.nvmrc`:

```bash
nvm use
```

If your shell still resolves an older Node version, prefix commands with:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH
```

Do not run multiple `pnpm` commands at the same time in this repo. A previous concurrent run caused transient pnpm workspace-state parsing failures.

## 3. Install

```bash
corepack enable
pnpm install
```

The repo uses a local pnpm store through `pnpm-workspace.yaml`:

```yaml
storeDir: .pnpm-store
```

If pnpm tries to write to a global store, reset the project-local store:

```bash
pnpm config set store-dir .pnpm-store --location project
pnpm install
```

## 4. Configure

Create an environment file:

```bash
cp .env.example .env
```

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3027` | HTTP server port. |
| `TUBEROSA_API_KEY` | empty | Optional HTTP API key. When set, all routes except `/health` require `Authorization: Bearer <key>` or `x-tuberosa-api-key`. |
| `DATABASE_URL` | `postgres://tuberosa:tuberosa@localhost:5432/tuberosa` | Local Postgres connection. |
| `POSTGRES_PASSWORD` | `tuberosa` | Docker Compose Postgres password used by the app and worker. Change this outside local development. |
| `REDIS_URL` | `redis://localhost:6379` | Local Redis connection. |
| `TUBEROSA_STORE` | `postgres` | `postgres` or `memory`. |
| `TUBEROSA_CACHE` | `redis` | `redis`, `memory`, or `none`. |
| `TUBEROSA_MODEL_PROVIDER` | `hash` | `hash` or `openai`. |
| `OPENAI_API_KEY` | empty | Enables OpenAI embeddings when provider is `openai`. |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | OpenAI embedding model. |
| `EMBEDDING_DIMENSIONS` | `1536` | Must match the pgvector column dimension. |
| `CONTEXT_CACHE_TTL_SECONDS` | `300` | Redis or memory cache TTL for context packs. |
| `TUBEROSA_MAX_REQUEST_BYTES` | `10485760` | Maximum HTTP JSON body size. |
| `TUBEROSA_MAX_INGEST_CONTENT_BYTES` | `2097152` | Maximum size for a single knowledge content field before chunking. |

## 5. Run With Docker

Use Docker for the full production-like local stack:

```bash
docker compose up --build -d
curl http://localhost:3027/health
```

Expected response:

```json
{
  "ok": true,
  "service": "tuberosa",
  "store": "postgres",
  "cache": "redis",
  "modelProvider": "hash"
}
```

The Compose stack runs:

- Postgres/pgvector bound to `127.0.0.1:5432`.
- Redis bound to `127.0.0.1:6379`.
- Tuberosa HTTP app bound to `127.0.0.1:3027`.
- Worker placeholder process.

Stop services:

```bash
docker compose down
```

Remove the database volume as well:

```bash
docker compose down -v
```

## 6. Run Without Docker

Use this when you already have Postgres and Redis running locally:

```bash
pnpm run migrate
pnpm run dev
```

Use memory-only mode for a no-service local smoke run:

```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run dev
```

Memory mode does not persist knowledge after the process exits.

## 7. Common Commands

```bash
pnpm run build
pnpm test
pnpm run test:integration
pnpm run eval:retrieval
pnpm run dev
pnpm start
pnpm run mcp
pnpm run worker
pnpm run migrate
```

Command purpose:

- `build`: TypeScript compile check.
- `test`: unit and deterministic in-memory tests.
- `test:integration`: Docker-gated Postgres and Redis checks.
- `eval:retrieval`: retrieval quality regression suite.
- `dev`: HTTP server in watch mode.
- `start`: built HTTP server.
- `mcp`: MCP stdio server.
- `worker`: worker placeholder.
- `migrate`: apply SQL migrations.

## 8. HTTP API Usage

All endpoints return JSON.

When `TUBEROSA_API_KEY` is set, include one of these headers on every endpoint except `/health`:

```bash
Authorization: Bearer <your-key>
x-tuberosa-api-key: <your-key>
```

Knowledge ingestion runs safety checks before embedding or storage:

- credential-like secrets are redacted;
- prompt-injection instructions are blocked;
- malware-like download/execute or destructive shell patterns are blocked;
- retrieval re-checks candidates so legacy unsafe knowledge is not returned to agents.
- search prompts and error strings are redacted before they are stored or embedded.

### Health

```bash
curl http://localhost:3027/health
```

### Add Knowledge

```bash
curl -X POST http://localhost:3027/knowledge \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "sourceType": "manual",
    "sourceUri": "docs/paywall.md",
    "itemType": "wiki",
    "title": "Newsletter paywall workflow",
    "summary": "How newsletter paywall selection should behave.",
    "content": "PaywallSelectionModal must keep selected product ids stable while editors configure newsletter paywall options.",
    "trustLevel": 80,
    "labels": [
      { "type": "business_area", "value": "paywall", "weight": 1 },
      { "type": "technology", "value": "react", "weight": 0.8 },
      { "type": "symbol", "value": "PaywallSelectionModal", "weight": 1 }
    ],
    "references": [
      { "type": "file", "uri": "src/components/paywall-selection-modal.tsx" }
    ]
  }'
```

### Ingest Files

```bash
curl -X POST http://localhost:3027/ingest/files \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "files": [
      {
        "path": "src/components/paywall-selection-modal.tsx",
        "content": "export function PaywallSelectionModal() { return null; }",
        "labels": [
          { "type": "business_area", "value": "paywall", "weight": 1 }
        ]
      }
    ]
  }'
```

Use atomic mode for markdown/docs when you want a large document split into small, labeled knowledge records:

```bash
curl -X POST http://localhost:3027/ingest/files \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "mode": "atomic",
    "files": [
      {
        "path": "docs/paywall.md",
        "content": "# Paywall\n\nCore paywall notes.\n\n## Product id stability\n\nSelected product ids must remain stable while editors configure newsletter paywall options."
      }
    ]
  }'
```

Atomic markdown ingestion stores each useful heading section as its own knowledge item. Each atom keeps the original file reference, line range, section path metadata, inferred labels, and normal chunks/embeddings.

### List Knowledge

```bash
curl 'http://localhost:3027/knowledge?project=newsletter-app&q=paywall&limit=25'
```

### Search Context

```bash
curl -X POST http://localhost:3027/context/search \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "prompt": "Update PaywallSelectionModal for the newsletter paywall flow",
    "files": ["src/components/paywall-selection-modal.tsx"],
    "symbols": ["PaywallSelectionModal"],
    "taskType": "implementation",
    "tokenBudget": 4000
  }'
```

Important response fields:

- `id`: context pack id.
- `queryId`: stored query id.
- `confidence`: pack-level confidence.
- `classified`: extracted files, symbols, errors, technologies, business areas, and lexical query.
- `sections`: `essential`, `supporting`, and `optional` groups.
- `sections[].items[].matchReasons`: why a candidate matched.
- `sections[].items[].references`: file, URL, commit, tool, conversation, or external references.

### Search Context With Debug Trace

Pass `debug: true` when you need to inspect retrieval behavior:

```bash
curl -X POST http://localhost:3027/context/search \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "prompt": "Update PaywallSelectionModal for the newsletter paywall flow",
    "symbols": ["PaywallSelectionModal"],
    "debug": true
  }'
```

The debug trace includes:

- Cache key and whether cache was bypassed.
- Search limits and token budget.
- Rejected knowledge ids and filter decisions.
- Timing per stage.
- Candidate lists for metadata, lexical, memory, vector, fusion, and rerank.
- Raw, fused, rerank, and final scores when available.
- Final selected candidates by context-pack section.

Debug traces are returned only for that response. They are not persisted in stored context packs and are not cached.

### Get A Context Pack

```bash
curl http://localhost:3027/context/packs/<context-pack-id>
```

### Record Feedback

```bash
curl -X POST http://localhost:3027/context/feedback \
  -H 'Content-Type: application/json' \
  -d '{
    "contextPackId": "<context-pack-id>",
    "project": "newsletter-app",
    "feedbackType": "stale",
    "reason": "This points at the legacy paywall flow.",
    "rejectedKnowledgeIds": ["<knowledge-id>"]
  }'
```

Feedback types:

- `selected`
- `rejected`
- `irrelevant`
- `stale`
- `missing_context`

Rejected, irrelevant, and stale feedback trigger one retry with rejected knowledge excluded.

### Create A Reflection Draft

```bash
curl -X POST http://localhost:3027/reflection-drafts \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "title": "Keep paywall product ids stable",
    "summary": "Newsletter paywall edits should preserve selected product ids.",
    "content": "When changing PaywallSelectionModal, preserve selected product ids across render and submit paths because downstream billing configuration depends on stable ids.",
    "triggerType": "user_correction",
    "labels": [
      { "type": "business_area", "value": "paywall", "weight": 1 },
      { "type": "symbol", "value": "PaywallSelectionModal", "weight": 1 }
    ]
  }'
```

### Approve A Reflection Draft

```bash
curl -X POST http://localhost:3027/reflection-drafts/<draft-id>/approve
```

Approval writes the draft into knowledge as searchable memory.

## 9. MCP Usage

Run the MCP stdio server:

```bash
pnpm run mcp
```

Tools:

- `tuberosa_search_context`
- `tuberosa_get_context_pack`
- `tuberosa_reflect`
- `tuberosa_feedback_context`

Resource templates:

- `tuberosa://packs/{id}`
- `tuberosa://knowledge/{id}`

Prompts:

- `tuberosa_bootstrap_session`
- `tuberosa_reflect_after_task`

Recommended agent flow:

1. Call `tuberosa_search_context` before implementation or debugging.
2. Include prompt, project, cwd, files, symbols, errors, and task type when known.
3. Review the shortlist confidence and references.
4. Call `tuberosa_get_context_pack` after the shortlist looks relevant.
5. If context is wrong, call `tuberosa_feedback_context` and retry once.
6. After a useful lesson, call `tuberosa_reflect`.
7. Approve reflection drafts before they become searchable memory.

Use `debug: true` in `tuberosa_search_context` only when diagnosing retrieval quality.

## 10. Agent Configuration

### Codex

```toml
[mcp_servers.tuberosa]
command = "pnpm"
args = ["--dir", "/home/nash/tuberosa", "run", "mcp"]
```

Node-pinned wrapper:

```toml
[mcp_servers.tuberosa]
command = "/usr/bin/zsh"
args = [
  "-lc",
  "cd /home/nash/tuberosa && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run mcp"
]
```

### Claude Code

```bash
claude mcp add --transport stdio --scope project tuberosa -- pnpm --dir /home/nash/tuberosa run mcp
```

### GitHub Copilot

Workspace MCP config:

```json
{
  "servers": {
    "tuberosa": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["--dir", "/home/nash/tuberosa", "run", "mcp"]
    }
  }
}
```

For cloud agents, the server and database must exist in the cloud agent environment.

## 11. QA Checklist

Run these checks before handoff after code changes:

```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run test:integration
git diff --check
```

For end-to-end HTTP smoke testing with Docker:

```bash
docker compose up --build -d
curl -fsS http://localhost:3027/health
```

Then run:

1. `POST /knowledge` with a known symbol and file reference.
2. `POST /context/search` for that symbol.
3. `POST /context/search` again with `debug: true`.
4. `POST /context/feedback` with `feedbackType: "selected"`.
5. `POST /reflection-drafts`.
6. `POST /reflection-drafts/:id/approve`.
7. `POST /context/search` for the reflection memory.

Expected QA outcome:

- Build succeeds.
- Unit tests pass.
- Retrieval eval passes expected metrics.
- Integration tests pass when Docker services are reachable, or skip cleanly when they are not.
- Health endpoint returns `ok: true`.
- Search returns a context pack with references and match reasons.
- Debug search returns stages and selected candidates.
- Feedback updates context pack status or returns a retry.
- Approved reflection becomes searchable memory.

## 12. Troubleshooting

### pnpm or `node:sqlite` fails under Node 20

Use Node 22:

```bash
nvm use
corepack enable
pnpm install
```

### Docker app exits during migration

```bash
docker compose logs --no-color app worker
docker compose up --build -d
```

### `curl localhost:3027` fails in a sandbox

Local networking may require explicit approval in sandboxed environments. Run the server and smoke tests from an environment allowed to bind and access local ports.

### OpenAI embeddings fail

Check:

- `TUBEROSA_MODEL_PROVIDER=openai`
- `OPENAI_API_KEY` is set.
- `OPENAI_EMBEDDING_MODEL` supports `EMBEDDING_DIMENSIONS`.
- Postgres `knowledge_chunks.embedding vector(...)` matches the configured embedding length.

### MCP client does not see tools

Verify with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector pnpm --dir /home/nash/tuberosa run mcp
```

Then check absolute paths, Node version, pnpm availability, and that the MCP process does not print non-JSON logs to stdout.
