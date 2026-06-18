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
| `local` | nothing extra | ✅ real bge-small embeddings + cross-encoder rerank | ✅ agent-delegated (see below) |
| `openai` | `OPENAI_API_KEY` | ✅ real embeddings + rerank | ✅ requires `OPENAI_RERANK_MODEL` set |
| `ollama` | `TUBEROSA_OLLAMA_URL` | ✅ local rerank only (no Ollama embeddings) | ✅ set `TUBEROSA_OLLAMA_EXTRACT_MODEL` |

FIND works on every provider. LEARN is agent-delegated by default — see the section below.

## Self-learning (LEARN)

Self-learning is **agent-delegated by default**. When a session finishes and no model extractor is configured, `tuberosa_finish_session` returns a `learningHandoff` in the response. This nudges the calling agent to author lesson atoms itself and submit them via `tuberosa_submit_session_atoms`.

**`provider=local`** is the recommended base. It gives real `bge-small-en-v1.5` embeddings (384-dim, downloaded once to `~/.cache/tuberosa/models`) and a local cross-encoder reranker. Note: Ollama has **no embedding support** in this project — embeddings always run through bge-small under `local`, even when you also configure an Ollama reranker or extractor.

**Headless fallback** — if you run in a context where no agent is present (CI pipelines, batch ingestion, unattended servers), set `TUBEROSA_OLLAMA_EXTRACT_MODEL` to activate automatic Ollama-based extraction. Leave it **unset** for interactive sessions so the `learningHandoff` fires instead.

```bash
# Interactive default — agent-delegated learning (recommended)
# TUBEROSA_OLLAMA_EXTRACT_MODEL is not set

# Headless fallback — Ollama extracts automatically
TUBEROSA_OLLAMA_EXTRACT_MODEL=qwen2.5:3b-instruct
```

After changing `TUBEROSA_OLLAMA_EXTRACT_MODEL`, restart the MCP server so it takes effect.

## Local models (real search, no API key)

Tuberosa's default `local` provider uses two models downloaded once to
`~/.cache/tuberosa/models`:

- `Xenova/bge-small-en-v1.5` — 384-dim embeddings (vector search)
- `onnx-community/bge-reranker-v2-m3-ONNX` — cross-encoder reranking

Download and verify them:

```bash
npx tuberosa setup-models   # downloads + verifies both models
npx tuberosa doctor --deep  # confirms they actually load
```

If the models are missing, a real-world server **refuses to start** rather than
silently returning fake results. Override only for debugging with
`TUBEROSA_ALLOW_HASH_FALLBACK=true` (degraded, lexical-only search). Tests and
CI use `TUBEROSA_MODEL_PROVIDER=hash` for determinism — that is expected.

Air-gapped machines: run `setup-models` once on a connected machine and copy
`~/.cache/tuberosa/models` to the target.

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
