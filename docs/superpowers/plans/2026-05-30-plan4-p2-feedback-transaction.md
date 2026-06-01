# P4-2 — Transactional Feedback Learning Fan-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Make the feedback-learning fan-out (`createKnowledgeGap` / `createLearningProposal` / `getKnowledge` / `updateAtom` / `incrementAtomReuse`) atomic, so a mid-fan-out failure rolls back all its writes instead of leaving partial learning state — by adding a generic `withTransaction` primitive to the `KnowledgeStore` interface.

**Architecture:** Add `withTransaction<T>(fn: (tx: KnowledgeStore) => Promise<T>): Promise<T>` to the store interface. Postgres routes simple queries through a swappable `Queryable` (`this.db`, defaulting to the pool); `withTransaction` acquires one client, `BEGIN`s, runs `fn` against a transaction-bound store whose `db` is that client, then `COMMIT`/`ROLLBACK`. Memory snapshots its maps and restores on throw. The retrieval service wraps the fan-out in `store.withTransaction(...)`.

**Tech Stack:** TypeScript (NodeNext), Node 22, `pg`, `node --test`.

**Branch:** `fix/plan4-feedback-transaction` (already created, stacked on `refactor/plan3-techdebt`).

**Verify gate:** `pnpm run build && pnpm test && pnpm run eval:retrieval && pnpm run eval:agent-context && pnpm run test:integration` (Postgres up).

**Constraint:** `withTransaction`'s `tx` handle supports the **simple-query methods only** (those using `this.pool.query`). The 6 `this.pool.connect()` methods (internal-transaction upserts) must NOT be called inside a `withTransaction` callback — document this and keep the fan-out limited to the simple-query methods it already uses.

---

## File Structure
**Modified:** `src/storage/store.ts` (interface + a `Queryable` type), `src/storage/postgres-store.ts` (route simple queries through `this.db`; implement `withTransaction`; tx-bound clone), `src/storage/memory-store.ts` (snapshot/restore `withTransaction`), `src/retrieval/service.ts` (wrap fan-out). **Created:** `test/store-transaction.test.ts`.

---

## Task 1: Add `withTransaction` to the `KnowledgeStore` interface

**Files:** Modify `src/storage/store.ts`.

- [ ] **Step 1: Read `src/storage/store.ts`** — find the `KnowledgeStore` interface and how methods are declared.
- [ ] **Step 2: Add the method to the interface** (place near the top of the interface, after any existing lifecycle methods):
```typescript
  /**
   * Run `fn` inside a single transaction. The `tx` handle is a store bound to one
   * connection: all of its simple-query writes commit together, or roll back if `fn`
   * throws. NOTE: only simple-query methods are transaction-safe inside `fn`; methods
   * that open their own connection (bulk upserts) must not be called here.
   */
  withTransaction<T>(fn: (tx: KnowledgeStore) => Promise<T>): Promise<T>;
```
- [ ] **Step 3: Build — expect FAILURE** in both stores (interface not yet implemented): `pnpm run build 2>&1 | tail -20`. Confirm the errors are "Property 'withTransaction' is missing in type 'PostgresKnowledgeStore'/'MemoryKnowledgeStore'". That's the TDD red for the interface.
- [ ] **Step 4: Commit** (after Tasks 2-3 make it green — do not commit a broken build alone; this step is a checkpoint, proceed to Task 2).

---

## Task 2: Implement `withTransaction` in `PostgresKnowledgeStore`

**Files:** Modify `src/storage/postgres-store.ts`.

- [ ] **Step 1: Add a `Queryable` field.** Near the top of the class, add a private query target that defaults to the pool. Read the constructor (around line 185) and the field declarations first. Add:
```typescript
  // Query target for simple (non-connect) queries. Defaults to the pool; a
  // transaction-bound clone (see withTransaction) swaps in a single client.
  private db: Pick<Pool, 'query'> = this.pool;
```
Place this AFTER `this.pool` is assigned (or initialize in the constructor right after `this.pool = new Pool(...)`).

- [ ] **Step 2: Route simple queries through `this.db`.** Replace `this.pool.query` with `this.db.query` **only** in the methods that use plain queries (NOT the 6 methods that call `this.pool.connect()` — those keep `this.pool`). The safe mechanical approach: do a global replace of `this.pool.query(` → `this.db.query(`, then re-add `this.pool` is unaffected for `.connect()`. Since `connect()`-based methods use `this.pool.connect()` (not `.query`), replacing only `.query(` is safe. Run:
```bash
grep -c "this.pool.query" src/storage/postgres-store.ts   # note the count (was 76)
```
After replace, `this.pool.query` count should be 0 and `this.db.query` count should match the old 76. `this.pool.connect` count stays 6.
> Do this carefully — it's a find/replace of `this.pool.query(` → `this.db.query(` across the file. Verify with the grep counts.

- [ ] **Step 3: Add a private transaction-bound constructor path + `withTransaction`.** The clone must share the same `pool` (so it's a real `PostgresKnowledgeStore` with all methods) but route `db` to the transaction client. Read the constructor; add an optional second parameter or a private static factory. Recommended: change the constructor to accept the sub-stores/pool so a clone can be built, OR add a private field-copy clone. Simplest robust implementation:
```typescript
  async withTransaction<T>(fn: (tx: KnowledgeStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // Build a transaction-bound view that shares this store's pool + sub-stores
    // but routes simple queries to the single client.
    const tx = Object.create(this) as PostgresKnowledgeStore;
    (tx as { db: Pick<Pool, 'query'> }).db = client;
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[postgres-store] withTransaction ROLLBACK failed.', rollbackError);
      }
      throw error;
    } finally {
      client.release();
    }
  }
```
> `Object.create(this)` makes `tx` share all of `this`'s methods and fields by prototype, then overrides only `db`. The sub-stores (`this.contextPacks` etc.) are NOT transaction-bound — but the fan-out doesn't use them, and the constraint documents this. If `Object.create` interacts badly with private fields, instead refactor the constructor to accept `(pool, db)` and `new PostgresKnowledgeStore(this.pool, client)`; pick whichever the type-checker accepts cleanly.
- [ ] **Step 4: Build** — `pnpm run build 2>&1 | tail -10`. Postgres error gone (Memory still missing — Task 3).

---

## Task 3: Implement `withTransaction` in `MemoryKnowledgeStore` (snapshot/restore)

**Files:** Modify `src/storage/memory-store.ts`.

- [ ] **Step 1: Read the class fields** — identify the in-memory collections (Maps/arrays) that the fan-out writes touch (knowledge gaps, learning proposals, knowledge, atoms). List every mutable collection field.
- [ ] **Step 2: Implement snapshot/restore `withTransaction`:**
```typescript
  async withTransaction<T>(fn: (tx: KnowledgeStore) => Promise<T>): Promise<T> {
    const snapshot = this.snapshotState();
    try {
      return await fn(this);
    } catch (error) {
      this.restoreState(snapshot);
      throw error;
    }
  }
```
- [ ] **Step 3: Add `snapshotState`/`restoreState` private helpers** that deep-copy and restore every mutable collection identified in Step 1. Use `structuredClone` for plain-data maps, or rebuild `new Map(...)` with cloned values. Example shape (adapt to actual field names):
```typescript
  private snapshotState() {
    return {
      knowledge: new Map(structuredClone([...this.knowledge])),
      gaps: structuredClone(this.gaps),
      proposals: structuredClone(this.proposals),
      atoms: new Map(structuredClone([...this.atoms])),
      // ...every collection the fan-out can mutate
    };
  }
  private restoreState(s: ReturnType<MemoryKnowledgeStore['snapshotState']>) {
    this.knowledge = s.knowledge;
    this.gaps = s.gaps;
    this.proposals = s.proposals;
    this.atoms = s.atoms;
    // ...
  }
```
> The `tx` passed to `fn` is `this` (the same store) — on success, mutations stand; on throw, the snapshot is restored. Snapshot ALL collections the fan-out methods can write, plus any they read-modify. If embeddings/vectors are stored in those maps, ensure they're cloned too. If `structuredClone` chokes on a class instance in a collection, clone field-by-field.
- [ ] **Step 4: Build clean** — `pnpm run build 2>&1 | tail -5`.

---

## Task 4: Add transaction tests

**Files:** Create `test/store-transaction.test.ts`.

- [ ] **Step 1: Write tests against `MemoryKnowledgeStore`** (deterministic, no docker):
```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('withTransaction commits on success', async () => {
  const store = new MemoryKnowledgeStore();
  const gap = await store.withTransaction(async (tx) =>
    tx.createKnowledgeGap({ project: 'p', prompt: 'x', missingSignals: [] }));
  assert.ok(gap.id);
  assert.ok(await store.getKnowledgeGap(gap.id));
});

test('withTransaction rolls back all writes on throw', async () => {
  const store = new MemoryKnowledgeStore();
  const before = await store.listKnowledgeGaps({ project: 'p', limit: 100 });
  await assert.rejects(store.withTransaction(async (tx) => {
    await tx.createKnowledgeGap({ project: 'p', prompt: 'a', missingSignals: [] });
    await tx.createKnowledgeGap({ project: 'p', prompt: 'b', missingSignals: [] });
    throw new Error('boom');
  }), /boom/);
  const after = await store.listKnowledgeGaps({ project: 'p', limit: 100 });
  assert.equal(after.length, before.length, 'no gaps should persist after rollback');
});
```
> Adapt `createKnowledgeGap`/`listKnowledgeGaps` arg shapes to the real signatures (read them). Use whatever fan-out write is simplest to assert.
- [ ] **Step 2: Run — expect PASS:** `node --test --import tsx test/store-transaction.test.ts`.
- [ ] **Step 3: Commit** Tasks 1-4 together:
```bash
git add src/storage/store.ts src/storage/postgres-store.ts src/storage/memory-store.ts test/store-transaction.test.ts
git commit -m "feat(storage): add withTransaction primitive to KnowledgeStore"
```

---

## Task 5: Wrap the feedback learning fan-out in a transaction

**Files:** Modify `src/retrieval/service.ts` (`recordFeedback` / `recordFeedbackLearning` / `recordAtomReuse`).

- [ ] **Step 1: Read `recordFeedback` (≈line 322) + `recordFeedbackLearning` + `recordAtomReuse`** to see how they call `this.store`.
- [ ] **Step 2: Route the learning writes through `withTransaction`.** The cleanest minimal change: in `recordFeedbackLearning` and `recordAtomReuse`, replace `this.store` for the WRITE calls with a `tx` passed in. Change their signatures to accept a `tx: KnowledgeStore` and call `this.store.withTransaction(...)` around them from `recordFeedback`:
```typescript
  // in recordFeedback, after `const feedback = await this.store.recordFeedback(input);`
  await this.store.withTransaction(async (tx) => {
    await this.recordFeedbackLearning(tx, input, feedback, pack);
    await this.recordAtomReuse(tx, input, pack);
  });
```
And change `recordFeedbackLearning`/`recordAtomReuse` to take `tx: KnowledgeStore` as their first parameter and use `tx.createKnowledgeGap` / `tx.createLearningProposal` / `tx.getKnowledge` / `tx.incrementAtomReuse` / `tx.updateAtom` instead of `this.store.*`.
> `recordFeedback` itself (the FeedbackEvent insert) stays OUTSIDE the transaction — it already succeeded and is the anchor the gaps/proposals reference via `feedback.id`. Only the dependent learning writes are wrapped. Confirm `feedback.id` is available before the tx (it is).
- [ ] **Step 3: Add a failure-rollback test** to `test/store-transaction.test.ts` or a retrieval test: simulate a fan-out write throwing (e.g. a store stub whose second `createLearningProposal` rejects) and assert no partial proposals persist. Use the existing retrieval-test construction pattern for the service.
- [ ] **Step 4: Verify gate:**
```bash
pnpm run build && node --test --import tsx test/store-transaction.test.ts && pnpm run eval:retrieval 2>&1 | tail -3 && pnpm test 2>&1 | tail -5
```
- [ ] **Step 5: Commit:**
```bash
git add src/retrieval/service.ts test/store-transaction.test.ts
git commit -m "fix(retrieval): run feedback-learning fan-out in a transaction"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full gate** incl. integration (Postgres exercises the real BEGIN/COMMIT/ROLLBACK):
```bash
pnpm run build && pnpm test && pnpm run eval:retrieval && pnpm run eval:agent-context && pnpm run test:integration
```
- [ ] **Step 2: Confirm query routing:** `grep -c "this.pool.query" src/storage/postgres-store.ts` → 0; `grep -c "this.db.query" src/storage/postgres-store.ts` → matches old count; `grep -c "this.pool.connect" src/storage/postgres-store.ts` → 6 (unchanged).
- [ ] **Step 3: Scope check:** `git diff --stat refactor/plan3-techdebt..HEAD`.

---

## Self-Review (plan author)
- **Coverage:** interface (T1), Postgres impl + query routing (T2), Memory snapshot/restore (T3), tests (T4), service wrap (T5), verify (T6). Matches P4-2 "add withTransaction" decision.
- **Hazards addressed:** nested transactions avoided (fan-out uses only simple-query methods; constraint documented); `recordFeedback` anchor insert stays outside the tx; Memory rollback via state snapshot; `this.pool.connect` methods untouched.
- **Risk to watch:** the `this.pool.query`→`this.db.query` global replace (T2 Step 2) must not touch `this.pool.connect`; verified by grep counts. `Object.create(this)` clone must preserve private fields/methods — fallback to a constructor-based clone if tsc complains.
- **Eval-safety:** no scoring/ranking change; the wrap only alters failure atomicity. Eval is a gate in T5/T6.
