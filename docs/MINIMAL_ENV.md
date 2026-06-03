# Tuberosa — Minimal Local Environment

This is the short list of environment variables you actually need to run Tuberosa locally. Tuberosa reads ~50 `TUBEROSA_*` variables, but **all of them have sensible defaults** — you only set the few that pick your storage, cache, and model provider.

Every variable keeps the same name it always had; SP3 only grouped them inside the code (`AppConfig`), not on the command line.

## The three ways to run

### 1. No dependencies (fastest; data is lost on exit)

No Postgres, no Redis, no API key. Everything lives in memory and uses a deterministic "hash" model (good for tests and a quick look).

```bash
TUBEROSA_STORE=memory
TUBEROSA_CACHE=memory
TUBEROSA_MODEL_PROVIDER=hash
```

Run: `pnpm run dev` (HTTP server on `127.0.0.1:3027`) or start the MCP stdio server.

### 2. Docker (Postgres + Redis, persistent)

Use the bundled `docker compose up --build -d`. The defaults already point at the compose services, so you usually set **nothing** extra:

| Variable | Default | Note |
|---|---|---|
| `TUBEROSA_STORE` | `postgres` | default — keep it |
| `TUBEROSA_CACHE` | `redis` | default — keep it |
| `DATABASE_URL` | `postgres://tuberosa:tuberosa@localhost:5432/tuberosa` | override only if your DB differs |
| `REDIS_URL` | `redis://localhost:6379` | override only if your Redis differs |
| `PORT` | `3027` | HTTP port |
| `TUBEROSA_HTTP_HOST` | `127.0.0.1` | loopback only; set `0.0.0.0` to expose |

### 3. Pick a model provider

`TUBEROSA_MODEL_PROVIDER` chooses how embeddings / rewrite / rerank work:

| Value | Needs | What you get |
|---|---|---|
| `hash` | nothing | deterministic, offline; used by all tests |
| `openai` | `OPENAI_API_KEY` | real embeddings + rerank via OpenAI; also turns the LLM critic on by default |
| `ollama` | `TUBEROSA_OLLAMA_URL` | local models via an Ollama server |

If you set `OPENAI_API_KEY` and don't set `TUBEROSA_MODEL_PROVIDER`, the provider defaults to `openai`.

> Note: the automatic "learn from sessions" loop (atom extraction) is not yet wired to a shipping provider — that is tracked as SP2 of the de-bloat engagement. Retrieval works on all providers; only the auto-learning half waits on SP2.

## Full reference, grouped (matches the code `AppConfig`)

You will not normally touch these — they exist for tuning. Listed by the group they now live in.

| Group | Env var | Default |
|---|---|---|
| **http** | `PORT` | `3027` |
| | `TUBEROSA_HTTP_HOST` | `127.0.0.1` |
| | `TUBEROSA_API_KEY` | (unset) |
| | `TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK` | `true` |
| | `TUBEROSA_MAX_REQUEST_BYTES` | `10485760` (10 MB) |
| **storage** | `TUBEROSA_STORE` | `postgres` |
| | `TUBEROSA_CACHE` | `redis` |
| | `DATABASE_URL` | `postgres://tuberosa:tuberosa@localhost:5432/tuberosa` |
| | `REDIS_URL` | `redis://localhost:6379` |
| | `TUBEROSA_AUTO_MIGRATE` | `true` |
| **model** | `TUBEROSA_MODEL_PROVIDER` | `openai` if `OPENAI_API_KEY` set, else `hash` |
| | `EMBEDDING_DIMENSIONS` | `1536` |
| | `OPENAI_API_KEY` | (unset) |
| | `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` |
| | `OPENAI_REWRITE_MODEL` / `OPENAI_RERANK_MODEL` | (unset) |
| | `TUBEROSA_OPENAI_TIMEOUT_MS` | `30000` |
| | `TUBEROSA_OLLAMA_URL` / `TUBEROSA_OLLAMA_RERANK_MODEL` / `TUBEROSA_OLLAMA_TIMEOUT_MS` | (unset) |
| | `TUBEROSA_LLM_CRITIC_ENABLED` | `true` when provider is `openai`, else `false` |
| **context** | `TUBEROSA_CONTEXT_MODE` | `layered` |
| | `CONTEXT_CACHE_TTL_SECONDS` | `300` |
| | `TUBEROSA_DEEP_CONTEXT_BUDGET` | `60000` |
| **ingest** | `TUBEROSA_MAX_INGEST_CONTENT_BYTES` | `2097152` (2 MB) |
| **backup** | `TUBEROSA_BACKUP_DIR` | `.tuberosa/backups` |
| | `TUBEROSA_EXPORT_BASE_DIR` | `.tuberosa/exports` |
| | `TUBEROSA_IMPORT_BASE_DIR` | `.tuberosa/imports` |
| | `TUBEROSA_BACKUP_INTERVAL_SECONDS` | `3600` |
| | `TUBEROSA_BACKUP_STARTUP_DELAY_SECONDS` | `60` |
| | `TUBEROSA_BACKUP_RETENTION_COUNT` | `24` |
| | `TUBEROSA_BACKUP_RETENTION_MAX_AGE_DAYS` | `30` |
| | `TUBEROSA_BACKUP_WRITE_THROUGH` | `false` |
| | `TUBEROSA_BACKUP_WRITE_THROUGH_THROTTLE_SECONDS` | `600` |
| **mirror** | `TUBEROSA_PHYSICAL_MIRROR_ENABLED` | `false` |
| | `TUBEROSA_PHYSICAL_MIRROR_DIR` | `.tuberosa/current` |
| | `TUBEROSA_PHYSICAL_MIRROR_DEBOUNCE_MS` | `500` |
| **atlas** | `TUBEROSA_ATLAS_DIR` | `.tuberosa/atlas` |
| | `TUBEROSA_ATLAS_AUTO_REGEN` | `true` |
| **errorLog** | `TUBEROSA_ERROR_LOG_DIR` | `.tuberosa/error-logs` |
| | `TUBEROSA_ERROR_LOG_MAX_BYTES` | `262144` (256 KB) |
| | `TUBEROSA_ERROR_LOG_AUTO_CAPTURE` | `true` |
| | `TUBEROSA_ERROR_LOG_CAPTURE_CLIENT_ERRORS` | `false` |
| **worktree** | `TUBEROSA_WORKTREE_ENABLED` | `true` |
| | `TUBEROSA_WORKTREE_MAX_FILES` | `50` |
| | `TUBEROSA_WORKTREE_MAX_MTIME_AGE_HOURS` | `72` |
| **archival** | `TUBEROSA_ARCHIVAL_ENABLED` | `true` |
| | `TUBEROSA_ARCHIVAL_INTERVAL_HOURS` | `24` |
| **graphInference** | `TUBEROSA_GRAPH_INFERENCE_ENABLED` | `true` |
| **userStyle** | `TUBEROSA_USER_STYLE_ENABLED` | `true` |
| | `TUBEROSA_USER_ID` | (unset) |
| | `TUBEROSA_TEAM_ID` | `default` |
| | `TUBEROSA_CONVENTIONS_ENABLED` | `true` |
| | `TUBEROSA_USER_STYLE_CLUSTER_INTERVAL_HOURS` | `1` |
| | `TUBEROSA_USER_STYLE_CLUSTER_WINDOW_DAYS` | `30` |
| | `TUBEROSA_USER_STYLE_MIN_CLUSTER_EVENTS` | `3` |
| **(top level)** | `NODE_ENV` | `development` |
| | `TUBEROSA_PERSIST_REPLAY` | `false` |
| | `TUBEROSA_DEFAULT_PROJECT` / `TUBEROSA_DEFAULT_CWD` | (unset) |

Boolean vars accept `1`, `true`, `yes`, `on` (case-insensitive) as true; anything else is false.
