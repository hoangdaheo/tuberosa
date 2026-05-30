# Plan 2 — Security & Robustness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the verified security/robustness findings from the audit: the live `::uuid`-cast High-severity bug, unredacted deep-context, cache faults aborting searches, batch-ingest fragility, missing network timeouts, and a few hardening nits — without changing retrieval behavior.

**Architecture:** Stacked on the workbench-removal branch. Each fix is TDD where unit-testable (failing test → fix → green), with the docker-gated integration suite covering Postgres-only paths. Verify gate after each task.

**Tech Stack:** TypeScript (NodeNext), Node 22, `node --test` + `tsx`, Postgres (pgvector) + Redis.

**Branch:** `fix/plan2-security-robustness` (already created off `chore/workbench-removal-and-audit`).

**Verify gate:** `pnpm run build && pnpm test && pnpm run eval:retrieval && pnpm run eval:agent-context` (Node 22.21.1 already on PATH).

---

## File Structure

**Created:** `src/util/uuid.ts` (shared `isPersistedKnowledgeId` / `isUuid`), `test/util-uuid.test.ts`, `test/retrieval-deep-context-safety.test.ts`, `test/retrieval-cache-resilience.test.ts`, `test/ingest-batch-resilience.test.ts`.

**Modified:** `src/storage/postgres-store.ts` (import shared uuid helper, drop private copy, add guards to 3 getters, pool options), `src/storage/postgres/context-store.ts` (guard `getContextPack`), `src/security/knowledge-safety.ts` (redact deepContext in `sanitizeContextPack`), `src/retrieval/service.ts` (best-effort cache read/write), `src/ingest/service.ts` (batch resilience + sanitize-before-enrich), `src/model/provider.ts` (`AbortSignal.timeout`), `src/config.ts` (`openAiTimeoutMs` key + NaN-safe byte caps), `src/validation.ts` (bound `tokenBudget`).

---

## Task 1: Extract shared UUID guard to `src/util/uuid.ts`

**Why:** `getContextPack` lives in `context-store.ts`, which cannot see the module-private `isPersistedKnowledgeId` in `postgres-store.ts`. Extract it so both files (and future call sites) share one version-agnostic guard. Use the version-agnostic pattern (Postgres accepts any hex UUID) — this is the correct shape for protecting `::uuid` casts.

**Files:** Create `src/util/uuid.ts`, `test/util-uuid.test.ts`; Modify `src/storage/postgres-store.ts:115-118`.

- [ ] **Step 1: Write the failing test** — `test/util-uuid.test.ts`:
```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isPersistedKnowledgeId } from '../src/util/uuid.js';

test('isPersistedKnowledgeId: accepts canonical and version-agnostic uuids', () => {
  assert.equal(isPersistedKnowledgeId('5f50a373-6fdd-46a1-83a5-7fb80c97de19'), true);
  assert.equal(isPersistedKnowledgeId('00000000-0000-0000-0000-000000000000'), true);
});

test('isPersistedKnowledgeId: rejects non-uuid ids', () => {
  assert.equal(isPersistedKnowledgeId('worktree:abc123'), false);
  assert.equal(isPersistedKnowledgeId('not-a-uuid'), false);
  assert.equal(isPersistedKnowledgeId(''), false);
  assert.equal(isPersistedKnowledgeId(undefined), false);
  assert.equal(isPersistedKnowledgeId(42), false);
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing): `node --test --import tsx test/util-uuid.test.ts`

- [ ] **Step 3: Create `src/util/uuid.ts`:**
```typescript
/**
 * Version-agnostic UUID shape guard. Postgres `::uuid` casts accept any
 * hex-formatted UUID regardless of version/variant, and throw `invalid input
 * syntax for type uuid` on anything else. Guarding agent/user-supplied ids with
 * this predicate BEFORE they reach a `::uuid` cast turns a 503 into a clean
 * "not found" (undefined), matching MemoryKnowledgeStore's permissive behavior.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPersistedKnowledgeId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
```

- [ ] **Step 4: Re-point `postgres-store.ts`.** Remove the local `UUID_PATTERN` (line 115) and `isPersistedKnowledgeId` function (116-118). Add to the import block at the top: `import { isPersistedKnowledgeId } from '../util/uuid.js';` (note: from `src/storage/`, the path is `../util/uuid.js`). Leave `filterPersistedKnowledgeIds` (152-155) where it is — it now calls the imported helper.

- [ ] **Step 5: Run — expect PASS** + build: `node --test --import tsx test/util-uuid.test.ts && pnpm run build 2>&1 | tail -5`

- [ ] **Step 6: Commit:**
```bash
git add src/util/uuid.ts test/util-uuid.test.ts src/storage/postgres-store.ts
git commit -m "refactor: extract shared isPersistedKnowledgeId to util/uuid"
```

---

## Task 2: Guard the four unguarded `::uuid` getters (HIGH)

**Why:** `getAgentSession`, `getReflectionDraft`, `getKnowledgeRelation` (postgres-store) and `getContextPack` (context-store) cast agent-supplied ids straight into `uuid` columns → a non-UUID id (e.g. `worktree:<sha>`) throws → mapped to 503 instead of a clean `undefined`/404. `getKnowledge:482` already guards correctly; mirror it.

**Files:** Modify `src/storage/postgres-store.ts:624,1504,1690`; `src/storage/postgres/context-store.ts:59`.

- [ ] **Step 1: Add the guard to `getKnowledgeRelation` (postgres-store.ts:625).** Insert as the first line of the method body:
```typescript
  async getKnowledgeRelation(id: string): Promise<KnowledgeRelation | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
```

- [ ] **Step 2: Add the guard to `getAgentSession` (postgres-store.ts:1505).** First line of body:
```typescript
  async getAgentSession(id: string): Promise<AgentSession | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
```

- [ ] **Step 3: Add the guard to `getReflectionDraft` (postgres-store.ts:1691).** First line of body:
```typescript
  async getReflectionDraft(id: string): Promise<ReflectionDraft | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
```

- [ ] **Step 4: Guard `getContextPack` in context-store.ts.** Add import at top: `import { isPersistedKnowledgeId } from '../../util/uuid.js';` (from `src/storage/postgres/`, path is `../../util/uuid.js`). Then first line of `getContextPack` body (line 60):
```typescript
  async getContextPack(id: string): Promise<ContextPack | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query<{ pack: ContextPack; status: ContextPack['status'] }>(
```

- [ ] **Step 5: Build + run integration tests if Postgres is up.**
```bash
pnpm run build 2>&1 | tail -5
pnpm run test:integration 2>&1 | tail -20   # skips cleanly if stack down
```
Expected: build clean. If the integration stack is up, the session/pack/draft/relation getters now return undefined for non-UUID ids rather than throwing. If the stack is down, the build + unit suite is the gate (the guard is a one-line mirror of the proven `getKnowledge` pattern).

- [ ] **Step 6: Commit:**
```bash
git add src/storage/postgres-store.ts src/storage/postgres/context-store.ts
git commit -m "fix(storage): guard uuid-cast getters against non-uuid ids (was 503, now 404)"
```

---

## Task 3: Redact deep-context content in `sanitizeContextPack` (MED)

**Why:** Layered `deepContext` inlines raw stored chunk `content`/`contextualContent` (service.ts:1717-1718). `sanitizeContextPack` (knowledge-safety.ts:439) only walks `pack.sections`, never `pack.deepContext`, and it's the single sanitizer applied to both fresh (service.ts:318) and cached (228) returns. Extend it to redact deepContext too.

**Files:** Modify `src/security/knowledge-safety.ts:439-454`; Create `test/retrieval-deep-context-safety.test.ts`.

- [ ] **Step 1: Write the failing test** — `test/retrieval-deep-context-safety.test.ts`:
```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { KnowledgeSafetyService } from '../src/security/knowledge-safety.js';

test('sanitizeContextPack redacts secrets in deepContext content', () => {
  const safety = new KnowledgeSafetyService();
  const pack: any = {
    sections: [],
    deepContext: {
      mode: 'layered',
      budget: 1000,
      tokenEstimate: 10,
      sections: [{
        name: 'essential',
        tokenEstimate: 10,
        items: [{
          knowledgeId: 'k1', title: 'T', summary: 'S', content: 'token sk-ABCDEF1234567890ABCDEF1234567890',
          contextualContent: 'context sk-ABCDEF1234567890ABCDEF1234567890', chunkIds: [], tokenEstimate: 10,
        }],
      }],
    },
  };
  const out: any = safety.sanitizeContextPack(pack);
  assert.ok(!out.deepContext.sections[0].items[0].content.includes('sk-ABCDEF1234567890ABCDEF1234567890'),
    'deepContext content should be redacted');
  assert.ok(!out.deepContext.sections[0].items[0].contextualContent.includes('sk-ABCDEF1234567890ABCDEF1234567890'),
    'deepContext contextualContent should be redacted');
});
```
> Confirm the secret pattern: open `src/security/knowledge-safety.ts` and check `redactSecretPatterns`; if an `sk-`+32hex token is not a recognized pattern, substitute a string that IS recognized (e.g. an `AKIA...` AWS key or whatever the existing redaction patterns match) so the test exercises real redaction.

- [ ] **Step 2: Run — expect FAIL** (deepContext returned verbatim): `node --test --import tsx test/retrieval-deep-context-safety.test.ts`

- [ ] **Step 3: Extend `sanitizeContextPack`.** Replace the method body (knowledge-safety.ts:439-454) so it also redacts an optional `deepContext`. Keep the existing sections logic; append deepContext handling:
```typescript
  sanitizeContextPack<T extends { sections: Array<{ items: RankedCandidate[]; tokenEstimate: number }>; deepContext?: unknown }>(
    pack: T,
    options: SafetySanitizeOptions = {},
  ): T {
    const sanitizedSections = pack.sections.map((section) => {
      const items = this.sanitizeSearchCandidates(section.items, options);
      return { ...section, items, tokenEstimate: items.reduce((sum, item) => sum + item.tokenEstimate, 0) };
    });
    const deepContext = this.sanitizeDeepContext(pack.deepContext);
    return { ...pack, sections: sanitizedSections, ...(deepContext !== undefined ? { deepContext } : {}) };
  }

  private sanitizeDeepContext(deepContext: unknown): unknown {
    if (!deepContext || typeof deepContext !== 'object') return deepContext;
    const dc = deepContext as { sections?: Array<{ items?: Array<Record<string, unknown>> }> };
    if (!Array.isArray(dc.sections)) return deepContext;
    return {
      ...dc,
      sections: dc.sections.map((section) => ({
        ...section,
        items: (section.items ?? []).map((item) => ({
          ...item,
          title: typeof item.title === 'string' ? this.scanAndRedactText(item.title) : item.title,
          summary: typeof item.summary === 'string' ? this.scanAndRedactText(item.summary) : item.summary,
          content: typeof item.content === 'string' ? this.scanAndRedactText(item.content) : item.content,
          contextualContent: typeof item.contextualContent === 'string'
            ? this.scanAndRedactText(item.contextualContent) : item.contextualContent,
        })),
      })),
    };
  }
```
> `scanAndRedactText` is a method on this same class (used by `sanitizeKnowledgeInput`); confirm it returns the redacted string. If its signature differs, adapt the call but keep the redaction.

- [ ] **Step 4: Run — expect PASS** + verify the eval still green (sanitization touches the returned pack):
```bash
node --test --import tsx test/retrieval-deep-context-safety.test.ts && pnpm run eval:retrieval 2>&1 | tail -5
```

- [ ] **Step 5: Commit:**
```bash
git add src/security/knowledge-safety.ts test/retrieval-deep-context-safety.test.ts
git commit -m "fix(security): redact secrets in layered deepContext output"
```

---

## Task 4: Make the context-pack cache best-effort (MED)

**Why:** `getCachedContextPack` (service.ts:447) and the cache write in `saveCompactContextPack` (service.ts:1348) call `cache.getJson`/`cache.setJson` without try/catch. A Redis fault or a poisoned cached value throws `CacheError` out of `searchContext` → 503, even though an uncached search would have succeeded. A cache must be best-effort.

**Files:** Modify `src/retrieval/service.ts:443-448,1340-1349`; Create `test/retrieval-cache-resilience.test.ts`.

- [ ] **Step 1: Write the failing test.** Inspect an existing retrieval test (e.g. `test/retrieval.test.ts`) for how `RetrievalService` is constructed (store + cache + model provider + config) and reuse that setup. Then in `test/retrieval-cache-resilience.test.ts` build a service with a cache stub whose `getJson` and `setJson` reject, and assert `searchContext` still resolves a pack:
```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
// import the same helpers the existing retrieval tests use to build a service + seed knowledge
// (copy the construction pattern from test/retrieval.test.ts)

test('searchContext succeeds when the cache throws on read and write', async () => {
  const throwingCache = {
    getJson: async () => { throw new Error('redis down'); },
    setJson: async () => { throw new Error('redis down'); },
    get: async () => { throw new Error('redis down'); },
    set: async () => { throw new Error('redis down'); },
    del: async () => {},
    close: async () => {},
  };
  // const service = buildServiceWith(throwingCache);  // per existing test helper
  // await seedKnowledge(...);
  // const result = await service.searchContext({ prompt: 'some seeded topic', project: 'p' });
  // assert.ok(result.contextPackId);
  assert.ok(true); // replace with the real assertion once the service is wired per existing helpers
});
```
> Replace the placeholder with the real construction copied from the existing retrieval test. The assertion must be: a search that would hit the cache path completes successfully despite the cache throwing.

- [ ] **Step 2: Run — expect FAIL** (CacheError propagates): `node --test --import tsx test/retrieval-cache-resilience.test.ts`

- [ ] **Step 3: Wrap the cache read** (service.ts:443-448):
```typescript
  private async getCachedContextPack(
    cacheKey: string,
    input: NormalizedContextSearchInput,
  ): Promise<ContextPack | undefined> {
    if (input.bypassCache || input.debug) return undefined;
    try {
      return await this.cache.getJson<ContextPack>(cacheKey);
    } catch (error) {
      console.error('[retrieval] context-pack cache read failed; continuing uncached.', error);
      return undefined;
    }
  }
```

- [ ] **Step 4: Wrap the cache write** (service.ts:1340-1349):
```typescript
async function saveCompactContextPack(
  store: KnowledgeStore,
  cache: Cache,
  cacheKey: string,
  pack: ContextPack,
  ttlSeconds: number,
): Promise<void> {
  await store.saveContextPack(pack);
  try {
    await cache.setJson(cacheKey, pack, ttlSeconds);
  } catch (error) {
    console.error('[retrieval] context-pack cache write failed; pack persisted to store.', error);
  }
}
```
> `console.error` → stderr is allowed here (this is the HTTP/retrieval path, not MCP stdout). Confirm `console.error` is acceptable in this module (it already appears in postgres-store). Do NOT add console.* to any `src/mcp/` path.

- [ ] **Step 5: Run — expect PASS** + full suite:
```bash
node --test --import tsx test/retrieval-cache-resilience.test.ts && pnpm test 2>&1 | tail -5
```

- [ ] **Step 6: Commit:**
```bash
git add src/retrieval/service.ts test/retrieval-cache-resilience.test.ts
git commit -m "fix(retrieval): make context-pack cache best-effort (redis fault no longer fails search)"
```

---

## Task 5: Batch-ingest resilience in `ingestFiles` (MED)

**Why:** `ingestFiles` (ingest/service.ts:128-141) does `results.push(await this.ingestKnowledge(input))` in a loop with no per-file try/catch. One file throwing (safety-block, duplicate, store error) aborts the whole batch; earlier files are already committed and the caller gets no partial-progress info.

**Files:** Modify `src/ingest/service.ts:128-141`; Create `test/ingest-batch-resilience.test.ts`. First READ the full `ingestFiles` body and its current return type so the change preserves the contract.

- [ ] **Step 1: Read `ingestFiles` (ingest/service.ts:128-145)** and note its return shape and `IngestFilesOptions`.

- [ ] **Step 2: Write the failing test** — `test/ingest-batch-resilience.test.ts`: build an `IngestionService` (copy construction from an existing ingest test), call `ingestFiles` with one valid file and one crafted to throw (e.g. content that trips a safety block, or a malformed input the existing pipeline rejects), and assert the valid file still ingested and the failure is reported rather than thrown. Mirror the existing ingest test's setup exactly.

- [ ] **Step 3: Add per-file try/catch.** Change the loop so each file is isolated and failures are collected. Preserve the existing success-result shape; add a parallel `errors` array to the return (extend the return type accordingly, and update any caller/type):
```typescript
    const results = [];
    const errors: Array<{ path?: string; error: string }> = [];
    for (const input of inputs) {
      try {
        results.push(await this.ingestKnowledge(input));
      } catch (error) {
        errors.push({ path: (input as { sourceUri?: string }).sourceUri, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // include `errors` in the returned object alongside the existing fields
```
> Adapt variable names (`inputs`/`files`) to the actual code you read in Step 1. Update the function's return type and any TypeScript interface so `errors` is part of the contract. Do not change the success path's shape.

- [ ] **Step 4: Run — expect PASS** + build + suite:
```bash
node --test --import tsx test/ingest-batch-resilience.test.ts && pnpm run build 2>&1 | tail -3 && pnpm test 2>&1 | tail -5
```

- [ ] **Step 5: Commit:**
```bash
git add src/ingest/service.ts test/ingest-batch-resilience.test.ts
git commit -m "fix(ingest): isolate per-file failures in ingestFiles (no full-batch abort)"
```

---

## Task 6: Sanitize before LLM label enrichment (MED, latent)

**Why:** `ingestKnowledge` calls `refineInput` (which runs label enrichers, ingest/service.ts:65) BEFORE `sanitizeKnowledgeInput` (line 66). The default enricher is a no-op, but if a real LLM provider is configured, raw secrets are sent off-box before redaction.

**Files:** Modify `src/ingest/service.ts:63-70`. READ the method first.

- [ ] **Step 1: Read `ingestKnowledge` + `refineInput` (ingest/service.ts:63-95)** to understand what `refineInput` does and what `sanitizeKnowledgeInput` returns.

- [ ] **Step 2: Reorder so sanitization happens before enrichment.** The safest minimal change: sanitize first, then refine the sanitized input.
```typescript
  async ingestKnowledge(input: KnowledgeInput) {
    const sanitizedInput = this.safety.sanitizeKnowledgeInput(input);
    const refined = await this.refineInput(sanitizedInput);
    // ...continue using `refined` exactly as before (it is now both sanitized and enriched)
```
> Verify `refineInput` does not itself depend on un-sanitized fields, and that downstream code that used `sanitizedInput` still receives sanitized+refined content. If `refineInput` must run on the original (e.g. it needs the raw title), instead sanitize the text fields passed INTO the enricher. Pick the variant that keeps redaction strictly before any LLM call; if ambiguous, STOP and report.

- [ ] **Step 3: Run the ingest tests + build:**
```bash
pnpm run build 2>&1 | tail -3 && node --test --import tsx test/ingest*.test.ts 2>&1 | tail -8
```
Expected: existing ingest tests stay green (behavior with the default no-op enricher is unchanged).

- [ ] **Step 4: Commit:**
```bash
git add src/ingest/service.ts
git commit -m "fix(ingest): redact input before LLM label enrichment"
```

---

## Task 7: Timeout on OpenAI fetch calls (MED)

**Why:** `fetchOpenAiEmbedding` (provider.ts:403) and `fetchOpenAiJson` (429) call `fetch(...)` with no `AbortSignal`. Node's global `fetch` has no default timeout; a hung upstream stalls indefinitely — the MCP stdio path has no request ceiling.

**Files:** Modify `src/config.ts` (add `openAiTimeoutMs`), `src/model/provider.ts:401-460`. READ both fetch functions first.

- [ ] **Step 1: Add config key.** In `src/config.ts`, add to the `AppConfig` interface near the other openAi fields (after line 19): `openAiTimeoutMs: number;`. In the config builder (near line 97 where `ollamaTimeoutMs` is set), add:
```typescript
    openAiTimeoutMs: Number(process.env.TUBEROSA_OPENAI_TIMEOUT_MS ?? 30_000),
```

- [ ] **Step 2: Pass the signal in both fetches.** Read `fetchOpenAiEmbedding` and `fetchOpenAiJson` (provider.ts:401-460); they receive `config: AppConfig`. Add `signal: AbortSignal.timeout(config.openAiTimeoutMs)` to each `fetch` options object. Example for the embedding call:
```typescript
    return await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { /* unchanged */ },
      body: /* unchanged */,
      signal: AbortSignal.timeout(config.openAiTimeoutMs),
    });
```
Apply the same `signal` to the `/v1/responses` fetch in `fetchOpenAiJson`. Don't change anything else.

- [ ] **Step 3: Add a small config test** to an existing config test file (or create `test/config-openai-timeout.test.ts`): set `process.env.TUBEROSA_OPENAI_TIMEOUT_MS` and assert the built config reflects it, and that the default is 30000 when unset. Run it.

- [ ] **Step 4: Build + suite:** `pnpm run build 2>&1 | tail -3 && pnpm test 2>&1 | tail -5`

- [ ] **Step 5: Commit:**
```bash
git add src/config.ts src/model/provider.ts test/
git commit -m "fix(model): add AbortSignal timeout to OpenAI fetch calls"
```

---

## Task 8: Hardening nits — bound tokenBudget + NaN-safe byte caps (LOW)

**Why:** `tokenBudget` is validated positive but unbounded (validation.ts:521); `maxRequestBytes`/`maxIngestContentBytes` use `Number(env)` which yields `NaN` on bad input, silently disabling the cap (config.ts:101-102).

**Files:** Modify `src/validation.ts:521`, `src/config.ts:101-102`.

- [ ] **Step 1: Bound tokenBudget.** Read `readOptionalPositiveNumber` (validation.ts:1239). Add a clamp where `tokenBudget` is read (line 521), e.g. wrap with a max via a small helper or inline `Math.min`. Concretely, after the existing read, clamp:
```typescript
    tokenBudget: clampOptional(readOptionalPositiveNumber(record, 'tokenBudget', 'context search input'), 200_000),
```
and add a tiny local helper near the other readers:
```typescript
function clampOptional(value: number | undefined, max: number): number | undefined {
  return value === undefined ? value : Math.min(value, max);
}
```
> Pick a ceiling consistent with `deepContextBudget` handling; 200k tokens is generous but bounded. Confirm no existing test asserts an above-ceiling tokenBudget passes through unchanged; if one does, that's a real behavior decision — keep the ceiling well above realistic budgets.

- [ ] **Step 2: NaN-safe byte caps (config.ts:101-102).** Add a helper and use it:
```typescript
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
```
Then:
```typescript
    maxRequestBytes: envInt('TUBEROSA_MAX_REQUEST_BYTES', 10 * 1024 * 1024),
    maxIngestContentBytes: envInt('TUBEROSA_MAX_INGEST_CONTENT_BYTES', 2 * 1024 * 1024),
```
> Keep the change scoped to these two lines unless you choose to apply `envInt` more broadly (optional; not required).

- [ ] **Step 3: Build + suite:** `pnpm run build 2>&1 | tail -3 && pnpm test 2>&1 | tail -5`

- [ ] **Step 4: Commit:**
```bash
git add src/validation.ts src/config.ts
git commit -m "fix(config/validation): bound tokenBudget and make byte caps NaN-safe"
```

---

## Task 9: Postgres pool limits (LOW/MED)

**Why:** `new Pool({ connectionString })` (postgres-store.ts:186) sets no `max`, `connectionTimeoutMillis`, `idleTimeoutMillis`, or `statement_timeout`. A down DB hangs connection attempts; a slow query has no server-side cap.

**Files:** Modify `src/storage/postgres-store.ts:186`.

- [ ] **Step 1: Add bounded pool options.**
```typescript
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
    });
```
> These are conservative defaults; they don't change behavior for healthy queries. If a known long-running query exceeds 30s (check `migrate`/backup paths run via separate short-lived connections, not this pool), raise `statement_timeout` accordingly or scope it. If unsure whether any legitimate query exceeds 30s, report DONE_WITH_CONCERNS noting it.

- [ ] **Step 2: Build + integration tests if stack up:**
```bash
pnpm run build 2>&1 | tail -3
pnpm run test:integration 2>&1 | tail -15   # skips if stack down
```

- [ ] **Step 3: Commit:**
```bash
git add src/storage/postgres-store.ts
git commit -m "fix(storage): set Postgres pool size and timeouts"
```

---

## Task 10: Final verification gate

- [ ] **Step 1: Full gate.**
```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run eval:agent-context
```
Expected: build clean; full suite green (new tests added); both evals green.

- [ ] **Step 2: Integration suite (best-effort).** `pnpm run test:integration 2>&1 | tail -20` — runs the Postgres-backed getter guards if the docker stack is up; otherwise note it skipped.

- [ ] **Step 3: Confirm scope.** `git diff --stat chore/workbench-removal-and-audit..HEAD` — changes confined to the files listed in File Structure + new tests.

---

## Self-Review (completed by plan author)

**Spec coverage:** Maps to spec Plan 2 table — uuid guards (T1+T2, High), deepContext redaction (T3), best-effort cache (T4), batch ingest (T5), pre-enrichment redaction (T6), fetch timeout (T7), tokenBudget bound + NaN caps (T8), pool limits (T9). All 8 spec rows covered; T1 added as the enabling extraction (also satisfies Plan 3's UUID-unification item — note this so Plan 3 drops it).

**Placeholder scan:** Code blocks are concrete for guards, redaction, cache wrappers, timeout, config, pool. Three tasks (T4 cache test, T5 ingest test, T6 ordering) instruct the implementer to copy the EXACT construction pattern from a named existing test/method rather than guess — this is deliberate (the service/ingest construction is verbose and already established) and the implementer subagent reads those files. Not a placeholder: the required behavior + assertions are fully specified.

**Type consistency:** `isPersistedKnowledgeId(value: unknown): value is string` is identical across T1 (definition) and T2 (call sites). `openAiTimeoutMs: number` added to AppConfig (T7) and read in the builder. `clampOptional`/`envInt` helpers are defined where used.

**Ordering note:** T1 must precede T2 (guards import the extracted helper). T3/T4 touch retrieval but different functions — independent. T8/T9 independent nits.
