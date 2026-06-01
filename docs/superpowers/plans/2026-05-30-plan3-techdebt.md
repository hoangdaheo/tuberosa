# Plan 3 — Tech-Debt Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Eliminate the verified, eval-safe tech debt: the duplicate `ValidationError` (a real correctness bug), four `cosineSimilarity` copies, duplicated store/server helpers, scattered token-estimation, and `row: any` mappers — without changing retrieval behavior.

**Architecture:** Stacked on the Plan 2 branch. Each task is a small, behavior-preserving consolidation with TDD where it adds value, gated by the full verify suite. Pure dedup/relocation: the canonical implementation chosen always matches existing numeric/string behavior so the retrieval eval stays byte-for-byte green.

**Tech Stack:** TypeScript (NodeNext), Node 22, `node --test` + `tsx`.

**Branch:** `refactor/plan3-techdebt` (already created off `fix/plan2-security-robustness`).

**Verify gate:** `pnpm run build && pnpm test && pnpm run eval:retrieval && pnpm run eval:agent-context`.

## Scope decision (recon-driven)

Recon on this branch corrected three spec items. **Executed here (eval-safe):** ValidationError fix, cosineSimilarity dedup, store-helper dedup, `shouldAutoCapture` dedup, token-estimation unify, `row: any` tightening, UUID-regex centralization. **Moved to Plan 4 proposals (behavior/eval risk > value):**
- **Magic-numbers→policy** — adding fields to `DEFAULT_POLICY` changes `getRetrievalPolicyFingerprint` (sha256 of the whole policy); must be a dedicated PR that verifies no test/eval asserts a fixed fingerprint. Deferred.
- **`truncate` consolidation** — variants differ in ellipsis char (`...` vs `…`), undefined handling, and reserve width; merging changes emitted strings (snapshot risk). Deferred.
- **Behavior-changing non-null-assertion guards** (classifier `domain!`, clusterer `reason!`, conflict-resolver `metadata!`) — adding guards changes control flow when the value is absent; needs case-by-case behavioral review. Deferred. (The one provably-safe rewrite — `recommendation.ts:166`, where a `typeof === 'string'` check already proves the field — IS done here as Task 7.) The audit's claimed write-gate.ts `!` site does not exist.

---

## File Structure

**Created:** `src/util/vector.ts` (canonical `cosineSimilarity`), `src/storage/shared.ts` (`canonicalKnowledgePair`, `shouldDropInferredRelationsForStatus`), `src/error-log/auto-capture.ts` (`shouldAutoCapture`), `test/util-vector.test.ts`.
**Modified:** `src/security/safe-paths.ts` (drop local ValidationError, import canonical), `test/safe-paths.test.ts` + `test/export-import-security.test.ts` (import path), `src/ingest/duplicate-detector.ts` + `src/reflection/write-gate.ts` + `src/storage/memory-store.ts` + `src/user-style/clusterer.ts` (import shared cosineSimilarity), `src/storage/postgres-store.ts` + `src/storage/memory-store.ts` (import shared store helpers; `row: any`→`Record<string, unknown>`), `src/http/server.ts` + `src/mcp/server.ts` (import shared `shouldAutoCapture`), `src/util/text.ts` (export `TOKEN_CHARS`), `src/retrieval/preprocessor.ts` + `src/retrieval/anchor-window.ts` (import `TOKEN_CHARS`), `src/retrieval/service.ts` (use `estimateTokens` for the two inline copies), `src/util/uuid.ts` (add strict `isRfc4122Uuid`), `src/reflection/recommendation.ts` (optional-chaining cleanup).

---

## Task 1: Fix the duplicate `ValidationError` (HIGH correctness)

**Why:** `src/security/safe-paths.ts:4` declares a SECOND `class ValidationError extends Error` (no `code`/`status`). It's thrown by `assertSafeChildName`/`assertSafeBundlePath`, which run inside HTTP (`server.ts:573,599`), MCP (`server.ts:401,416`), export, and bootstrap. Because it isn't an `AppError`, a path-safety violation does NOT map to HTTP 400 — it falls through `toAppError` as a generic 500. The canonical `ValidationError` (`errors.ts:37`) carries `status:400`. Using it makes path-safety failures correctly return 400.

**Files:** Modify `src/security/safe-paths.ts:4-9`; `test/safe-paths.test.ts:35`; `test/export-import-security.test.ts:176`.

- [ ] **Step 1: Write/adjust a failing test.** In `test/safe-paths.test.ts`, add an assertion that the thrown error is the canonical AppError with status 400. First read the top of the file and how it currently imports/asserts `ValidationError`. Add:
```typescript
import { ValidationError } from '../src/errors.js';
// ...in an existing throwing case:
try { assertSafeChildName('../escape'); assert.fail('should throw'); }
catch (err) {
  assert.ok(err instanceof ValidationError);
  assert.equal((err as ValidationError).status, 400);
}
```
- [ ] **Step 2: Run — expect FAIL** (current safe-paths ValidationError has no `status`): `node --test --import tsx test/safe-paths.test.ts`
- [ ] **Step 3: Remove the local class, import canonical.** In `src/security/safe-paths.ts`, delete the local `export class ValidationError extends Error {...}` (lines 4-9) and add at the top: `import { ValidationError } from '../errors.js';`. Leave all `throw new ValidationError(message)` call sites unchanged (the canonical constructor accepts `(message, details?)`). Verify no import cycle: `errors.ts` must not import `safe-paths.ts` (it doesn't).
- [ ] **Step 4: Update the two test imports.** `test/safe-paths.test.ts:35` and `test/export-import-security.test.ts:176`: import `ValidationError` from `'../src/errors.js'` instead of from safe-paths. Keep the `assertSafe*` imports from safe-paths.
- [ ] **Step 5: Run — expect PASS** + build + full suite:
```bash
node --test --import tsx test/safe-paths.test.ts test/export-import-security.test.ts && pnpm run build 2>&1 | tail -3 && pnpm test 2>&1 | tail -5
```
- [ ] **Step 6: Commit:**
```bash
git add src/security/safe-paths.ts test/safe-paths.test.ts test/export-import-security.test.ts
git commit -m "fix: unify ValidationError so path-safety failures map to HTTP 400"
```

---

## Task 2: Consolidate `cosineSimilarity` into `src/util/vector.ts`

**Why:** Four copies (duplicate-detector.ts:158 exported, write-gate.ts:211, memory-store.ts:1803, clusterer.ts:86). All operate on embedding vectors. Canonical form uses `Math.sqrt(normL) * Math.sqrt(normR)` — **identical** to the duplicate-detector and memory-store versions (so their numerics are unchanged); the clusterer's `Math.sqrt(na*nb)` is numerically equivalent.

**Files:** Create `src/util/vector.ts`, `test/util-vector.test.ts`; Modify the four files above.

- [ ] **Step 1: Write the failing test** — `test/util-vector.test.ts`:
```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { cosineSimilarity } from '../src/util/vector.js';

test('cosineSimilarity: identical vectors → 1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
});
test('cosineSimilarity: orthogonal → 0', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});
test('cosineSimilarity: zero vector or empty → 0', () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([], [1]), 0);
});
```
- [ ] **Step 2: Run — expect FAIL:** `node --test --import tsx test/util-vector.test.ts`
- [ ] **Step 3: Create `src/util/vector.ts`** (canonical, full guards):
```typescript
/** Cosine similarity of two numeric (embedding) vectors. Returns 0 for empty or zero-norm inputs. */
export function cosineSimilarity(left: number[], right: number[]): number {
  const len = Math.min(left.length, right.length);
  if (len === 0) return 0;
  let dot = 0;
  let normL = 0;
  let normR = 0;
  for (let i = 0; i < len; i += 1) {
    dot += left[i] * right[i];
    normL += left[i] * left[i];
    normR += right[i] * right[i];
  }
  if (normL === 0 || normR === 0) return 0;
  return dot / (Math.sqrt(normL) * Math.sqrt(normR));
}
```
- [ ] **Step 4: Replace the four copies with imports.**
  - `src/ingest/duplicate-detector.ts`: delete the local `export function cosineSimilarity` (158-171); add `import { cosineSimilarity } from '../util/vector.js';`. NOTE: it was EXPORTED — check `grep -rn "from './duplicate-detector'" src/ test/` (or `duplicate-detector.js`) for anyone importing `cosineSimilarity` from it; if found, update them to import from `../util/vector.js` (recon found no cross-module importers, but re-verify).
  - `src/reflection/write-gate.ts`: delete local (211-226); add `import { cosineSimilarity } from '../util/vector.js';`.
  - `src/storage/memory-store.ts`: delete local (1803-1815); add `import { cosineSimilarity } from '../util/vector.js';`.
  - `src/user-style/clusterer.ts`: delete local (86-98); add `import { cosineSimilarity } from '../util/vector.js';`.
- [ ] **Step 5: Run tests + eval** (memory-store cosine feeds atom vector search; eval must stay green):
```bash
node --test --import tsx test/util-vector.test.ts && pnpm run build 2>&1 | tail -3 && pnpm test 2>&1 | tail -5 && pnpm run eval:retrieval 2>&1 | tail -3
```
- [ ] **Step 6: Commit:**
```bash
git add src/util/vector.ts test/util-vector.test.ts src/ingest/duplicate-detector.ts src/reflection/write-gate.ts src/storage/memory-store.ts src/user-style/clusterer.ts
git commit -m "refactor: consolidate cosineSimilarity into util/vector"
```

---

## Task 3: Lift duplicated store helpers into `src/storage/shared.ts`

**Why:** `canonicalKnowledgePair` and `shouldDropInferredRelationsForStatus` are byte-identical in `postgres-store.ts` (3225, 3329) and `memory-store.ts` (1817, 1971).

**Files:** Create `src/storage/shared.ts`; Modify `src/storage/postgres-store.ts`, `src/storage/memory-store.ts`.

- [ ] **Step 1: Create `src/storage/shared.ts`:**
```typescript
import type { StoredKnowledge } from '../types.js';

/** Order a knowledge-id pair deterministically (for symmetric relation keys). */
export function canonicalKnowledgePair(left: string, right: string): [string, string] {
  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}

/** Inferred relations are dropped for knowledge that is archived or blocked. */
export function shouldDropInferredRelationsForStatus(status: StoredKnowledge['status'] | undefined): boolean {
  return status === 'archived' || status === 'blocked';
}
```
> Confirm `StoredKnowledge` is exported from `../types.js` (it is, used widely). If the local copies reference the type differently, match the existing import.
- [ ] **Step 2: Remove both copies from each store and import.** In `postgres-store.ts` delete the two functions (3225-3227, 3329-3331) and add `import { canonicalKnowledgePair, shouldDropInferredRelationsForStatus } from './shared.js';`. Same in `memory-store.ts` (delete 1817-1819, 1971-1973; add the import). Call sites (postgres 552/700, memory 366/489) are unchanged.
- [ ] **Step 3: Build + full suite + integration if up:**
```bash
pnpm run build 2>&1 | tail -3 && pnpm test 2>&1 | tail -5 && pnpm run test:integration 2>&1 | tail -10
```
- [ ] **Step 4: Commit:**
```bash
git add src/storage/shared.ts src/storage/postgres-store.ts src/storage/memory-store.ts
git commit -m "refactor(storage): share canonicalKnowledgePair + shouldDropInferredRelationsForStatus"
```

---

## Task 4: Share `shouldAutoCapture` (only the identical piece)

**Why:** `shouldAutoCapture` is byte-identical in `http/server.ts` and `mcp/server.ts`. (The `maybeCapture*` and `categoryForAppError` functions legitimately diverge by surface — leave them per-surface; do NOT force a shared abstraction.)

**Files:** Create `src/error-log/auto-capture.ts`; Modify `src/http/server.ts`, `src/mcp/server.ts`.

- [ ] **Step 1: Locate the two copies.** `grep -n "function shouldAutoCapture" src/http/server.ts src/mcp/server.ts`. Read both to confirm identical (they take `(services: AppServices, error: AppError)`).
- [ ] **Step 2: Create `src/error-log/auto-capture.ts`:**
```typescript
import type { AppServices } from '../types.js';
import type { AppError } from '../errors.js';

/** Whether an AppError should be auto-captured as an error-log entry. */
export function shouldAutoCapture(services: AppServices, error: AppError): boolean {
  if (!services.config.errorLogAutoCapture) {
    return false;
  }
  return services.config.errorLogCaptureClientErrors || error.status >= 500;
}
```
> Confirm the correct import for `AppServices` (it may live in `../types.js` or a services module — match what `server.ts` uses). If `AppServices` isn't exported from `types.js`, import from wherever `server.ts` imports it.
- [ ] **Step 3: Remove both local copies; import the shared one** in `http/server.ts` and `mcp/server.ts`. Leave `maybeCaptureHttpError`/`maybeCaptureMcpError`/`categoryForAppError` exactly as they are.
- [ ] **Step 4: Build + suite:** `pnpm run build 2>&1 | tail -3 && pnpm test 2>&1 | tail -5`
- [ ] **Step 5: Commit:**
```bash
git add src/error-log/auto-capture.ts src/http/server.ts src/mcp/server.ts
git commit -m "refactor(error-log): share shouldAutoCapture across http + mcp"
```

---

## Task 5: Unify token estimation (eval-safe)

**Why:** `estimateTokens` (util/text.ts:9) + a `TOKEN_CHARS=4` duplicated in `preprocessor.ts:14` and `anchor-window.ts:1`, plus two inline `Math.max(1, Math.ceil(atom.claim.length / 4))` in `service.ts:1381,1423` that are byte-identical to `estimateTokens`. To stay eval-safe, we ONLY (a) export the `4` as a constant and (b) replace the byte-identical inline copies — we do NOT change `preprocessor`'s no-floor formula.

**Files:** Modify `src/util/text.ts`, `src/retrieval/preprocessor.ts`, `src/retrieval/anchor-window.ts`, `src/retrieval/service.ts`.

- [ ] **Step 1: Export the constant from `src/util/text.ts`.** Add `export const TOKEN_CHARS = 4;` and rewrite `estimateTokens` to use it (behavior identical):
```typescript
export const TOKEN_CHARS = 4;
export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / TOKEN_CHARS));
}
```
- [ ] **Step 2: preprocessor.ts** — replace the local `const TOKEN_CHARS = 4;` with `import { TOKEN_CHARS } from '../util/text.js';` (keep its existing `estimateTokens(s)` body `Math.ceil(s.length / TOKEN_CHARS)` UNCHANGED — do not add the `Math.max(1, …)` floor, to preserve current behavior). If `preprocessor.ts` already imports from `util/text.js`, add `TOKEN_CHARS` to that import.
- [ ] **Step 3: anchor-window.ts** — replace local `const TOKEN_CHARS = 4;` with `import { TOKEN_CHARS } from '../util/text.js';`. The `windowTokens * TOKEN_CHARS` usage is unchanged.
- [ ] **Step 4: service.ts** — at lines 1381 and 1423, replace `Math.max(1, Math.ceil(atom.claim.length / 4))` with `estimateTokens(atom.claim)`. Add `estimateTokens` to the existing `util/text.js` import in service.ts (check it isn't already imported).
- [ ] **Step 5: Build + suite + eval (must be byte-for-byte green):**
```bash
pnpm run build 2>&1 | tail -3 && pnpm test 2>&1 | tail -5 && pnpm run eval:retrieval 2>&1 | tail -3
```
- [ ] **Step 6: Commit:**
```bash
git add src/util/text.ts src/retrieval/preprocessor.ts src/retrieval/anchor-window.ts src/retrieval/service.ts
git commit -m "refactor: share TOKEN_CHARS and reuse estimateTokens for atom token math"
```

---

## Task 6: Tighten `row: any` mappers to `Record<string, unknown>`

**Why:** `mapSourceFileRow` (postgres-store.ts:245) and `mapSyncRunRow` (262) use `row: any`, inconsistent with sibling mappers (`mapKnowledgeRow:3123`) that use `Record<string, unknown>` + explicit casts and the `toIso(...)` date helper.

**Files:** Modify `src/storage/postgres-store.ts:245-275`.

- [ ] **Step 1: Read `mapKnowledgeRow` (3123) and the `toIso` helper** to match the casting idiom (`String(...)`, `Number(...)`, `row.x as T`, `toIso(...)` for dates).
- [ ] **Step 2: Convert both methods to `row: Record<string, unknown>`** with explicit casts. Example for `mapSourceFileRow`:
```typescript
  private mapSourceFileRow(row: Record<string, unknown>): SourceFileRecord {
    return {
      id: String(row.id),
      project: String(row.project_name),
      path: String(row.path),
      contentHash: (row.content_hash as string | null) ?? null,
      status: row.status as SourceFileRecord['status'],
      lastSyncedSha: (row.last_synced_sha as string | null) ?? null,
      priorPaths: (row.prior_paths as string[] | null) ?? [],
      knowledgeCount: Number(row.knowledge_count ?? 0),
      firstSeenAt: toIso(row.first_seen_at),
      lastSeenAt: toIso(row.last_seen_at),
      archivedAt: row.archived_at ? toIso(row.archived_at) : null,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
    };
  }
```
Apply the analogous treatment to `mapSyncRunRow` (the `plan` field keeps its `typeof row.plan === 'string' ? JSON.parse(...) : row.plan` logic; cast appropriately). MATCH the exact field types from `SourceFileRecord`/`SyncRunRecord` (read those interfaces) and reuse the existing `toIso` helper rather than `.toISOString?.()`. If `toIso`'s null-handling differs from the original `?.toISOString?.() ?? row.x`, preserve the original semantics (don't change what's emitted for null/Date/string inputs).
- [ ] **Step 3: Build + suite + integration if up** (these mappers run only on the Postgres path):
```bash
pnpm run build 2>&1 | tail -3 && pnpm test 2>&1 | tail -5 && pnpm run test:integration 2>&1 | tail -12
```
> If the integration stack is down, the build (type-check) is the primary gate; the cast types must exactly satisfy `SourceFileRecord`/`SyncRunRecord`.
- [ ] **Step 4: Commit:**
```bash
git add src/storage/postgres-store.ts
git commit -m "refactor(storage): type row mappers as Record<string, unknown>"
```

---

## Task 7: Centralize the strict UUID regex + one safe optional-chaining cleanup

**Why:** `metadataUuidString` (service.ts:2407) inlines a strict RFC-4122 regex — keep its strict semantics (it validates an agent-supplied metadata field, NOT a `::uuid` cast), but move the regex into `util/uuid.ts` next to `isPersistedKnowledgeId` so both UUID patterns live in one place. Also do the one provably-safe non-null-assertion removal at `recommendation.ts:166`.

**Files:** Modify `src/util/uuid.ts`, `src/retrieval/service.ts:2407-2412`, `src/reflection/recommendation.ts:166`.

- [ ] **Step 1: Add a strict export to `src/util/uuid.ts`:**
```typescript
const RFC4122_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Strict RFC-4122 UUID check (version 1-5, standard variant). Stricter than isPersistedKnowledgeId — use for validating user/agent-supplied identifier *values*, not for guarding `::uuid` casts. */
export function isRfc4122Uuid(value: unknown): value is string {
  return typeof value === 'string' && RFC4122_PATTERN.test(value);
}
```
- [ ] **Step 2: Use it in `metadataUuidString`** (service.ts:2407). Add `isRfc4122Uuid` to the import from `../util/uuid.js` (add the import if service.ts doesn't already import from there), and rewrite:
```typescript
function metadataUuidString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadataString(metadata, key);
  return value && isRfc4122Uuid(value) ? value : undefined;
}
```
Semantics are identical (same strict pattern), just centralized.
- [ ] **Step 3: Optional-chaining cleanup at recommendation.ts:166.** The `typeof ... === 'string'` guard already proves the field; replace the `!` with optional chaining:
```typescript
  const fitFromMetadata = (input.draft.metadata as { contextFit?: { fitStatus?: string } })?.contextFit?.fitStatus;
```
> Read the surrounding ternary first; ensure the type of `fitFromMetadata` stays `string | undefined` and downstream usage is unchanged. This is behavior-identical (the guard returned the same value).
- [ ] **Step 4: Build + suite + eval:**
```bash
pnpm run build 2>&1 | tail -3 && pnpm test 2>&1 | tail -5 && pnpm run eval:retrieval 2>&1 | tail -3
```
- [ ] **Step 5: Commit:**
```bash
git add src/util/uuid.ts src/retrieval/service.ts src/reflection/recommendation.ts
git commit -m "refactor: centralize RFC-4122 uuid regex; drop a provably-safe non-null assertion"
```

---

## Task 8: Final verification gate

- [ ] **Step 1: Full gate.**
```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run eval:agent-context
```
Expected: build clean; full suite green; both evals byte-for-byte green (this plan changed no retrieval numerics).
- [ ] **Step 2: Integration (best-effort):** `pnpm run test:integration 2>&1 | tail -15`.
- [ ] **Step 3: Confirm no remaining duplicates.**
```bash
grep -rn "function cosineSimilarity" src/        # expect 0 (only the util import + re-exports)
grep -rn "class ValidationError" src/            # expect 1 (errors.ts only)
grep -rn "const TOKEN_CHARS = 4" src/            # expect 1 (util/text.ts only)
```
- [ ] **Step 4: Scope check:** `git diff --stat fix/plan2-security-robustness..HEAD`.

---

## Self-Review (completed by plan author)

**Spec coverage:** Covers spec Plan 3 rows 1 (ValidationError, T1), 3 (cosineSimilarity, T2), 5 (store helpers, T3), 4 (shouldAutoCapture, T4 — scoped to the identical piece only, per recon), 6 (token estimation, T5), 7 (row:any, T6), 2 (UUID regex, T7 — centralized not merged, per recon). Spec rows 8 (magic-numbers→policy), 9a (truncate), 9b (behavior-changing non-null guards) explicitly deferred to Plan 4 proposals with rationale (fingerprint/snapshot/control-flow risk). The one safe non-null removal (recommendation.ts:166) is in T7.

**Placeholder scan:** Concrete code for every created file and the ValidationError/token/uuid edits. Tasks 4 and 6 instruct reading the exact sibling pattern (`AppServices` import, `mapKnowledgeRow`/`toIso`, `SourceFileRecord`/`SyncRunRecord` interfaces) before editing — deliberate, since the cast types must match existing interfaces precisely.

**Type consistency:** `cosineSimilarity(left:number[], right:number[]):number`, `shouldAutoCapture(services, error)`, `canonicalKnowledgePair`/`shouldDropInferredRelationsForStatus`, `TOKEN_CHARS`/`estimateTokens`, `isRfc4122Uuid(value:unknown):value is string` are consistent across definition and all call sites.

**Eval-safety:** T2 canonical matches duplicate-detector + memory-store numerics exactly; T5 preserves preprocessor's no-floor formula and only swaps byte-identical inline copies; nothing touches fusion weights/policy. Eval must stay green — it's a verify-gate step in T2, T5, T7, and T8.
