# P4-1 — Split PostgresKnowledgeStore (incremental sub-store extraction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Shrink the 3605-line `postgres-store.ts` god-class by extracting cohesive, transaction-safe domains into sub-stores under `src/storage/postgres/`, following the existing delegation pattern — without changing any behavior and without breaking P4-2's `withTransaction`.

**Architecture:** Mirror the existing `PostgresContextStore`/`PostgresBackupStore`/`PostgresLabelStore` pattern: each sub-store takes `private readonly pool: Pool`, owns its domain's queries, and `PostgresKnowledgeStore` constructs it and delegates its interface methods to it. Extract **source-sync**, **relations**, and **agent-sessions** (none are used inside `withTransaction`). Knowledge/gaps/proposals/atoms/conflicts stay on the main store.

**Tech Stack:** TypeScript (NodeNext), `pg`, `node --test`.

**Branch:** `refactor/plan4-split-postgres-store` (created, stacked on `refactor/plan4-nonnull-guards`).

**Verify gate:** `pnpm run build && pnpm test && pnpm run eval:retrieval && pnpm run test:integration` (Postgres up) after EACH task.

## Hard constraints
- **Do NOT extract** `createKnowledgeGap`, `createLearningProposal`, `getKnowledge`, `updateKnowledge`, `updateAtom`, `incrementAtomReuse`, `getAtom`, or any method called inside `withTransaction`'s fan-out — they must stay on the main store so the `Object.create(this)` + `this.db` rebind keeps routing them to the transaction client.
- Sub-stores use `this.pool` directly (consistent with existing sub-stores). None of the extracted methods participate in `withTransaction`, so this is correct.
- Behavior must be byte-identical: move method bodies verbatim; only `this.pool`/`this.db` → the sub-store's `this.pool`, and shared helpers (`projectIdByName`, `ensureProject`, `mapSourceFileRow`, `toIso`, `isPersistedKnowledgeId`) must be available to the sub-store (import the module-level ones; for instance-method helpers, either duplicate the small private helper or pass via constructor — prefer importing module-level helpers).
- One sub-store per task/commit; full verify gate green between each.

---

## Task 1: Extract `PostgresSourceSyncStore` (source files + sync runs)

**Methods to move** (verbatim bodies): `upsertSourceFile`, `listSourceFiles`, `getSourceFile` (if present), `createSyncRun`, `getSyncRun`, `markSyncRunApplied`, plus the private mappers `mapSourceFileRow`/`mapSyncRunRow`. (Use `grep -n` to find the exact current set in the source-file/sync-run region ~lines 245-440.)

**Files:** Create `src/storage/postgres/source-sync-store.ts`; Modify `src/storage/postgres-store.ts`.

- [ ] **Step 1: Read the full method bodies** for every method listed above + the helpers they call (`projectIdByName`, `ensureProject`, `toIso`, `isPersistedKnowledgeId`). Note which helpers are module-level functions (importable) vs instance methods.
- [ ] **Step 2: Create `src/storage/postgres/source-sync-store.ts`** following `context-store.ts`'s shape:
```typescript
import type { Pool } from 'pg';
import type { /* SourceFileRecord, SyncRunRecord, *Input, *Options */ } from '../../types.js';
import { isPersistedKnowledgeId } from '../../util/uuid.js';
// import module-level helpers (toIso, etc.) if exported; otherwise re-declare the tiny private ones here

export class PostgresSourceSyncStore {
  constructor(private readonly pool: Pool) {}
  // paste the method bodies verbatim, changing `this.db.query`/`this.pool.query` → `this.pool.query`
  // and `this.ensureProject(this.db|this.pool, ...)` → a local projectId helper on this.pool
}
```
> `projectIdByName`/`ensureProject` are private instance methods on the main store. The cleanest move: extract them to a shared module (`src/storage/postgres/project-helpers.ts`) exporting `projectIdByName(db, name)` / `ensureProject(db, name)` taking a `Queryable`, and have BOTH the main store and the new sub-store import them. If that's too broad, duplicate the tiny helper privately in the sub-store. Prefer the shared module. (`toIso` similarly — export it from a shared `row-helpers.ts` or re-declare.)
- [ ] **Step 3: Delete the moved methods from `postgres-store.ts`; construct + delegate.** Add `private readonly sourceSync: PostgresSourceSyncStore;` and `this.sourceSync = new PostgresSourceSyncStore(this.pool);` in the constructor. Replace each moved method with a one-line delegation, e.g.:
```typescript
  upsertSourceFile(input: UpsertSourceFileInput): Promise<SourceFileRecord> {
    return this.sourceSync.upsertSourceFile(input);
  }
```
Keep the exact public signatures (the `KnowledgeStore` interface is unchanged).
- [ ] **Step 4: Verify gate** — `pnpm run build && pnpm test && pnpm run eval:retrieval && pnpm run test:integration`. Source-sync has integration coverage; confirm green.
- [ ] **Step 5: Commit:**
```bash
git add src/storage/postgres/source-sync-store.ts src/storage/postgres/project-helpers.ts src/storage/postgres-store.ts
git commit -m "refactor(storage): extract PostgresSourceSyncStore"
```

---

## Task 2: Extract `PostgresRelationStore` (knowledge relations)

**Methods to move:** `listKnowledgeRelations`, `getKnowledgeRelation`, `createKnowledgeRelation`, `updateKnowledgeRelation`, `deleteKnowledgeRelation`, `expireRelationsFromKnowledge`, `insertKnowledgeRelation`, and the relation row mapper(s) (`mapRelationRow`, `relationSelect`). Confirm NONE are called inside `withTransaction` (they aren't) — but note `createKnowledge`/`updateKnowledge` (which STAY on main) call `insertKnowledgeRelation`/`expireRelationsFromKnowledge`; if so, those helpers must remain callable from main. **Decision:** if a relation helper is used by a method that stays on main, keep that helper on main (or in the shared module), and only move the standalone relation CRUD. Verify call sites with `grep` before moving each.

**Files:** Create `src/storage/postgres/relation-store.ts`; Modify `src/storage/postgres-store.ts`.

- [ ] **Step 1: `grep -n "insertKnowledgeRelation\|expireRelationsFromKnowledge\|mapRelationRow\|relationSelect"` across `src/`** to map cross-usage. Move only what's safe; leave shared helpers where both need them (shared module).
- [ ] **Step 2: Create the sub-store** (same shape as Task 1) with the standalone relation CRUD methods.
- [ ] **Step 3: Delegate** from the main store (construct + one-line delegations), keeping signatures identical.
- [ ] **Step 4: Verify gate** (relations have integration + unit coverage).
- [ ] **Step 5: Commit:** `git commit -m "refactor(storage): extract PostgresRelationStore"`

---

## Task 3: Extract `PostgresAgentSessionStore` (sessions + decisions + replays)

**Methods to move:** `createAgentSession`, `listAgentSessions`, `getAgentSession`, `updateAgentSession`/`finishAgentSession` (whatever exists), `recordAgentDecision`/`listAgentDecisions`, session-replay read/write if co-located. Confirm none are in the `withTransaction` fan-out (they aren't).

**Files:** Create `src/storage/postgres/agent-session-store.ts`; Modify `src/storage/postgres-store.ts`.

- [ ] **Step 1: grep + read** all agent-session/decision/replay methods and their helpers.
- [ ] **Step 2: Create the sub-store**, move bodies verbatim, keep the `getAgentSession` uuid guard.
- [ ] **Step 3: Delegate** from main; identical signatures.
- [ ] **Step 4: Verify gate** (agent-session tests + integration).
- [ ] **Step 5: Commit:** `git commit -m "refactor(storage): extract PostgresAgentSessionStore"`

---

## Task 4: Final verification

- [ ] **Step 1:** Full gate incl. integration.
- [ ] **Step 2:** `wc -l src/storage/postgres-store.ts` — confirm a meaningful reduction from 3605.
- [ ] **Step 3:** Confirm `withTransaction` still works: `node --test --import tsx test/store-transaction.test.ts` + the integration rollback test. (The fan-out methods stayed on main, so this MUST still pass — it's the key regression check for the split.)
- [ ] **Step 4:** `grep -c "this.pool.connect" src/storage/postgres-store.ts` and confirm the 6 internal-tx upserts + withTransaction (7) are intact or correctly moved with their domain.

---

## Self-Review (plan author)
- **Coverage:** extracts 3 cohesive tx-safe domains (source-sync, relations, sessions); explicitly excludes the withTransaction fan-out methods (constraint) so P4-2 atomicity is preserved — verified by Task 4 Step 3.
- **Behavior preservation:** verbatim body moves + one-line delegations + identical signatures; shared helpers (`projectIdByName`/`ensureProject`/`toIso`) extracted to a shared module rather than duplicated where practical.
- **Risk:** production store; mitigated by one-sub-store-per-commit + full integration gate between each, and the explicit transaction regression check.
- **Not exhaustive:** knowledge/gaps/proposals/atoms/conflicts remain on main (gaps/proposals/atoms are tx-touched; conflicts left for a later pass to bound this PR). This is a meaningful first reduction, not a complete decomposition.
