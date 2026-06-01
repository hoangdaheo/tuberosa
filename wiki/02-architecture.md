# 02 — Architecture

Tuberosa is a single Node process with two server surfaces (HTTP and MCP stdio), one shared application core, and a pluggable storage layer.

## Process model

```
┌─────────────────────────── Tuberosa process ──────────────────────────┐
│                                                                       │
│  src/index.ts          ←  HTTP entry (src/http/server.ts)             │
│  src/mcp-stdio.ts      ←  MCP stdio entry (src/mcp/server.ts)         │
│  src/worker.ts         ←  background worker (backups, mirror, etc.)   │
│                                                                       │
│  src/app.ts  createAppServices() — wires the singletons below:        │
│    ├─ config         (src/config.ts)                                  │
│    ├─ store          (src/storage/{postgres,memory}-store.ts)         │
│    ├─ cache          (src/cache.ts — Redis | in-memory | none)        │
│    ├─ retrieval      (src/retrieval/service.ts)                       │
│    ├─ ingestion      (src/ingest/service.ts)                          │
│    ├─ reflection     (src/reflection/service.ts)                      │
│    ├─ operations     (src/operations/*) — backups, mirror, ...        │
│    ├─ agent-session  (src/agent-session/service.ts)                   │
│    ├─ model          (src/model/provider.ts)                          │
│    └─ security       (src/security/{knowledge-safety,safe-paths}.ts)  │
└───────────────────────────────────────────────────────────────────────┘
```

`createAppServices()` is the single composition root. Both entry points call it; tests construct the same services in `MemoryKnowledgeStore` mode.

## Source layout

```
src/
├─ index.ts              HTTP entry (binds, runs)
├─ mcp-stdio.ts          MCP entry (JSON-RPC over stdio)
├─ worker.ts             Background worker
├─ app.ts                createAppServices() — composition root
├─ config.ts             Env → AppConfig
├─ cache.ts              Cache abstraction (Redis | memory | none)
│
├─ agent-session/        start/finish/decision/learning-signal
├─ atoms/                Atom critic, tier, archival, gate-telemetry, inference/
├─ atlas/                Deterministic 5-file project atlas (inputs, builders, service)
├─ bootstrap/            BootstrapService — one-command first run (sync+atlas+health+export)
├─ evaluation/           Eval runners (retrieval, agent-context, safety, …)
├─ export/               Exporter, importer, codecs, manifest, bootstrap-pack (Export V2)
├─ http/                 server.ts (routes), error mapping
├─ ingest/               IngestionService, document atomizer, duplicate-detector
├─ knowledge-areas/      area-model.ts — partition knowledge into areas (atlas/export/health spine)
├─ maintenance/          service.ts — dedup / decay / re-link maintenance plans
├─ mcp/                  server.ts (tools + resources + prompts), schemas
├─ model/                ModelProvider (hash | openai | ollama)
├─ operations/           backup-service, physical-mirror, organization, session-replay, error-logs
├─ reflection/           draft lifecycle, write-gate, recommendation
├─ relations/            inference — infer knowledge relations at ingest time
├─ retrieval/            classifier, fusion, context-fit, context-pack, service
├─ security/             knowledge-safety (redaction + injection guard), safe-paths
├─ source-sync/          SourceSyncService — detect add/change/rename/delete, plan, apply
├─ storage/              postgres-store, memory-store, factory, migrations.ts (SQL files at top-level migrations/)
├─ types/                shared TS types (atoms, knowledge, references)
└─ user-style/           clusterer, conflict-resolver, finish-session-router
```

## Two entry points

### HTTP — `src/index.ts` → `src/http/server.ts`

- Binds to `${TUBEROSA_HTTP_HOST}:${PORT}` (default `127.0.0.1:3027`).
- Boundary check at `src/index.ts:8` refuses to start when host is non-loopback AND no API key is set AND `TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK=false`.
- All routes are JSON; `/health` is public; everything else gates behind `TUBEROSA_API_KEY` if set.
- Errors flow through `appErrorToHttpBody` (`src/errors.ts`): `{error: string, code: string, ...details}`.

### MCP stdio — `src/mcp-stdio.ts` → `src/mcp/server.ts`

- Reads JSON-RPC frames from stdin, writes JSON-RPC to stdout, diagnostics to stderr.
- 16 MiB frame cap (`src/mcp-stdio.ts:14`).
- Defaults `TUBEROSA_CACHE=memory` so clients initialize without Redis.
- Dispatcher is `handleMcpRequest`; tool calls funnel into `callTool(services, params)` (~`src/mcp/server.ts:138`).

## Storage layer

The `KnowledgeStore` interface (`src/storage/store.ts`) has two implementations:

| Implementation | When | Source |
|---|---|---|
| `PostgresKnowledgeStore` | Production / `TUBEROSA_STORE=postgres` | `src/storage/postgres-store.ts` |
| `MemoryKnowledgeStore` | Tests, embedded mode | `src/storage/memory-store.ts` |

A `StorageFactory` picks one based on env (`src/storage/factory.ts`). A cache wrapper (`src/cache.ts`) sits between the retrieval service and the store; cache backends are Redis (`RedisCache`), in-memory (`MemoryCache`), or `none`.

## Retrieval service

Orchestrates the pipeline (see [04-retrieval-pipeline.md](04-retrieval-pipeline.md)). The service is stateless — it takes a request, talks to the store, the model provider, and the cache, and returns a context pack.

## Operations service

`src/operations/` holds long-running ops: scheduled backups, the physical-mirror writer, organization exports, error-log management, session replay. The worker process (`src/worker.ts`) runs the same code paths as the HTTP process — they share the same `createAppServices` composition.

## Model provider

`src/model/provider.ts` exposes a single `ModelProvider` interface with three methods: `embed`, `rewriteQuery`, `rerank`. Implementations:

- `HashModelProvider` — deterministic, no API key. Used in every test.
- `OpenAiModelProvider` — embeddings via `/v1/embeddings`, rewrite/rerank via `/v1/responses` with structured JSON output.
- `OllamaModelProvider` — embeddings + reranker against a local Ollama server.

Selected by `TUBEROSA_MODEL_PROVIDER`.

## Physical mirror

When `TUBEROSA_PHYSICAL_MIRROR_ENABLED=true` (default), every write to the store schedules a debounced sync to `.tuberosa/current/`. The mirror is Markdown + JSONL — human-readable, grep-friendly. The MCP server also exposes the mirror as resources (`tuberosa://knowledge/{id}`, `tuberosa://packs/{id}`, …).

## Knowledge lifecycle

Three subsystems keep a project's knowledge in step with its files and make it understandable. They share one backbone — `buildAreaModel` (`src/knowledge-areas/`) — and chain together:

```
files change → SourceSyncService (src/source-sync/)   → plan → apply (ingest / re-point / archive)
                                  │
                                  └─ on apply → AtlasService (src/atlas/) regenerates .tuberosa/atlas/*.md

BootstrapService (src/bootstrap/) = sync (additive) + atlas + health + optional Export V2, in one command
```

- **Source sync** — [15-source-lifecycle-sync.md](15-source-lifecycle-sync.md).
- **Atlas & area model** — [16-project-atlas.md](16-project-atlas.md).
- **Bootstrap & Export V2** — [17-bootstrap-and-export-v2.md](17-bootstrap-and-export-v2.md).

## What runs where

| Concern | HTTP | MCP | Worker |
|---|---|---|---|
| Retrieval | yes | yes | – |
| Ingestion | yes | – | – |
| Backups | – | – | yes (and HTTP on demand) |
| Mirror writes | scheduled from every write route | scheduled from MCP write tools | scheduled from background jobs |
| Eval / sandbox | manual via CLI | – | – |
| Migrations | on startup if `TUBEROSA_AUTO_MIGRATE=true` | – | – |

## Read next

- [03-knowledge-model.md](03-knowledge-model.md) — what's actually stored.
- [04-retrieval-pipeline.md](04-retrieval-pipeline.md) — how a search becomes a pack.
- [14-development-and-extension.md](14-development-and-extension.md) — adding a new tool, route, or store method.
