# Local-First Provider Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real-world Tuberosa runs use real local models and fail loud when they are missing, never silently falling back to the fake hash provider, with a setup command + doctor check to keep models available.

**Architecture:** Add an explicit "strict" runtime (default when `provider=local`). In strict mode the local embedder and cross-encoder throw `ModelProviderError` instead of silently delegating to hash; a startup health check (`assertModelsReady`) refuses to boot when they are unavailable and points the user to `npx tuberosa setup-models`. Hash remains reachable only via explicit `TUBEROSA_MODEL_PROVIDER=hash` (tests/CI/embedded) or an opt-in `TUBEROSA_ALLOW_HASH_FALLBACK=true`. The cross-encoder blend gets real unit coverage via the existing injectable scorer.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 22, `node --test` runner via `tsx`, `@xenova/transformers` (optional, lazy-loaded), existing `bin/commands/*` CLI with injectable `CommandIo`.

## Global Constraints

- Node `>= 22.13` (repo pins `22.21.1` in `.nvmrc`). Prefix commands with `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH` if the shell uses an older Node.
- Run tests with the local-models guard set so no ONNX download happens in CI: `TUBEROSA_DISABLE_LOCAL_MODELS=true`.
- `pnpm run eval:retrieval` MUST stay green (hitRate=1, staleRejectionRate=1). It pins `provider=hash` — do not change that.
- MCP stdout is protocol-only: never add `console.log`/`process.stdout.write` to the MCP code path; use `stderr`.
- Do NOT add a `Co-Authored-By: Claude ...` trailer to any commit (user preference).
- Default-install promise: the local path must never silently degrade to hash. (This plan enforces it.)
- Use `.js` import specifiers in TS source (NodeNext resolution).

---

### Task 1: Config — add `allowHashFallback`

**Files:**
- Modify: `src/config.ts` (model block, ~line 134-151) and the `AppConfig.model` type (~line 20)
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `config.model.allowHashFallback: boolean` (default `false`; `true` when `TUBEROSA_ALLOW_HASH_FALLBACK` is `1`/`true`).

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.ts`:

```ts
test('allowHashFallback defaults to false and reads the env flag', () => {
  delete process.env.TUBEROSA_ALLOW_HASH_FALLBACK;
  assert.equal(loadConfig().model.allowHashFallback, false);
  process.env.TUBEROSA_ALLOW_HASH_FALLBACK = 'true';
  assert.equal(loadConfig().model.allowHashFallback, true);
  delete process.env.TUBEROSA_ALLOW_HASH_FALLBACK;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/config.test.ts`
Expected: FAIL — `allowHashFallback` is `undefined`.

- [ ] **Step 3: Add the field to the type and loader**

In `src/config.ts`, in the `model:` object type (near `provider: 'hash' | 'openai' | 'local' | 'ollama';`) add:

```ts
    /** When true, the real-world path may fall back to the hash provider. Off by default. */
    allowHashFallback: boolean;
```

In `loadConfig()`'s returned `model: { ... }` block add (next to `provider:`):

```ts
      allowHashFallback: readBoolean(process.env.TUBEROSA_ALLOW_HASH_FALLBACK, false),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): add allowHashFallback flag (default off)"
```

---

### Task 2: Cross-encoder blend unit test (closes the coverage gap)

This task adds the test that motivated the whole effort. No production change — it locks the existing `0.70/0.22/0.08` blend behavior so future tweaks can't pass silently.

**Files:**
- Test: `test/local-rerank-blend.test.ts` (create)

**Interfaces:**
- Consumes: `LocalCrossEncoderProvider` from `src/model/local-provider.js`, its `scorer` option (`LocalCrossEncoderScorer`).

- [ ] **Step 1: Write the failing test**

Create `test/local-rerank-blend.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalCrossEncoderProvider } from '../src/model/local-provider.js';
import type { RankedCandidate } from '../src/types.js';

function candidate(id: string, fusedScore: number, trustLevel: number, rank: number): RankedCandidate {
  return {
    knowledgeId: id, title: id, summary: id, content: id, contextualContent: id,
    fusedScore, trustLevel, rank, finalScore: fusedScore, rerankScore: fusedScore,
    matchReasons: [], references: [], labels: [], itemType: 'wiki', project: 'p',
  } as unknown as RankedCandidate;
}

test('blend = 0.70*model + 0.22*fused + 0.08*trust controls the order', async () => {
  // A has weak fused/trust but strong model score; B is the reverse.
  const scorer = {
    score: async (_p: string, items: Array<{ knowledgeId: string }>) =>
      items.map((it) => (it.knowledgeId === 'A' ? 1 : 0)),
  };
  const provider = new LocalCrossEncoderProvider({ scorer, embeddingDimensions: 384 });
  const result = await provider.rerank({
    prompt: 'q',
    classified: { project: 'p', taskType: 'unknown', confidence: 1, files: [], symbols: [], errors: [], technologies: [], businessAreas: [] },
    candidates: [candidate('B', 0.6, 50, 1), candidate('A', 0.2, 10, 2)],
  });
  // A: 0.70*1 + 0.22*0.2 + 0.08*0.1 = 0.752 ; B: 0.70*0 + 0.22*0.6 + 0.08*0.5 = 0.172
  assert.equal(result.candidates[0]!.knowledgeId, 'A');
  assert.ok(Math.abs(result.candidates[0]!.finalScore - 0.752) < 1e-9);
});

test('a model-blind blend (degenerate weights) would reorder — guards the recipe', async () => {
  // Same inputs, but if the model score were ignored, B (higher fused) would win.
  // This documents that the model term is load-bearing for the ordering above.
  const scorer = { score: async (_p: string, items: Array<{ knowledgeId: string }>) => items.map(() => 0) };
  const provider = new LocalCrossEncoderProvider({ scorer, embeddingDimensions: 384 });
  const result = await provider.rerank({
    prompt: 'q',
    classified: { project: 'p', taskType: 'unknown', confidence: 1, files: [], symbols: [], errors: [], technologies: [], businessAreas: [] },
    candidates: [candidate('B', 0.6, 50, 1), candidate('A', 0.2, 10, 2)],
  });
  assert.equal(result.candidates[0]!.knowledgeId, 'B');
});
```

- [ ] **Step 2: Run the test**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/local-rerank-blend.test.ts`
Expected: PASS (this verifies current behavior). If the `RankedCandidate` shape cast fails to compile, adjust the literal to match `src/types.ts` `RankedCandidate` exactly — read it first with `grep -n "interface RankedCandidate" src/types.ts`.

- [ ] **Step 3: Verify build**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Expected: clean (no `noUncheckedIndexedAccess` errors — note the `!` on `candidates[0]`).

- [ ] **Step 4: Commit**

```bash
git add test/local-rerank-blend.test.ts
git commit -m "test(rerank): cover the local cross-encoder blend weights"
```

---

### Task 3: Strict embeddings + readiness probes on `LocalCrossEncoderProvider`

**Files:**
- Modify: `src/model/local-provider.ts`
- Test: `test/local-provider-strict.test.ts` (create)

**Interfaces:**
- Consumes: `ModelProviderError` from `src/errors.js`.
- Produces (new on `LocalRerankerOptions`): `strict?: boolean`.
- Produces (new methods on `LocalCrossEncoderProvider`):
  - `hasLocalReranker(): Promise<boolean>`
  - `verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }>`

- [ ] **Step 1: Write the failing test**

Create `test/local-provider-strict.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalCrossEncoderProvider } from '../src/model/local-provider.js';
import { ModelProviderError } from '../src/errors.js';

test('strict mode throws instead of hashing when the embedder is unavailable', async () => {
  // No embedder injected + local models disabled => embedder is null.
  process.env.TUBEROSA_DISABLE_LOCAL_MODELS = 'true';
  const provider = new LocalCrossEncoderProvider({ strict: true, embeddingDimensions: 384 });
  await assert.rejects(() => provider.embed('hello'), ModelProviderError);
});

test('non-strict mode still falls back to hash embeddings', async () => {
  process.env.TUBEROSA_DISABLE_LOCAL_MODELS = 'true';
  const provider = new LocalCrossEncoderProvider({ strict: false, embeddingDimensions: 384 });
  const vector = await provider.embed('hello');
  assert.equal(vector.length, 384);
});

test('verifyReady reports both models false when disabled', async () => {
  process.env.TUBEROSA_DISABLE_LOCAL_MODELS = 'true';
  const provider = new LocalCrossEncoderProvider({ embeddingDimensions: 384 });
  const report = await provider.verifyReady();
  assert.deepEqual(report, { embedder: false, reranker: false, dims: null });
});

test('verifyReady reports true when scorer + embedder are injected', async () => {
  const provider = new LocalCrossEncoderProvider({
    embeddingDimensions: 3,
    embedder: { embed: async () => [0.1, 0.2, 0.3] },
    scorer: { score: async (_p, items) => items.map(() => 0.5) },
  });
  const report = await provider.verifyReady();
  assert.deepEqual(report, { embedder: true, reranker: true, dims: 3 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/local-provider-strict.test.ts`
Expected: FAIL — `strict` option ignored; `verifyReady`/`hasLocalReranker` undefined.

- [ ] **Step 3: Implement strict + probes**

In `src/model/local-provider.ts`:

Add the import at the top (after the existing imports):

```ts
import { ModelProviderError } from '../errors.js';
```

Add to `LocalRerankerOptions`:

```ts
  /** When true, embed/rerank throw ModelProviderError instead of silently using hash. */
  strict?: boolean;
```

Add a field and assign it in the constructor (next to the other `private readonly` fields and assignments):

```ts
  private readonly strict: boolean;
```
```ts
    this.strict = options.strict ?? false;
```

Replace the three hash-fallback exits in `embed()` with strict-aware versions:

```ts
  async embed(text: string): Promise<number[]> {
    const embedder = await this.loadEmbedder();
    if (!embedder) {
      if (this.strict) throw new ModelProviderError('local embedding model unavailable; run `npx tuberosa setup-models`');
      return this.fallback.embed(text);
    }
    try {
      const vector = await embedder.embed(text);
      if (this.expectedDimensions !== undefined && vector.length !== this.expectedDimensions) {
        const message = `local embedder returned ${vector.length} dims, expected ${this.expectedDimensions}; check TUBEROSA_EMBEDDING_MODEL vs EMBEDDING_DIMENSIONS`;
        if (this.strict) throw new ModelProviderError(message);
        this.logEmbedFailure(message);
        this.embedderPromise = Promise.resolve(null);
        return this.fallback.embed(text);
      }
      return vector;
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (this.strict) throw new ModelProviderError(`local embedder threw: ${error instanceof Error ? error.message : String(error)}`);
      this.logEmbedFailure(`local embedder threw: ${error instanceof Error ? error.message : String(error)}`);
      return this.fallback.embed(text);
    }
  }
```

Add the two probe methods (after `probeEmbeddingDimensions`):

```ts
  /** True when the real local cross-encoder is loadable. */
  async hasLocalReranker(): Promise<boolean> {
    return (await this.loadScorer()) !== null;
  }

  /** Probe both models without falling back. Used by setup-models and the startup health check. */
  async verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }> {
    const dims = await this.probeEmbeddingDimensions();
    const reranker = await this.hasLocalReranker();
    return { embedder: dims !== null, reranker, dims };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/local-provider-strict.test.ts`
Expected: PASS (all four tests).

- [ ] **Step 5: Build + commit**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
git add src/model/local-provider.ts test/local-provider-strict.test.ts
git commit -m "feat(model): strict local embeddings + verifyReady probes"
```

---

### Task 4: Strict rerank degrades to real fused order (not hash)

In strict mode, a rerank failure should throw `ModelProviderError`; the retrieval service already catches rerank throws and degrades to the **real fused ordering** (`src/retrieval/service.ts:840-871`), marking `rerankerAvailable: false`. That is the desired "never fake" behavior.

**Files:**
- Modify: `src/model/local-provider.ts` (`rerank`)
- Test: `test/local-provider-strict.test.ts` (extend)

**Interfaces:**
- Consumes: `strict` flag from Task 3.

- [ ] **Step 1: Write the failing test**

Append to `test/local-provider-strict.test.ts`:

```ts
test('strict rerank throws when the scorer is unavailable', async () => {
  process.env.TUBEROSA_DISABLE_LOCAL_MODELS = 'true';
  const provider = new LocalCrossEncoderProvider({ strict: true, embeddingDimensions: 384 });
  await assert.rejects(() => provider.rerank({
    prompt: 'q',
    classified: { project: 'p', taskType: 'unknown', confidence: 1, files: [], symbols: [], errors: [], technologies: [], businessAreas: [] },
    candidates: [{ knowledgeId: 'A', title: 'A', summary: 'A', content: 'A', contextualContent: 'A', fusedScore: 0.5, trustLevel: 50, rank: 1, finalScore: 0.5, rerankScore: 0.5, matchReasons: [], references: [], labels: [], itemType: 'wiki', project: 'p' } as any],
  }), ModelProviderError);
});

test('strict rerank with a working scorer still blends normally', async () => {
  const provider = new LocalCrossEncoderProvider({ strict: true, embeddingDimensions: 3, scorer: { score: async (_p, items) => items.map(() => 0.9) } });
  const result = await provider.rerank({
    prompt: 'q',
    classified: { project: 'p', taskType: 'unknown', confidence: 1, files: [], symbols: [], errors: [], technologies: [], businessAreas: [] },
    candidates: [{ knowledgeId: 'A', title: 'A', summary: 'A', content: 'A', contextualContent: 'A', fusedScore: 0.5, trustLevel: 50, rank: 1, finalScore: 0.5, rerankScore: 0.5, matchReasons: [], references: [], labels: [], itemType: 'wiki', project: 'p' } as any],
  });
  assert.equal(result.candidates.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/local-provider-strict.test.ts`
Expected: FAIL — first new test does not throw (returns hash rerank).

- [ ] **Step 3: Implement strict rerank**

In `rerank()`, replace the two `return this.fallback.rerank(input);` branches:

The scorer-missing branch:

```ts
    const scorer = await this.loadScorer();
    if (!scorer) {
      if (this.strict) throw new ModelProviderError('local cross-encoder unavailable; run `npx tuberosa setup-models`');
      return this.fallback.rerank(input);
    }
```

The scoring-threw branch (inside the `catch`):

```ts
    } catch (error) {
      if (this.strict) throw new ModelProviderError(`local reranker scoring threw: ${error instanceof Error ? error.message : String(error)}`);
      this.logLoadFailure(`local reranker scoring threw: ${error instanceof Error ? error.message : String(error)}`);
      return this.fallback.rerank(input);
    }
```

- [ ] **Step 4: Run test + confirm the service degrade path is intact**

Run: `node --test --import tsx test/local-provider-strict.test.ts`
Expected: PASS.

Run: `grep -n "rerankerAvailable: false" src/retrieval/service.ts`
Expected: still present (~line 865) — confirms the service degrades a thrown rerank to real fused order.

- [ ] **Step 5: Build + commit**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
git add src/model/local-provider.ts test/local-provider-strict.test.ts
git commit -m "feat(model): strict rerank throws so the service keeps real fused order"
```

---

### Task 5: Factory + registry — remove the silent hash fallback, thread strict, expose verifyReady

**Files:**
- Modify: `src/model/factory.ts`
- Modify: `src/model/registry.ts`
- Test: `test/model-factory-strict.test.ts` (create)

**Interfaces:**
- Consumes: `config.model.allowHashFallback` (Task 1); `LocalCrossEncoderProvider` `strict` + `verifyReady` (Tasks 3-4).
- Produces: `ProviderRegistry.verifyReady?(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }>`; `createModelProvider` throws `ModelProviderError` rather than returning hash when `provider !== 'hash'` and `allowHashFallback` is false.

- [ ] **Step 1: Write the failing test**

Create `test/model-factory-strict.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelProvider } from '../src/model/factory.js';
import { HashModelProvider } from '../src/model/provider.js';
import { ModelProviderError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';

function configWith(overrides: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const config = loadConfig();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return config;
}

test('explicit hash provider still returns HashModelProvider', () => {
  const config = configWith({ TUBEROSA_MODEL_PROVIDER: 'hash' });
  assert.ok(createModelProvider(config) instanceof HashModelProvider);
});

test('openai selected without a key throws instead of returning hash', () => {
  const config = configWith({ TUBEROSA_MODEL_PROVIDER: 'openai', OPENAI_API_KEY: undefined, TUBEROSA_ALLOW_HASH_FALLBACK: undefined });
  assert.throws(() => createModelProvider(config), ModelProviderError);
});

test('allowHashFallback=true permits the hash fallback', () => {
  const config = configWith({ TUBEROSA_MODEL_PROVIDER: 'openai', OPENAI_API_KEY: undefined, TUBEROSA_ALLOW_HASH_FALLBACK: 'true' });
  assert.ok(createModelProvider(config) instanceof HashModelProvider);
});

test('local provider exposes verifyReady', () => {
  const config = configWith({ TUBEROSA_MODEL_PROVIDER: 'local' });
  const models = createModelProvider(config) as { verifyReady?: unknown };
  assert.equal(typeof models.verifyReady, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/model-factory-strict.test.ts`
Expected: FAIL — `openai`-without-key returns hash (no throw); `verifyReady` missing.

- [ ] **Step 3: Implement registry passthrough + strict wiring**

In `src/model/registry.ts`, add a health field + methods to `ProviderRegistry` (after the `fallback` field / constructor):

```ts
  private healthProvider?: { verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }> };

  setHealthProvider(provider: { verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }> }): void {
    this.healthProvider = provider;
  }

  async verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }> {
    if (!this.healthProvider) return { embedder: true, reranker: true, dims: null };
    return this.healthProvider.verifyReady();
  }
```

In `buildProviderRegistry`, pass `strict` to the local provider and register it as the health provider:

```ts
  const local = new LocalCrossEncoderProvider({
    embeddingDimensions: config.model.embeddingDimensions,
    embeddingModelId: config.model.embeddingModel,
    fallback: hash,
    strict: !config.model.allowHashFallback,
  });
```

Immediately after `registry.register(... 'local-cross-encoder' ...)`, add:

```ts
  registry.setHealthProvider(local);
```

In `src/model/factory.ts`, replace the final `return new HashModelProvider(...)` with a strict guard:

```ts
export function createModelProvider(config: AppConfig): ModelProvider {
  if (config.model.provider === 'openai' && config.model.openAiApiKey) {
    return new OpenAiModelProvider(config);
  }

  if (config.model.provider === 'local') {
    const registry = buildProviderRegistry(config);
    if (registry) return registry;
  }

  if (config.model.provider === 'ollama') {
    const registry = buildOllamaRegistry(config);
    if (registry) return registry;
  }

  if (config.model.provider === 'hash' || config.model.allowHashFallback) {
    return new HashModelProvider(config.model.embeddingDimensions);
  }

  throw new ModelProviderError(
    `model provider '${config.model.provider}' could not be initialized and hash fallback is disabled. `
    + 'Set the required credentials, run `npx tuberosa setup-models`, or set TUBEROSA_ALLOW_HASH_FALLBACK=true to opt into degraded mode.',
  );
}
```

Add the import to `src/model/factory.ts`:

```ts
import { ModelProviderError } from '../errors.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/model-factory-strict.test.ts`
Expected: PASS.

- [ ] **Step 5: Build + full suite + commit**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
TUBEROSA_DISABLE_LOCAL_MODELS=true pnpm test
```
Expected: build clean; full suite green (watch for any test that relied on the old silent-hash factory fallback — if one fails, it was asserting the bug; update it to set `TUBEROSA_MODEL_PROVIDER=hash` or `TUBEROSA_ALLOW_HASH_FALLBACK=true` explicitly).

```bash
git add src/model/factory.ts src/model/registry.ts test/model-factory-strict.test.ts
git commit -m "feat(model): remove silent hash fallback; expose registry verifyReady"
```

---

### Task 6: Startup health check in `createAppServices`

**Files:**
- Create: `src/model/health.ts`
- Modify: `src/app.ts` (after `const models = createModelProvider(config);`, ~line 51)
- Test: `test/model-health.test.ts` (create)

**Interfaces:**
- Consumes: `ModelProvider` (optional `verifyReady`), `AppConfig`, `ModelProviderError`.
- Produces: `assertModelsReady(models: ModelProvider, config: AppConfig): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `test/model-health.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertModelsReady } from '../src/model/health.js';
import { ModelProviderError } from '../src/errors.js';
import type { AppConfig } from '../src/config.js';

const baseModel = { embed: async () => [], rewriteQuery: async () => undefined, rerank: async () => ({ candidates: [] }) };
function cfg(provider: string, allowHashFallback = false, env = 'development'): AppConfig {
  return { env, model: { provider, allowHashFallback } } as unknown as AppConfig;
}

test('skips the check for non-local providers', async () => {
  await assertModelsReady(baseModel as any, cfg('hash'));
});

test('skips the check in the test env', async () => {
  await assertModelsReady(baseModel as any, cfg('local', false, 'test'));
});

test('throws when the local embedder is unavailable', async () => {
  const models = { ...baseModel, verifyReady: async () => ({ embedder: false, reranker: true, dims: null }) };
  await assert.rejects(() => assertModelsReady(models as any, cfg('local')), ModelProviderError);
});

test('throws when the reranker is unavailable', async () => {
  const models = { ...baseModel, verifyReady: async () => ({ embedder: true, reranker: false, dims: 384 }) };
  await assert.rejects(() => assertModelsReady(models as any, cfg('local')), ModelProviderError);
});

test('passes when both models are ready', async () => {
  const models = { ...baseModel, verifyReady: async () => ({ embedder: true, reranker: true, dims: 384 }) };
  await assertModelsReady(models as any, cfg('local'));
});

test('skips when allowHashFallback is set', async () => {
  const models = { ...baseModel, verifyReady: async () => ({ embedder: false, reranker: false, dims: null }) };
  await assertModelsReady(models as any, cfg('local', true));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/model-health.test.ts`
Expected: FAIL — `src/model/health.js` does not exist.

- [ ] **Step 3: Implement `assertModelsReady`**

Create `src/model/health.ts`:

```ts
import type { AppConfig } from '../config.js';
import { ModelProviderError } from '../errors.js';
import type { ModelProvider } from './provider.js';

interface ReadinessProbe { verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }>; }

function hasVerifyReady(models: ModelProvider): models is ModelProvider & ReadinessProbe {
  return typeof (models as Partial<ReadinessProbe>).verifyReady === 'function';
}

/**
 * Real-world guard: when running the local provider in strict mode, refuse to
 * start unless the local embedding model AND cross-encoder actually load. This
 * is the boundary that stops Tuberosa silently serving fake (hash) search.
 */
export async function assertModelsReady(models: ModelProvider, config: AppConfig): Promise<void> {
  if (config.model.provider !== 'local' || config.model.allowHashFallback) return;
  if (config.env === 'test') return; // unit/integration tests construct providers directly
  if (!hasVerifyReady(models)) return;

  const report = await models.verifyReady();
  const remedy = 'Run `npx tuberosa setup-models` to download the local models, or set TUBEROSA_ALLOW_HASH_FALLBACK=true for degraded mode.';
  if (!report.embedder) {
    throw new ModelProviderError(`Local embedding model is unavailable — refusing to start with fake search. ${remedy}`);
  }
  if (!report.reranker) {
    throw new ModelProviderError(`Local cross-encoder is unavailable — refusing to start with fake search. ${remedy}`);
  }
}
```

- [ ] **Step 4: Wire it into `createAppServices`**

In `src/app.ts`, add the import (with the other model import):

```ts
import { assertModelsReady } from './model/health.js';
```

Directly after `const models = createModelProvider(config);` add:

```ts
  await assertModelsReady(models, config);
```

- [ ] **Step 5: Run test + build to verify it passes**

Run: `node --test --import tsx test/model-health.test.ts`
Expected: PASS.
Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/model/health.ts src/app.ts test/model-health.test.ts
git commit -m "feat(app): fail loud at startup when local models are missing"
```

---

### Task 7: `tuberosa setup-models` CLI command

Downloads + verifies the embedding model and cross-encoder in-process (no subprocess), then prints a clear result. Testable via an injected provider factory.

**Files:**
- Create: `bin/commands/setup-models.ts`
- Modify: `bin/commands/types.ts` (add `'setup-models'` to the command union)
- Modify: `bin/commands/parser.ts` (recognize the token)
- Modify: `bin/tuberosa.ts` (dispatch + import)
- Modify: `bin/commands/parser.ts` `usage()` (document it)
- Test: `test/cli-setup-models.test.ts` (create)

**Interfaces:**
- Consumes: `CliInvocation`, `CommandIo`, `CommandResult` from `./types.js`.
- Produces: `setupModelsCommand(invocation, io, deps?): Promise<CommandResult>` where `deps.makeProbe?: () => { verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }> }`.

- [ ] **Step 1: Write the failing test**

Create `test/cli-setup-models.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupModelsCommand } from '../bin/commands/setup-models.js';
import type { CommandIo } from '../bin/commands/types.js';

function fakeIo(): CommandIo & { lines: string[]; errs: string[] } {
  const lines: string[] = []; const errs: string[] = [];
  return { lines, errs, cwd: '/tmp', env: {}, out: (l: string) => lines.push(l), err: (l: string) => errs.push(l) } as any;
}

test('exits 0 and reports success when both models load', async () => {
  const io = fakeIo();
  const result = await setupModelsCommand({ command: 'setup-models', options: {}, positional: [] }, io, {
    makeProbe: () => ({ verifyReady: async () => ({ embedder: true, reranker: true, dims: 384 }) }),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(io.lines.join('\n').includes('384'));
});

test('exits 1 when a model fails to load', async () => {
  const io = fakeIo();
  const result = await setupModelsCommand({ command: 'setup-models', options: {}, positional: [] }, io, {
    makeProbe: () => ({ verifyReady: async () => ({ embedder: false, reranker: true, dims: null }) }),
  });
  assert.equal(result.exitCode, 1);
  assert.ok(io.errs.join('\n').toLowerCase().includes('embedding'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/cli-setup-models.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the command**

Create `bin/commands/setup-models.ts`:

```ts
import type { CliInvocation, CommandIo, CommandResult } from './types.js';
import { LocalCrossEncoderProvider } from '../../src/model/local-provider.js';

export interface SetupModelsDeps {
  makeProbe?: () => { verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }> };
}

/**
 * `tuberosa setup-models` — download + verify the local embedding model and
 * cross-encoder so real-world runs never fall back to fake (hash) search.
 * Idempotent: re-running with a warm cache just re-verifies.
 */
export async function setupModelsCommand(
  _invocation: CliInvocation,
  io: CommandIo,
  deps: SetupModelsDeps = {},
): Promise<CommandResult> {
  const dims = io.env.EMBEDDING_DIMENSIONS ? Number(io.env.EMBEDDING_DIMENSIONS) : 384;
  const makeProbe = deps.makeProbe ?? (() => new LocalCrossEncoderProvider({ embeddingDimensions: dims }));
  io.out('Setting up local models (this downloads on first run; may take a few minutes)...');
  const report = await makeProbe().verifyReady();

  if (report.embedder) io.out(`✓ embedding model ready (${report.dims} dims)`);
  else io.err('✗ embedding model failed to load — check your network/proxy and disk space.');

  if (report.reranker) io.out('✓ cross-encoder reranker ready');
  else io.err('✗ cross-encoder reranker failed to load — check your network/proxy and disk space.');

  const ok = report.embedder && report.reranker;
  io.out(ok ? 'Local models are ready. Real search is enabled.' : 'Setup incomplete — see errors above.');
  return { exitCode: ok ? 0 : 1 };
}
```

Note: the in-process probe respects `TUBEROSA_DISABLE_LOCAL_MODELS`/`NODE_ENV=test` (returns false), which is why the test injects `makeProbe`.

- [ ] **Step 4: Wire command into the parser + dispatcher**

In `bin/commands/types.ts`, add `'setup-models'` to the `CliInvocation['command']` union (find the union with `'init' | 'doctor' | ...`).

In `bin/commands/parser.ts`, extend the recognized-command condition:

```ts
      if (
        token === 'init' || token === 'doctor' || token === 'mcp'
        || token === 'sync' || token === 'hook' || token === 'atlas'
        || token === 'bootstrap' || token === 'setup-models' || token === 'help'
      ) {
```

In `bin/tuberosa.ts`, add the import and dispatch case:

```ts
import { setupModelsCommand } from './commands/setup-models.js';
```
```ts
    case 'setup-models':
      return setupModelsCommand(invocation, io);
```

In `parser.ts` `usage()`, add a line under `Commands:` (after the `bootstrap` line):

```ts
    '  setup-models  Download + verify the local embedding model and cross-encoder (real search; no API key).',
```

- [ ] **Step 5: Run test + build to verify it passes**

Run: `node --test --import tsx test/cli-setup-models.test.ts`
Expected: PASS.
Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add bin/commands/setup-models.ts bin/commands/types.ts bin/commands/parser.ts bin/tuberosa.ts test/cli-setup-models.test.ts
git commit -m "feat(cli): add tuberosa setup-models command"
```

---

### Task 8: Extend `tuberosa doctor` — reranker check, corrected remediation, `--deep`

**Files:**
- Modify: `bin/commands/doctor.ts`
- Test: `test/doctor.test.ts` (extend; confirm the file name first with `ls test | grep doctor`)

**Interfaces:**
- Consumes: existing `DoctorCheck`, `CommandIo`, `runDoctorChecks`.
- Produces: a new `checkRerankerModel` check; updated `checkEmbeddingModel` remediation wording; a `--deep` option that actually loads the models via `LocalCrossEncoderProvider.verifyReady`.

- [ ] **Step 1: Write the failing test**

Add to the doctor test file (e.g. `test/doctor.test.ts`):

```ts
test('doctor checks the reranker model and points to setup-models', async () => {
  const io = makeDoctorIo({ env: { TUBEROSA_MODEL_PROVIDER: 'local', HOME: '/no/such/home' } });
  const checks = await runDoctorChecks({ command: 'doctor', options: {}, positional: [] }, io);
  const reranker = checks.find((c) => c.name === 'reranker model');
  assert.ok(reranker, 'expected a reranker model check');
  assert.match(reranker!.remediation ?? '', /setup-models/);
  const embedding = checks.find((c) => c.name === 'embedding model');
  assert.match(embedding!.remediation ?? '', /setup-models/);
  assert.doesNotMatch(embedding!.detail + (embedding!.remediation ?? ''), /fall back to hash/);
});
```

If the existing test file has no `makeDoctorIo` helper, reuse the pattern already used by the other doctor tests (inject `fs.exists`); read the file first with `grep -n "runDoctorChecks\|io" test/doctor.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/doctor.test.ts`
Expected: FAIL — no `reranker model` check; embedding remediation still mentions hash.

- [ ] **Step 3: Implement the checks**

In `bin/commands/doctor.ts`, change the embedding-model `warn` branch remediation (currently line ~197-198) from:

```ts
    detail: `${model} not found in ${cacheDir} — first query will download it (or fall back to hash)`,
    remediation: 'Run `npx tuberosa init` (its warm-up step downloads the model).',
```
to:

```ts
    detail: `${model} not found in ${cacheDir} — real search needs it`,
    remediation: 'Run `npx tuberosa setup-models` to download the local models.',
```

Add a reranker check function modeled on `checkEmbeddingModel`:

```ts
async function checkRerankerModel(io: CommandIo): Promise<DoctorCheck> {
  const provider = io.env.TUBEROSA_MODEL_PROVIDER ?? (io.env.OPENAI_API_KEY ? 'openai' : 'local');
  if (provider !== 'local') {
    return { name: 'reranker model', status: 'skip', detail: `provider is '${provider}' — no local reranker needed` };
  }
  if (!io.fs) return { name: 'reranker model', status: 'skip', detail: 'fs unavailable' };
  const cacheDir = io.env.TUBEROSA_MODEL_CACHE_DIR ?? `${io.env.HOME ?? '~'}/.cache/tuberosa/models`;
  const model = io.env.TUBEROSA_RERANKER_MODEL ?? 'onnx-community/bge-reranker-v2-m3-ONNX';
  const modelPath = `${cacheDir}/${model}`;
  if (await io.fs.exists(modelPath)) {
    return { name: 'reranker model', status: 'ok', detail: `${model} cached at ${modelPath}` };
  }
  return {
    name: 'reranker model',
    status: 'warn',
    detail: `${model} not found in ${cacheDir} — real reranking needs it`,
    remediation: 'Run `npx tuberosa setup-models` to download the local models.',
  };
}
```

Register it in `runDoctorChecks`, right after `checks.push(await checkEmbeddingModel(io));`:

```ts
  checks.push(await checkRerankerModel(io));
```

For `--deep`: in `runDoctorChecks`, after the static checks, when `invocation.options.deep === true`, append a check that actually loads the models:

```ts
  if (invocation.options.deep === true) {
    checks.push(await checkModelsLoad(io));
  }
```

And add:

```ts
async function checkModelsLoad(io: CommandIo): Promise<DoctorCheck> {
  const provider = io.env.TUBEROSA_MODEL_PROVIDER ?? (io.env.OPENAI_API_KEY ? 'openai' : 'local');
  if (provider !== 'local') return { name: 'models load (deep)', status: 'skip', detail: `provider is '${provider}'` };
  try {
    const { LocalCrossEncoderProvider } = await import('../../src/model/local-provider.js');
    const dims = io.env.EMBEDDING_DIMENSIONS ? Number(io.env.EMBEDDING_DIMENSIONS) : 384;
    const report = await new LocalCrossEncoderProvider({ embeddingDimensions: dims }).verifyReady();
    if (report.embedder && report.reranker) return { name: 'models load (deep)', status: 'ok', detail: `both models loaded (${report.dims} dims)` };
    return { name: 'models load (deep)', status: 'fail', detail: `embedder=${report.embedder} reranker=${report.reranker}`, remediation: 'Run `npx tuberosa setup-models`.' };
  } catch (error) {
    return { name: 'models load (deep)', status: 'fail', detail: (error as Error).message, remediation: 'Run `npx tuberosa setup-models`.' };
  }
}
```

- [ ] **Step 4: Run test + build to verify it passes**

Run: `node --test --import tsx test/doctor.test.ts`
Expected: PASS.
Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add bin/commands/doctor.ts test/doctor.test.ts
git commit -m "feat(doctor): reranker check, setup-models remediation, --deep load probe"
```

---

### Task 9: Wire `init` to run setup-models + document it

**Files:**
- Modify: `bin/commands/init.ts` (warm-up section, ~line 90-95)
- Modify: `docs/SETUP.md`
- Test: covered by existing `test/init*.test.ts` behavior; add an assertion only if an init test already injects the warm-up path (check with `grep -n "warmup" test/init*.test.ts`).

**Interfaces:**
- Consumes: the new `setup-models` command and the existing `runPackageScript`. `init` should ensure BOTH models are present (today it warms only embeddings).

- [ ] **Step 1: Decide the integration point**

`init` already runs the `warmup-embeddings` package script (fatal on failure). The reranker is not covered. The lowest-risk change that ships a real reranker too: after a successful embedding warm-up, also verify the reranker loads, reusing the in-process probe (no new package script needed).

- [ ] **Step 2: Implement**

In `bin/commands/init.ts`, immediately after the existing warm-up success (after the `warmupExit` block, ~line 95), add:

```ts
  // The cross-encoder is a separate model from embeddings; load it now so the
  // first real search doesn't pay the download and never silently degrades.
  try {
    const { LocalCrossEncoderProvider } = await import('../../src/model/local-provider.js');
    const dims = io.env.EMBEDDING_DIMENSIONS ? Number(io.env.EMBEDDING_DIMENSIONS) : 384;
    const hasReranker = await new LocalCrossEncoderProvider({ embeddingDimensions: dims }).hasLocalReranker();
    io.out(hasReranker ? '✓ cross-encoder reranker ready' : '! cross-encoder not cached yet — run `npx tuberosa setup-models`');
  } catch {
    io.out('! could not verify the cross-encoder — run `npx tuberosa setup-models`');
  }
```

(Reranker readiness is a warning, not fatal: search still works via the startup health check, which is the authoritative gate.)

- [ ] **Step 3: Document in SETUP.md**

In `docs/SETUP.md`, add a section:

```markdown
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
```

- [ ] **Step 4: Build + full suite + commit**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
TUBEROSA_DISABLE_LOCAL_MODELS=true pnpm test
```
Expected: build clean; full suite green.

```bash
git add bin/commands/init.ts docs/SETUP.md
git commit -m "feat(init): verify cross-encoder + document setup-models"
```

---

### Task 10: Final verification gates

**Files:** none (verification only).

- [ ] **Step 1: Run every gate**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH
pnpm run build                                   # clean
TUBEROSA_DISABLE_LOCAL_MODELS=true pnpm test     # all green
pnpm run eval:retrieval                          # PASS (hitRate=1, staleRejectionRate=1)
pnpm run eval:agent-context                      # PASS
pnpm run verify:bundled-skills                   # PASS
```

- [ ] **Step 2: Manual smoke (real models, optional but recommended)**

```bash
npx tuberosa setup-models      # expect two ✓ lines + "Local models are ready"
npx tuberosa doctor --deep     # expect embedding + reranker checks ok
```

- [ ] **Step 3: Fail-loud smoke**

With the model cache emptied and `TUBEROSA_ALLOW_HASH_FALLBACK` unset, start the server and confirm it exits with the `setup-models` message (not silent fake search). Re-set `TUBEROSA_ALLOW_HASH_FALLBACK=true` and confirm it boots degraded.

- [ ] **Step 4: GitNexus + commit hygiene**

```bash
npx gitnexus analyze           # reindex (code changed)
```
Confirm `gitnexus_detect_changes` (or the CLI equivalent) shows only the symbols this plan touched.
