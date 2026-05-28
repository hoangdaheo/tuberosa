# 01 — Getting Started

Three ways to run Tuberosa, in increasing order of durability:

1. **Embedded (no Docker)** — fastest. Data lost on exit. Good for poking the API.
2. **Local Postgres + Redis** — durable. The default daily-driver setup.
3. **Docker compose** — full stack including the app + worker. Best when you want the production-like wiring.

## Requirements

- Node 22 (see `.nvmrc` — 22.21.1). Tuberosa uses native fetch and `node:test`.
- pnpm 11+ (via `corepack enable`).
- Docker (optional, for the Postgres+Redis stack).
- Linux, macOS, or WSL2. Windows-native is untested.

## Install

```bash
git clone <repo>
cd tuberosa
corepack enable
pnpm install
cp .env.example .env
```

## Option 1: embedded mode

No Docker, no DB. Data lives in memory and disappears on exit.

```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run dev
```

In another shell:

```bash
curl http://localhost:3027/health
# {"ok":true,"service":"tuberosa","store":"memory",...}
```

## Option 2: Postgres + Redis on the host

If you already have Postgres (with pgvector) and Redis running locally:

```bash
createdb tuberosa
psql tuberosa -c 'CREATE EXTENSION IF NOT EXISTS vector;'
DATABASE_URL=postgres://you:you@localhost/tuberosa REDIS_URL=redis://localhost:6379 \
  pnpm run migrate
pnpm run dev
```

`pnpm run dev` watches sources and restarts on change.

## Option 3: Docker compose

```bash
docker compose up --build -d
curl http://localhost:3027/health
```

The compose stack brings up Postgres (with pgvector), Redis, the HTTP app, and a worker. Migrations run as part of `app` startup.

> If the `app` container exit-loops with "Refusing to start: TUBEROSA_HTTP_HOST=0.0.0.0 …", set `TUBEROSA_API_KEY` in `.env` (the boundary check refuses to bind to `0.0.0.0` without auth). See [12-security-model.md](12-security-model.md#boundary-check).

Stop the stack:

```bash
docker compose down       # keeps Postgres data
docker compose down -v    # wipes Postgres data
```

## First ingest + search + feedback

```bash
# 1. Ingest a knowledge item
curl -sX POST http://localhost:3027/knowledge -H 'Content-Type: application/json' -d '{
  "project": "demo",
  "sourceType": "manual",
  "sourceUri": "docs/widget.md",
  "itemType": "wiki",
  "title": "How to use the Widget",
  "content": "Widget supports preserving selected ids across edits.",
  "labels": [{ "type": "business_area", "value": "widget", "weight": 1 }],
  "references": [{ "type": "file", "uri": "src/widget.tsx" }]
}'

# 2. Search
curl -sX POST http://localhost:3027/context/search -H 'Content-Type: application/json' -d '{
  "project": "demo",
  "prompt": "Update Widget for the new flow",
  "files": ["src/widget.tsx"],
  "taskType": "implementation"
}' | jq '.id, .contextFit.status, .sections.essential[0].title'

# 3. Feedback (keep the pack id from step 2)
curl -sX POST http://localhost:3027/context/feedback -H 'Content-Type: application/json' -d '{
  "contextPackId": "<id>",
  "project": "demo",
  "feedbackType": "selected"
}'
```

## First agent session (MCP)

In one shell:

```bash
pnpm run mcp
```

In another, drive it with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector pnpm --silent run mcp
```

Or wire it into Claude Code:

```bash
claude mcp add --transport stdio --scope project tuberosa -- \
  pnpm --silent --dir $(pwd) run mcp
```

Then in Claude Code: ask the agent to call `tuberosa_start_session` with `project: "demo"`, `prompt: "Update Widget"`, and inspect what comes back. See [05-agent-session-lifecycle.md](05-agent-session-lifecycle.md) for the recommended flow.

## What to read next

- New to the data model? [03-knowledge-model.md](03-knowledge-model.md).
- Want to understand how a search becomes a context pack? [04-retrieval-pipeline.md](04-retrieval-pipeline.md).
- Want to ingest your own repo? [13-operations-runbook.md](13-operations-runbook.md#self-ingest).
- Running into a problem? [13-operations-runbook.md#troubleshooting](13-operations-runbook.md#troubleshooting).
