# 11 — Configuration

All configuration is environment-variable driven. Defaults come from `src/config.ts` (`loadConfig`). The example `.env.example` ships every tunable.

## Core

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | Standard. |
| `PORT` | `3027` | HTTP port. |
| `TUBEROSA_HTTP_HOST` | `127.0.0.1` | Bind address. Loopback is required unless `TUBEROSA_API_KEY` is set or `TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK=true`. |

## Storage & cache

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://tuberosa:tuberosa@localhost:5432/tuberosa` | Postgres connection. |
| `POSTGRES_PASSWORD` | `tuberosa` | Used by Docker Compose. Change outside local dev. |
| `REDIS_URL` | `redis://localhost:6379` | Redis. |
| `TUBEROSA_STORE` | `postgres` | `postgres` or `memory`. |
| `TUBEROSA_CACHE` | `redis` | `redis`, `memory`, or `none`. MCP stdio defaults to `memory`. |
| `TUBEROSA_AUTO_MIGRATE` | `true` | Run SQL migrations on app start. |

## Model provider

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_MODEL_PROVIDER` | `hash` | `hash` (deterministic), `openai`, or `ollama`. |
| `OPENAI_API_KEY` | _empty_ | Required when `TUBEROSA_MODEL_PROVIDER=openai`. |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Must agree with `EMBEDDING_DIMENSIONS`. |
| `OPENAI_REWRITE_MODEL` | _empty_ | When unset, `gpt-4o-mini` is used. |
| `OPENAI_RERANK_MODEL` | _empty_ | When unset, `gpt-4o-mini` is used. |
| `EMBEDDING_DIMENSIONS` | `1536` | Must equal the `vector(N)` column in `migrations/001_init.sql`. Changing requires a new migration. |
| `TUBEROSA_OLLAMA_URL` | `http://localhost:11434` | Used when `TUBEROSA_MODEL_PROVIDER=ollama`. |
| `TUBEROSA_OLLAMA_RERANK_MODEL` | `dengcao/Qwen3-Reranker-0.6B:Q8_0` | Local reranker. |
| `TUBEROSA_OLLAMA_TIMEOUT_MS` | `10000` | Per-call timeout. |
| `TUBEROSA_RERANKER_MODEL` | _empty_ | Optional ONNX reranker (e.g. `onnx-community/bge-reranker-v2-m3-ONNX`). |

## Retrieval

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_CONTEXT_MODE` | `layered` | `layered` (deep context) or `compact` (shortlist only). |
| `TUBEROSA_DEEP_CONTEXT_BUDGET` | `60000` | Token budget for deep-context expansion. Clamped 30k–100k. |
| `CONTEXT_CACHE_TTL_SECONDS` | `300` | Context-pack cache TTL (Redis or memory). |
| `TUBEROSA_MAX_REQUEST_BYTES` | `10485760` | Max HTTP body size (10 MiB). |
| `TUBEROSA_MAX_INGEST_CONTENT_BYTES` | `2097152` | Max per-file ingestion body (2 MiB). |

Detailed fusion weights, task profiles, and graph budget live in `config/retrieval-policy.json` (not env). See [04-retrieval-pipeline.md](04-retrieval-pipeline.md#where-each-piece-is-configurable).

## Security

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_API_KEY` | _empty_ | When set, all routes except `/health` require `Authorization: Bearer <key>`. |
| `TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK` | `false` | When `true` and no key is set, non-loopback requests are refused (the boundary check at `src/index.ts:8` refuses to *start* the server in the dangerous combo). |
| `TUBEROSA_EXPORT_BASE_DIR` | `.tuberosa/exports` | Confines `/operations/export-pack` and `tuberosa_export_pack` outputs. |
| `TUBEROSA_IMPORT_BASE_DIR` | `.tuberosa/imports` | Confines `/operations/import-pack` and `tuberosa_import_pack` inputs. |

Full security model: [12-security-model.md](12-security-model.md).

## Backups

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_BACKUP_DIR` | `.tuberosa/backups` | Where snapshots are written. |
| `TUBEROSA_BACKUP_INTERVAL_SECONDS` | `3600` | Cadence. `0` disables scheduled backups. |
| `TUBEROSA_BACKUP_STARTUP_DELAY_SECONDS` | `60` | Wait this long before first scheduled run. |
| `TUBEROSA_BACKUP_RETENTION_COUNT` | `24` | Keep N latest snapshots. |
| `TUBEROSA_BACKUP_RETENTION_MAX_AGE_DAYS` | `30` | Delete older than this. |
| `TUBEROSA_BACKUP_WRITE_THROUGH` | `false` | Mirror every write directly to disk (in addition to scheduled snapshots). |
| `TUBEROSA_BACKUP_WRITE_THROUGH_THROTTLE_SECONDS` | `600` | Min seconds between write-through snapshots. |

## Physical mirror

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_PHYSICAL_MIRROR_ENABLED` | `true` | Sync DB to `.tuberosa/current/` (Markdown + JSONL). |
| `TUBEROSA_PHYSICAL_MIRROR_DIR` | `.tuberosa/current` | Mirror directory. |
| `TUBEROSA_PHYSICAL_MIRROR_DEBOUNCE_MS` | `500` | Coalesce rapid writes into one sync. |

## Error logs

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_ERROR_LOG_DIR` | `.tuberosa/error-logs` | Filesystem-backed incident storage. |
| `TUBEROSA_ERROR_LOG_MAX_BYTES` | `262144` | Max per-log size (256 KiB). |
| `TUBEROSA_ERROR_LOG_AUTO_CAPTURE` | `true` | Auto-capture HTTP/MCP server errors. |
| `TUBEROSA_ERROR_LOG_CAPTURE_CLIENT_ERRORS` | `false` | Capture 4xx errors too (not just 5xx). |
| `TUBEROSA_PERSIST_REPLAY` | `true` | Persist session replays. |

## User identity

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_USER_ID` | _empty_ | Default `userId` for user-style-atom routes. |

## Embedded mode (no Docker, no DB)

For local development / smoke tests:

```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run dev
```

Skips Postgres + Redis + OpenAI entirely. Data is lost on exit.

## Reading the actual config

```bash
node --import tsx -e "import {loadConfig} from './src/config.js'; console.log(JSON.stringify(loadConfig(), null, 2))"
```

## Read next

- [01-getting-started.md](01-getting-started.md) — practical setup.
- [12-security-model.md](12-security-model.md) — when to set which security knob.
- [13-operations-runbook.md](13-operations-runbook.md) — backup / mirror / migration ops.
