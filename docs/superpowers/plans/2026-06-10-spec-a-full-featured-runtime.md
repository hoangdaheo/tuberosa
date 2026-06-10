# Spec A — Full-Featured Default Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a plain `tuberosa init` + `tuberosa mcp` install run REAL local embeddings (`Xenova/bge-small-en-v1.5`, 384-dim) against Docker Postgres + Redis by default — no API key, no hash fallback unless the user explicitly opts into `--embedded` trial mode.

**Architecture:** Extend the existing `local` provider (which today only reranks locally — its `embed()` delegates to hash) with a real lazy-loaded embedding pipeline, standardize every provider on 384 dimensions via migration `014`, add a re-embed backfill and a warm-up script, then flip the CLI defaults (`buildEnv`, `init` Docker-required) on top. Tests and evals stay pinned to the deterministic hash provider via an explicit `TUBEROSA_DISABLE_LOCAL_MODELS` guard.

**Tech Stack:** TypeScript (Node 22, ESM), `@xenova/transformers` (pure JS/WASM ONNX), pg/pgvector, node:test + tsx.

**Spec:** `docs/superpowers/specs/2026-06-10-full-featured-enduser-design.md` (Spec A). Read it first.

**Conventions you must follow (from CLAUDE.md):**
- Run commands with `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH` prefix if the shell's Node is older than 22.13.
- MCP stdout is protocol-only — never `console.log` in the MCP code path; diagnostics go to stderr.
- `pnpm run eval:retrieval` must stay green; you may not edit eval fixtures/thresholds.
- Commit messages: conventional style, NO co-author trailers.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/model/local-provider.ts` | Modify | Add `LocalEmbedder` seam + lazy `feature-extraction` pipeline; keep rerank as-is |
| `src/config.ts` | Modify | `embeddingModel` field; defaults: provider `local`, dims `384` |
| `src/model/registry.ts` | Modify | `local` registry gains `embed` capability |
| `migrations/014_embedding_dim_384.sql` | Create | Both embedding columns → `vector(384)`, HNSW rebuilt |
| `src/storage/embedding-dimensions.ts` | Create | Startup dimension validation (pure + queryable seam) |
| `src/app.ts` | Modify | Validate dims on Postgres startup |
| `src/storage/reembed.ts` | Create | Backfill null embeddings (pure over a queryable seam) |
| `scripts/reembed.ts` | Create | CLI entry for the backfill |
| `scripts/warmup-embeddings.ts` | Create | Download/verify the embedding model; exit 1 on failure |
| `bin/commands/mcp.ts` | Modify | `buildEnv` full-feature defaults + `--embedded` |
| `src/mcp-stdio.ts` | Modify | Friendly fail-fast stderr on startup error |
| `bin/commands/init.ts` | Modify | Docker hard-fail, `--embedded`, warm-up + reembed steps |
| `bin/commands/doctor.ts` | Modify | Embedding-model cache check |
| `bin/commands/parser.ts` | Modify | Help text for new defaults/flags |
| `package.json` | Modify | `@xenova/transformers` dep, `reembed` script, test-guard env |
| `.env.example`, docs | Modify | New defaults documented |
| Tests | Modify/Create | `test/local-provider.test.ts`, `test/model-registry.test.ts`, `test/config.test.ts`, `test/cli.test.ts`, `test/embedding-dimensions.test.ts`, `test/reembed.test.ts`, `test/integration.test.ts` |

---

### Task 1: Real local embeddings in `LocalCrossEncoderProvider`

**Files:**
- Modify: `src/model/local-provider.ts`
- Modify: `package.json` (dependency + test-script guard)
- Test: `test/local-provider.test.ts`

- [ ] **Step 1: Add the dependency and the test-script guard**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm add @xenova/transformers
```

Then in `package.json`, change the test script (CRITICAL: once `@xenova/transformers` is installed, any test that exercises the default load path would try to download models; the guard keeps unit tests deterministic and offline):

```json
"test": "TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/*.test.ts",
```

- [ ] **Step 2: Write the failing tests**

Append to `test/local-provider.test.ts` (it already imports `LocalCrossEncoderProvider`; extend the import with `type LocalEmbedder`):

```typescript
import { LocalCrossEncoderProvider, type LocalCrossEncoderScorer, type LocalEmbedder } from '../src/model/local-provider.js';
```

```typescript
describe('local embeddings', () => {
  it('uses the injected embedder for embed()', async () => {
    const embedder: LocalEmbedder = {
      async embed() {
        return [0.1, 0.2, 0.3];
      },
    };
    const provider = new LocalCrossEncoderProvider({ embedder, embeddingDimensions: 3 });
    const vector = await provider.embed('hello');
    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  });

  it('falls back to hash when the embedder throws', async () => {
    const embedder: LocalEmbedder = {
      async embed() {
        throw new Error('boom');
      },
    };
    const provider = new LocalCrossEncoderProvider({ embedder, embeddingDimensions: 384 });
    const vector = await provider.embed('hello');
    assert.equal(vector.length, 384); // hash fallback respects configured dims
  });

  it('falls back to hash when the embedder returns wrong dimensions', async () => {
    const embedder: LocalEmbedder = {
      async embed() {
        return [1, 2]; // 2 dims, expected 384
      },
    };
    const provider = new LocalCrossEncoderProvider({ embedder, embeddingDimensions: 384 });
    const vector = await provider.embed('hello');
    assert.equal(vector.length, 384);
  });

  it('falls back to hash when local models are disabled via env', async () => {
    process.env.TUBEROSA_DISABLE_LOCAL_MODELS = 'true';
    try {
      const provider = new LocalCrossEncoderProvider({ embeddingDimensions: 384 });
      assert.equal(await provider.hasLocalEmbedder(), false);
      const vector = await provider.embed('hello');
      assert.equal(vector.length, 384);
    } finally {
      delete process.env.TUBEROSA_DISABLE_LOCAL_MODELS;
    }
  });

  it('reports hasLocalEmbedder() = true with an injected embedder', async () => {
    const embedder: LocalEmbedder = {
      async embed() {
        return [0.5];
      },
    };
    const provider = new LocalCrossEncoderProvider({ embedder });
    assert.equal(await provider.hasLocalEmbedder(), true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/local-provider.test.ts`
Expected: FAIL — `LocalEmbedder` is not exported, `embedder` option unknown, `hasLocalEmbedder` undefined.

- [ ] **Step 4: Implement the embedder in `src/model/local-provider.ts`**

4a. Add imports at the top (after the existing imports):

```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';
```

4b. Replace the file's header comment paragraph that starts `* Embeddings + query rewrite delegate to the fallback hash provider` (lines 22-24) with:

```typescript
 * Embeddings run on a lazily-loaded local model (`Xenova/bge-small-en-v1.5` by
 * default, 384-dim). Query rewrite delegates to the fallback hash provider.
 * When the model cannot load (offline, TUBEROSA_DISABLE_LOCAL_MODELS=true),
 * embed() falls back to hash with ONE stderr warning — never silently.
```

4c. Add to `LocalRerankerOptions` (after the `scorer?` member):

```typescript
  /** Pretrained embedding model id. Defaults to `Xenova/bge-small-en-v1.5` (384-dim). */
  embeddingModelId?: string;
  /**
   * Optional injected embedder. When provided, the provider uses it instead of
   * loading the ONNX pipeline. Tests rely on this to stay deterministic/offline.
   */
  embedder?: LocalEmbedder;
```

4d. Add the interface next to `LocalCrossEncoderScorer`:

```typescript
export interface LocalEmbedder {
  /** Return one embedding vector for the text. */
  embed(text: string): Promise<number[]>;
  /** Optional dispose hook for the underlying pipeline. */
  dispose?(): Promise<void> | void;
}
```

4e. Add constants next to `DEFAULT_MODEL_ID`:

```typescript
const DEFAULT_EMBEDDING_MODEL_ID = 'Xenova/bge-small-en-v1.5';
const DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'tuberosa', 'models');
```

4f. In the class: add fields, extend the constructor, replace `embed()`, add the loader. New/changed members:

```typescript
  private readonly embeddingModelId: string;
  private readonly expectedDimensions?: number;
  private embedderPromise: Promise<LocalEmbedder | null> | null = null;
  private hasLoggedEmbedFailure = false;
```

Constructor additions (cacheDir line REPLACES the existing one — the default cache moves to a stable, doctor-checkable location):

```typescript
    this.cacheDir = options.cacheDir ?? process.env.TUBEROSA_MODEL_CACHE_DIR ?? DEFAULT_CACHE_DIR;
    this.embeddingModelId = options.embeddingModelId ?? process.env.TUBEROSA_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL_ID;
    this.expectedDimensions = options.embeddingDimensions;
    if (options.embedder) {
      this.embedderPromise = Promise.resolve(options.embedder);
    }
```

Note: `cacheDir` field changes from `private readonly cacheDir?: string;` to `private readonly cacheDir: string;`.

Replace the current `embed()` (which only delegates to fallback):

```typescript
  async embed(text: string): Promise<number[]> {
    const embedder = await this.loadEmbedder();
    if (!embedder) {
      return this.fallback.embed(text);
    }
    try {
      const vector = await embedder.embed(text);
      if (this.expectedDimensions !== undefined && vector.length !== this.expectedDimensions) {
        this.logEmbedFailure(
          `local embedder returned ${vector.length} dims, expected ${this.expectedDimensions}; check TUBEROSA_EMBEDDING_MODEL vs EMBEDDING_DIMENSIONS`,
        );
        return this.fallback.embed(text);
      }
      return vector;
    } catch (error) {
      this.logEmbedFailure(`local embedder threw: ${error instanceof Error ? error.message : String(error)}`);
      return this.fallback.embed(text);
    }
  }

  /** True when the real local embedding pipeline is loadable (used by the init warm-up). */
  async hasLocalEmbedder(): Promise<boolean> {
    return (await this.loadEmbedder()) !== null;
  }

  private async loadEmbedder(): Promise<LocalEmbedder | null> {
    if (this.embedderPromise) return this.embedderPromise;
    this.embedderPromise = this.createDefaultEmbedder();
    return this.embedderPromise;
  }

  private async createDefaultEmbedder(): Promise<LocalEmbedder | null> {
    if (localModelsDisabled()) {
      this.logEmbedFailure('local models disabled (NODE_ENV=test or TUBEROSA_DISABLE_LOCAL_MODELS=true)');
      return null;
    }
    try {
      const transformers = (await dynamicImport('@xenova/transformers')) as TransformersModule | null;
      if (!transformers || typeof transformers.pipeline !== 'function') {
        this.logEmbedFailure('@xenova/transformers is not installed; install it to enable local embeddings');
        return null;
      }
      if (transformers.env) {
        transformers.env.cacheDir = this.cacheDir;
      }
      const pipeline = await transformers.pipeline('feature-extraction', this.embeddingModelId, {
        quantized: true,
      });
      return new TransformersEmbedder(pipeline);
    } catch (error) {
      this.logEmbedFailure(`local embedder init failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private logEmbedFailure(reason: string): void {
    if (this.hasLoggedEmbedFailure) return;
    this.hasLoggedEmbedFailure = true;
    if ((process.env.NODE_ENV ?? '') === 'test' || process.env.TUBEROSA_SILENT_LOCAL_PROVIDER === 'true') return;
    process.stderr.write(`[tuberosa] local embedder unavailable; falling back to hash embeddings — ${reason}\n`);
  }
```

4g. Same guard for the reranker (now that the package is installed, tests without an injected scorer must not download the ~150MB reranker). At the TOP of the existing `createDefaultScorer()`:

```typescript
    if (localModelsDisabled()) {
      this.logLoadFailure('local models disabled (NODE_ENV=test or TUBEROSA_DISABLE_LOCAL_MODELS=true)');
      return null;
    }
```

4h. Module-level helpers at the bottom (next to `TransformersScorer`):

```typescript
function localModelsDisabled(): boolean {
  return (process.env.NODE_ENV ?? '') === 'test' || process.env.TUBEROSA_DISABLE_LOCAL_MODELS === 'true';
}

class TransformersEmbedder implements LocalEmbedder {
  constructor(private readonly pipeline: TransformersPipeline) {}

  async embed(text: string): Promise<number[]> {
    const raw = await this.pipeline(text, { pooling: 'mean', normalize: true });
    return toVector(raw);
  }
}

/** Transformers feature-extraction returns a Tensor ({ data: Float32Array }) or nested arrays. */
function toVector(raw: unknown): number[] {
  if (raw && typeof raw === 'object' && 'data' in raw) {
    const data = (raw as { data: ArrayLike<number> }).data;
    return Array.from(data, (value) => Number(value));
  }
  if (Array.isArray(raw)) {
    const flat = Array.isArray(raw[0]) ? (raw[0] as unknown[]) : raw;
    return flat.map((value) => Number(value));
  }
  throw new Error('unexpected feature-extraction output shape');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/local-provider.test.ts`
Expected: PASS, including all pre-existing rerank tests (`# fail 0`).

- [ ] **Step 6: Full suite + commit**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test` — expected `# fail 0`.

```bash
git add src/model/local-provider.ts test/local-provider.test.ts package.json pnpm-lock.yaml
git commit -m "feat(model): real local embeddings (bge-small-en-v1.5) with hash fallback + test guard"
```

---

### Task 2: Config — `embeddingModel` field, defaults `local` + 384

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.ts` (follow the file's existing pattern of setting/unsetting `process.env` around `loadConfig()` — match its helper style; the assertions are what matter):

```typescript
describe('full-featured defaults (Spec A)', () => {
  it('defaults the model provider to local when no OpenAI key is set', () => {
    delete process.env.TUBEROSA_MODEL_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    const config = loadConfig();
    assert.equal(config.model.provider, 'local');
  });

  it('still prefers openai when an API key is present', () => {
    delete process.env.TUBEROSA_MODEL_PROVIDER;
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const config = loadConfig();
      assert.equal(config.model.provider, 'openai');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('defaults embedding dimensions to 384 and the model to bge-small', () => {
    delete process.env.EMBEDDING_DIMENSIONS;
    delete process.env.TUBEROSA_EMBEDDING_MODEL;
    const config = loadConfig();
    assert.equal(config.model.embeddingDimensions, 384);
    assert.equal(config.model.embeddingModel, 'Xenova/bge-small-en-v1.5');
  });

  it('honors TUBEROSA_EMBEDDING_MODEL', () => {
    process.env.TUBEROSA_EMBEDDING_MODEL = 'Xenova/other-model';
    try {
      assert.equal(loadConfig().model.embeddingModel, 'Xenova/other-model');
    } finally {
      delete process.env.TUBEROSA_EMBEDDING_MODEL;
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/config.test.ts`
Expected: FAIL (provider is `hash`, dims 1536, `embeddingModel` undefined).

- [ ] **Step 3: Implement in `src/config.ts`**

3a. In the `model:` type block, add after `embeddingDimensions: number;`:

```typescript
    /** Local embedding model id (TUBEROSA_EMBEDDING_MODEL). 384-dim by default. */
    embeddingModel: string;
```

3b. In `loadConfig()`, the `model:` object — three changed lines and one new line:

```typescript
      provider: readEnum(process.env.TUBEROSA_MODEL_PROVIDER, ['hash', 'openai', 'local', 'ollama'], process.env.OPENAI_API_KEY ? 'openai' : 'local'),
      embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 384),
      embeddingModel: process.env.TUBEROSA_EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5',
```

and inside `llmCriticEnabled` change the inline fallback `'hash'` to `'local'`:

```typescript
        (process.env.TUBEROSA_MODEL_PROVIDER ?? (process.env.OPENAI_API_KEY ? 'openai' : 'local')) === 'openai',
```

3c. In `src/model/local-provider.ts`, change the constructor's hash-fallback default dims from 1536 to 384:

```typescript
    this.fallback = options.fallback ?? new HashModelProvider(options.embeddingDimensions ?? 384);
```

- [ ] **Step 4: Run tests + fix fallout**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test`
Expected: config tests PASS. If other tests fail because they relied on the implicit `hash`/1536 defaults, fix the TESTS by setting the env or config explicitly (e.g. `provider: 'hash'`, `embeddingDimensions: 1536` in their config literals) — do NOT weaken the new defaults. `test/support/test-config.ts` likely needs `embeddingModel: 'Xenova/bge-small-en-v1.5'` added to satisfy the type; eval scripts (`scripts/eval-*.ts`) construct config literals that now need the `embeddingModel` field too — add it with the default value, change nothing else in them.

- [ ] **Step 5: Eval gate + commit**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval` — must exit 0, all PASS (eval pins `provider: 'hash'`, `embeddingDimensions: 1536` explicitly; only the added type field touches it).

```bash
git add src/config.ts src/model/local-provider.ts test/ scripts/
git commit -m "feat(config): default provider=local, 384-dim embeddings, TUBEROSA_EMBEDDING_MODEL"
```

---

### Task 3: Registry — `local` gains the `embed` capability

**Files:**
- Modify: `src/model/registry.ts`
- Test: `test/model-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/model-registry.test.ts` (match its existing config-literal helper; the key assertions):

```typescript
describe('local registry embed capability (Spec A)', () => {
  it('routes embed through the local provider, not hash', () => {
    const registry = buildProviderRegistry(makeConfig({ provider: 'local' }));
    assert.ok(registry);
    const entries = (registry as ProviderRegistry).describe();
    const embedEntry = entries.find((entry) => entry.capability === 'embed');
    assert.equal(embedEntry?.providerName, 'local-cross-encoder');
    const rewriteEntry = entries.find((entry) => entry.capability === 'rewriteQuery');
    assert.equal(rewriteEntry?.providerName, 'hash');
  });
});
```

(`makeConfig` = whatever helper the file already uses to build an `AppConfig` with `model.provider` overridable; reuse it. Import `ProviderRegistry` from `../src/model/registry.js` if not already imported.)

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/model-registry.test.ts`
Expected: FAIL — embed entry's providerName is `hash`.

- [ ] **Step 3: Implement in `buildProviderRegistry`**

Replace the body after `const registry = new ProviderRegistry(hash);` (currently registers hash for `['embed', 'rewriteQuery']` and local for `['rerank']`):

```typescript
  const local = new LocalCrossEncoderProvider({
    embeddingDimensions: config.model.embeddingDimensions,
    embeddingModelId: config.model.embeddingModel,
    fallback: hash,
  });
  registry.register(asCapabilityProvider({
    name: 'hash',
    provider: hash,
    capabilities: ['rewriteQuery'],
  }));
  registry.register(asCapabilityProvider({
    name: 'local-cross-encoder',
    provider: local,
    capabilities: ['embed', 'rerank'],
  }));
  return registry;
```

Also update the doc comment line `- \`TUBEROSA_MODEL_PROVIDER=local\`: hash embeddings + local cross-encoder rerank.` to:

```typescript
 * - `TUBEROSA_MODEL_PROVIDER=local` (default): local embeddings (bge-small) + local cross-encoder rerank.
```

Leave `buildOllamaRegistry` untouched.

- [ ] **Step 4: Run tests, then commit**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test` — `# fail 0`.

```bash
git add src/model/registry.ts test/model-registry.test.ts
git commit -m "feat(model): local provider registry embeds locally instead of hash"
```

---

### Task 4: Migration `014_embedding_dim_384.sql` + integration-test dims

**Files:**
- Create: `migrations/014_embedding_dim_384.sql`
- Modify: `test/integration.test.ts` (and `test/support/test-config.ts` if it pins 1536)

- [ ] **Step 1: Write the migration**

Create `migrations/014_embedding_dim_384.sql`:

```sql
-- Spec A: standardize embeddings at 384 dimensions (Xenova/bge-small-en-v1.5;
-- OpenAI text-embedding-3-small with dimensions=384).
-- 1536-d vectors cannot be cast down, so existing embeddings are cleared.
-- `pnpm run reembed` backfills them (tuberosa init runs it automatically).

DROP INDEX IF EXISTS idx_chunks_embedding_hnsw;
DROP INDEX IF EXISTS idx_atoms_embedding;

ALTER TABLE knowledge_chunks ALTER COLUMN embedding TYPE vector(384) USING NULL::vector(384);
ALTER TABLE knowledge_atoms  ALTER COLUMN embedding TYPE vector(384) USING NULL::vector(384);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_atoms_embedding   ON knowledge_atoms USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 2: Update integration fixtures from 1536 to 384**

In `test/integration.test.ts`, change `const models = new HashModelProvider(1536);` to `new HashModelProvider(384)` (every occurrence — grep the file). Then:

```bash
grep -rn "1536" test/integration.test.ts test/support/
```

Update any hit that feeds vectors into Postgres to 384. Do NOT touch 1536 in eval scripts or memory-store unit tests — they never touch the Postgres schema.

Add inside the main integration test (after `await runMigrations(migrationPool)` but before `migrationPool.end()`):

```typescript
  const chunkDim = await migrationPool.query(
    `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
     WHERE attrelid = 'knowledge_chunks'::regclass AND attname = 'embedding'`,
  );
  equal(chunkDim.rows[0]?.type, 'vector(384)');
  const atomDim = await migrationPool.query(
    `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
     WHERE attrelid = 'knowledge_atoms'::regclass AND attname = 'embedding'`,
  );
  equal(atomDim.rows[0]?.type, 'vector(384)');
```

- [ ] **Step 3: Run the integration test against Docker**

```bash
docker compose up -d postgres redis
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
```

Expected: PASS (or SKIP if Docker is genuinely unavailable — in that case state so in the task report; the migration will be re-verified in Task 12).

- [ ] **Step 4: Commit**

```bash
git add migrations/014_embedding_dim_384.sql test/integration.test.ts test/support/
git commit -m "feat(storage): migrate embedding columns to vector(384) with HNSW rebuild"
```

---

### Task 5: Startup dimension validation

**Files:**
- Create: `src/storage/embedding-dimensions.ts`
- Modify: `src/app.ts`
- Test: `test/embedding-dimensions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/embedding-dimensions.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseVectorDimension, validateEmbeddingDimensions } from '../src/storage/embedding-dimensions.js';

function stubDb(typeByTable: Record<string, string | undefined>) {
  return {
    async query(_text: string, params?: unknown[]) {
      const table = String(params?.[0]);
      const type = typeByTable[table];
      return { rows: type ? [{ type }] : [] };
    },
  };
}

describe('parseVectorDimension', () => {
  it('parses vector(384)', () => {
    assert.equal(parseVectorDimension('vector(384)'), 384);
  });
  it('returns null for non-vector types', () => {
    assert.equal(parseVectorDimension('text'), null);
  });
});

describe('validateEmbeddingDimensions', () => {
  it('passes when both tables match', async () => {
    const db = stubDb({ knowledge_chunks: 'vector(384)', knowledge_atoms: 'vector(384)' });
    await validateEmbeddingDimensions(db, 384);
  });

  it('throws a guided error on mismatch', async () => {
    const db = stubDb({ knowledge_chunks: 'vector(1536)', knowledge_atoms: 'vector(1536)' });
    await assert.rejects(
      () => validateEmbeddingDimensions(db, 384),
      /vector\(1536\).*EMBEDDING_DIMENSIONS=384.*tuberosa init/s,
    );
  });

  it('skips tables that do not exist yet', async () => {
    const db = stubDb({});
    await validateEmbeddingDimensions(db, 384);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/embedding-dimensions.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/storage/embedding-dimensions.ts`**

```typescript
/**
 * Spec A — enforce the "embedding dimensions must be consistent" constraint
 * mechanically: the vector(N) columns must match EMBEDDING_DIMENSIONS, or we
 * fail fast at startup with a guided error instead of corrupting searches.
 */

export interface DimensionQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<{ type?: string }> }>;
}

const EMBEDDING_COLUMNS = [
  { table: 'knowledge_chunks', column: 'embedding' },
  { table: 'knowledge_atoms', column: 'embedding' },
] as const;

export function parseVectorDimension(formatted: string): number | null {
  const match = /^vector\((\d+)\)$/.exec(formatted.trim());
  return match ? Number(match[1]) : null;
}

export async function validateEmbeddingDimensions(db: DimensionQueryable, expected: number): Promise<void> {
  for (const target of EMBEDDING_COLUMNS) {
    const result = await db.query(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
       WHERE attrelid = to_regclass($1) AND attname = $2`,
      [target.table, target.column],
    );
    const formatted = result.rows[0]?.type;
    if (!formatted) continue; // table not created yet; migrations define the right dim
    const actual = parseVectorDimension(formatted);
    if (actual !== null && actual !== expected) {
      throw new Error(
        `Embedding dimension mismatch: ${target.table}.${target.column} is vector(${actual}) `
        + `but EMBEDDING_DIMENSIONS=${expected}. Run 'npx tuberosa init' to apply migrations, `
        + `or set EMBEDDING_DIMENSIONS=${actual} to match the database.`,
      );
    }
  }
}
```

(Note `to_regclass($1)` rather than `$1::regclass` — it returns NULL instead of throwing when the table is missing.)

- [ ] **Step 4: Wire into `src/app.ts`**

Add the import:

```typescript
import { validateEmbeddingDimensions } from './storage/embedding-dimensions.js';
```

Replace `migrateStoreIfNeeded` (validation must run even when `autoMigrate=false`, so the early-return shape changes):

```typescript
async function migrateStoreIfNeeded(config: AppConfig): Promise<void> {
  if (config.storage.store !== 'postgres') {
    return;
  }

  const pool = new Pool({ connectionString: config.storage.databaseUrl });
  try {
    if (config.storage.autoMigrate) {
      await runMigrations(pool, {
        onApplied: (file) => {
          if (config.env !== 'test') {
            console.error(`Applied database migration ${file}`);
          }
        },
      });
    }
    await validateEmbeddingDimensions(pool, config.model.embeddingDimensions);
  } finally {
    await pool.end();
  }
}
```

- [ ] **Step 5: Run tests + commit**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test` — `# fail 0`.

```bash
git add src/storage/embedding-dimensions.ts src/app.ts test/embedding-dimensions.test.ts
git commit -m "feat(storage): fail fast on embedding dimension mismatch at startup"
```

---

### Task 6: Re-embed backfill

**Files:**
- Create: `src/storage/reembed.ts`
- Create: `scripts/reembed.ts`
- Modify: `package.json`
- Test: `test/reembed.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/reembed.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reembedMissing } from '../src/storage/reembed.js';

interface Call { text: string; params?: unknown[] }

function stubDb(rowsByTable: Record<string, Array<{ id: string; text: string }>>) {
  const calls: Call[] = [];
  const remaining = new Map(Object.entries(rowsByTable).map(([k, v]) => [k, [...v]]));
  return {
    calls,
    db: {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params });
        if (text.startsWith('SELECT')) {
          const table = /FROM (\w+)/.exec(text)![1]!;
          const limit = Number(params?.[0] ?? 50);
          const rows = (remaining.get(table) ?? []).splice(0, limit);
          return { rows };
        }
        return { rows: [] };
      },
    },
  };
}

describe('reembedMissing', () => {
  it('embeds and updates every null-embedding row in both tables', async () => {
    const { db, calls } = stubDb({
      knowledge_chunks: [
        { id: 'c1', text: 'chunk one' },
        { id: 'c2', text: 'chunk two' },
      ],
      knowledge_atoms: [{ id: 'a1', text: 'claim one' }],
    });
    const embedded: string[] = [];
    const result = await reembedMissing(db, async (text) => {
      embedded.push(text);
      return [0.1, 0.2];
    });
    assert.equal(result.knowledge_chunks, 2);
    assert.equal(result.knowledge_atoms, 1);
    assert.deepEqual(embedded, ['chunk one', 'chunk two', 'claim one']);
    const updates = calls.filter((call) => call.text.startsWith('UPDATE'));
    assert.equal(updates.length, 3);
    assert.equal(updates[0]!.params?.[0], '[0.1,0.2]');
    assert.equal(updates[0]!.params?.[1], 'c1');
  });

  it('returns zeros when nothing is missing', async () => {
    const { db } = stubDb({ knowledge_chunks: [], knowledge_atoms: [] });
    const result = await reembedMissing(db, async () => [1]);
    assert.equal(result.knowledge_chunks, 0);
    assert.equal(result.knowledge_atoms, 0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/reembed.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/storage/reembed.ts`**

```typescript
/**
 * Spec A — backfill embeddings after migration 014 cleared them (or after any
 * provider/model change). Idempotent: only touches rows where embedding IS NULL,
 * so it is safe to interrupt and re-run.
 */

export interface ReembedQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<{ id: string; text: string }> }>;
}

export interface ReembedOptions {
  batchSize?: number;
  onProgress?: (table: string, done: number) => void;
}

export interface ReembedResult {
  knowledge_chunks: number;
  knowledge_atoms: number;
}

const TARGETS = [
  { table: 'knowledge_chunks', textExpr: "coalesce(nullif(contextual_content, ''), content)" },
  { table: 'knowledge_atoms', textExpr: 'claim' },
] as const;

export async function reembedMissing(
  db: ReembedQueryable,
  embed: (text: string) => Promise<number[]>,
  options: ReembedOptions = {},
): Promise<ReembedResult> {
  const batchSize = options.batchSize ?? 50;
  const result: ReembedResult = { knowledge_chunks: 0, knowledge_atoms: 0 };

  for (const target of TARGETS) {
    while (true) {
      const batch = await db.query(
        `SELECT id, ${target.textExpr} AS text FROM ${target.table} WHERE embedding IS NULL ORDER BY id LIMIT $1`,
        [batchSize],
      );
      if (batch.rows.length === 0) break;
      for (const row of batch.rows) {
        const vector = await embed(row.text ?? '');
        await db.query(
          `UPDATE ${target.table} SET embedding = $1::vector WHERE id = $2`,
          [`[${vector.join(',')}]`, row.id],
        );
        result[target.table as keyof ReembedResult] += 1;
      }
      options.onProgress?.(target.table, result[target.table as keyof ReembedResult]);
    }
  }
  return result;
}
```

- [ ] **Step 4: CLI entry `scripts/reembed.ts`** (mirrors `scripts/migrate.ts`)

```typescript
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { createModelProvider } from '../src/model/factory.js';
import { reembedMissing } from '../src/storage/reembed.js';

const config = loadConfig();
if (config.storage.store !== 'postgres') {
  process.stderr.write('[tuberosa] reembed skipped: TUBEROSA_STORE is not postgres.\n');
  process.exit(0);
}

const pool = new Pool({ connectionString: config.storage.databaseUrl });
const provider = createModelProvider(config);

try {
  const result = await reembedMissing(pool, (text) => provider.embed(text), {
    onProgress: (table, done) => process.stderr.write(`[tuberosa] reembed ${table}: ${done}\n`),
  });
  process.stderr.write(
    `[tuberosa] reembed complete: ${result.knowledge_chunks} chunk(s), ${result.knowledge_atoms} atom(s).\n`,
  );
} finally {
  await pool.end();
}
```

Add to `package.json` scripts:

```json
"reembed": "tsx scripts/reembed.ts",
```

- [ ] **Step 5: Run tests + build + commit**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build` — both green (build proves `Pool` satisfies `ReembedQueryable`).

```bash
git add src/storage/reembed.ts scripts/reembed.ts test/reembed.test.ts package.json
git commit -m "feat(storage): idempotent re-embed backfill for null embeddings"
```

---

### Task 7: Warm-up script

**Files:**
- Create: `scripts/warmup-embeddings.ts`

No unit test (thin script over already-tested provider methods); init's spawn of it is tested in Task 9.

- [ ] **Step 1: Implement `scripts/warmup-embeddings.ts`**

```typescript
/**
 * Spec A — `tuberosa init` warm-up: download/load the local embedding model NOW
 * so the agent's first real call is fast, and FAIL the init if the default
 * install would silently degrade to hash.
 *
 * Exit codes: 0 = ready (or provider is not 'local' — nothing to warm),
 *             1 = local model failed to load or produced wrong dimensions.
 */
import { loadConfig } from '../src/config.js';
import { LocalCrossEncoderProvider } from '../src/model/local-provider.js';

const config = loadConfig();
if (config.model.provider !== 'local') {
  process.stderr.write(`[tuberosa] warmup skipped: model provider is '${config.model.provider}'.\n`);
  process.exit(0);
}

const provider = new LocalCrossEncoderProvider({
  embeddingDimensions: config.model.embeddingDimensions,
  embeddingModelId: config.model.embeddingModel,
});

if (!(await provider.hasLocalEmbedder())) {
  process.stderr.write(
    '[tuberosa] embedding model failed to load/download. Check network/proxy and disk space, '
    + 'or re-run `npx tuberosa init --embedded` for volatile trial mode.\n',
  );
  process.exit(1);
}

const vector = await provider.embed('tuberosa warmup');
if (vector.length !== config.model.embeddingDimensions) {
  process.stderr.write(
    `[tuberosa] embedding model produced ${vector.length} dims but EMBEDDING_DIMENSIONS=${config.model.embeddingDimensions}. `
    + 'Fix TUBEROSA_EMBEDDING_MODEL / EMBEDDING_DIMENSIONS so they agree.\n',
  );
  process.exit(1);
}
process.stderr.write(`[tuberosa] embedding model ready (${config.model.embeddingModel}, ${vector.length} dims).\n`);
```

- [ ] **Step 2: Smoke-run it (downloads ~34 MB once)**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH npx tsx scripts/warmup-embeddings.ts; echo "exit=$?"`
Expected: `[tuberosa] embedding model ready (Xenova/bge-small-en-v1.5, 384 dims).` then `exit=0`. (If the machine is offline, expected: the failure message and `exit=1` — that is the designed behavior; note it and move on.)

- [ ] **Step 3: Verify the disable-guard makes it fail closed**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true npx tsx scripts/warmup-embeddings.ts; echo "exit=$?"`
Expected: failure message, `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add scripts/warmup-embeddings.ts
git commit -m "feat(cli): embedding warm-up script for init"
```

---

### Task 8: `tuberosa mcp` full-feature defaults + `--embedded` + fail-fast

**Files:**
- Modify: `bin/commands/mcp.ts`
- Modify: `src/mcp-stdio.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/cli.test.ts`, find the existing `buildEnv` tests and REPLACE assertions that expect `memory`/`hash` defaults; add:

```typescript
describe('mcp buildEnv (Spec A defaults)', () => {
  it('defaults to the full-feature stack', () => {
    const env = buildEnv({});
    assert.equal(env.TUBEROSA_STORE, 'postgres');
    assert.equal(env.TUBEROSA_CACHE, 'redis');
    assert.equal(env.TUBEROSA_MODEL_PROVIDER, 'local');
    assert.equal(env.TUBEROSA_AUTO_MIGRATE, 'false');
  });

  it('preserves user-exported values', () => {
    const env = buildEnv({ TUBEROSA_STORE: 'memory', TUBEROSA_MODEL_PROVIDER: 'openai' });
    assert.equal(env.TUBEROSA_STORE, 'memory');
    assert.equal(env.TUBEROSA_MODEL_PROVIDER, 'openai');
    assert.equal(env.TUBEROSA_CACHE, 'redis');
  });

  it('--embedded forces the volatile trial stack', () => {
    const env = buildEnv({ TUBEROSA_STORE: 'postgres' }, { embedded: true });
    assert.equal(env.TUBEROSA_STORE, 'memory');
    assert.equal(env.TUBEROSA_CACHE, 'memory');
    assert.equal(env.TUBEROSA_MODEL_PROVIDER, 'hash');
  });

  it('TUBEROSA_EMBEDDED=1 in the environment triggers embedded mode', () => {
    const env = buildEnv({ TUBEROSA_EMBEDDED: '1' });
    assert.equal(env.TUBEROSA_STORE, 'memory');
    assert.equal(env.TUBEROSA_MODEL_PROVIDER, 'hash');
  });
});
```

And one mcpCommand-level test (reuse the file's `makeIo` harness; assert the spawned child's env):

```typescript
  it('mcp --embedded spawns the server with the trial env', async () => {
    const fs = makeFs({ '/pkg/dist/src/mcp-stdio.js': 'compiled' });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/pkg' } });
    const result = await mcpCommand({ command: 'mcp', options: { embedded: true }, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.equal(harness.spawnCalls[0]?.env?.TUBEROSA_STORE, 'memory');
    assert.equal(harness.spawnCalls[0]?.env?.TUBEROSA_MODEL_PROVIDER, 'hash');
  });
```

(Check how existing mcp tests satisfy `resolvePackageRoot` — follow the same fixture; `TUBEROSA_PACKAGE_ROOT` env is the documented escape hatch.)

- [ ] **Step 2: Run to verify failure**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/cli.test.ts`
Expected: new tests FAIL; old buildEnv assertions you replaced should now match the new expectations (if you missed one, it fails here — fix it).

- [ ] **Step 3: Implement `buildEnv` + flag in `bin/commands/mcp.ts`**

Replace `buildEnv`:

```typescript
export function buildEnv(
  env: Record<string, string | undefined>,
  options: { embedded?: boolean } = {},
): Record<string, string | undefined> {
  const embedded = options.embedded === true
    || env.TUBEROSA_EMBEDDED === '1'
    || env.TUBEROSA_EMBEDDED === 'true';
  if (embedded) {
    // Volatile trial mode — explicit opt-in, so it overrides exported values.
    return {
      ...env,
      TUBEROSA_STORE: 'memory',
      TUBEROSA_CACHE: 'memory',
      TUBEROSA_MODEL_PROVIDER: 'hash',
      TUBEROSA_AUTO_MIGRATE: 'false',
    };
  }
  return {
    ...env,
    TUBEROSA_STORE: env.TUBEROSA_STORE ?? 'postgres',
    TUBEROSA_CACHE: env.TUBEROSA_CACHE ?? 'redis',
    TUBEROSA_MODEL_PROVIDER: env.TUBEROSA_MODEL_PROVIDER ?? 'local',
    TUBEROSA_AUTO_MIGRATE: env.TUBEROSA_AUTO_MIGRATE ?? 'false',
  };
}
```

In `mcpCommand`, change the env construction line to pass the flag:

```typescript
  const env = buildEnv(io.env, { embedded: invocation.options.embedded === true });
```

Update the file's header comment "Strategy" bullet about embedded-mode defaults to describe the new default (postgres/redis/local) and the `--embedded` / `TUBEROSA_EMBEDDED=1` escape hatch.

- [ ] **Step 4: Fail-fast in `src/mcp-stdio.ts`**

Replace `const services = await createAppServices();` with:

```typescript
import type { AppServices } from './app.js';
```
(add to the existing import line from `./app.js`)

```typescript
let services: AppServices;
try {
  services = await createAppServices();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[tuberosa] MCP server startup failed: ${message}\n`);
  process.stderr.write(
    "[tuberosa] If the store is unreachable, run 'npx tuberosa init' first, "
    + 'or set TUBEROSA_EMBEDDED=1 for volatile trial mode.\n',
  );
  process.exit(1);
}
```

(stdout stays untouched — JSON-RPC only.)

- [ ] **Step 5: Run tests + commit**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test` — `# fail 0`. Also `pnpm run build`.

```bash
git add bin/commands/mcp.ts src/mcp-stdio.ts test/cli.test.ts
git commit -m "feat(cli): tuberosa mcp defaults to full-feature stack with --embedded escape hatch"
```

---

### Task 9: `tuberosa init` — Docker hard-fail, `--embedded`, warm-up, reembed

**Files:**
- Modify: `bin/commands/init.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Update/write the tests**

Existing init tests in `test/cli.test.ts` assert the silent embedded fallback (exit 0 when Docker is missing) — REWRITE those to the new contract, and add the new ones:

```typescript
describe('init (Spec A contract)', () => {
  it('hard-fails with guidance when Docker is missing', async () => {
    const harness = makeIo({
      spawn: makeSpawn((command) => (
        command === 'docker' ? { exitCode: 1, stdout: '', stderr: 'not found' } : { exitCode: 0, stdout: '', stderr: '' }
      ), []),
    });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 1);
    assert.ok(harness.stderr.join('\n').includes('docs.docker.com'));
    assert.ok(harness.stderr.join('\n').includes('--embedded'));
  });

  it('--embedded prints trial-mode instructions and exits 0 without Docker', async () => {
    const harness = makeIo({
      spawn: makeSpawn(() => ({ exitCode: 1, stdout: '', stderr: '' }), []),
    });
    const result = await initCommand({ command: 'init', options: { embedded: true }, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.ok(harness.stdout.join('\n').includes('volatile'));
  });

  it('--no-docker still works but prints a deprecation note', async () => {
    const harness = makeIo({
      spawn: makeSpawn(() => ({ exitCode: 1, stdout: '', stderr: '' }), []),
    });
    const result = await initCommand({ command: 'init', options: { 'no-docker': true }, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.ok(harness.stderr.join('\n').includes('deprecated'));
  });

  it('fails when the embedding warm-up fails', async () => {
    // Full happy path until the warm-up spawn (node …warmup-embeddings…) exits 1.
    const fs = makeFs({ '/work/proj/.env.example': 'X=1', '/pkg/dist/scripts/migrate.js': 'm', '/pkg/dist/scripts/warmup-embeddings.js': 'w', '/pkg/migrations': 'dir' });
    const harness = makeIo({
      fs,
      env: { TUBEROSA_PACKAGE_ROOT: '/pkg' },
      spawn: makeSpawn((command, args) => {
        if (args.some((arg) => arg.includes('warmup-embeddings'))) return { exitCode: 1, stdout: '', stderr: 'model download failed' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }, []),
    });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 1);
    assert.ok(harness.stderr.join('\n').includes('--embedded'));
  });

  it('runs the reembed backfill after migrations and only warns on failure', async () => {
    const fs = makeFs({ '/work/proj/.env.example': 'X=1', '/pkg/dist/scripts/migrate.js': 'm', '/pkg/dist/scripts/warmup-embeddings.js': 'w', '/pkg/dist/scripts/reembed.js': 'r', '/pkg/migrations': 'dir' });
    const spawnCalls: RecordedSpawn[] = [];
    const harness = makeIo({
      fs,
      env: { TUBEROSA_PACKAGE_ROOT: '/pkg' },
      spawn: makeSpawn((command, args) => {
        if (args.some((arg) => arg.includes('reembed'))) return { exitCode: 1, stdout: '', stderr: 'transient' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }, spawnCalls),
    });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0); // reembed failure is a warning, not fatal
    assert.ok(spawnCalls.some((call) => call.args.some((arg) => arg.includes('reembed'))));
    assert.ok(harness.stderr.join('\n').includes('pnpm run reembed') || harness.stderr.join('\n').includes('re-run'));
  });
});
```

NOTE: the happy-path tests above assume the docker health-check spawn (`pg_isready`) returns exit 0 via the default handler. If existing init tests use a more detailed spawn script for compose/health, mirror that pattern instead of the minimal handler — the assertions are the contract.

- [ ] **Step 2: Run to verify failures**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/cli.test.ts`
Expected: new tests FAIL (old fallback still active, no warm-up spawn exists).

- [ ] **Step 3: Implement in `bin/commands/init.ts`**

3a. `InitContext`: rename `forceEmbedded` semantics — keep the field, derive it from both flags in `resolveContext`:

```typescript
    forceEmbedded: invocation.options.embedded === true || invocation.options['no-docker'] === true,
```

3b. In `initCommand`, replace the Docker-detection block:

```typescript
  if (context.forceEmbedded) {
    if (invocation.options['no-docker'] === true) {
      io.err('--no-docker is deprecated; use --embedded.');
    }
    return printEmbeddedMode(io, context, 'requested via --embedded');
  }
  const dockerAvailable = await detectDocker(spawn);
  if (!dockerAvailable) {
    io.err('✗ Docker not found.');
    io.err('Tuberosa needs Docker for persistent storage and real vector search.');
    io.err('  - Install Docker: https://docs.docker.com/get-docker/');
    io.err('  - Or opt into volatile trial mode: npx tuberosa init --embedded');
    return { exitCode: 1 };
  }
```

3c. The compose-failure branch (`composeResult.exitCode !== 0`) becomes a hard fail too:

```typescript
  if (composeResult.exitCode !== 0) {
    io.err(`docker compose failed (exit ${composeResult.exitCode}): ${composeResult.stderr.trim() || composeResult.stdout.trim()}`);
    io.err('Fix Docker and re-run `npx tuberosa init`, or use `npx tuberosa init --embedded` for volatile trial mode.');
    return { exitCode: 1 };
  }
```

3d. After the `runMigrations` block and before `printSuccess`, add warm-up + reembed:

```typescript
  const warmupExit = await runPackageScript(io, fs, spawn, context, 'warmup-embeddings');
  if (warmupExit !== 0) {
    io.err('Embedding model warm-up failed — the default install must not silently degrade.');
    io.err('Fix the network/proxy and re-run `npx tuberosa init`, or use `npx tuberosa init --embedded`.');
    return { exitCode: 1 };
  }

  const reembedExit = await runPackageScript(io, fs, spawn, context, 'reembed');
  if (reembedExit !== 0) {
    io.err('Re-embed backfill failed; searches work but older knowledge has no vectors yet.');
    io.err('Re-run later with `pnpm run reembed` (in the Tuberosa package) or `npx tuberosa init`.');
  }
```

3e. Generalize the existing `runMigrations` helper into a shared spawner — add below it (same resolution rules as migrations: prefer `dist/scripts/<name>.js`, fall back to `tsx scripts/<name>.ts`, cwd = packageRoot, DATABASE_URL defaulted):

```typescript
/** Run one of the package's bundled scripts (dist build preferred, tsx checkout fallback). */
async function runPackageScript(
  io: CommandIo,
  fs: FsAdapter,
  spawn: SpawnFn,
  context: InitContext,
  name: 'warmup-embeddings' | 'reembed',
): Promise<number> {
  const packageRoot = await resolvePackageRoot(io.env, fs);
  if (!packageRoot) {
    io.err(`Could not locate the Tuberosa package root to run ${name}. Set TUBEROSA_PACKAGE_ROOT.`);
    return 1;
  }
  const distEntry = `${packageRoot}/dist/scripts/${name}.js`;
  const tsxEntry = `${packageRoot}/scripts/${name}.ts`;
  const args: string[] = (await fs.exists(distEntry)) ? [distEntry] : ['--import', 'tsx', tsxEntry];
  const result = await spawn('node', args, {
    cwd: packageRoot,
    env: { ...io.env, DATABASE_URL: io.env.DATABASE_URL ?? `postgres://tuberosa:tuberosa@127.0.0.1:${context.postgresPort}/tuberosa` },
    timeoutMs: 300_000, // model download can take minutes on slow links
  });
  if (result.exitCode !== 0) {
    io.err(`${name} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.exitCode;
}
```

3f. Reword `printEmbeddedMode` so it never reads like a default (replace the first three `io.out` lines):

```typescript
  io.out('');
  io.out(`Embedded trial mode (${reason}).`);
  io.out('  ⚠ volatile: no Postgres, no Redis, hash embeddings — data is lost when the process exits.');
  io.out('  For the full product (real vector search + persistence), install Docker and run `npx tuberosa init`.');
```

and in its MCP snippet section keep `mcpSnippet(context, { embedded: true })` as-is.

- [ ] **Step 4: Run tests, fix the old init tests you rewrote, commit**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test` — `# fail 0`.

```bash
git add bin/commands/init.ts test/cli.test.ts
git commit -m "feat(cli): init requires Docker, warms the embedding model, backfills embeddings"
```

---

### Task 10: Doctor — embedding-model check

**Files:**
- Modify: `bin/commands/doctor.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('doctor embedding model check', () => {
  it('reports ok when the model is cached', async () => {
    const fs = makeFs({ '/home/u/.cache/tuberosa/models/Xenova/bge-small-en-v1.5': 'dir' });
    const harness = makeIo({ fs, env: { HOME: '/home/u' } });
    const checks = await runDoctorChecks({ command: 'doctor', options: {}, positional: [] }, harness.io);
    const check = checks.find((entry) => entry.name === 'embedding model');
    assert.equal(check?.status, 'ok');
  });

  it('warns with warm-up remediation when the model is missing', async () => {
    const harness = makeIo({ env: { HOME: '/home/u' } });
    const checks = await runDoctorChecks({ command: 'doctor', options: {}, positional: [] }, harness.io);
    const check = checks.find((entry) => entry.name === 'embedding model');
    assert.equal(check?.status, 'warn');
    assert.ok(check?.remediation?.includes('tuberosa init'));
  });

  it('skips when the provider is not local', async () => {
    const harness = makeIo({ env: { HOME: '/home/u', TUBEROSA_MODEL_PROVIDER: 'openai' } });
    const checks = await runDoctorChecks({ command: 'doctor', options: {}, positional: [] }, harness.io);
    const check = checks.find((entry) => entry.name === 'embedding model');
    assert.equal(check?.status, 'skip');
  });
});
```

- [ ] **Step 2: Run to verify failure** — the `embedding model` check does not exist yet.

- [ ] **Step 3: Implement in `bin/commands/doctor.ts`**

Add to `runDoctorChecks` after `checkMcpStdio`:

```typescript
  checks.push(await checkEmbeddingModel(io));
```

And the function:

```typescript
async function checkEmbeddingModel(io: CommandIo): Promise<DoctorCheck> {
  const provider = io.env.TUBEROSA_MODEL_PROVIDER ?? (io.env.OPENAI_API_KEY ? 'openai' : 'local');
  if (provider !== 'local') {
    return { name: 'embedding model', status: 'skip', detail: `provider is '${provider}' — no local model needed` };
  }
  if (!io.fs) return { name: 'embedding model', status: 'skip', detail: 'fs unavailable' };
  const cacheDir = io.env.TUBEROSA_MODEL_CACHE_DIR ?? `${io.env.HOME ?? '~'}/.cache/tuberosa/models`;
  const model = io.env.TUBEROSA_EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5';
  const modelPath = `${cacheDir}/${model}`;
  if (await io.fs.exists(modelPath)) {
    return { name: 'embedding model', status: 'ok', detail: `${model} cached at ${modelPath}` };
  }
  return {
    name: 'embedding model',
    status: 'warn',
    detail: `${model} not found in ${cacheDir} — first query will download it (or fall back to hash)`,
    remediation: 'Run `npx tuberosa init` (its warm-up step downloads the model).',
  };
}
```

- [ ] **Step 4: Run + commit**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test` — `# fail 0`.

```bash
git add bin/commands/doctor.ts test/cli.test.ts
git commit -m "feat(cli): doctor checks the local embedding model cache"
```

---

### Task 11: Help text, `.env.example`, docs

**Files:**
- Modify: `bin/commands/parser.ts`, `.env.example`, `README.md`, `docs/INSTALL.md`, `docs/SETUP.md`, `docs/MINIMAL_ENV.md`, `CLAUDE.md`

- [ ] **Step 1: `parser.ts` usage text**

Replace the `init` and `mcp` command lines and the `--no-docker` option line in `usage()`:

```typescript
    '  init      Bootstrap the full local stack: Docker Postgres + Redis, migrations, local embedding model. Hard-fails without Docker (use --embedded for volatile trial mode).',
    '  mcp       Run the MCP stdio server. Defaults to the full stack (postgres + redis + local embeddings); --embedded for the volatile trial stack.',
```

```typescript
    '  --embedded          Volatile trial mode (memory store, hash embeddings) for `init` and `mcp`.',
    '  --no-docker         Deprecated alias of --embedded.',
```

- [ ] **Step 2: `.env.example`**

Change:

```
TUBEROSA_MODEL_PROVIDER=local
EMBEDDING_DIMENSIONS=384
```

and add below the reranker block:

```
# Local embedding model (TUBEROSA_MODEL_PROVIDER=local, the default).
# Downloaded once to ~/.cache/tuberosa/models by `tuberosa init`.
TUBEROSA_EMBEDDING_MODEL=Xenova/bge-small-en-v1.5
# TUBEROSA_EMBEDDED=1   # volatile trial mode: memory store + hash embeddings
```

- [ ] **Step 3: Docs sweep**

Run: `grep -rn "TUBEROSA_MODEL_PROVIDER=hash\|MODEL_PROVIDER = \"hash\"\|hash provider" README.md docs/*.md CLAUDE.md`

For every hit that describes the *default end-user experience*, update it to: default = `local` embeddings (384-dim `bge-small-en-v1.5`) + Docker Postgres/Redis; `--embedded` / `TUBEROSA_EMBEDDED=1` = volatile trial mode (memory + hash). Hits that describe the *contributor/test* environment (e.g. CLAUDE.md "Local no-dependency mode", eval docs) stay as `hash` — that mode still exists and is still correct for tests. In CLAUDE.md, also update the single-test snippet to include the guard:

```bash
TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/retrieval.test.ts
```

and note `EMBEDDING_DIMENSIONS` default is now 384 in the "Key constraints" embedding-dimensions paragraph (1536 → 384, matching `migrations/014_embedding_dim_384.sql`).

- [ ] **Step 4: Commit**

```bash
git add bin/commands/parser.ts .env.example README.md docs/ CLAUDE.md
git commit -m "docs(cli): document full-featured defaults and --embedded trial mode"
```

---

### Task 12: Full verification

- [ ] **Step 1: Run every gate**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run verify:bundled-skills
docker compose up -d postgres redis && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
```

Expected: build clean; `# fail 0`; both evals exit 0 all PASS; `Bundled-skills OK`; integration PASS (migration 014 + 384-dim asserts).

- [ ] **Step 2: Live end-to-end smoke (the actual product promise)**

```bash
cd /tmp && mkdir -p tuberosa-smoke && cd tuberosa-smoke
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node /home/nash/tuberosa/dist/bin/tuberosa.js init --root /tmp/tuberosa-smoke
```

Expected: compose up, migrations applied, `[tuberosa] embedding model ready (Xenova/bge-small-en-v1.5, 384 dims)`, reembed complete, success banner. Then `tuberosa doctor` shows `✓ embedding model`.

- [ ] **Step 3: Report**

Report each command + outcome verbatim in the task summary. If anything is red, STOP and fix before claiming done — do not skip gates.

---

## Self-Review (completed during planning)

**1. Spec coverage** — A.2.1 → Task 1 (+ Task 3 registry wiring); A.2.2 → Tasks 4, 5 (+ config dims in Task 2); A.2.3 → Task 6 (+ init wiring Task 9); A.2.4 → Tasks 2, 8; A.2.5 → Tasks 7, 9 (skills/config copying is Spec B, intentionally absent); A.2.6 → Task 11; A.3 (eval untouched) → guard in Task 1 + gate runs in Tasks 2, 12; A.4 → tests embedded per task + Task 12. Doctor check (A.2.5 last bullet) → Task 10.

**2. Placeholder scan** — No TBD/TODO. Two intentional soft spots are flagged inline as instructions, not gaps: Task 2 Step 4 (mechanical type-fallout fixes whose exact set `tsc` will enumerate) and Task 11 Step 3 (docs sweep driven by a given grep with an explicit decision rule).

**3. Type consistency** — `LocalEmbedder` (T1) used in warmup (T7); `embeddingModel` config field (T2) consumed by registry (T3), warmup (T7), doctor default string (T10); `validateEmbeddingDimensions(db, expected)` (T5) called from app.ts with a `Pool` (structurally satisfies `DimensionQueryable`); `reembedMissing(db, embed, options)` (T6) called from scripts/reembed.ts with `(text) => provider.embed(text)`; `runPackageScript` name union matches the two script files created in T6/T7; `buildEnv(env, {embedded})` signature consistent between T8 impl and tests.
