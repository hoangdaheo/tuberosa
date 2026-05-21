# Reranker Upgrade Plan: bge-reranker-v2-m3 + Ollama/Qwen3

## Context

The current default reranker (`Xenova/bge-reranker-base`) has two hard problems for Tuberosa's corpus:
- **512-token context limit** — code files, specs, and chunked markdown are silently truncated
- **No code training** — it was trained on MS MARCO passage retrieval; code syntax and markdown structure give it no signal advantage

This plan upgrades in two ordered steps:

1. **Step 1 (minimal, safe)**: Change the default model to `onnx-community/bge-reranker-v2-m3-ONNX` — a confirmed Transformers.js v3 / `@xenova/transformers` drop-in with 8K context and 2× better code scores. Zero new infrastructure.

2. **Step 2 (new provider)**: Add an `OllamaRerankProvider` that calls Ollama's HTTP rerank API, unlocking `Qwen3-Reranker-0.6B` (32K context, 73 code benchmark score, Apache 2.0, 639 MB GGUF). Ollama must already be running locally; provider falls back to hash if unreachable.

---

## Step 1 — Switch Default to bge-reranker-v2-m3-ONNX

### What changes

**`src/model/local-provider.ts` (line 52)**
Change the `DEFAULT_MODEL_ID` constant:
```ts
// Before
const DEFAULT_MODEL_ID = 'Xenova/bge-reranker-base';

// After
const DEFAULT_MODEL_ID = 'onnx-community/bge-reranker-v2-m3-ONNX';
```
Everything else stays the same — the `TUBEROSA_RERANKER_MODEL` env var still overrides this.

**`test/local-provider.test.ts`**
One assertion hardcodes the old model ID in `result.model`. Update it to `'onnx-community/bge-reranker-v2-m3-ONNX'` (the test injects a mock scorer so no real model download happens).

**`.env.example`**
The `TUBEROSA_RERANKER_MODEL` env var is currently undocumented. Add a commented entry next to `TUBEROSA_MODEL_PROVIDER` showing the default and available alternatives:
```
# TUBEROSA_RERANKER_MODEL=onnx-community/bge-reranker-v2-m3-ONNX
# Alternatives: Xenova/bge-reranker-base (512-token, lighter), onnx-community/bge-reranker-v2-m3-ONNX (8K, recommended)
```

### Files touched
- `src/model/local-provider.ts` — 1 line change
- `test/local-provider.test.ts` — 1 assertion update
- `.env.example` — add 2 comment lines

### Verification
```bash
pnpm test                  # local-provider.test.ts must pass with updated model name
pnpm run eval:retrieval    # must stay green (hash provider path is unchanged)
pnpm run sandbox           # metrics must meet Phase 4 thresholds
```

---

## Step 2 — OllamaRerankProvider + Qwen3-Reranker-0.6B

### Architecture

The existing `ProviderRegistry` in `src/model/registry.ts` already supports composing providers per capability. The Ollama provider registers only for `'rerank'`; hash handles `embed` and `rewriteQuery` (same as the local provider). The wiring mirrors `buildProviderRegistry()` exactly.

```
TUBEROSA_MODEL_PROVIDER=ollama
  → buildOllamaRegistry(config)
      ├─ Hash: embed + rewriteQuery
      └─ OllamaRerankProvider: rerank
           └─ Falls back to Hash if Ollama HTTP call fails/unreachable
```

### New file: `src/model/ollama-provider.ts`

Implements `ModelProvider`. Key design decisions:
- **`embed` / `rewriteQuery`** delegate to an injected `fallback` (defaults to `HashModelProvider`) — same pattern as `LocalCrossEncoderProvider`.
- **`rerank`**: calls `POST <TUBEROSA_OLLAMA_URL>/api/rerank` with `{ model, query, documents: string[] }`. Ollama responds with `{ results: [{ index, relevance_score }] }`. Map `index` back to original candidates.
- **Score blend**: `0.70 × ollamaScore + 0.22 × fusedScore + 0.08 × trustScore` — same formula as the local Xenova provider for consistency.
- **Graceful degradation**: any network error, timeout, or non-200 response falls back to `this.fallback.rerank(input)` and logs to stderr (same pattern as `LocalCrossEncoderProvider.logLoadFailure`).
- **Timeout**: configurable via `TUBEROSA_OLLAMA_TIMEOUT_MS` (default 10 000 ms) using `AbortSignal.timeout()` (Node 22 built-in, no new deps).
- **topK window**: same sliding-window logic as local provider — rerank top-N, tail gets hash fallback, then merge + re-sort.
- **Test injection**: accept optional `fetchFn` in options (default `globalThis.fetch`) so tests mock HTTP without real Ollama.

```ts
export interface OllamaRerankerOptions {
  modelId?: string;       // default: TUBEROSA_OLLAMA_RERANK_MODEL ?? 'dengcao/Qwen3-Reranker-0.6B'
  ollamaUrl?: string;     // default: TUBEROSA_OLLAMA_URL ?? 'http://localhost:11434'
  topK?: number;          // default: TUBEROSA_RERANKER_TOPK ?? 16
  timeoutMs?: number;     // default: TUBEROSA_OLLAMA_TIMEOUT_MS ?? 10000
  fallback?: ModelProvider;
  fetchFn?: typeof fetch; // for test injection
}

export class OllamaRerankProvider implements ModelProvider {
  readonly name = 'ollama-reranker';
  // embed, rewriteQuery delegate to fallback
  // rerank calls POST /api/rerank
}
```

### Update `src/config.ts`

Extend `modelProvider` union type:
```ts
// Before
modelProvider: 'hash' | 'openai' | 'local';

// After
modelProvider: 'hash' | 'openai' | 'local' | 'ollama';
```

Add optional Ollama fields to `AppConfig`:
```ts
ollamaUrl?: string;
ollamaRerankModel?: string;
ollamaTimeoutMs?: number;
```

Read them in `loadConfig()`:
```ts
ollamaUrl: process.env.TUBEROSA_OLLAMA_URL,
ollamaRerankModel: process.env.TUBEROSA_OLLAMA_RERANK_MODEL,
ollamaTimeoutMs: process.env.TUBEROSA_OLLAMA_TIMEOUT_MS ? Number(process.env.TUBEROSA_OLLAMA_TIMEOUT_MS) : undefined,
```

### Update `src/model/registry.ts`

Add `buildOllamaRegistry(config: AppConfig): ModelProvider | null` next to `buildProviderRegistry`. Pattern is identical — hash for embed/rewrite, `OllamaRerankProvider` for rerank:
```ts
export function buildOllamaRegistry(config: AppConfig): ModelProvider | null {
  if (config.modelProvider !== 'ollama') return null;
  const hash = new HashModelProvider(config.embeddingDimensions);
  const registry = new ProviderRegistry(hash);
  registry.register(asCapabilityProvider({ name: 'hash', provider: hash, capabilities: ['embed', 'rewriteQuery'] }));
  registry.register(asCapabilityProvider({
    name: 'ollama-reranker',
    provider: new OllamaRerankProvider({
      modelId: config.ollamaRerankModel,
      ollamaUrl: config.ollamaUrl,
      timeoutMs: config.ollamaTimeoutMs,
      fallback: hash,
    }),
    capabilities: ['rerank'],
  }));
  return registry;
}
```

### Update `src/model/provider.ts`

In `createModelProvider`, handle the `'ollama'` case with lazy `require` (same pattern as `'local'`):
```ts
if (config.modelProvider === 'local') { ... }   // existing
if (config.modelProvider === 'ollama') {
  const { buildOllamaRegistry } = require('./registry.js');
  const registry = buildOllamaRegistry(config);
  if (registry) return registry;
}
```

### Update `.env.example`

Add Ollama section after the existing model provider block:
```
# Ollama reranker (TUBEROSA_MODEL_PROVIDER=ollama)
# Requires Ollama running at TUBEROSA_OLLAMA_URL with the model pulled:
#   ollama pull dengcao/Qwen3-Reranker-0.6B
# TUBEROSA_OLLAMA_URL=http://localhost:11434
# TUBEROSA_OLLAMA_RERANK_MODEL=dengcao/Qwen3-Reranker-0.6B
# TUBEROSA_OLLAMA_TIMEOUT_MS=10000
```

### New test: `test/ollama-provider.test.ts`

Five tests, all using injected `fetchFn` (no real Ollama required):

1. **Happy path**: mock returns `{ results: [{ index:0, relevance_score:0.9 }, { index:1, relevance_score:0.5 }] }` → top candidate has `matchReasons` containing `'ollama-rerank:'` and correct `rerankScore` blend.
2. **Reorder**: mock returns index order reversed → output candidates sorted by blended score descending.
3. **Network failure**: mock throws → falls back to hash provider rerank, no throw.
4. **Non-200 response**: mock returns `{ ok: false, status: 503 }` → falls back to hash, logs to stderr.
5. **Delegation**: `embed()` and `rewriteQuery()` delegate to hash fallback.

Use the same `buildCandidate()` / `buildInput()` helper pattern from `test/local-provider.test.ts`.

### Files touched
- NEW: `src/model/ollama-provider.ts`
- NEW: `test/ollama-provider.test.ts`
- `src/config.ts` — add `'ollama'` union + 3 fields
- `src/model/registry.ts` — add `buildOllamaRegistry` + import `OllamaRerankProvider`
- `src/model/provider.ts` — add `'ollama'` branch in `createModelProvider`
- `.env.example` — add Ollama env var block

### Verification
```bash
pnpm test                  # new test/ollama-provider.test.ts must pass; all prior tests stay green
pnpm run eval:retrieval    # must stay green (hash provider unchanged)
pnpm run sandbox           # must meet Phase 4 thresholds (hash provider used by default in sandbox)
```

Manual smoke test (requires Ollama running + model pulled):
```bash
ollama pull dengcao/Qwen3-Reranker-0.6B
TUBEROSA_MODEL_PROVIDER=ollama TUBEROSA_STORE=memory TUBEROSA_CACHE=memory pnpm run dev
# Then use tuberosa_search_context via MCP and verify matchReasons shows 'ollama-rerank:'
```

---

## Rollback

- **Step 1**: set `TUBEROSA_RERANKER_MODEL=Xenova/bge-reranker-base` in `.env` to restore old model. The constant change is a one-line revert.
- **Step 2**: `TUBEROSA_MODEL_PROVIDER=hash` (or `local`) reverts to existing behaviour. The new `'ollama'` branch is never reached; no migration needed.

---

## Order of execution

1. Step 1 first — 3-file, 3-line change. Verify tests + sandbox green.
2. Step 2 second — new provider + 5-file change. Verify tests + eval + sandbox green.
