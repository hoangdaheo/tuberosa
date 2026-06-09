# Setup — Tuberosa (Happy Path)

Tuberosa is a local MCP context broker for coding agents. It has two pillars: **FIND** (retrieve project knowledge) and **LEARN** (turn finished sessions into reusable memory).

## Three ways to run

**1. No dependencies** — fastest to try. Data is lost when you stop the server.

```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run dev
```

HTTP server runs on `127.0.0.1:3027`.

**2. Docker** — persistent. Keeps your data between restarts.

```bash
docker compose up --build -d
```

Port `3027`, loopback only. To reset everything (this also drops the database):

```bash
docker compose down -v
```

**3. Pick a provider** — see the matrix below to decide what model backend to use.

## Provider / extraction matrix

| Provider | Needs | FIND (retrieval) | LEARN (atom extraction) |
|---|---|---|---|
| `hash` | nothing | ✅ offline, deterministic | ❌ none |
| `openai` | `OPENAI_API_KEY` | ✅ real embeddings + rerank | ✅ requires `OPENAI_RERANK_MODEL` set |
| `ollama` | `TUBEROSA_OLLAMA_URL` | ✅ local models | ✅ set `TUBEROSA_OLLAMA_EXTRACT_MODEL` (e.g. `qwen2.5:3b-instruct`) |

FIND works on every provider. LEARN needs a real model (`openai` or `ollama`). After you set the extract model, **restart the MCP server** so it takes effect.

## Verify it's alive

```bash
curl -s http://127.0.0.1:3027/health
```

Real response shape (elided):

```json
{ "ok": true, "service": "tuberosa", "store": "memory", "durability": "ephemeral", "cache": "memory", "modelProvider": "hash", ... }
```

---

Full grouped env reference: [docs/MINIMAL_ENV.md](./MINIMAL_ENV.md).
