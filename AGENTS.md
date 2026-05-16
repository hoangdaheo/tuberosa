# Tuberosa Agent Guide

## Project Purpose

Tuberosa is a local-first context broker for agentic AI tools. It sits between coding agents and durable project or user knowledge, retrieves the right references for the current task, and saves reviewed reflection memories so future agents avoid repeated mistakes.

The v1 architecture is:

- MCP stdio server as the primary agent integration.
- HTTP API for CRUD, ingestion, retrieval, feedback, and reflection review.
- Postgres plus pgvector for durable knowledge, labels, references, chunks, vectors, context packs, feedback, and reflection memory.
- Redis for short-lived context-pack caching and coordination.
- Provider-pluggable model adapter, with deterministic hash embeddings for local development and OpenAI embeddings when configured.
- Docker Compose deployment for Postgres, Redis, app, and worker.

Before substantial work, read `tuberosa-project.md` for the product intent and `handoff.md` for current work state, recent verification, known failures, and next-step recommendations.

## Stack And Runtime

- Runtime: Node.js `>=22.13`; `.nvmrc` pins `22.21.1`.
- Package manager: pnpm `>=11.1.2`.
- Language: strict TypeScript with NodeNext ESM.
- Tests: Node's built-in test runner with `tsx`.
- Durable services: Postgres/pgvector and Redis through Docker Compose.

If the shell is on an older Node version, use `nvm use` or prefix commands with:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH
```

Do not run multiple `pnpm` commands concurrently; pnpm workspace state has previously produced transient JSON parse failures during concurrent runs.

## Common Commands

```bash
pnpm install
pnpm run build
pnpm test
pnpm run test:integration
pnpm run eval:retrieval
pnpm run dev
pnpm run mcp
pnpm run migrate
docker compose up --build -d
docker compose down
```

Use `pnpm run eval:retrieval` before and after changes to retrieval classification, fusion, reranking, or context-pack assembly.

`pnpm run test:integration` is Docker-gated. It probes Postgres and Redis and skips cleanly when services are unavailable.

## Source Map

- `src/app.ts`: service composition.
- `src/index.ts`: HTTP app entry point.
- `src/mcp-stdio.ts`: MCP stdio entry point.
- `src/http/server.ts`: HTTP routes.
- `src/mcp/server.ts`: MCP tools, resources, and prompts.
- `src/ingest/service.ts`: knowledge and file ingestion.
- `src/retrieval/classifier.ts`: prompt classification.
- `src/retrieval/service.ts`: retrieval pipeline.
- `src/retrieval/fusion.ts`: candidate fusion.
- `src/retrieval/context-pack.ts`: context pack assembly.
- `src/reflection/service.ts`: reflection draft and approval workflow.
- `src/storage/store.ts`: storage interface.
- `src/storage/postgres-store.ts`: Postgres implementation.
- `src/storage/memory-store.ts`: in-memory test and fallback implementation.
- `src/storage/migrations.ts`: reusable migration runner.
- `migrations/001_init.sql`: database schema.
- `eval/retrieval-fixtures.json`: deterministic retrieval evaluation fixture.
- `test/*.test.ts`: unit and integration tests.

## API Surface

HTTP endpoints currently include:

- `GET /health`
- `POST /knowledge`
- `GET /knowledge`
- `POST /ingest/files`
- `POST /context/search`
- `GET /context/packs/:id`
- `POST /context/feedback`
- `POST /reflection-drafts`
- `POST /reflection-drafts/:id/approve`

MCP tools currently include:

- `tuberosa_search_context`
- `tuberosa_get_context_pack`
- `tuberosa_reflect`
- `tuberosa_feedback_context`

MCP resources and prompts are defined in `src/mcp/server.ts`.

## Development Notes

- Keep normal MCP context packs compact. Put verbose retrieval diagnostics behind a debug flag, endpoint, or explicit tool field.
- Retrieval should preserve provenance: labels, references, match reasons, scores, and feedback decisions.
- Reflection memories should be reviewable drafts first; approval makes them searchable.
- Avoid storing secrets, raw private conversation, or prompt-injection content as durable knowledge.
- The SQL schema uses `knowledge_references`; avoid creating a table named `references`, which is a reserved identifier.
- Prefer existing abstractions over new ones: `KnowledgeStore`, cache adapters, model providers, ingestion, retrieval, and reflection services.
- Keep Docker defaults aligned with `.env.example` and `docker-compose.yml`.

## Verification Expectations

For narrow code changes, run:

```bash
pnpm run build
pnpm test
```

For storage, migration, cache, or Docker behavior, also run:

```bash
pnpm run test:integration
```

For retrieval behavior, also run:

```bash
pnpm run eval:retrieval
```

Run `git diff --check` before handing off changes.
