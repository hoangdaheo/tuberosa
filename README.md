# Tuberosa

Tuberosa is a local-first context broker for agentic AI workflows. It stores project knowledge, retrieves the best matching references for a new task, and captures approved reflection memories so future agents do not repeat known mistakes.

## Architecture

- MCP server for agent integrations.
- HTTP API for CRUD, ingestion, retrieval, and review flows.
- Postgres + pgvector for durable metadata, full-text search, vector search, labels, and audit history.
- Redis for short-lived context-pack and query-result caching.
- Provider-pluggable model adapter with a deterministic local hash provider for development and an OpenAI embedding adapter when `OPENAI_API_KEY` is set.

## Quick Start

Use Node.js `22.13` or newer. This repo includes `.nvmrc` pinned to Node `22.21.1`.

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm run migrate
pnpm run dev
```

Docker is supported through `docker-compose.yml`:

```bash
docker compose up --build
```

This WSL environment does not currently expose Docker, so local verification can use:

```bash
pnpm run build
pnpm test
```

## MCP Usage

Run the stdio MCP server:

```bash
pnpm run mcp
```

Primary tools:

- `tuberosa_search_context`
- `tuberosa_get_context_pack`
- `tuberosa_reflect`
- `tuberosa_feedback_context`

## HTTP API

- `GET /health`
- `POST /ingest/files`
- `POST /context/search`
- `GET /context/packs/:id`
- `POST /context/feedback`
- `POST /reflection-drafts`
- `POST /reflection-drafts/:id/approve`
- `POST /knowledge`
- `GET /knowledge?q=&project=`

## Retrieval Flow

Tuberosa classifies the prompt, searches by metadata, full text, and vectors, fuses rankings with weighted reciprocal rank fusion, reranks with deterministic provider logic, then returns a compact context pack with provenance and confidence.

Context is proposed first. If it is rejected, feedback is stored and future matching can avoid the rejected knowledge.
