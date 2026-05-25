# Tuberosa Goal-Alignment Refactor — Master Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This document is five sequenced sub-plans**; execute Plan 1 → 2 → 3 → 4 → 5 in order, with verification gates between each.

**Goal:** Make Tuberosa actually do what `docs/tuberosa-project.md` says it does — be a worktree-aware MCP context broker that surfaces the right knowledge for the agent's current task, with secure boundaries, enforced invariants, preview-first maintenance, and compact research-trace learning.

**Architecture:** Five-phase refactor. Plan 1 fixes the bleeding P0 bugs that block the MCP from running and leave the HTTP boundary open. Plan 2 lands CI + trust-boundary tests so later refactors merge safely. Plan 3 ships the goal-doc features that were planned but never built (worktree provider, startup brief, research trace, classifier verb-fix). Plan 4 closes the review loop with maintenance preview/apply and workbench surfaces. Plan 5 splits the monolith files now that Plan 2's parity matrix protects the seams.

**Tech Stack:** TypeScript (NodeNext ESM), Node 22+, pnpm 11, Postgres + pgvector, Redis, Preact workbench SPA, MCP stdio + HTTP entry points.

**Source documents this roadmap consolidates (do not re-do this analysis):**
- `docs/tuberosa-project.md` — product intent
- `docs/audit-specs/problems/audit-and-check-coverage.md` — multi-agent code audit (5 waves, dependency ordering)
- `docs/audit-specs/eval/audit-evaluation.md` — independent verification (22 TRUE / 2 FALSE / 5 PARTIAL of 29 audit claims; 3 audit blind spots: CI, perf, mirror default)
- `feedbacks/feedback-synthesis.md` — what the product is missing vs. user expectations
- `feedbacks/plan-synthesis.md` — Phase A–D features (worktree, startup brief, maintenance preview, research trace)
- Memory: `MEMORY.md` notes the worktree-UUID P0 bug that currently blocks Tuberosa MCP from this checkout

---

## Diagnosis — goal pillars vs. current code

| # | Goal pillar (from `docs/tuberosa-project.md`) | Current state | Plan |
|---|---|---|---|
| 1 | Classify task; extract retrieval intent | Works on concrete prompts; prompt verbs (`Analyze`, `Answer`, `Investigate`) extracted as symbols, polluting fit (10/10 recent context-quality records are `selected_but_noisy`) | 3 |
| 2 | Retrieve from lexical/vector/metadata/memory/graph | Pipeline complete, but `worktree:<sha>` ids leak into `(item->>'knowledgeId')::uuid` in `postgres-store.ts:1248` — MCP errors out from any worktree-tagged checkout (verified blocking on `26959d0` today) | 1 |
| 3 | `ready / needs_confirmation / insufficient` fit | Implemented; `applyNoiseTolerance('strict')` is a no-op unless fit is already `ready` (`service.ts:1455`) | 3 |
| 4 | Compact context pack with provenance | Works; adjacency too broad — `Tuberosa Architecture Inventory May 2026` shows up as noise 3× in feedback rollups | 3 |
| 5 | Record context decisions | Implemented end-to-end | — |
| 6 | Reflection drafts, review-gated | Implemented; 9 pending drafts sit in workbench with no UX path to review them | 4 |
| 7 | Feedback reduces ranking (selected/rejected/stale/irrelevant/missing) | Implemented; suppression deltas are magic numbers in `service.ts:1781` not in `retrieval-policy.json` | 5 |
| 8 | Prefer worktree truth for handoff/continuation | **Not built.** `src/retrieval/worktree.ts` is a 520-LOC skeleton; bridge into retrieval is partial, no `startupBrief`, no read-first list | 3 |
| 9 | Compact research-trace learning on finish-session | **Not built.** No `ResearchTraceInput` on finish; drafts accumulate without traceability | 3 |
| — | Foundation: HTTP boundary | Unauthenticated by default, binds `0.0.0.0`, leaks raw pg error text to clients | 1 |
| — | Foundation: CI gates | No `.github/workflows/` directory exists; `pnpm test` / `eval:retrieval` only run manually | 2 |
| — | Foundation: physical mirror | Defaults to `true`; fresh Docker writes `.tuberosa/current/` into the bind-mounted source tree | 1 |
| — | Foundation: file shape | `postgres-store.ts` 2746 LOC, `service.ts` 2072, `types.ts` 1987, `memory-store.ts` 1524, `validation.ts` 1285 | 5 |
| — | Foundation: dup migrations | Three `002_*.sql` files duplicate tables already in `001_init.sql`; `CREATE TABLE IF NOT EXISTS` masks the duplication today | 1 |

---

# Plan 1 — P0 Stop-the-Bleed ✅ COMPLETED 2026-05-25 on branch `refactor/plan1-stop-the-bleed`

**Goal:** Close the P0 correctness, security, and migration bugs that block downstream work and leave production deployments unsafe. Estimated 1–2 days.

**Prerequisite:** None.

**Verification gate before Plan 2 starts:** `pnpm run build && pnpm test && pnpm run eval:retrieval` all green; `tuberosa_search_context` succeeds against the local main checkout.

**Final status:** 6/6 tickets shipped on `refactor/plan1-stop-the-bleed`. Verification: build clean, 301 unit tests pass, retrieval eval at hit@5=100%, agent-context eval passes, integration tests pass against the Docker stack. Implementation deviations vs. the plan as written are listed under each ticket below.

**✅ Merged to `main` 2026-05-25** via PR #1 (`91c96b1`). Verified on `main`:
- `fee7f47` worktree `pack_feedback` CTE guard → `src/storage/postgres-store.ts`
- `5cbcf93` memory-store `status='approved'` filter → `src/storage/memory-store.ts:1207`
- `d3c90b4` MCP `-32700` parse guard → `src/mcp-stdio.ts:30,36`
- `275a9d4` HTTP loopback-aware auth + raw-error strip + `physicalMirrorEnabled: false` default → `src/config.ts:8,10,57,58,83`, `src/index.ts:7`
- `c07e747` dup `002_*.sql` removed + `003_cleanup_dup_002s.sql` added → `migrations/`
- `745d1f1` retrieval eval default `failUnderHitRate=1` → `scripts/eval-retrieval.ts:243`

**Task 1.7 (slowloris timeouts) shipped on `refactor/audit-wave1-slowloris-ci` (PR #2) — merged to `main` 2026-05-25 via `058370c`.** See task body below.

---

### Task 1.1: Add fixture asserting worktree-uuid mixed-id query

**Files:**
- Test: `test/storage-feedback-summary.test.ts` (new)

- [ ] **Step 1: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { PostgresKnowledgeStore } from '../src/storage/postgres-store.js';
import { createPgPool, hasDocker } from './support/pg.js';

test('getFeedbackSummaries tolerates worktree:<sha> ids mixed with uuids', async (t) => {
  if (!(await hasDocker())) {
    t.skip('docker stack not running');
    return;
  }
  const pool = await createPgPool();
  const store = new PostgresKnowledgeStore(pool);
  const uuid = '11111111-1111-1111-1111-111111111111';
  const worktreeId = 'worktree:abc123def456';
  const summaries = await store.getFeedbackSummaries([uuid, worktreeId], { project: 'tuberosa' });
  assert.ok(summaries instanceof Map, 'returns a map without throwing on mixed ids');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test:integration -- --test-name-pattern='worktree:<sha>'`
Expected: FAIL with `invalid input syntax for type uuid: "worktree:abc123def456"`

- [ ] **Step 3: Patch the `pack_feedback` CTE**

Edit `src/storage/postgres-store.ts:1248`:

```sql
-- before
(item->>'knowledgeId')::uuid AS knowledge_id,

-- after
CASE
  WHEN item->>'knowledgeId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN (item->>'knowledgeId')::uuid
END AS knowledge_id,
```

Add `AND knowledge_id IS NOT NULL` to the `relevant_feedback` WHERE clause downstream of the CTE.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test:integration -- --test-name-pattern='worktree:<sha>'`
Expected: PASS

- [ ] **Step 5: Smoke from this checkout**

Run: `node --import tsx -e "import('./src/app.js').then(async ({ createAppServices }) => { const s = await createAppServices(); console.log(await s.retrieval.searchContext({ prompt: 'test', cwd: process.cwd(), project: 'tuberosa' })); await s.close(); })"`
Expected: returns a context pack with no `invalid input syntax for type uuid` error.

- [ ] **Step 6: Commit**

```bash
git add src/storage/postgres-store.ts test/storage-feedback-summary.test.ts
git commit -m "fix(storage): guard pack_feedback CTE against worktree:<sha> ids"
```

---

### Task 1.2: Memory-store must filter `status='approved'` ✅ COMPLETED

**Deviation:** Plan referenced `status: 'pending'` in test seeds, but `KnowledgeStatus` is `'approved' | 'needs_review' | 'archived' | 'blocked'`. Used `'needs_review'` instead. Test moved from `searchMetadata` to `searchMemories` because the metadata path scores on label hits, not raw `files: [...]`; the parity concern was identical. Also stripped now-redundant `&& item.status !== 'approved'` guards at the graph-relation call sites (the audit hadn't called these out as a cleanup but they became dead code once `allowed()` enforced it centrally).

**Files:**
- Modify: `src/storage/memory-store.ts:1205`
- Test: `test/storage-parity-status.test.ts` (new)

- [ ] **Step 1: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { seedKnowledge } from './support/seed.js';

test('memory-store lexical search excludes non-approved items', async () => {
  const store = new MemoryKnowledgeStore();
  await seedKnowledge(store, [
    { id: 'a', title: 'Approved doc', status: 'approved' },
    { id: 'b', title: 'Pending doc', status: 'pending' },
  ]);
  const candidates = await store.searchLexical({ query: 'doc', project: 'tuberosa', limit: 10 });
  const ids = candidates.map((c) => c.knowledgeId);
  assert.ok(ids.includes('a'));
  assert.ok(!ids.includes('b'), 'pending item must be excluded');
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `node --test --import tsx test/storage-parity-status.test.ts`
Expected: FAIL — both `a` and `b` returned.

- [ ] **Step 3: Patch `allowed()`**

`src/storage/memory-store.ts:1205`:

```ts
private allowed(item: StoredKnowledge, options: SearchOptions): boolean {
  return (
    item.status === 'approved' &&
    (!options.project || item.project === options.project) &&
    !(options.rejectedKnowledgeIds ?? []).includes(item.id)
  );
}
```

- [ ] **Step 4: Run to verify PASS**, then run full `pnpm test` and fix any fixture that depended on pending items being returned.

- [ ] **Step 5: Commit**

```bash
git add src/storage/memory-store.ts test/storage-parity-status.test.ts
git commit -m "fix(storage): memory-store must filter status=approved like pg store"
```

---

### Task 1.3: MCP stdio guard `JSON.parse` against malformed frames ✅ COMPLETED

**No deviation.** Plan's test pattern worked as written. Added `TUBEROSA_PHYSICAL_MIRROR_ENABLED=false` to the child env so the spawned server doesn't write to the working tree during the test.

**Files:**
- Modify: `src/mcp-stdio.ts:28`
- Test: `test/mcp-stdio-fuzz.test.ts` (new)

- [ ] **Step 1: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('mcp-stdio survives malformed JSON frame', async () => {
  const child = spawn('node', ['--import', 'tsx', 'src/mcp-stdio.ts'], {
    env: { ...process.env, TUBEROSA_STORE: 'memory', TUBEROSA_CACHE: 'memory', TUBEROSA_MODEL_PROVIDER: 'hash' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stdin.write('{not valid json\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  assert.match(out, /-32700/, 'emits Parse error for the bad frame');
  assert.match(out, /"id":1/, 'still answers subsequent valid frames');
});
```

- [ ] **Step 2: Verify FAIL** — child process exits on the bad frame.

- [ ] **Step 3: Wrap parse**

`src/mcp-stdio.ts`, replace the `drain` loop:

```ts
async function drain(): Promise<void> {
  while (true) {
    const framed = readNextMessage();
    if (!framed) return;

    let message: JsonRpcRequest;
    try {
      message = JSON.parse(framed.body) as JsonRpcRequest;
    } catch (error) {
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error', data: { code: 'validation_error', status: 400 } },
      }, framed.framing);
      continue;
    }

    if (!('id' in message)) continue;

    try {
      const result = await handleMcpRequest(services, message);
      writeMessage({ jsonrpc: '2.0', id: message.id, result }, framed.framing);
    } catch (error) {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: appErrorToJsonRpcError(error),
      }, framed.framing);
    }
  }
}
```

- [ ] **Step 4: Verify PASS**, then commit.

```bash
git add src/mcp-stdio.ts test/mcp-stdio-fuzz.test.ts
git commit -m "fix(mcp): wrap frame JSON.parse and return -32700 on bad input"
```

---

### Task 1.4: HTTP — require API key for non-loopback; bind 127.0.0.1 by default; strip raw pg/redis messages ✅ COMPLETED

**Deviation:** Plan's HTTP test (`fetch` with `host: '203.0.113.5'` header) wouldn't actually exercise non-loopback behavior — `socket.remoteAddress` stays `127.0.0.1` for any local fetch. Replaced with unit tests on a new exported `isAuthorizedRequest(request, config)` predicate plus `isLoopbackRequest`. The predicate layers on top of `isAuthorizedApiKey` so the existing helper (and the test asserting `isAuthorizedApiKey(undefined, undefined) === true`) keeps working. Also picked up the Plan 1.7 work (flip `physicalMirrorEnabled` default to `false`) in the same commit — they share `src/config.ts` and grouping them avoided a second config bump. Env var named `TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK` rather than the plan's `TUBEROSA_REQUIRE_API_KEY` to make the boolean's scope unambiguous. Twenty-plus test/script files that build `AppConfig` literals got the two new fields swept into them via `sed` so `tsc` stays green.

**Files:**
- Modify: `src/config.ts`, `src/index.ts`, `src/http/server.ts:794-800`, `src/errors.ts:101-138`
- Test: `test/http-security.test.ts` (extend existing)

- [ ] **Step 1: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/http/server.js';
import { createAppServices } from '../src/app.js';

test('HTTP refuses non-loopback request without API key', async () => {
  process.env.TUBEROSA_API_KEY = '';
  const services = await createAppServices();
  const server = createHttpServer(services);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}/operations/workbench/summary`, {
    headers: { host: '203.0.113.5' },
  });
  assert.equal(res.status, 401);
  server.close();
  await services.close();
});

test('HTTP body strips raw pg message but keeps code', async () => {
  // Simulate pg error
  const { appErrorToHttpBody, toAppError } = await import('../src/errors.js');
  const body = appErrorToHttpBody(toAppError({ code: '22P02', severity: 'ERROR', message: 'invalid input syntax for type uuid: "xxx"' }));
  assert.equal(body.code, 'store_error');
  assert.doesNotMatch(body.error, /invalid input syntax/);
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Add config fields**

In `src/config.ts` `AppConfig` add:
```ts
httpHost: string;
requireApiKeyForNonLoopback: boolean;
```

In `loadConfig()` add:
```ts
httpHost: process.env.TUBEROSA_HTTP_HOST ?? '127.0.0.1',
requireApiKeyForNonLoopback: readBoolean(process.env.TUBEROSA_REQUIRE_API_KEY, true),
```

And flip the physical-mirror default (rolls Task 1.7 into the same edit):
```ts
physicalMirrorEnabled: readBoolean(process.env.TUBEROSA_PHYSICAL_MIRROR_ENABLED, false),
```

- [ ] **Step 4: Bind explicit host**

`src/index.ts`:
```ts
server.listen(services.config.port, services.config.httpHost, () => {
  services.operations.startScheduledBackups();
  console.log(`Tuberosa HTTP server listening on http://${services.config.httpHost}:${services.config.port}`);
});
```

- [ ] **Step 5: Loopback-aware auth**

`src/http/server.ts:794` — replace `isAuthorizedApiKey` callers with a function that checks remote address:

```ts
function isLoopback(request: IncomingMessage): boolean {
  const addr = request.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function assertAuthorized(request: IncomingMessage, config: AppConfig): void {
  const provided = readProvidedApiKey(request);
  if (config.apiKey && provided && secureEqual(provided, config.apiKey)) return;
  if (!config.requireApiKeyForNonLoopback && !config.apiKey) return;
  if (isLoopback(request) && !config.apiKey) return;
  throw new HttpError(401, 'Unauthorized.');
}
```

Replace every call to `isAuthorizedApiKey` in the file with `assertAuthorized(request, config)`.

- [ ] **Step 6: Sanitize pg/redis errors**

`src/errors.ts`:
```ts
const PG_PUBLIC_MESSAGE = 'Storage error. See server logs for details.';
const REDIS_PUBLIC_MESSAGE = 'Cache error. See server logs for details.';

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (isPgError(error)) {
    const err = new StoreError(PG_PUBLIC_MESSAGE, error);
    return err;
  }
  if (isRedisError(error)) {
    const err = new CacheError(REDIS_PUBLIC_MESSAGE, error);
    return err;
  }
  // ... rest unchanged
}
```

Add structured server-side log of `error.cause` in the HTTP request handler before returning the response (`src/http/server.ts` around line 1023, where `errorLogs.recordLog` is already called — keep the rich data there).

- [ ] **Step 7: Verify PASS**, full `pnpm test`, then commit.

```bash
git add src/config.ts src/index.ts src/http/server.ts src/errors.ts test/http-security.test.ts
git commit -m "fix(http): default 127.0.0.1 + API-key for non-loopback; strip raw store errors"
```

---

### Task 1.5: Drop the three duplicate `002_*.sql` migrations with paired cleanup ✅ COMPLETED

**No deviation.** Behaved exactly as plan specified.

**Files:**
- Delete: `migrations/002_agent_sessions.sql`, `migrations/002_knowledge_relations.sql`, `migrations/002_knowledge_conflicts.sql`
- Create: `migrations/003_cleanup_dup_002s.sql`
- Test: `test/migration-cleanup.test.ts` (new)

- [ ] **Step 1: Confirm tables and indexes are in `001_init.sql`**

Run: `grep -E 'CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS' migrations/001_init.sql | grep -E 'agent_sessions|agent_context_decisions|knowledge_relations|knowledge_conflicts'`
Expected: at least 8 hits proving 001 already declares these.

- [ ] **Step 2: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';

test('only one 002_* migration remains, plus an explicit 003_ cleanup', async () => {
  const files = await readdir('migrations');
  const m002 = files.filter((f) => f.startsWith('002_')).sort();
  assert.deepEqual(m002, ['002_learning_review_records.sql']);
  assert.ok(files.includes('003_cleanup_dup_002s.sql'));
});
```

- [ ] **Step 3: Verify FAIL**

- [ ] **Step 4: Write the cleanup migration**

`migrations/003_cleanup_dup_002s.sql`:
```sql
DELETE FROM schema_migrations
WHERE filename IN (
  '002_agent_sessions.sql',
  '002_knowledge_relations.sql',
  '002_knowledge_conflicts.sql'
);
```

- [ ] **Step 5: Delete the three files**

```bash
git rm migrations/002_agent_sessions.sql migrations/002_knowledge_relations.sql migrations/002_knowledge_conflicts.sql
```

- [ ] **Step 6: Verify PASS** + run `pnpm run migrate` against a fresh DB if Docker is available, plus `pnpm run test:integration`.

- [ ] **Step 7: Commit**

```bash
git add migrations/ test/migration-cleanup.test.ts
git commit -m "fix(migrations): collapse dup 002_* files; add 003 cleanup of orphan schema_migrations rows"
```

---

### Task 1.6: Default-on `failUnderHitRate=1` in retrieval eval ✅ COMPLETED

**Deviation:** Plan's test spawned the eval script as a subprocess with a corrupted fixture. Switched to a unit test that imports `shouldFail` and `DEFAULT_HIT_RATE_THRESHOLD` (newly exported) and table-tests the predicate directly. Same coverage, much faster, no fixture-corruption ceremony. Real `pnpm run eval:retrieval` confirmed still green at hit@5=100%.

**Files:**
- Modify: `scripts/eval-retrieval.ts:237-244`

- [ ] **Step 1: Write failing test**

```ts
// test/eval-retrieval-default-gate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('eval:retrieval exits non-zero when hitRate < 1.0 by default', () => {
  const result = spawnSync('node', ['--import', 'tsx', 'scripts/eval-retrieval.ts', '--fixture', 'test/fixtures/retrieval-fail.json']);
  assert.notEqual(result.status, 0);
});
```

(Create `test/fixtures/retrieval-fail.json` with one fixture row that intentionally won't match — copy any existing row and corrupt its `expectedKnowledgeIds` so the case fails.)

- [ ] **Step 2: Verify FAIL** — script currently exits 0 unless `--fail-under-hit-rate` is passed.

- [ ] **Step 3: Patch**

`scripts/eval-retrieval.ts:237-244`:
```ts
function shouldFail(report: RetrievalEvalReport, options: CliOptions): boolean {
  const failedCase = report.cases.some((testCase) => !testCase.passed);
  const threshold = options.failUnderHitRate ?? 1.0;
  const missedThreshold = report.metrics.hitRate !== null && report.metrics.hitRate < threshold;
  return failedCase || missedThreshold;
}
```

- [ ] **Step 4: Run `pnpm run eval:retrieval` against the real fixture** — must still PASS at hitRate=1.

- [ ] **Step 5: Verify the new test PASSES**, then commit.

```bash
git add scripts/eval-retrieval.ts test/eval-retrieval-default-gate.test.ts test/fixtures/retrieval-fail.json
git commit -m "fix(eval): retrieval eval enforces hitRate>=1.0 by default"
```

---

### Task 1.7: HTTP slowloris guard — `requestTimeout` + `headersTimeout` ✅ COMPLETED

**Deviation:** Timeouts set inside `createHttpServer` (`src/http/server.ts`) rather than in the bootstrap (`src/index.ts`). The factory seam is testable without spawning the bootstrap; the plan's assertion of `server.requestTimeout` on the value returned by `createHttpServer` becomes the natural test. Shipped on `refactor/audit-wave1-slowloris-ci` (`12a8aa6`).

Source: audit Wave 3.4 (verified P1 — `src/http/server.ts:756-775` has byte cap but no socket timeout; a 1-byte-per-second client holds a worker indefinitely). Co-located here because the fix touches `src/index.ts`, which Task 1.4 already opens. Cheap, additive, no breaking change. **Not on `refactor/plan1-stop-the-bleed` — new addition.**

**Files:**
- Modify: `src/index.ts` (set timeouts on the server returned by `createHttpServer`)
- Test: `test/http-security.test.ts` (assert the defaults)

- [ ] **Step 1: Write failing test**

Append to `test/http-security.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/http/server.js';
import { createAppServices } from '../src/app.js';

test('HTTP server enforces requestTimeout and headersTimeout', async () => {
  const services = await createAppServices();
  const server = createHttpServer(services);
  // The bootstrap in src/index.ts must set these. We assert on the values
  // the bootstrap writes; if the bootstrap isn't responsible (e.g. the
  // factory sets them), update the assertion to read from the factory output.
  assert.equal(server.requestTimeout, 60_000, 'requestTimeout default should be 60s');
  assert.equal(server.headersTimeout, 10_000, 'headersTimeout default should be 10s');
  server.close();
  await services.close();
});
```

Note: `createHttpServer` returns a vanilla `http.Server` whose defaults are `requestTimeout=300000`, `headersTimeout=60000`. The test will fail until the bootstrap in `src/index.ts` writes the tighter defaults.

- [ ] **Step 2: Verify FAIL**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/http-security.test.ts
```

- [ ] **Step 3: Set the timeouts in `src/index.ts`**

After `const server = createHttpServer(services);` and before `server.listen(...)`:

```ts
server.requestTimeout = 60_000;
server.headersTimeout = 10_000;
```

If Task 1.4 was already merged with `server.listen(port, httpHost, ...)`, the new lines slot between server construction and `listen`. If a future task wants per-deployment tuning, lift to config — for now defaults are sufficient.

- [ ] **Step 4: Verify PASS**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/http-security.test.ts
git commit -m "fix(http): set requestTimeout=60s and headersTimeout=10s to defeat slowloris"
```

---

### Plan 1 Verification Gate

Before starting Plan 2, run every command and confirm green:
- `pnpm run build`
- `pnpm test`
- `pnpm run eval:retrieval`
- `pnpm run eval:agent-context`
- `pnpm run test:integration` (if Docker available)
- Manual: from this checkout, call `tuberosa_search_context` via the MCP and confirm no `worktree:<sha>` uuid error.
- Manual slowloris smoke: `timeout 15 nc 127.0.0.1 3027` then type one byte; the server must close the socket within 60s (it will not — `requestTimeout` is for the **request body**, not idle sockets; for true slowloris also confirm Node's default `keepAliveTimeout` is acceptable, or document the gap and defer to a deployment-level reverse proxy).

---

# Plan 2 — CI + Trust-Boundary Coverage

**Goal:** Make the CLAUDE.md invariants enforceable. Add CI workflows so every PR runs build + tests + retrieval eval. Add unit suites for the trust-boundary modules that today have zero or weak direct coverage (`validation.ts`, `write-gate.ts`, `factory.ts`, `knowledge-namespace.ts`). Add the storage parity matrix that the audit identified as the single highest-upside coverage item — without it, Plan 5 cannot safely split the stores.

**Prerequisite:** Plan 1 green.

**Verification gate before Plan 3 starts:** All new tests in this plan pass locally; CI workflow runs them on a synthetic PR.

**✅ All 6 tasks shipped on `refactor/audit-wave1-slowloris-ci` (PR #2) — merged to `main` 2026-05-25 via `058370c`.** Final verification: 406/406 unit tests pass locally and on GitHub Actions CI (build + tests + `eval:retrieval` + `eval:agent-context` + Postgres/Redis integration all green). Implementation deviations vs. plan-as-written are listed under each task. Plus two follow-up CI hardening commits: `fff9e40` (Corepack-based pnpm install so Node 22 is provisioned first) and `1184b49` (test fakes aligned with real `RerankResult` shape and `StoredKnowledge.sourceUri` optionality — surfaced by strict `tsc` in CI).

**Verification gate to Plan 3:** ✅ passed. Plan 3 is now unblocked.

---

### Task 2.1: Add `.github/workflows/ci.yml` ✅ COMPLETED

**No deviation.** Workflow contains 10 steps including build, unit tests, retrieval/agent-context evals, and Postgres+Redis integration tests with service containers. Shipped as `1a8998d`.

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: ci
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env: { POSTGRES_USER: tuberosa, POSTGRES_PASSWORD: tuberosa, POSTGRES_DB: tuberosa }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U tuberosa"
          --health-interval 10s --health-timeout 5s --health-retries 5
      redis:
        image: redis:7-alpine
        ports: ['6379:6379']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.21.1', cache: 'pnpm' }
      - uses: pnpm/action-setup@v4
        with: { version: '11.1.2' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm test
      - run: pnpm run eval:retrieval
      - run: pnpm run eval:agent-context
      - env:
          DATABASE_URL: postgres://tuberosa:tuberosa@localhost:5432/tuberosa
          REDIS_URL: redis://localhost:6379
        run: pnpm run test:integration
```

- [ ] **Step 2: Open a throwaway PR to verify the workflow runs and passes.** If it fails, fix the workflow inline before merging.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: gate PRs on build, tests, retrieval eval, agent-context eval, integration"
```

---

### Task 2.2: CLAUDE.md invariant tests ✅ COMPLETED

**Deviation:** Embedding-dim test scans `migrations/001_init.sql` for *every* `vector(N)` declaration and asserts they all agree before comparing to `EMBEDDING_DIMENSIONS` — protects against future migrations adding mismatched dims. MCP stdout test parses both line- and Content-Length-framed responses (covers both framings the server emits). Shipped as `a95df92`.

**Files:**
- Create: `test/invariants.test.ts`

- [ ] **Step 1: Write the tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

test('embedding dimension in config matches migrations/001_init.sql vector(N)', async () => {
  const sql = await readFile('migrations/001_init.sql', 'utf8');
  const match = sql.match(/vector\((\d+)\)/);
  assert.ok(match);
  const sqlDims = Number(match[1]);
  const { loadConfig } = await import('../src/config.js');
  const cfg = loadConfig();
  assert.equal(cfg.embeddingDimensions, sqlDims);
});

test('mcp-stdio writes only JSON-RPC frames to stdout', async () => {
  const child = spawn('node', ['--import', 'tsx', 'src/mcp-stdio.ts'], {
    env: { ...process.env, TUBEROSA_STORE: 'memory', TUBEROSA_CACHE: 'memory', TUBEROSA_MODEL_PROVIDER: 'hash' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  for (const line of out.split('\n').filter(Boolean)) {
    const body = line.startsWith('Content-Length') ? line.split('\r\n\r\n')[1] : line;
    if (!body) continue;
    assert.doesNotThrow(() => JSON.parse(body), `non-JSON on stdout: ${body.slice(0, 80)}`);
  }
});
```

- [ ] **Step 2: Run** — both tests should pass against Plan 1 code. If `mcp-stdio` test fails, find the offending `console.log` and remove it.

- [ ] **Step 3: Commit**

```bash
git add test/invariants.test.ts
git commit -m "test: CLAUDE.md invariants (embedding dims, mcp stdout discipline)"
```

---

### Task 2.3: Table-driven `validation.ts` tests ✅ COMPLETED

**Deviation:** Plan-as-written referenced `validateIngestKnowledgeInput` and `validateRecordContextDecisionInput`; actual export names are `validateKnowledgeInput` and `validateRecordAgentContextDecisionInput`. Final table covers 64 rows across 7 validators (added `validateReflectionDraftInput`). All passed first run — no schema bugs surfaced. Shipped as `40bd772`.

**Files:**
- Create: `test/validation.test.ts`

- [ ] **Step 1: Identify the trust-boundary schemas**

Read `src/validation.ts` and list every exported `parse*` / `validate*` / `assert*` function. For each, plan one happy-path row, one rejection row per branch (missing field, wrong type, wrong enum, exceeds bound, recursive nesting).

- [ ] **Step 2: Write table-driven test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/validation.js';

const CASES = [
  // ContextSearchInput
  { name: 'CS happy minimal',             input: { prompt: 'x' },                                  expect: 'ok',   fn: v.validateContextSearchInput },
  { name: 'CS missing prompt',            input: {},                                               expect: 'fail', fn: v.validateContextSearchInput },
  { name: 'CS empty prompt',              input: { prompt: '' },                                   expect: 'fail', fn: v.validateContextSearchInput },
  { name: 'CS prompt wrong type',         input: { prompt: 42 },                                   expect: 'fail', fn: v.validateContextSearchInput },
  { name: 'CS contextMode=compact',       input: { prompt: 'x', contextMode: 'compact' },          expect: 'ok',   fn: v.validateContextSearchInput },
  { name: 'CS contextMode=layered',       input: { prompt: 'x', contextMode: 'layered' },          expect: 'ok',   fn: v.validateContextSearchInput },
  { name: 'CS contextMode=lean rejected', input: { prompt: 'x', contextMode: 'lean' },             expect: 'fail', fn: v.validateContextSearchInput },
  { name: 'CS noiseTolerance=strict',     input: { prompt: 'x', noiseTolerance: 'strict' },        expect: 'ok',   fn: v.validateContextSearchInput },
  { name: 'CS noiseTolerance=other',      input: { prompt: 'x', noiseTolerance: 'other' },         expect: 'fail', fn: v.validateContextSearchInput },
  { name: 'CS taskType=debugging',        input: { prompt: 'x', taskType: 'debugging' },           expect: 'ok',   fn: v.validateContextSearchInput },
  { name: 'CS taskType=bogus',            input: { prompt: 'x', taskType: 'bogus' },               expect: 'fail', fn: v.validateContextSearchInput },
  { name: 'CS tokenBudget negative',      input: { prompt: 'x', tokenBudget: -1 },                 expect: 'fail', fn: v.validateContextSearchInput },
  { name: 'CS files not array',           input: { prompt: 'x', files: 'a.ts' },                   expect: 'fail', fn: v.validateContextSearchInput },
  { name: 'CS rejectedKnowledgeIds bad',  input: { prompt: 'x', rejectedKnowledgeIds: ['not-uuid'] }, expect: 'fail', fn: v.validateContextSearchInput },

  // IngestKnowledgeInput
  { name: 'Ingest happy',                 input: { project: 'p', title: 't', content: 'c' },       expect: 'ok',   fn: v.validateIngestKnowledgeInput },
  { name: 'Ingest missing project',       input: { title: 't', content: 'c' },                     expect: 'fail', fn: v.validateIngestKnowledgeInput },
  { name: 'Ingest missing title',         input: { project: 'p', content: 'c' },                   expect: 'fail', fn: v.validateIngestKnowledgeInput },
  { name: 'Ingest missing content',       input: { project: 'p', title: 't' },                     expect: 'fail', fn: v.validateIngestKnowledgeInput },
  { name: 'Ingest itemType=spec',         input: { project: 'p', title: 't', content: 'c', itemType: 'spec' }, expect: 'ok',   fn: v.validateIngestKnowledgeInput },
  { name: 'Ingest itemType=bogus',        input: { project: 'p', title: 't', content: 'c', itemType: 'x' },    expect: 'fail', fn: v.validateIngestKnowledgeInput },
  { name: 'Ingest labels missing type',   input: { project: 'p', title: 't', content: 'c', labels: [{ value: 'v' }] }, expect: 'fail', fn: v.validateIngestKnowledgeInput },
  { name: 'Ingest references missing uri', input: { project: 'p', title: 't', content: 'c', references: [{ kind: 'file' }] }, expect: 'fail', fn: v.validateIngestKnowledgeInput },

  // StartAgentSessionInput
  { name: 'StartSession happy',           input: { prompt: 'x' },                                  expect: 'ok',   fn: v.validateStartAgentSessionInput },
  { name: 'StartSession bad cwd type',    input: { prompt: 'x', cwd: 123 },                        expect: 'fail', fn: v.validateStartAgentSessionInput },

  // RecordContextDecisionInput
  { name: 'Decision selected',            input: { sessionId: '11111111-1111-1111-1111-111111111111', feedbackType: 'selected' }, expect: 'ok',   fn: v.validateRecordContextDecisionInput },
  { name: 'Decision bogus type',          input: { sessionId: '11111111-1111-1111-1111-111111111111', feedbackType: 'maybe' },    expect: 'fail', fn: v.validateRecordContextDecisionInput },
  { name: 'Decision bad sessionId',       input: { sessionId: 'not-uuid', feedbackType: 'selected' }, expect: 'fail', fn: v.validateRecordContextDecisionInput },

  // FinishAgentSessionInput
  { name: 'Finish completed',             input: { sessionId: '11111111-1111-1111-1111-111111111111', outcome: 'completed' }, expect: 'ok', fn: v.validateFinishAgentSessionInput },
  { name: 'Finish bogus outcome',         input: { sessionId: '11111111-1111-1111-1111-111111111111', outcome: 'sorta' },     expect: 'fail', fn: v.validateFinishAgentSessionInput },
];

for (const c of CASES) {
  test(`validation: ${c.name}`, () => {
    if (c.expect === 'ok') {
      assert.doesNotThrow(() => c.fn(c.input));
    } else {
      assert.throws(() => c.fn(c.input));
    }
  });
}
```

Aim for ≥ 60 rows. Each row corresponds to one branch in `validation.ts`.

- [ ] **Step 3: Run; address any genuine schema bugs surfaced**, then commit.

```bash
git add test/validation.test.ts
git commit -m "test(validation): table-driven coverage of trust-boundary schemas"
```

---

### Task 2.4: `write-gate.ts` unit tests ✅ COMPLETED

**Deviation:** Plan called the function `evaluateWriteGate({draft, store, models})`; actual export is `computeWriteGate({draft, candidates, models?, now?})` — store is not a dependency, the caller pre-resolves candidates. Audit P1 (empty-embedding fallback to lexical proxy) confirmed by failing test; fix added: `embeddingDegraded` flag downgrades NOOP/UPDATE/DELETE → ADD when `models` was supplied but `draftEmbedding` came back empty. Shipped as `ede70ba`.

**Files:**
- Create: `test/write-gate.test.ts`

- [ ] **Step 1: Write one test per gate decision**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { evaluateWriteGate } from '../src/reflection/write-gate.js';
import { makeDraft, makeMemory } from './support/reflection-factories.js';

const models = new HashModelProvider();

test('gate returns ADD when no contradicting memory exists', async () => {
  const store = new MemoryKnowledgeStore();
  const draft = makeDraft({ title: 'New rule', content: 'Always X' });
  const result = await evaluateWriteGate({ draft, store, models });
  assert.equal(result.decision, 'ADD');
});

test('gate returns NOOP when an approved memory matches by title+content+labels', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertKnowledge(makeMemory({ title: 'Always X', content: 'Always X', status: 'approved' }));
  const draft = makeDraft({ title: 'Always X', content: 'Always X' });
  const result = await evaluateWriteGate({ draft, store, models });
  assert.equal(result.decision, 'NOOP');
});

test('gate falls back to ADD when candidate embedding is empty (no UPDATE/NOOP)', async () => {
  const store = new MemoryKnowledgeStore();
  const failingModels = { ...models, embed: async () => [] };
  const draft = makeDraft({ title: 'Anything', content: 'Anything' });
  const result = await evaluateWriteGate({ draft, store, models: failingModels });
  assert.notEqual(result.decision, 'NOOP');
  assert.notEqual(result.decision, 'UPDATE');
});

test('gate returns DELETE when draft negates an existing memory in same file/line', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertKnowledge(makeMemory({
    title: 'Set X true', content: 'set X = true', status: 'approved',
    references: [{ uri: 'src/foo.ts', kind: 'file', line: 12 }],
  }));
  const draft = makeDraft({
    title: 'Set X false', content: 'set X = false',
    references: [{ uri: 'src/foo.ts', kind: 'file', line: 12 }],
  });
  const result = await evaluateWriteGate({ draft, store, models });
  assert.equal(result.decision, 'DELETE');
});

test('gate refuses to auto-decide when draft has zero learning signals', async () => {
  const store = new MemoryKnowledgeStore();
  const draft = makeDraft({ title: 'Sparse', content: 'Sparse', learningSignals: [] });
  const result = await evaluateWriteGate({ draft, store, models });
  assert.equal(result.gates.find((g) => g.name === 'signal_confidence')?.status, 'pass');
});
```

Create `test/support/reflection-factories.ts` with `makeDraft` / `makeMemory` builders returning fully-populated shapes (id, project, createdAt, labels, references, learningSignals).

- [ ] **Step 2: Run; fix the empty-embedding fallback bug audit flagged (gate currently uses lexical proxy, which masks embedding failures). Make `evaluateWriteGate` refuse to decide stronger than `ADD` when `candidateEmbedding.length === 0`.

- [ ] **Step 3: Commit**

```bash
git add src/reflection/write-gate.ts test/write-gate.test.ts
git commit -m "test(write-gate): direct coverage of every gate decision branch"
```

---

### Task 2.5: Storage parity matrix ✅ COMPLETED

**Deviation:** Parity asserts on `sourceUri` sets, not `knowledgeId` sets — backends generate independent UUIDs per insert, but the source URI is the stable cross-backend identifier. New helpers: `test/support/pg.ts` (extracted `postgresAvailable`/`ensurePostgresMigrated` from `test/integration.test.ts`), `test/support/parity-fixtures.ts` (5 named scenarios + a `runFixture` driver). Both backends agreed on all 5 scenarios on first run — no divergences surfaced (the audit's P2 about precise-vs-broad metadata scoring would need score-tolerance assertions, not ID-set parity, and is deferred). Shipped as `a9fa8bc`.

**Files:**
- Create: `test/storage-parity.test.ts`, `test/support/parity-fixtures.ts`

- [ ] **Step 1: Define the parity fixtures**

A `ParityFixture` is `{ seed: StoredKnowledge[]; query: SearchOptions; expectedIds: string[] }`. Cover at minimum:
- approved-only filter
- lexical query precise vs broad
- rejected-knowledge-id exclusion
- project filter
- metadata-search precision/broad split
- searchMemories label-match
- worktree:<sha> id passthrough (must not crash)

Each fixture lives in `test/support/parity-fixtures.ts` as a const array.

- [ ] **Step 2: Write the matrix runner**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { PostgresKnowledgeStore } from '../src/storage/postgres-store.js';
import { hasDocker, createPgPool } from './support/pg.js';
import { PARITY_FIXTURES } from './support/parity-fixtures.js';

for (const fixture of PARITY_FIXTURES) {
  test(`parity[memory] ${fixture.name}`, async () => {
    const store = new MemoryKnowledgeStore();
    await seedAll(store, fixture.seed);
    const got = await store.searchLexical(fixture.query);
    assert.deepEqual(got.map((c) => c.knowledgeId).sort(), fixture.expectedIds.sort());
  });

  test(`parity[postgres] ${fixture.name}`, async (t) => {
    if (!(await hasDocker())) { t.skip(); return; }
    const pool = await createPgPool();
    const store = new PostgresKnowledgeStore(pool);
    await seedAll(store, fixture.seed);
    const got = await store.searchLexical(fixture.query);
    assert.deepEqual(got.map((c) => c.knowledgeId).sort(), fixture.expectedIds.sort());
  });
}
```

- [ ] **Step 3: Run; fix any divergences surfaced.** Expect at least `precise vs broad metadata score` to diverge — patch `memory-store.searchMetadata` to mirror the Postgres precision buckets.

- [ ] **Step 4: Commit**

```bash
git add test/storage-parity.test.ts test/support/parity-fixtures.ts src/storage/memory-store.ts
git commit -m "test(storage): parity matrix; fix memory-store metadata precision drift"
```

---

### Task 2.6: `factory.ts`, `knowledge-namespace.ts`, `model/registry.ts` ✅ COMPLETED

**Deviation:** Plan referenced `normaliseNamespace`/`matchNamespace`; actual exports are `deriveNamespace`/`namespaceMatchesFilter` (plus `kindFromItemType`, `readNamespaceFromMetadata`, `writeNamespaceToMetadata`). `createKnowledgeStore` is synchronous and takes only `AppConfig` (no pool arg). `buildProviderRegistry` returns `ModelProvider | null` (null when `modelProvider !== 'local'`); same for `buildOllamaRegistry`. 22 tests total across the three files. Shipped as `17f1024`.

**Files:**
- Create: `test/storage-factory.test.ts`, `test/knowledge-namespace.test.ts`, `test/model-registry.test.ts`

- [ ] **Step 1: factory test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeStore } from '../src/storage/factory.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { PostgresKnowledgeStore } from '../src/storage/postgres-store.js';
import { hasDocker, createPgPool } from './support/pg.js';

test('factory returns MemoryKnowledgeStore when store=memory', async () => {
  const store = await createKnowledgeStore({ store: 'memory' } as any);
  assert.ok(store instanceof MemoryKnowledgeStore);
});

test('factory returns PostgresKnowledgeStore when store=postgres', async (t) => {
  if (!(await hasDocker())) { t.skip(); return; }
  const pool = await createPgPool();
  const store = await createKnowledgeStore({ store: 'postgres', databaseUrl: 'postgres://tuberosa:tuberosa@localhost:5432/tuberosa' } as any, pool);
  assert.ok(store instanceof PostgresKnowledgeStore);
});
```

- [ ] **Step 2: namespace test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseNamespace, matchNamespace } from '../src/storage/knowledge-namespace.js';

test('normaliseNamespace fills missing fields with defaults', () => {
  const ns = normaliseNamespace({ project: 'tuberosa' });
  assert.equal(ns.project, 'tuberosa');
  assert.equal(ns.kind, '*');
  assert.equal(ns.agent, '*');
});

test('matchNamespace rejects mismatched project', () => {
  assert.equal(matchNamespace({ project: 'a', kind: '*', agent: '*' }, { project: 'b' }), false);
});

test('matchNamespace rejects mismatched kind when stored kind is concrete', () => {
  assert.equal(matchNamespace({ project: 'a', kind: 'wiki', agent: '*' }, { project: 'a', kind: 'spec' }), false);
});

test('matchNamespace wildcards stored kind=* against any requested kind', () => {
  assert.equal(matchNamespace({ project: 'a', kind: '*', agent: '*' }, { project: 'a', kind: 'wiki' }), true);
});
```

- [ ] **Step 3: registry test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderRegistry } from '../src/model/registry.js';

test('buildProviderRegistry uses hash provider when modelProvider=hash', () => {
  const reg = buildProviderRegistry({ modelProvider: 'hash', embeddingDimensions: 1536 } as any);
  assert.equal(reg.embed.providerName, 'hash');
  assert.equal(reg.rerank.providerName, 'hash');
});

test('buildProviderRegistry uses ollama for rerank when configured', () => {
  const reg = buildProviderRegistry({
    modelProvider: 'ollama', embeddingDimensions: 1536,
    ollamaUrl: 'http://localhost:11434', ollamaRerankModel: 'qwen2.5:3b',
  } as any);
  assert.equal(reg.rerank.providerName, 'ollama');
});
```

- [ ] **Step 4: Commit**

```bash
git add test/storage-factory.test.ts test/knowledge-namespace.test.ts test/model-registry.test.ts
git commit -m "test: cover factory/namespace/registry trust-boundary modules"
```

---

### Plan 2 Verification Gate

- All new test files pass locally.
- CI workflow runs on a real PR and is green.
- `pnpm run eval:retrieval`, `pnpm run eval:agent-context`, `pnpm run eval:safety` all green.

---

# Plan 3 — Goal-Aligned Product Features ✅ COMPLETED 2026-05-25 on `main`

**Goal:** Ship the four features the goal doc and `feedbacks/plan-synthesis.md` describe but the codebase doesn't have: (A) a bounded worktree evidence provider wired into retrieval, (B) a `StartupBrief` with `proceed / confirm / clarify` and read-first files, (C) classifier fix for prompt-verb-as-symbol noise, (D) `ResearchTraceInput` on finish-session. Estimated 5–7 days.

**Prerequisite:** Plan 2 green (especially the parity matrix and CLAUDE.md invariants).

**Verification gate before Plan 4 starts:** `eval:retrieval` and `eval:agent-context` both green; new fixtures `eval/startup-brief-fixtures.json` and `eval/research-trace-fixtures.json` exercise verdict and trace shape.

**Final status:** All 6 tasks shipped on `main`:
- `fd8f67b` feat(session): add compact research trace on finish (Task 3.6)
- `f5e6366` feat(retrieval): harden bounded worktree evidence (Task 3.2)
- `d1c0b21` feat(retrieval): add startup brief verdicts (Tasks 3.1 + 3.3)
- `013ec50` fix(classifier): scope prompt verb symbol filtering (Task 3.4)
- `74792c7` fix(retrieval): strict noise downgrades weak confirmation (Task 3.5)

Verification (2026-05-25): build clean, 418/418 unit tests pass, `eval:retrieval` green at hit@5=100%, `eval:agent-context` passes, `eval:startup-brief` 8/8 cases, `eval:knowledge-completeness` all cases ≥90 score. Plan 4 unblocked.

---

### Task 3.1: Fixture-first — startup brief eval fixture

**Files:**
- Create: `eval/startup-brief-fixtures.json`, `src/evaluation/startup-brief-evaluator.ts`, `scripts/eval-startup-brief.ts`

- [ ] **Step 1: Define the fixture rows**

JSON shape:
```json
{
  "cases": [
    {
      "name": "continuation with current handoff present",
      "prompt": "Continue from handoff.md",
      "seed": { "worktreeFiles": ["handoff.md"], "memory": [] },
      "expect": { "verdict": "proceed", "readFirst": ["handoff.md"], "missingSignals": [] }
    },
    {
      "name": "continuation without handoff in worktree or memory",
      "prompt": "Continue from handoff",
      "seed": { "worktreeFiles": [], "memory": [] },
      "expect": { "verdict": "clarify", "missingSignals": ["handoff_file"] }
    },
    {
      "name": "memory and worktree disagree on plan content",
      "prompt": "Continue Phase 9",
      "seed": { "worktreeFiles": ["plan-phase9.md"], "memory": [{ "title": "Phase 9 stale plan" }] },
      "expect": { "verdict": "confirm", "missingSignals": ["plan_mismatch"] }
    }
  ]
}
```

Aim for ≥ 8 cases (one per verdict × one per evidence shape).

- [ ] **Step 2: Write the evaluator** that takes the fixture row, calls the (not-yet-built) startup-brief composer, and asserts verdict + readFirst + missingSignals.

- [ ] **Step 3: Wire `pnpm run eval:startup-brief` in `package.json`.** Run it; it should fail because the composer doesn't exist yet.

- [ ] **Step 4: Commit (fixture-only)**

```bash
git add eval/startup-brief-fixtures.json src/evaluation/startup-brief-evaluator.ts scripts/eval-startup-brief.ts package.json
git commit -m "test(startup-brief): fixture + evaluator (failing until composer lands)"
```

---

### Task 3.2: Worktree evidence provider — extend `src/retrieval/worktree.ts`

**Files:**
- Modify: `src/retrieval/worktree.ts` (already 520 LOC)
- Modify: `src/retrieval/service.ts` (wire provider into pipeline; ensure it runs only when `cwd` is supplied)
- Create: `test/worktree-provider.test.ts`

- [ ] **Step 1: Audit current `worktree.ts`** — what it does and doesn't surface today.

Run: `grep -n "^export\|tryAdd\|collectWorktreeEvidence\|root_handoff\|git_changed" src/retrieval/worktree.ts | head -40`

- [ ] **Step 2: Write failing tests for the four bounded buckets**

```ts
test('worktree provider returns prompt-named files', async () => {});
test('worktree provider returns git-changed files (porcelain v1)', async () => {});
test('worktree provider returns handoff-family files (handoff*.md, plan-*.md)', async () => {});
test('worktree provider returns recently-modified files within max-age window', async () => {});
test('tryAdd does not starve git_changed when prompt_named hits the cap', async () => {});
test('worktree provider parses git status -z (NUL separators) for paths with control chars', async () => {});
test('worktree provider strips secrets from file evidence', async () => {});
test('worktree evidence is bounded: no raw file bodies, only path + first heading + byte count + status', async () => {});
```

- [ ] **Step 3: Patch `worktree.ts`** — implement per-bucket caps (fixes audit P2 finding `worktree.ts:235,248`), switch to `git status --porcelain=v1 -z` and split on NUL (fixes `worktree.ts:323`).

- [ ] **Step 4: Wire into retrieval**

In `src/retrieval/service.ts` `searchContext`, when `input.cwd` is set and `config.worktreeEnabled`, call the worktree provider and merge its results as a sixth candidate source tagged `source: 'worktree'`. Use the existing fusion path but bias raw scores upward when `worktree` and `lexical/metadata` agree (no new fusion code — just produce candidates).

- [ ] **Step 5: Run** `pnpm run eval:retrieval` (must stay green) + new tests.

- [ ] **Step 6: Commit**

```bash
git add src/retrieval/worktree.ts src/retrieval/service.ts test/worktree-provider.test.ts
git commit -m "feat(retrieval): bounded worktree evidence provider as sixth source"
```

---

### Task 3.3: `StartupBrief` composer

**Files:**
- Create: `src/retrieval/startup-brief.ts`
- Modify: `src/retrieval/service.ts` (attach `startupBrief` to context-pack response)
- Modify: `src/types.ts` (add types)
- Test: covered by Task 3.1's fixture eval

- [ ] **Step 1: Types**

```ts
export interface StartupBrief {
  verdict: 'proceed' | 'confirm' | 'clarify';
  readFirst: { path: string; reason: string; source: 'worktree' | 'memory' }[];
  directEvidence: { knowledgeId?: string; path?: string; reason: string }[];
  adjacentEvidence: { knowledgeId: string; reason: string }[];
  missingSignals: string[];
  riskyAreas: string[];
  verificationCommands: string[];
  requiredContextDecision: 'selected' | 'selected_but_noisy' | 'rejected' | 'stale' | 'irrelevant' | 'missing_context';
}
```

- [ ] **Step 2: Verdict rules**

In `src/retrieval/startup-brief.ts` export `composeStartupBrief({ classified, candidates, contextFit, worktreeEvidence })`:

- `proceed` if `contextFit.fitStatus === 'ready'` AND every required handoff/plan file present in worktree AND no disagreement detected.
- `confirm` if `contextFit.fitStatus === 'needs_confirmation'` OR memory and worktree headings disagree.
- `clarify` if `contextFit.fitStatus === 'insufficient'` OR required signals absent from both worktree and memory.

Mismatch detection compares titles/first-headings, not body text.

- [ ] **Step 3: Wire into `RetrievalService.searchContext` response.** Add `startupBrief` to `ContextSearchResult` and to `tuberosa_start_session` output.

- [ ] **Step 4: Run** `pnpm run eval:startup-brief` (Task 3.1's failing fixture should now pass for the 8+ cases).

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/startup-brief.ts src/retrieval/service.ts src/types.ts
git commit -m "feat(retrieval): StartupBrief with proceed/confirm/clarify verdict"
```

---

### Task 3.4: Classifier — stop extracting prompt verbs as symbols

**Files:**
- Modify: `src/retrieval/classifier.ts`
- Add fixture rows: `eval/retrieval-fixtures.json`

- [ ] **Step 1: Add failing fixture rows**

Add to `eval/retrieval-fixtures.json` cases where the prompt contains `Analyze`, `Answer`, `Investigate`, `Audit`, `Review` and the expected `classification.symbols` is `[]`. The eval will fail because today these get extracted.

- [ ] **Step 2: Run** `pnpm run eval:retrieval` — confirm new cases fail.

- [ ] **Step 3: Patch classifier**

In `src/retrieval/classifier.ts`, the symbol extractor recognizes any capitalized-camel token as a symbol. Add a deny-list of prompt verbs:

```ts
const PROMPT_VERB_STOPWORDS = new Set([
  'Analyze', 'Answer', 'Audit', 'Build', 'Check', 'Continue',
  'Create', 'Debug', 'Design', 'Document', 'Explain', 'Explore',
  'Find', 'Fix', 'Implement', 'Improve', 'Investigate', 'List',
  'Plan', 'Refactor', 'Remove', 'Review', 'Run', 'Search',
  'Show', 'Summarize', 'Test', 'Trace', 'Update', 'Verify',
  'Write',
]);

// in extractSymbols(): after candidate token extraction
const filtered = candidates.filter((token) => !PROMPT_VERB_STOPWORDS.has(token));
```

Make sure the deny-list only applies to tokens that appear in the **first sentence** of the prompt (so genuine class/function names elsewhere still classify).

- [ ] **Step 4: Run** `pnpm run eval:retrieval` — must pass at hitRate=1.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/classifier.ts eval/retrieval-fixtures.json
git commit -m "fix(classifier): deny-list prompt verbs from symbol extraction"
```

---

### Task 3.5: Tighten `applyNoiseTolerance('strict')`

**Files:**
- Modify: `src/retrieval/service.ts:1455`
- Add fixture row: `eval/retrieval-fixtures.json`

- [ ] **Step 1: Add failing fixture**

A case with `noiseTolerance: 'strict'`, weak evidence, current expectation `needs_confirmation`, new expectation `insufficient`.

- [ ] **Step 2: Patch**

```ts
function applyNoiseTolerance(noise: 'balanced' | 'strict', fit: ContextFit, candidates: SearchCandidate[]): ContextFit {
  if (noise !== 'strict') return fit;
  if (fit.fitStatus === 'ready') {
    // existing strict-on-ready logic
    return fit;
  }
  if (fit.fitStatus === 'needs_confirmation') {
    const hasHardSignal = candidates.some((c) => c.source === 'lexical' || c.source === 'worktree' || c.source === 'metadata');
    if (!hasHardSignal) {
      return { ...fit, fitStatus: 'insufficient', missingSignals: [...fit.missingSignals, 'strict_no_hard_signal'] };
    }
  }
  return fit;
}
```

- [ ] **Step 3: Run eval — green. Commit.**

```bash
git add src/retrieval/service.ts eval/retrieval-fixtures.json
git commit -m "fix(retrieval): strict noise tolerance also downgrades needs_confirmation without hard signal"
```

---

### Task 3.6: `ResearchTraceInput` on finish-session

**Files:**
- Create: `src/agent-session/research-trace.ts`
- Modify: `src/agent-session/service.ts`, `src/types.ts`, `src/validation.ts`, `src/mcp/server.ts`, `src/http/server.ts`
- Create: `test/research-trace.test.ts`, `eval/research-trace-fixtures.json`

- [ ] **Step 1: Types and bounds**

```ts
export interface ResearchTraceStep {
  kind: 'thought' | 'action' | 'observation' | 'decision';
  text: string;          // ≤ 280 chars
  references?: { file?: string; symbol?: string; command?: string; knowledgeId?: string }[];
}
export interface ResearchTraceInput {
  steps: ResearchTraceStep[]; // ≤ 12
  outcome: string;            // ≤ 500 chars
}
export interface ResearchTraceSummary extends ResearchTraceInput {
  derived: boolean;           // true when auto-derived from signals
  bytes: number;
}
```

- [ ] **Step 2: Validation in `src/validation.ts`**

Enforce caps; reject any step longer than 280 chars or > 12 steps.

- [ ] **Step 3: Auto-derivation when omitted**

In `src/agent-session/research-trace.ts` export `deriveTrace({ learningSignals, sessionNotes, contextDecisions, changedFiles, verificationCommands })` that produces a compact trace without reading raw conversation. Map each input kind to a step kind:
- `decision` ← context decisions + selected reflection draft
- `action` ← changedFiles + verificationCommands
- `observation` ← learningSignals of kind `verification|file_change`
- `thought` ← learningSignals of kind `tip|decision`

- [ ] **Step 4: Store on session metadata + draft provenance**

In `tuberosa_finish_session` (`src/agent-session/service.ts`), if `input.researchTrace` is present, validate and attach. Otherwise call `deriveTrace`. Persist into session metadata and into reflection-draft provenance.

- [ ] **Step 5: Tests + fixture**

Each test asserts the trace shape and that no raw transcript text is stored.

- [ ] **Step 6: Commit**

```bash
git add src/agent-session/research-trace.ts src/agent-session/service.ts src/types.ts src/validation.ts \
        src/mcp/server.ts src/http/server.ts test/research-trace.test.ts eval/research-trace-fixtures.json
git commit -m "feat(session): compact ResearchTrace on finish-session (input or auto-derived)"
```

---

### Plan 3 Verification Gate

- `pnpm run eval:retrieval`, `eval:agent-context`, `eval:startup-brief`, `eval:knowledge-completeness` all green.
- New fixture `eval/startup-brief-fixtures.json` exercises all three verdicts.
- New fixture `eval/research-trace-fixtures.json` exercises auto-derivation + explicit input.

---

# Plan 4 — Maintenance Preview + Workbench Review UX

**Goal:** Close the review loop. Add preview/apply maintenance endpoints (per `plan-synthesis.md` Phase C) and surface them — plus the new `StartupBrief` and `ResearchTrace` — in the workbench so the 9 pending drafts and 3 open gaps can actually be resolved. Estimated 3–4 days.

**Prerequisite:** Plan 3 green.

**Verification gate before Plan 5 starts:** Maintenance endpoints work end-to-end; workbench renders all four new panels; browser test green.

---

### Task 4.1: Maintenance preview/apply API

**Files:**
- Modify: `src/maintenance/service.ts`
- Modify: `src/http/server.ts`, `src/mcp/server.ts`
- Create: `test/maintenance.test.ts`, `eval/maintenance-fixtures.json`

- [ ] **Step 1: Define MaintenanceAction shape**

```ts
export type MaintenanceKind =
  | 'duplicate_merge' | 'stale_archive' | 'supersession'
  | 'weak_grounding_demote' | 'add_labels' | 'add_references' | 'relation_repair';

export interface MaintenanceAction {
  id: string;                  // deterministic hash of (kind, targetIds)
  kind: MaintenanceKind;
  risk: 'low' | 'medium' | 'high';
  targetIds: string[];
  rationale: string;
  evidence: { source: string; reference: string }[];
  before: { title: string; summary: string; labels: { type: string; value: string }[] };
}
export interface MaintenancePreview {
  generatedAt: string;
  actions: MaintenanceAction[];
}
```

- [ ] **Step 2: Detectors**

In `src/maintenance/service.ts` add one method per kind. Each returns `MaintenanceAction[]`. Reuse existing duplicate-detector and supersession primitives.

- [ ] **Step 3: Endpoints**

HTTP:
- `POST /operations/maintenance/preview` → `MaintenancePreview`
- `POST /operations/maintenance/apply` → body `{ actionIds: string[] }`, re-runs detector before mutating, returns `expired` for any action whose preconditions changed.

MCP: same shapes via `tuberosa_propose_maintenance` (preview) and `tuberosa_apply_maintenance` (apply). These tools already exist (see deferred-tool list); update their implementations to match the new shape.

- [ ] **Step 4: Auto-apply only low-risk additive enrichment**

`add_labels` and `add_references` may auto-apply behind explicit opt-in flag `autoApplyLowRisk: true`. Archive / supersede / merge / demote must remain explicit-approve.

- [ ] **Step 5: Tests**

```ts
test('preview is idempotent under repeated calls', async () => {});
test('apply returns expired for actions whose preconditions changed', async () => {});
test('autoApplyLowRisk: false leaves add_labels in pending', async () => {});
test('autoApplyLowRisk: true applies add_labels but not stale_archive', async () => {});
```

- [ ] **Step 6: Commit**

```bash
git add src/maintenance/service.ts src/http/server.ts src/mcp/server.ts test/maintenance.test.ts eval/maintenance-fixtures.json
git commit -m "feat(maintenance): preview/apply with re-check + low-risk auto-apply flag"
```

---

### Task 4.2: Workbench — StartupBriefPanel

**Files:**
- Create: `src/workbench/views/StartupBriefPanel.tsx`
- Modify: `src/workbench/views/SessionView.tsx`, `src/workbench/state/api.ts`
- Modify: `src/workbench/glossary/terms.ts`
- Create: `test/browser/startup-brief.test.ts`

- [ ] **Step 1: Wire data**

`src/workbench/state/api.ts` — add `fetchStartupBrief(sessionId)` calling `GET /agent-sessions/:id/startup-brief`.

- [ ] **Step 2: Component**

Renders verdict badge, read-first list with `worktree`/`memory` source badges, direct vs adjacent evidence, missing signals, risky areas, verification commands.

- [ ] **Step 3: Glossary entries**

Add: `startup_brief`, `worktree_evidence`, `read_first`, `proceed_confirm_clarify`.

- [ ] **Step 4: Browser test**

`test/browser/startup-brief.test.ts` (uses the existing Playwright setup) — open `/workbench/session/:id`, assert verdict badge + readFirst list visible.

- [ ] **Step 5: Commit**

```bash
git add src/workbench/views/StartupBriefPanel.tsx src/workbench/views/SessionView.tsx \
        src/workbench/state/api.ts src/workbench/glossary/terms.ts test/browser/startup-brief.test.ts
git commit -m "feat(workbench): StartupBriefPanel in SessionView"
```

---

### Task 4.3: Workbench — MemoryMaintenanceTab

**Files:**
- Create: `src/workbench/views/MemoryMaintenanceTab.tsx`
- Modify: `src/workbench/views/MemoryView.tsx` (add tab), `src/workbench/state/api.ts`
- Create: `test/browser/maintenance.test.ts`

- [ ] **Step 1: Data wiring**

`fetchMaintenancePreview()`, `applyMaintenance(actionIds)`. Group actions by kind; render risk badge.

- [ ] **Step 2: Controls**

Per-action: `apply`, `reject`, `open`. Bulk: `apply low-risk additive only`.

- [ ] **Step 3: Browser test**

Assert the preview lists at least one action; clicking apply produces a state change without page reload.

- [ ] **Step 4: Commit**

```bash
git add src/workbench/views/MemoryMaintenanceTab.tsx src/workbench/views/MemoryView.tsx \
        src/workbench/state/api.ts test/browser/maintenance.test.ts
git commit -m "feat(workbench): MemoryMaintenanceTab with preview + apply controls"
```

---

### Task 4.4: Workbench — ResearchTracePanel + finish-fields

**Files:**
- Create: `src/workbench/views/ResearchTracePanel.tsx`
- Modify: SessionView, DraftReviewView to display compact trace.
- Add glossary entries: `research_trace`, `verification_mode`.

- [ ] **Step 1: Render the trace as a vertical stepper** — `thought / action / observation / decision` color coded; references inline.

- [ ] **Step 2: When draft has trace, show it in DraftReviewView so reviewer sees investigation path.**

- [ ] **Step 3: Commit**

```bash
git add src/workbench/views/ResearchTracePanel.tsx src/workbench/views/SessionView.tsx \
        src/workbench/views/DraftReviewView.tsx src/workbench/glossary/terms.ts
git commit -m "feat(workbench): ResearchTracePanel + draft-review trace display"
```

---

### Plan 4 Verification Gate

- `pnpm run test:workbench-browser` green.
- Manually exercise: preview maintenance → apply one action → see workbench summary counts update.
- Workbench summary should show 0 risky auto-memories, drafts list rendering, gaps list rendering with maintenance suggestions.

---

# Plan 5 — Structural Cleanup

**Goal:** Now that the parity matrix (Plan 2) protects storage seams and the goal features (Plan 3+4) are live, split the monolith files, replace `as` casts with validated row mappers, lift magic numbers into config, and remove dormant modules. This is the audit's Wave 4+5 — high blast radius, only safe with the gates from Plan 2. Estimated 5–7 days.

**Prerequisite:** Plan 2 storage parity matrix green AND Plan 3+4 shipped (so behavior surface is stable before refactor).

**Verification gate before close:** All evals green; LOC of `postgres-store.ts`, `service.ts`, `types.ts`, `memory-store.ts`, `validation.ts` all under 1000.

---

### Task 5.1: Split `src/types.ts` (1987 LOC) into per-domain modules

**Files:**
- Create: `src/types/knowledge.ts`, `src/types/retrieval.ts`, `src/types/feedback.ts`, `src/types/session.ts`, `src/types/workbench.ts`, `src/types/ingestion.ts`, `src/types/operations.ts`
- Modify: `src/types.ts` → barrel re-exporting everything

- [ ] **Step 1: Inventory** — `grep -E "^export (type|interface|enum|const) " src/types.ts | wc -l`. List every export with the domain it belongs to.

- [ ] **Step 2: Move per domain.** Use `git mv`-equivalent (rewrite + redirect) one domain at a time, run `pnpm run build && pnpm test` between each.

- [ ] **Step 3: `src/types.ts` becomes a barrel:**

```ts
export * from './types/knowledge.js';
export * from './types/retrieval.js';
// ... etc
```

- [ ] **Step 4: Commit per domain split** (one commit per domain to keep diffs reviewable).

---

### Task 5.2: Split `src/storage/postgres-store.ts` (2746 LOC)

**Files:**
- Create: `src/storage/postgres/knowledge-store.ts`, `label-store.ts`, `search-store.ts`, `feedback-store.ts`, `session-store.ts`, `backup-store.ts`, `relations-store.ts`
- Modify: `src/storage/postgres-store.ts` → thin facade that composes the above

- [ ] **Step 1: Identify domain seams.** Each new file owns one table family + its searches.

- [ ] **Step 2: Move methods one domain at a time.** Run `pnpm test` AND `pnpm run test:integration` AND the storage parity matrix between each move.

- [ ] **Step 3: Facade preserves the `KnowledgeStore` interface verbatim** — no caller of `PostgresKnowledgeStore` changes.

- [ ] **Step 4: Commit per file** so reviewers can read each split independently.

---

### Task 5.3: Mirror split for `src/storage/memory-store.ts` (1524 LOC)

Same as 5.2 but for memory store. Parity matrix from Plan 2 catches divergence.

---

### Task 5.4: Replace `as` casts with `mapRow*` validators

**Files:**
- Modify: each new `src/storage/postgres/*.ts` file
- Create: `src/storage/postgres/row-mappers.ts`

- [ ] **Step 1: Per-table mapper**

```ts
export function mapKnowledgeRow(row: unknown): StoredKnowledge {
  if (!row || typeof row !== 'object') throw new StoreError('mapKnowledgeRow: not an object');
  const r = row as Record<string, unknown>;
  return {
    id: requireUuid(r.id, 'id'),
    title: requireString(r.title, 'title'),
    status: requireEnum(r.status, ['approved', 'pending', 'rejected'], 'status'),
    // ...
  };
}
```

Build the primitive validators (`requireUuid`, `requireString`, `requireEnum`, `requireArray`) once.

- [ ] **Step 2: Replace `as` casts.** Each `row.x as Y` becomes `mapXRow(row).y`.

- [ ] **Step 3: Replace the 12-line `as unknown as` block in memory-store** (`memory-store.ts:1062`) with calls to the new mappers — this is the riskiest cast in the codebase (backup-restore path).

- [ ] **Step 4: Commit**

```bash
git add src/storage/postgres/ src/storage/memory-store.ts
git commit -m "refactor(storage): replace `as` casts with mapRow* validators"
```

---

### Task 5.5: Split `src/retrieval/service.ts` (2072 LOC)

**Files:**
- Create: `src/retrieval/query-rewriter.ts`, `candidate-finder.ts`, `ranker.ts`, `suppression.ts`, `feedback-learning.ts`
- Modify: `src/retrieval/service.ts` → ~300-line orchestrator

- [ ] **Step 1: Extract `intentSuppressionAdjustment` (128 lines) into `suppression.ts`.** Drive it from a `SuppressionRule[]` table:

```ts
export interface SuppressionRule {
  code: SuppressionReason;
  detect: (ctx: SuppressionContext) => boolean;
  delta: (ctx: SuppressionContext) => number;
  evidenceFor: (ctx: SuppressionContext) => string[];
}
```

- [ ] **Step 2: Extract query-rewrite + probe** into `query-rewriter.ts`.

- [ ] **Step 3: Extract candidate ranking** into `ranker.ts`.

- [ ] **Step 4: Extract `recordFeedback`-driven learning** into `feedback-learning.ts`.

- [ ] **Step 5: `searchContext` shrinks to ~30 lines** that orchestrate the above.

- [ ] **Step 6: Commit per extraction.**

---

### Task 5.6: Magic numbers → `config/retrieval-policy.json`

**Files:**
- Modify: `config/retrieval-policy.json`
- Modify: `src/retrieval/policy.ts`, `src/retrieval/service.ts`, `src/retrieval/context-fit.ts`, `src/retrieval/fusion.ts`

- [ ] **Step 1: Identify** — at minimum the deltas at `service.ts:1781`, `1793`, `1807`, `1827`; `context-fit.ts:212`, `:221`, `:539`; `fusion.ts:75`, `:85`.

- [ ] **Step 2: Lift into JSON** under a `tuning` block; load via `policy.ts`.

- [ ] **Step 3: Run `pnpm run eval:retrieval` — must remain exactly at hitRate=1**, no score deltas. If any drift, the lift moved a default; restore the literal.

- [ ] **Step 4: Commit**

```bash
git add config/retrieval-policy.json src/retrieval/policy.ts src/retrieval/service.ts \
        src/retrieval/context-fit.ts src/retrieval/fusion.ts
git commit -m "refactor(retrieval): lift suppression/fit/fusion magic numbers into retrieval-policy.json"
```

---

### Task 5.7: Promote suppression-reason strings to literal union

**Files:**
- Modify: `src/types/retrieval.ts`, `src/retrieval/service.ts`, `src/retrieval/context-pack.ts`

```ts
export type SuppressionReason =
  | 'superseded' | 'stale_freshness' | 'evidence_mismatch'
  | 'domain_mismatch' | 'rejected_recent' | 'irrelevant_recent';
```

Every emit site changes from string literal to typed value.

- [ ] **Commit**.

---

### Task 5.8: Remove dormant ingest modules + CJS smell

**Files:**
- Delete: `src/ingest/late-chunker.ts`, `src/ingest/contextual-summarizer.ts`
- Modify: `src/model/provider.ts` (drop CJS `require()`, replace with static `import`), consolidate `buildProviderRegistry` + `buildOllamaRegistry` in `src/model/registry.ts`

- [ ] **Step 1: Verify zero importers.**

Run: `grep -rn "late-chunker\|contextual-summarizer\|summarizeSection\|supportsLongContextEmbed" src/ test/ scripts/`
Expected: only self-references.

- [ ] **Step 2: Verify no circular dep before replacing `require()`.**

Run: `node --import tsx -e "import('./src/model/provider.js').then(() => console.log('ok'))"` — must succeed after switching to static import (no cycle).

- [ ] **Step 3: Delete the files, consolidate registry, commit.**

---

### Task 5.9: Rename phase-N test files + strip phase comments

**Files:**
- Rename: `test/classifier-phase1.test.ts` → `test/classifier-extraction.test.ts`, etc.
- Strip "Phase N —" prefixes from source comments listed in audit §3.5.

- [ ] **One commit for the rename, one for the comment strip.**

---

### Task 5.10: Drop unused npm scripts after confirming with team

**Files:**
- Modify: `package.json`
- Delete: `scripts/seed-tuberosa-src.ts`, `scripts/backfill-domains.ts` if confirmed

- [ ] **Step 1: Open question to user before deleting.** Do not silently drop.

---

### Plan 5 Verification Gate

- `pnpm run build && pnpm test && pnpm run eval:retrieval && pnpm run eval:agent-context && pnpm run eval:knowledge-completeness && pnpm run eval:safety && pnpm run test:integration` all green.
- `wc -l src/storage/postgres/* src/storage/memory/* src/retrieval/* src/types/*` shows no single file over 1000 LOC.
- `grep -c " as " src/storage/postgres/*` < 10 total.

---

## Cross-plan risks and rollback boundaries

| Risk | Mitigation |
|---|---|
| Plan 1.4 (require API key for non-loopback) breaks an existing remote deploy | Default `requireApiKeyForNonLoopback: true` but allow `TUBEROSA_HTTP_HOST` to opt back into `0.0.0.0` if the operator explicitly accepts the risk. Document in README. |
| Plan 1.5 leaves orphan rows on existing DBs (existing tracked filenames) | `003_cleanup_dup_002s.sql` deletes those rows on migration. No-op on fresh DBs. |
| Plan 3 changes ranking | Every Plan 3 task adds a fixture before the code change. Eval must pass at hitRate=1 throughout. |
| Plan 5 splits change import paths | Run `pnpm run build` after every domain extraction. Barrel re-exports keep callers stable. |
| Plan 5.6 changes config defaults | The lift must preserve defaults exactly. If eval scores move, restore the literal in `policy.ts` and revisit the JSON. |

## Open questions to resolve before starting

1. **CI workflow scope** — GitHub Actions OK, or does the team need GitLab/CircleCI? (`Plan 2.1`)
2. **Plan 1.4 API-key rollout** — confirm `requireApiKeyForNonLoopback: true` default is acceptable; existing remote deploys must set `TUBEROSA_API_KEY` before merge.
3. **Plan 5.10 npm-script deletion** — `seed:self`, `backfill:domains` confirmed unused?
4. **Plan 4.1 maintenance auto-apply** — should the default for `autoApplyLowRisk` be `false`? Recommend yes; user can flip per-call.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task. Review between tasks. Fast iteration. Use `superpowers:subagent-driven-development`.
2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`. Batch execution with verification checkpoints at each `Plan N Verification Gate`.

Recommend: subagent-driven for Plans 1–2 (small, surgical), inline for Plan 3 (cohesive feature work with shared types), subagent-driven again for Plans 4–5.
