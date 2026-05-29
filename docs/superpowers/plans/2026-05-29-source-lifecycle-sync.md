# Source Lifecycle Sync (P0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `SourceSyncService` that detects added/changed/renamed/deleted files in a project, produces a reviewable `SyncPlan`, and applies it (ingest / re-ingest / re-point / archive-as-tombstone) behind CLI, MCP, and git-hook wrappers — so retrieval never serves knowledge for files that no longer exist.

**Architecture:** One engine (`src/source-sync/`) produces a `SyncPlan` and applies it. Detection is git-first (`git ls-files` + `git diff -M`) with a filesystem-walk fallback. A new `source_files` ledger (one row per path) plus a `sync_runs` audit table back it. Deleted-file knowledge is archived (status → `archived`) not hard-deleted; retrieval already filters `status='approved'`, so archived items drop out automatically while staying resurrectable. CLI/MCP/git-hook are thin wrappers; additive ops may auto-apply, archives always require human/agent confirmation.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 22 `node:test`, Postgres (pgvector) via `pg`, `execFile` for git, existing `IngestionService` + `KnowledgeStore` interface (`MemoryKnowledgeStore` for tests, `PostgresKnowledgeStore` for prod).

**Spec:** `docs/superpowers/specs/2026-05-29-project-knowledge-lifecycle-p0-source-sync-design.md`

**Branch:** `feat/source-lifecycle-sync` (already created; spec committed at `bd40d88`).

---

## Conventions for every task

- Node may be older in the shell. Prefix test/build commands when needed:
  `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH`
- Run a single test file: `node --test --import tsx test/<file>.test.ts`
- All new source imports use `.js` specifiers (ESM), matching the codebase.
- Never add `console.log`/`process.stdout.write` in the MCP code path — diagnostics go to stderr.
- After any change touching retrieval/classifier/fusion/context-fit, `pnpm run eval:retrieval` must stay green.

---

## File structure (created/modified)

**Created**
- `migrations/011_source_files.sql` — ledger + audit tables + indexes.
- `src/source-sync/types.ts` — `SyncPlan`, `SourceFileRecord`, `SyncRunRecord`, change-entry types.
- `src/source-sync/policy.ts` — file-selection (include/exclude/size/binary) policy + defaults.
- `src/source-sync/git-inventory.ts` — git-mode inventory + diff (rename detection).
- `src/source-sync/fs-inventory.ts` — filesystem-walk fallback inventory + content-hash diff.
- `src/source-sync/plan.ts` — pure plan builder (inventory diff + ledger → `SyncPlan`).
- `src/source-sync/apply.ts` — applies a `SyncPlan` (ingest/re-ingest/re-point/archive).
- `src/source-sync/service.ts` — `SourceSyncService` orchestrator (`sync`, `apply`).
- `bin/commands/sync.ts` — `tuberosa sync` + `tuberosa hook install` CLI commands.
- Test files: `test/source-sync-policy.test.ts`, `test/source-sync-git-inventory.test.ts`, `test/source-sync-fs-inventory.test.ts`, `test/source-sync-plan.test.ts`, `test/source-sync-apply.test.ts`, `test/source-sync-service.test.ts`, `test/source-sync-store.test.ts`, `test/source-sync-roundtrip.test.ts`.

**Modified**
- `src/storage/store.ts` — extend `KnowledgeStore` with ledger/audit/query methods + new input types.
- `src/storage/memory-store.ts` — implement the new methods.
- `src/storage/postgres-store.ts` — implement the new methods.
- `bin/tuberosa.ts` — dispatch `sync` and `hook`.
- `bin/commands/parser.ts` — recognize the new commands/flags (only if it enumerates commands).
- `src/mcp/server.ts` — add `tuberosa_sync_sources` case + tool definition.
- `src/operations/workbench-summary.ts` — add Source Health counts + tombstone list.
- `eval/retrieval-fixtures.json` — add a deleted-then-archived freshness fixture.

---

## Task 1: Migration — ledger + audit tables

**Files:**
- Create: `migrations/011_source_files.sql`
- Test: `test/source-sync-store.test.ts` (added in Task 3; migration itself is exercised by `pnpm run test:integration`)

- [ ] **Step 1: Write the migration**

Create `migrations/011_source_files.sql`:

```sql
-- P0 Source Lifecycle Sync: per-path ledger + sync audit.

CREATE TABLE IF NOT EXISTS source_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path text NOT NULL,
  content_hash text,
  status text NOT NULL DEFAULT 'tracked',
  last_synced_sha text,
  prior_paths text[] NOT NULL DEFAULT '{}',
  knowledge_count integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (project_id, path),
  CHECK (status IN ('tracked','changed','missing','archived','ignored'))
);

CREATE INDEX IF NOT EXISTS idx_source_files_project_status
  ON source_files (project_id, status);

CREATE TABLE IF NOT EXISTS sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode text NOT NULL,
  from_sha text,
  to_sha text,
  plan jsonb NOT NULL,
  applied boolean NOT NULL DEFAULT false,
  trigger text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CHECK (mode IN ('git','fs')),
  CHECK (trigger IN ('cli','mcp','git_hook'))
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_project
  ON sync_runs (project_id, created_at DESC);

-- Tombstone lookups: find archived knowledge for a dead source path quickly.
CREATE INDEX IF NOT EXISTS idx_knowledge_items_archived
  ON knowledge_items (project_id) WHERE status = 'archived';
```

- [ ] **Step 2: Verify it parses (syntax check via the migration runner against a live DB)**

Run (only if Docker stack is up): `pnpm run migrate`
Expected: `Applied 011_source_files.sql` printed; re-running is idempotent (no error — guarded by `IF NOT EXISTS`).
If Docker is down, skip — Task 3 integration tests will exercise it. Note: `knowledge_items.status` has no CHECK constraint in `001_init.sql`, so `'archived'` is already a legal value; no ALTER needed.

- [ ] **Step 3: Commit**

```bash
git add migrations/011_source_files.sql
git commit -m "feat(source-sync): add source_files ledger + sync_runs migration"
```

---

## Task 2: Core types

**Files:**
- Create: `src/source-sync/types.ts`

- [ ] **Step 1: Write the types**

Create `src/source-sync/types.ts`:

```ts
import type { KnowledgeItemType } from '../types.js';

export type SyncMode = 'git' | 'fs';
export type SyncTrigger = 'cli' | 'mcp' | 'git_hook';

export type SourceFileStatus = 'tracked' | 'changed' | 'missing' | 'archived' | 'ignored';

/** One durable row per file path — the ledger. */
export interface SourceFileRecord {
  id: string;
  project: string;
  path: string;
  contentHash: string | null;
  status: SourceFileStatus;
  lastSyncedSha: string | null;
  priorPaths: string[];
  knowledgeCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  archivedAt: string | null;
  metadata: Record<string, unknown>;
}

/** A single file as seen on disk during inventory. */
export interface InventoryEntry {
  path: string;
  contentHash: string;
  sizeBytes: number;
}

export type IgnoreReason = 'gitignored' | 'excluded' | 'too_large' | 'binary';

export interface SyncPlan {
  project: string;
  repoPath: string;
  mode: SyncMode;
  fromSha?: string;
  toSha?: string;
  added: Array<{ path: string; sizeBytes: number; willIngestAs: KnowledgeItemType }>;
  changed: Array<{ path: string; oldHash: string; newHash: string; knowledgeIds: string[] }>;
  renamed: Array<{ from: string; to: string; similarity: number }>;
  deleted: Array<{ path: string; knowledgeIds: string[]; atomIds: string[]; chunkCount: number }>;
  ignored: Array<{ path: string; reason: IgnoreReason }>;
  summary: { added: number; changed: number; renamed: number; deleted: number; ignored: number };
  destructive: boolean;
}

export interface SyncRunRecord {
  id: string;
  project: string;
  mode: SyncMode;
  fromSha: string | null;
  toSha: string | null;
  plan: SyncPlan;
  applied: boolean;
  trigger: SyncTrigger;
  createdAt: string;
  appliedAt: string | null;
}

/** Result of applying a plan. */
export interface ApplyResult {
  ingested: number;
  reingested: number;
  repointed: number;
  archived: number;
  skipped: Array<{ path: string; reason: 'hash_mismatch' | 'missing_on_disk' }>;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH npx tsc --noEmit -p tsconfig.json`
Expected: no errors referencing `src/source-sync/types.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/source-sync/types.ts
git commit -m "feat(source-sync): core SyncPlan + ledger types"
```

---

## Task 3: Store interface + ledger/audit methods

**Files:**
- Modify: `src/storage/store.ts` (add types + 7 methods to `KnowledgeStore`)
- Modify: `src/storage/memory-store.ts`
- Modify: `src/storage/postgres-store.ts`
- Test: `test/source-sync-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/source-sync-store.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('source ledger: upsert is per-path and updates in place', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.upsertSourceFile({
    project: 'p', path: 'src/a.ts', contentHash: 'h1', status: 'tracked', lastSyncedSha: 'sha1',
  });
  assert.equal(a.path, 'src/a.ts');
  assert.equal(a.contentHash, 'h1');

  const b = await store.upsertSourceFile({
    project: 'p', path: 'src/a.ts', contentHash: 'h2', status: 'changed', lastSyncedSha: 'sha2',
  });
  assert.equal(b.id, a.id, 'same path → same ledger row');
  assert.equal(b.contentHash, 'h2');

  const all = await store.listSourceFiles({ project: 'p', limit: 50 });
  assert.equal(all.length, 1);
});

test('source ledger: rename re-points path and records prior_paths', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'old.ts', contentHash: 'h', status: 'tracked' });
  const moved = await store.renameSourceFile({ project: 'p', from: 'old.ts', to: 'new.ts' });
  assert.equal(moved?.path, 'new.ts');
  assert.deepEqual(moved?.priorPaths, ['old.ts']);
  const byOld = await store.getSourceFile({ project: 'p', path: 'old.ts' });
  assert.equal(byOld, undefined);
});

test('sync_runs: create then mark applied', async () => {
  const store = new MemoryKnowledgeStore();
  const plan = {
    project: 'p', repoPath: '/r', mode: 'git' as const,
    added: [], changed: [], renamed: [], deleted: [], ignored: [],
    summary: { added: 0, changed: 0, renamed: 0, deleted: 0, ignored: 0 }, destructive: false,
  };
  const run = await store.createSyncRun({ project: 'p', mode: 'git', plan, trigger: 'cli' });
  assert.equal(run.applied, false);
  const fetched = await store.getSyncRun(run.id);
  assert.equal(fetched?.id, run.id);
  const applied = await store.markSyncRunApplied(run.id);
  assert.equal(applied?.applied, true);
  assert.ok(applied?.appliedAt);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test --import tsx test/source-sync-store.test.ts`
Expected: FAIL — `store.upsertSourceFile is not a function`.

- [ ] **Step 3: Add interface types + methods to `src/storage/store.ts`**

Add near the other input interfaces:

```ts
export interface UpsertSourceFileInput {
  project: string;
  path: string;
  contentHash: string | null;
  status?: SourceFileStatus;
  lastSyncedSha?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListSourceFilesOptions {
  project?: string;
  status?: SourceFileStatus;
  limit: number;
}

export interface RenameSourceFileInput {
  project: string;
  from: string;
  to: string;
}

export interface CreateSyncRunInput {
  project: string;
  mode: SyncMode;
  plan: SyncPlan;
  trigger: SyncTrigger;
  fromSha?: string | null;
  toSha?: string | null;
}
```

Add the import at the top of `store.ts`:

```ts
import type { SourceFileRecord, SourceFileStatus, SyncMode, SyncPlan, SyncRunRecord, SyncTrigger } from '../source-sync/types.js';
```

Add to the `KnowledgeStore` interface (after `deleteStaleFileAtoms`):

```ts
  // --- Source lifecycle sync (P0) ---
  upsertSourceFile(input: UpsertSourceFileInput): Promise<SourceFileRecord>;
  getSourceFile(options: { project: string; path: string }): Promise<SourceFileRecord | undefined>;
  listSourceFiles(options: ListSourceFilesOptions): Promise<SourceFileRecord[]>;
  renameSourceFile(input: RenameSourceFileInput): Promise<SourceFileRecord | undefined>;
  setSourceFileStatus(options: { project: string; path: string; status: SourceFileStatus }): Promise<SourceFileRecord | undefined>;
  listKnowledgeBySourcePath(options: { project: string; path: string }): Promise<StoredKnowledge[]>;
  createSyncRun(input: CreateSyncRunInput): Promise<SyncRunRecord>;
  getSyncRun(id: string): Promise<SyncRunRecord | undefined>;
  markSyncRunApplied(id: string): Promise<SyncRunRecord | undefined>;
```

- [ ] **Step 4: Implement in `src/storage/memory-store.ts`**

Add fields + methods to the class (use an incrementing id via the store's existing id helper — `MemoryKnowledgeStore` uses `crypto.randomUUID()`; match whatever the file already uses, e.g. `randomUUID()` already imported):

```ts
  private readonly sourceFiles = new Map<string, SourceFileRecord>(); // key: `${project} ${path}`
  private readonly syncRuns = new Map<string, SyncRunRecord>();

  private sourceKey(project: string, path: string): string {
    return `${project} ${path}`;
  }

  async upsertSourceFile(input: UpsertSourceFileInput): Promise<SourceFileRecord> {
    const key = this.sourceKey(input.project, input.path);
    const now = new Date().toISOString();
    const existing = this.sourceFiles.get(key);
    const record: SourceFileRecord = existing
      ? { ...existing, contentHash: input.contentHash, status: input.status ?? existing.status,
          lastSyncedSha: input.lastSyncedSha ?? existing.lastSyncedSha,
          metadata: input.metadata ?? existing.metadata, lastSeenAt: now }
      : { id: randomUUID(), project: input.project, path: input.path, contentHash: input.contentHash,
          status: input.status ?? 'tracked', lastSyncedSha: input.lastSyncedSha ?? null, priorPaths: [],
          knowledgeCount: 0, firstSeenAt: now, lastSeenAt: now, archivedAt: null, metadata: input.metadata ?? {} };
    this.sourceFiles.set(key, record);
    return { ...record };
  }

  async getSourceFile(options: { project: string; path: string }): Promise<SourceFileRecord | undefined> {
    const r = this.sourceFiles.get(this.sourceKey(options.project, options.path));
    return r ? { ...r } : undefined;
  }

  async listSourceFiles(options: ListSourceFilesOptions): Promise<SourceFileRecord[]> {
    return [...this.sourceFiles.values()]
      .filter((r) => (!options.project || r.project === options.project) && (!options.status || r.status === options.status))
      .slice(0, options.limit)
      .map((r) => ({ ...r }));
  }

  async renameSourceFile(input: RenameSourceFileInput): Promise<SourceFileRecord | undefined> {
    const fromKey = this.sourceKey(input.project, input.from);
    const record = this.sourceFiles.get(fromKey);
    if (!record) return undefined;
    this.sourceFiles.delete(fromKey);
    const moved: SourceFileRecord = { ...record, path: input.to, priorPaths: [...record.priorPaths, input.from],
      lastSeenAt: new Date().toISOString() };
    this.sourceFiles.set(this.sourceKey(input.project, input.to), moved);
    return { ...moved };
  }

  async setSourceFileStatus(options: { project: string; path: string; status: SourceFileStatus }): Promise<SourceFileRecord | undefined> {
    const key = this.sourceKey(options.project, options.path);
    const record = this.sourceFiles.get(key);
    if (!record) return undefined;
    const updated: SourceFileRecord = { ...record, status: options.status,
      archivedAt: options.status === 'archived' ? new Date().toISOString() : record.archivedAt };
    this.sourceFiles.set(key, updated);
    return { ...updated };
  }

  async listKnowledgeBySourcePath(options: { project: string; path: string }): Promise<StoredKnowledge[]> {
    const all = await this.listKnowledge({ project: options.project, limit: 10_000, review: true });
    return all.filter((k) => (k.metadata as Record<string, unknown> | undefined)?.['sourcePath'] === options.path);
  }

  async createSyncRun(input: CreateSyncRunInput): Promise<SyncRunRecord> {
    const run: SyncRunRecord = { id: randomUUID(), project: input.project, mode: input.mode,
      fromSha: input.fromSha ?? null, toSha: input.toSha ?? null, plan: input.plan, applied: false,
      trigger: input.trigger, createdAt: new Date().toISOString(), appliedAt: null };
    this.syncRuns.set(run.id, run);
    return { ...run };
  }

  async getSyncRun(id: string): Promise<SyncRunRecord | undefined> {
    const r = this.syncRuns.get(id);
    return r ? { ...r } : undefined;
  }

  async markSyncRunApplied(id: string): Promise<SyncRunRecord | undefined> {
    const r = this.syncRuns.get(id);
    if (!r) return undefined;
    const updated = { ...r, applied: true, appliedAt: new Date().toISOString() };
    this.syncRuns.set(id, updated);
    return { ...updated };
  }
```

Add the type imports to the top of `memory-store.ts`:

```ts
import type {
  UpsertSourceFileInput, ListSourceFilesOptions, RenameSourceFileInput, CreateSyncRunInput,
} from './store.js';
import type { SourceFileRecord, SourceFileStatus, SyncRunRecord } from '../source-sync/types.js';
```

(If `randomUUID` is not already imported, add `import { randomUUID } from 'node:crypto';`.)

- [ ] **Step 5: Run the memory-store test to verify it passes**

Run: `node --test --import tsx test/source-sync-store.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 6: Implement the same methods in `src/storage/postgres-store.ts`**

Add the type imports (alongside the existing `StaleFileAtomCleanupInput` import) and implement against the new tables. Map snake_case → camelCase with a private `mapSourceFileRow`:

```ts
  private mapSourceFileRow(row: any): SourceFileRecord {
    return {
      id: row.id, project: row.project_name, path: row.path, contentHash: row.content_hash,
      status: row.status, lastSyncedSha: row.last_synced_sha, priorPaths: row.prior_paths ?? [],
      knowledgeCount: row.knowledge_count ?? 0, firstSeenAt: row.first_seen_at?.toISOString?.() ?? row.first_seen_at,
      lastSeenAt: row.last_seen_at?.toISOString?.() ?? row.last_seen_at,
      archivedAt: row.archived_at ? (row.archived_at.toISOString?.() ?? row.archived_at) : null,
      metadata: row.metadata ?? {},
    };
  }

  async upsertSourceFile(input: UpsertSourceFileInput): Promise<SourceFileRecord> {
    const projectId = await this.ensureProjectByName(input.project);
    const { rows } = await this.pool.query(
      `INSERT INTO source_files (project_id, path, content_hash, status, last_synced_sha, metadata, last_seen_at)
       VALUES ($1,$2,$3,COALESCE($4,'tracked'),$5,COALESCE($6,'{}'::jsonb), now())
       ON CONFLICT (project_id, path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         status = COALESCE($4, source_files.status),
         last_synced_sha = COALESCE($5, source_files.last_synced_sha),
         metadata = COALESCE($6, source_files.metadata),
         last_seen_at = now()
       RETURNING *, (SELECT name FROM projects WHERE id = project_id) AS project_name`,
      [projectId, input.path, input.contentHash, input.status ?? null, input.lastSyncedSha ?? null, input.metadata ?? null],
    );
    return this.mapSourceFileRow(rows[0]);
  }

  async getSourceFile(options: { project: string; path: string }): Promise<SourceFileRecord | undefined> {
    const { rows } = await this.pool.query(
      `SELECT sf.*, p.name AS project_name FROM source_files sf JOIN projects p ON p.id = sf.project_id
       WHERE p.name = $1 AND sf.path = $2`, [options.project, options.path]);
    return rows[0] ? this.mapSourceFileRow(rows[0]) : undefined;
  }

  async listSourceFiles(options: ListSourceFilesOptions): Promise<SourceFileRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT sf.*, p.name AS project_name FROM source_files sf JOIN projects p ON p.id = sf.project_id
       WHERE ($1::text IS NULL OR p.name = $1) AND ($2::text IS NULL OR sf.status = $2)
       ORDER BY sf.path LIMIT $3`,
      [options.project ?? null, options.status ?? null, options.limit]);
    return rows.map((r) => this.mapSourceFileRow(r));
  }

  async renameSourceFile(input: RenameSourceFileInput): Promise<SourceFileRecord | undefined> {
    const { rows } = await this.pool.query(
      `UPDATE source_files sf SET path = $3, prior_paths = array_append(prior_paths, $2), last_seen_at = now()
       FROM projects p WHERE p.id = sf.project_id AND p.name = $1 AND sf.path = $2
       RETURNING sf.*, p.name AS project_name`,
      [input.project, input.from, input.to]);
    return rows[0] ? this.mapSourceFileRow(rows[0]) : undefined;
  }

  async setSourceFileStatus(options: { project: string; path: string; status: SourceFileStatus }): Promise<SourceFileRecord | undefined> {
    const { rows } = await this.pool.query(
      `UPDATE source_files sf SET status = $3, archived_at = CASE WHEN $3 = 'archived' THEN now() ELSE archived_at END
       FROM projects p WHERE p.id = sf.project_id AND p.name = $1 AND sf.path = $2
       RETURNING sf.*, p.name AS project_name`,
      [options.project, options.path, options.status]);
    return rows[0] ? this.mapSourceFileRow(rows[0]) : undefined;
  }

  async listKnowledgeBySourcePath(options: { project: string; path: string }): Promise<StoredKnowledge[]> {
    const { rows } = await this.pool.query(
      `SELECT ki.id FROM knowledge_items ki JOIN projects p ON p.id = ki.project_id
       WHERE p.name = $1 AND ki.metadata->>'sourcePath' = $2`, [options.project, options.path]);
    const out: StoredKnowledge[] = [];
    for (const r of rows) { const k = await this.getKnowledge(r.id); if (k) out.push(k); }
    return out;
  }

  async createSyncRun(input: CreateSyncRunInput): Promise<SyncRunRecord> {
    const projectId = await this.ensureProjectByName(input.project);
    const { rows } = await this.pool.query(
      `INSERT INTO sync_runs (project_id, mode, from_sha, to_sha, plan, trigger)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *, (SELECT name FROM projects WHERE id = project_id) AS project_name`,
      [projectId, input.mode, input.fromSha ?? null, input.toSha ?? null, JSON.stringify(input.plan), input.trigger]);
    return this.mapSyncRunRow(rows[0]);
  }

  async getSyncRun(id: string): Promise<SyncRunRecord | undefined> {
    const { rows } = await this.pool.query(
      `SELECT sr.*, p.name AS project_name FROM sync_runs sr JOIN projects p ON p.id = sr.project_id WHERE sr.id = $1`, [id]);
    return rows[0] ? this.mapSyncRunRow(rows[0]) : undefined;
  }

  async markSyncRunApplied(id: string): Promise<SyncRunRecord | undefined> {
    const { rows } = await this.pool.query(
      `UPDATE sync_runs sr SET applied = true, applied_at = now() FROM projects p
       WHERE p.id = sr.project_id AND sr.id = $1 RETURNING sr.*, p.name AS project_name`, [id]);
    return rows[0] ? this.mapSyncRunRow(rows[0]) : undefined;
  }

  private mapSyncRunRow(row: any): SyncRunRecord {
    return { id: row.id, project: row.project_name, mode: row.mode, fromSha: row.from_sha, toSha: row.to_sha,
      plan: typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan, applied: row.applied,
      trigger: row.trigger, createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      appliedAt: row.applied_at ? (row.applied_at.toISOString?.() ?? row.applied_at) : null };
  }
```

Note on `ensureProjectByName`: if a private project-lookup-by-name helper does not already exist, add one mirroring the existing `ensureProject(client, name)` used in `upsertSource` but operating on `this.pool` and returning the project id, creating the project row if absent.

- [ ] **Step 7: Build to confirm both stores satisfy the interface**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Expected: clean compile (no "missing method" errors on either store).

- [ ] **Step 8: Commit**

```bash
git add src/storage/store.ts src/storage/memory-store.ts src/storage/postgres-store.ts test/source-sync-store.test.ts
git commit -m "feat(source-sync): ledger + sync_runs store methods (memory + postgres)"
```

---

## Task 4: File-selection policy

**Files:**
- Create: `src/source-sync/policy.ts`
- Test: `test/source-sync-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/source-sync-policy.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyPath, DEFAULT_SYNC_POLICY } from '../src/source-sync/policy.js';

test('policy: source + docs are included', () => {
  assert.equal(classifyPath('src/a.ts', 10, DEFAULT_SYNC_POLICY).include, true);
  assert.equal(classifyPath('docs/x.md', 10, DEFAULT_SYNC_POLICY).include, true);
});

test('policy: lockfiles, dist, env, binaries are excluded with a reason', () => {
  assert.deepEqual(classifyPath('pnpm-lock.yaml', 10, DEFAULT_SYNC_POLICY), { include: false, reason: 'excluded' });
  assert.deepEqual(classifyPath('dist/a.js', 10, DEFAULT_SYNC_POLICY), { include: false, reason: 'excluded' });
  assert.deepEqual(classifyPath('.env', 10, DEFAULT_SYNC_POLICY), { include: false, reason: 'excluded' });
  assert.deepEqual(classifyPath('img/logo.png', 10, DEFAULT_SYNC_POLICY), { include: false, reason: 'binary' });
});

test('policy: oversized files are ignored as too_large', () => {
  assert.deepEqual(classifyPath('src/big.ts', 999_999_999, DEFAULT_SYNC_POLICY), { include: false, reason: 'too_large' });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test --import tsx test/source-sync-policy.test.ts`
Expected: FAIL — cannot find module `policy.js`.

- [ ] **Step 3: Implement `src/source-sync/policy.ts`**

```ts
import type { IgnoreReason } from './types.js';

export interface SyncPolicy {
  excludeGlobs: string[];      // matched against the repo-relative path
  binaryExtensions: string[];  // lowercased, no dot
  maxContentBytes: number;
}

export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  excludeGlobs: [
    'dist/', 'build/', 'node_modules/', 'coverage/', '.tuberosa/', '.git/',
    'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
    '.env', '.env.*',
  ],
  binaryExtensions: ['png','jpg','jpeg','gif','webp','ico','pdf','zip','gz','tar','wasm','woff','woff2','ttf','eot','mp4','mov','exe','bin'],
  maxContentBytes: 512 * 1024,
};

export interface PathClassification {
  include: boolean;
  reason?: IgnoreReason;
}

function matchesGlob(path: string, glob: string): boolean {
  if (glob.endsWith('/')) return path === glob.slice(0, -1) || path.startsWith(glob);
  if (glob.includes('*')) {
    const re = new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(path) || re.test(path.split('/').pop() ?? '');
  }
  return path === glob || (path.split('/').pop() ?? '') === glob;
}

export function classifyPath(path: string, sizeBytes: number, policy: SyncPolicy = DEFAULT_SYNC_POLICY): PathClassification {
  if (policy.excludeGlobs.some((g) => matchesGlob(path, g))) return { include: false, reason: 'excluded' };
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  if (policy.binaryExtensions.includes(ext)) return { include: false, reason: 'binary' };
  if (sizeBytes > policy.maxContentBytes) return { include: false, reason: 'too_large' };
  return { include: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/source-sync-policy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/source-sync/policy.ts test/source-sync-policy.test.ts
git commit -m "feat(source-sync): file-selection policy with default include/exclude"
```

---

## Task 5: Filesystem inventory (fallback differ)

**Files:**
- Create: `src/source-sync/fs-inventory.ts`
- Test: `test/source-sync-fs-inventory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/source-sync-fs-inventory.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkInventory } from '../src/source-sync/fs-inventory.js';
import { DEFAULT_SYNC_POLICY } from '../src/source-sync/policy.js';

test('walkInventory: returns included files with stable content hashes, flags ignored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fsinv-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lock\n');

  const { entries, ignored } = await walkInventory(root, DEFAULT_SYNC_POLICY);
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths, ['src/a.ts']);
  assert.match(entries[0].contentHash, /^[a-f0-9]{64}$/);
  assert.ok(ignored.some((i) => i.path === 'pnpm-lock.yaml' && i.reason === 'excluded'));
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test --import tsx test/source-sync-fs-inventory.test.ts`
Expected: FAIL — cannot find `fs-inventory.js`.

- [ ] **Step 3: Implement `src/source-sync/fs-inventory.ts`**

```ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { InventoryEntry, IgnoreReason } from './types.js';
import { classifyPath, type SyncPolicy } from './policy.js';

export interface InventoryResult {
  entries: InventoryEntry[];
  ignored: Array<{ path: string; reason: IgnoreReason }>;
}

export function hashContent(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function walkInventory(root: string, policy: SyncPolicy): Promise<InventoryResult> {
  const entries: InventoryEntry[] = [];
  const ignored: Array<{ path: string; reason: IgnoreReason }> = [];

  async function walk(dir: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const abs = join(dir, dirent.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (dirent.isDirectory()) {
        // Skip obviously excluded directories early to avoid descending into node_modules/.git.
        const dirClass = classifyPath(rel + '/', 0, policy);
        if (!dirClass.include && dirClass.reason === 'excluded') continue;
        await walk(abs);
        continue;
      }
      if (!dirent.isFile()) continue;
      const size = (await stat(abs)).size;
      const cls = classifyPath(rel, size, policy);
      if (!cls.include) { ignored.push({ path: rel, reason: cls.reason! }); continue; }
      const buf = await readFile(abs);
      entries.push({ path: rel, contentHash: hashContent(buf), sizeBytes: size });
    }
  }

  await walk(root);
  return { entries, ignored };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/source-sync-fs-inventory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/source-sync/fs-inventory.ts test/source-sync-fs-inventory.test.ts
git commit -m "feat(source-sync): filesystem-walk inventory fallback"
```

---

## Task 6: Git inventory + diff (rename detection)

**Files:**
- Create: `src/source-sync/git-inventory.ts`
- Test: `test/source-sync-git-inventory.test.ts`

- [ ] **Step 1: Write the failing test (real git repo in a tmpdir)**

Create `test/source-sync-git-inventory.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitDiffSince, isGitRepo, gitHeadSha } from '../src/source-sync/git-inventory.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test('gitDiffSince: classifies add / modify / rename / delete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitinv-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
  await writeFile(join(root, 'old.ts'), 'export const keep = 1;\n'.repeat(5));
  git(root, ['add', '.']); git(root, ['commit', '-q', '-m', 'c1']);
  const base = gitHeadSha(root);

  await writeFile(join(root, 'a.ts'), 'const a = 2;\n');          // modify
  await writeFile(join(root, 'b.ts'), 'const b = 1;\n');          // add
  await rename(join(root, 'old.ts'), join(root, 'new.ts'));       // rename
  await rm(join(root, 'a.ts')); // (then re-add so modify still detected — see below)
  await writeFile(join(root, 'a.ts'), 'const a = 2;\n');
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'c2']);

  assert.equal(isGitRepo(root), true);
  const diff = gitDiffSince(root, base);
  assert.ok(diff.added.includes('b.ts'));
  assert.ok(diff.modified.includes('a.ts'));
  assert.ok(diff.renamed.some((r) => r.from === 'old.ts' && r.to === 'new.ts'));
});

test('isGitRepo: false for a non-git directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nogit-'));
  assert.equal(isGitRepo(root), false);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test --import tsx test/source-sync-git-inventory.test.ts`
Expected: FAIL — cannot find `git-inventory.js`.

- [ ] **Step 3: Implement `src/source-sync/git-inventory.ts`**

```ts
import { execFileSync } from 'node:child_process';

export interface GitDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string; similarity: number }>;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function isGitRepo(cwd: string): boolean {
  try { return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; }
  catch { return false; }
}

export function gitHeadSha(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

export function gitLsFiles(cwd: string): string[] {
  return git(cwd, ['ls-files', '-z']).split(' ').filter(Boolean);
}

/** Diff between `fromSha` and HEAD with rename detection (`-M`). NUL-delimited, status-prefixed. */
export function gitDiffSince(cwd: string, fromSha: string): GitDiff {
  const out = git(cwd, ['diff', '--name-status', '-M', '-z', `${fromSha}`, 'HEAD']);
  const tokens = out.split(' ').filter((t) => t.length > 0);
  const diff: GitDiff = { added: [], modified: [], deleted: [], renamed: [] };
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (status.startsWith('R')) {
      const similarity = Number(status.slice(1)) || 100;
      const from = tokens[i++]; const to = tokens[i++];
      diff.renamed.push({ from, to, similarity });
    } else if (status.startsWith('C')) {
      i++; const to = tokens[i++]; diff.added.push(to);            // copy → treat target as add
    } else {
      const path = tokens[i++];
      if (status === 'A') diff.added.push(path);
      else if (status === 'M') diff.modified.push(path);
      else if (status === 'D') diff.deleted.push(path);
      else diff.modified.push(path);
    }
  }
  return diff;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/source-sync-git-inventory.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/source-sync/git-inventory.ts test/source-sync-git-inventory.test.ts
git commit -m "feat(source-sync): git inventory + diff with rename detection"
```

---

## Task 7: Plan builder (pure function)

**Files:**
- Create: `src/source-sync/plan.ts`
- Test: `test/source-sync-plan.test.ts`

The builder is pure: it takes a normalized change set + ledger lookups (already-fetched knowledge ids) and returns a `SyncPlan`. This keeps it trivially unit-testable with no store.

- [ ] **Step 1: Write the failing test**

Create `test/source-sync-plan.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildPlan, type ChangeSet } from '../src/source-sync/plan.js';

test('buildPlan: maps change classes and computes summary + destructive flag', () => {
  const changes: ChangeSet = {
    project: 'p', repoPath: '/r', mode: 'git', fromSha: 's1', toSha: 's2',
    added: [{ path: 'src/new.ts', sizeBytes: 20, willIngestAs: 'code_ref' }],
    changed: [{ path: 'src/a.ts', oldHash: 'h1', newHash: 'h2', knowledgeIds: ['k1'] }],
    renamed: [{ from: 'old.ts', to: 'new.ts', similarity: 98 }],
    deleted: [{ path: 'src/gone.ts', knowledgeIds: ['k2'], atomIds: ['atomA'], chunkCount: 3 }],
    ignored: [{ path: 'pnpm-lock.yaml', reason: 'excluded' }],
  };
  const plan = buildPlan(changes);
  assert.equal(plan.summary.added, 1);
  assert.equal(plan.summary.deleted, 1);
  assert.equal(plan.destructive, true, 'deletions make a plan destructive');
});

test('buildPlan: empty deletions → not destructive', () => {
  const plan = buildPlan({
    project: 'p', repoPath: '/r', mode: 'fs',
    added: [], changed: [], renamed: [], deleted: [], ignored: [],
  });
  assert.equal(plan.destructive, false);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test --import tsx test/source-sync-plan.test.ts`
Expected: FAIL — cannot find `plan.js`.

- [ ] **Step 3: Implement `src/source-sync/plan.ts`**

```ts
import type { SyncMode, SyncPlan } from './types.js';

export interface ChangeSet {
  project: string;
  repoPath: string;
  mode: SyncMode;
  fromSha?: string;
  toSha?: string;
  added: SyncPlan['added'];
  changed: SyncPlan['changed'];
  renamed: SyncPlan['renamed'];
  deleted: SyncPlan['deleted'];
  ignored: SyncPlan['ignored'];
}

export function buildPlan(changes: ChangeSet): SyncPlan {
  return {
    project: changes.project,
    repoPath: changes.repoPath,
    mode: changes.mode,
    fromSha: changes.fromSha,
    toSha: changes.toSha,
    added: changes.added,
    changed: changes.changed,
    renamed: changes.renamed,
    deleted: changes.deleted,
    ignored: changes.ignored,
    summary: {
      added: changes.added.length,
      changed: changes.changed.length,
      renamed: changes.renamed.length,
      deleted: changes.deleted.length,
      ignored: changes.ignored.length,
    },
    destructive: changes.deleted.length > 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/source-sync-plan.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/source-sync/plan.ts test/source-sync-plan.test.ts
git commit -m "feat(source-sync): pure SyncPlan builder"
```

---

## Task 8: Apply engine

**Files:**
- Create: `src/source-sync/apply.ts`
- Test: `test/source-sync-apply.test.ts`

Apply consumes a `SyncPlan` + a store + an `IngestionService` + a file reader. It ingests/re-ingests adds & changes, re-points renames, archives deletes, and re-validates content hashes for changed entries (skip on mismatch).

- [ ] **Step 1: Write the failing test**

Create `test/source-sync-apply.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { applyPlan } from '../src/source-sync/apply.js';
import { hashContent } from '../src/source-sync/fs-inventory.js';
import type { SyncPlan } from '../src/source-sync/types.js';

function newIngestion(store: MemoryKnowledgeStore): IngestionService {
  return new IngestionService(store, new HashModelProvider());
}

test('applyPlan: archives knowledge for a deleted file and excludes it from approved listing', async () => {
  const store = new MemoryKnowledgeStore();
  const ingestion = newIngestion(store);
  await ingestion.ingestFiles('p', [{ project: 'p', path: 'src/gone.ts', content: 'export const gone = 1;\n' }]);
  await store.upsertSourceFile({ project: 'p', path: 'src/gone.ts', contentHash: 'h', status: 'tracked' });

  const linked = await store.listKnowledgeBySourcePath({ project: 'p', path: 'src/gone.ts' });
  assert.ok(linked.length >= 1, 'precondition: knowledge exists for the file');

  const plan: SyncPlan = {
    project: 'p', repoPath: '/r', mode: 'git',
    added: [], changed: [], renamed: [],
    deleted: [{ path: 'src/gone.ts', knowledgeIds: linked.map((k) => k.id), atomIds: [], chunkCount: 0 }],
    ignored: [], summary: { added: 0, changed: 0, renamed: 0, deleted: 1, ignored: 0 }, destructive: true,
  };

  const reader = async () => { throw new Error('no reads expected for delete-only plan'); };
  const result = await applyPlan({ store, ingestion, plan, readFile: reader });
  assert.equal(result.archived, linked.length);

  const approved = await store.listKnowledge({ project: 'p', limit: 100 }); // defaults to status='approved'
  assert.equal(approved.find((k) => k.id === linked[0].id), undefined, 'archived item no longer in approved listing');
  const sf = await store.getSourceFile({ project: 'p', path: 'src/gone.ts' });
  assert.equal(sf?.status, 'archived');
});

test('applyPlan: ingests added files and records a ledger row', async () => {
  const store = new MemoryKnowledgeStore();
  const ingestion = newIngestion(store);
  const content = 'export const added = 1;\n';
  const plan: SyncPlan = {
    project: 'p', repoPath: '/r', mode: 'git',
    added: [{ path: 'src/added.ts', sizeBytes: content.length, willIngestAs: 'code_ref' }],
    changed: [], renamed: [], deleted: [], ignored: [],
    summary: { added: 1, changed: 0, renamed: 0, deleted: 0, ignored: 0 }, destructive: false,
  };
  const reader = async (p: string) => { assert.equal(p, 'src/added.ts'); return content; };
  const result = await applyPlan({ store, ingestion, plan, readFile: reader });
  assert.equal(result.ingested, 1);
  const sf = await store.getSourceFile({ project: 'p', path: 'src/added.ts' });
  assert.equal(sf?.contentHash, hashContent(content));
});

test('applyPlan: changed entry whose on-disk hash drifted is skipped', async () => {
  const store = new MemoryKnowledgeStore();
  const ingestion = newIngestion(store);
  await ingestion.ingestFiles('p', [{ project: 'p', path: 'src/a.ts', content: 'v1\n' }]);
  const plan: SyncPlan = {
    project: 'p', repoPath: '/r', mode: 'git',
    added: [], changed: [{ path: 'src/a.ts', oldHash: 'old', newHash: hashContent('v2\n'), knowledgeIds: [] }],
    renamed: [], deleted: [], ignored: [],
    summary: { added: 0, changed: 1, renamed: 0, deleted: 0, ignored: 0 }, destructive: false,
  };
  const reader = async () => 'TOTALLY-DIFFERENT\n'; // hash != newHash
  const result = await applyPlan({ store, ingestion, plan, readFile: reader });
  assert.equal(result.reingested, 0);
  assert.deepEqual(result.skipped, [{ path: 'src/a.ts', reason: 'hash_mismatch' }]);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test --import tsx test/source-sync-apply.test.ts`
Expected: FAIL — cannot find `apply.js`.

- [ ] **Step 3: Implement `src/source-sync/apply.ts`**

```ts
import type { KnowledgeStore } from '../storage/store.js';
import type { IngestionService } from '../ingest/service.js';
import type { ApplyResult, SyncPlan } from './types.js';
import { hashContent } from './fs-inventory.js';

export interface ApplyOptions {
  store: KnowledgeStore;
  ingestion: IngestionService;
  plan: SyncPlan;
  /** Reads a repo-relative path → file content. */
  readFile: (path: string) => Promise<string>;
  syncRunId?: string;
}

export async function applyPlan(opts: ApplyOptions): Promise<ApplyResult> {
  const { store, ingestion, plan, readFile } = opts;
  const result: ApplyResult = { ingested: 0, reingested: 0, repointed: 0, archived: 0, skipped: [] };

  // 1. added → ingest + ledger row
  for (const add of plan.added) {
    let content: string;
    try { content = await readFile(add.path); }
    catch { result.skipped.push({ path: add.path, reason: 'missing_on_disk' }); continue; }
    await ingestion.ingestFiles(plan.project, [{ project: plan.project, path: add.path, content }]);
    await store.upsertSourceFile({
      project: plan.project, path: add.path, contentHash: hashContent(content),
      status: 'tracked', lastSyncedSha: plan.toSha ?? null,
    });
    result.ingested += 1;
  }

  // 2. changed → re-validate hash, re-ingest, update ledger
  for (const change of plan.changed) {
    let content: string;
    try { content = await readFile(change.path); }
    catch { result.skipped.push({ path: change.path, reason: 'missing_on_disk' }); continue; }
    if (hashContent(content) !== change.newHash) {
      result.skipped.push({ path: change.path, reason: 'hash_mismatch' }); continue;
    }
    await ingestion.ingestFiles(plan.project, [{ project: plan.project, path: change.path, content }]);
    await store.upsertSourceFile({
      project: plan.project, path: change.path, contentHash: change.newHash,
      status: 'tracked', lastSyncedSha: plan.toSha ?? null,
    });
    result.reingested += 1;
  }

  // 3. renamed → re-point ledger + knowledge metadata (preserve knowledge)
  for (const ren of plan.renamed) {
    await store.renameSourceFile({ project: plan.project, from: ren.from, to: ren.to });
    const linked = await store.listKnowledgeBySourcePath({ project: plan.project, path: ren.from });
    for (const k of linked) {
      await store.updateKnowledge(k.id, {
        metadata: { ...(k.metadata as Record<string, unknown>), sourcePath: ren.to },
      });
    }
    result.repointed += 1;
  }

  // 4. deleted → archive knowledge + atoms, tombstone ledger row (never hard-delete)
  for (const del of plan.deleted) {
    const linked = del.knowledgeIds.length
      ? del.knowledgeIds
      : (await store.listKnowledgeBySourcePath({ project: plan.project, path: del.path })).map((k) => k.id);
    for (const id of linked) {
      const current = await store.getKnowledge(id);
      if (!current) continue;
      await store.updateKnowledge(id, {
        status: 'archived',
        metadata: {
          ...(current.metadata as Record<string, unknown>),
          archive: { reason: 'source_deleted', sourcePath: del.path, syncRunId: opts.syncRunId ?? null },
        },
      });
      result.archived += 1;
    }
    for (const atomId of del.atomIds) {
      await store.updateAtom(atomId, { status: 'archived' });
    }
    await store.upsertSourceFile({ project: plan.project, path: del.path, contentHash: null });
    await store.setSourceFileStatus({ project: plan.project, path: del.path, status: 'archived' });
  }

  return result;
}
```

Note: `updateKnowledge`'s patch must accept `status` and `metadata`. Confirm `KnowledgePatchInput` includes both (it already supports `status` per `postgres-store.ts:284`; if `metadata` is not yet a patch field, add `metadata?: Record<string, unknown>` to `KnowledgePatchInput` and have both stores merge it — Postgres `SET metadata = COALESCE($n, metadata)`, memory `{ ...current, metadata: patch.metadata ?? current.metadata }`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/source-sync-apply.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/source-sync/apply.ts test/source-sync-apply.test.ts src/storage/store.ts src/storage/memory-store.ts src/storage/postgres-store.ts
git commit -m "feat(source-sync): apply engine (ingest/reingest/repoint/archive)"
```

---

## Task 9: SourceSyncService orchestrator

**Files:**
- Create: `src/source-sync/service.ts`
- Test: `test/source-sync-service.test.ts`

The service ties detection + plan + persistence together: `sync()` computes a `SyncPlan`, persists a `sync_runs` row, and returns `{ planId, plan }`. `apply(planId, { allowDestructive })` loads the persisted plan and runs `applyPlan`, refusing the destructive part unless `allowDestructive` is true.

- [ ] **Step 1: Write the failing test**

Create `test/source-sync-service.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { SourceSyncService } from '../src/source-sync/service.js';

test('SourceSyncService: first sync on empty ledger plans every file as an add', async () => {
  const root = await mkdtemp(join(tmpdir(), 'svc-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'README.md'), '# hi\n');

  const store = new MemoryKnowledgeStore();
  const ingestion = new IngestionService(store, new HashModelProvider());
  const svc = new SourceSyncService({ store, ingestion });

  const { planId, plan } = await svc.sync({ project: 'p', repoPath: root, trigger: 'cli' });
  assert.equal(plan.summary.added, 2);
  assert.equal(plan.destructive, false);
  assert.ok(planId);

  const res = await svc.apply({ planId, allowDestructive: false });
  assert.equal(res.ingested, 2);
});

test('SourceSyncService: apply refuses destructive plan unless allowed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'svc2-'));
  await writeFile(join(root, 'keep.ts'), 'export const k = 1;\n');
  const store = new MemoryKnowledgeStore();
  const ingestion = new IngestionService(store, new HashModelProvider());
  const svc = new SourceSyncService({ store, ingestion });

  // seed a ledger row + knowledge for a file that won't exist on disk → deletion
  await ingestion.ingestFiles('p', [{ project: 'p', path: 'gone.ts', content: 'export const g = 1;\n' }]);
  await store.upsertSourceFile({ project: 'p', path: 'gone.ts', contentHash: 'h', status: 'tracked' });

  const { planId, plan } = await svc.sync({ project: 'p', repoPath: root, trigger: 'cli' });
  assert.equal(plan.destructive, true);
  await assert.rejects(() => svc.apply({ planId, allowDestructive: false }), /destructive/i);

  const res = await svc.apply({ planId, allowDestructive: true });
  assert.equal(res.archived >= 1, true);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test --import tsx test/source-sync-service.test.ts`
Expected: FAIL — cannot find `service.js`.

- [ ] **Step 3: Implement `src/source-sync/service.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { IngestionService } from '../ingest/service.js';
import type { SyncMode, SyncPlan, SyncTrigger, ApplyResult } from './types.js';
import { DEFAULT_SYNC_POLICY, classifyPath, type SyncPolicy } from './policy.js';
import { walkInventory } from './fs-inventory.js';
import { isGitRepo, gitHeadSha, gitLsFiles, gitDiffSince } from './git-inventory.js';
import { hashContent } from './fs-inventory.js';
import { buildPlan, type ChangeSet } from './plan.js';
import { applyPlan } from './apply.js';
import { inferItemTypeFromPath } from '../ingest/item-type-inference.js';
import { readFile as fsRead, stat } from 'node:fs/promises';

export interface SourceSyncServiceOptions {
  store: KnowledgeStore;
  ingestion: IngestionService;
  policy?: SyncPolicy;
}

export interface SyncArgs {
  project: string;
  repoPath: string;
  trigger: SyncTrigger;
}

export interface ApplyArgs {
  planId: string;
  allowDestructive: boolean;
}

export class SourceSyncService {
  private readonly store: KnowledgeStore;
  private readonly ingestion: IngestionService;
  private readonly policy: SyncPolicy;

  constructor(opts: SourceSyncServiceOptions) {
    this.store = opts.store;
    this.ingestion = opts.ingestion;
    this.policy = opts.policy ?? DEFAULT_SYNC_POLICY;
  }

  async sync(args: SyncArgs): Promise<{ planId: string; plan: SyncPlan }> {
    const mode: SyncMode = isGitRepo(args.repoPath) ? 'git' : 'fs';
    const ledger = await this.store.listSourceFiles({ project: args.project, limit: 100_000 });
    const ledgerByPath = new Map(ledger.map((r) => [r.path, r]));

    // Build the on-disk inventory (path → {hash, size}) using git ls-files when available.
    const inventory = new Map<string, { contentHash: string; sizeBytes: number }>();
    const ignored: SyncPlan['ignored'] = [];
    const paths = mode === 'git' ? gitLsFiles(args.repoPath) : null;
    if (paths) {
      for (const rel of paths) {
        const size = (await stat(join(args.repoPath, rel))).size;
        const cls = classifyPath(rel, size, this.policy);
        if (!cls.include) { ignored.push({ path: rel, reason: cls.reason! }); continue; }
        const buf = await fsRead(join(args.repoPath, rel));
        inventory.set(rel, { contentHash: hashContent(buf), sizeBytes: size });
      }
    } else {
      const walked = await walkInventory(args.repoPath, this.policy);
      for (const e of walked.entries) inventory.set(e.path, { contentHash: e.contentHash, sizeBytes: e.sizeBytes });
      ignored.push(...walked.ignored);
    }

    const added: SyncPlan['added'] = [];
    const changed: SyncPlan['changed'] = [];
    for (const [path, info] of inventory) {
      const prior = ledgerByPath.get(path);
      if (!prior || prior.status === 'archived') {
        added.push({ path, sizeBytes: info.sizeBytes, willIngestAs: inferItemTypeFromPath(path) });
      } else if (prior.contentHash !== info.contentHash) {
        const linked = await this.store.listKnowledgeBySourcePath({ project: args.project, path });
        changed.push({ path, oldHash: prior.contentHash ?? '', newHash: info.contentHash, knowledgeIds: linked.map((k) => k.id) });
      }
    }

    // Deletions: ledger rows that are tracked/changed but absent from the inventory.
    const deleted: SyncPlan['deleted'] = [];
    for (const row of ledger) {
      if (row.status === 'archived' || row.status === 'ignored') continue;
      if (!inventory.has(row.path)) {
        const linked = await this.store.listKnowledgeBySourcePath({ project: args.project, path: row.path });
        deleted.push({ path: row.path, knowledgeIds: linked.map((k) => k.id), atomIds: [], chunkCount: 0 });
      }
    }

    // Rename detection via git diff (only when we have a baseline sha).
    const renamed: SyncPlan['renamed'] = [];
    const baseSha = ledger.find((r) => r.lastSyncedSha)?.lastSyncedSha ?? null;
    if (mode === 'git' && baseSha) {
      try {
        const diff = gitDiffSince(args.repoPath, baseSha);
        for (const r of diff.renamed) {
          // Convert a detected rename into a re-point, removing the false add+delete pair.
          const addIdx = added.findIndex((a) => a.path === r.to);
          if (addIdx >= 0) added.splice(addIdx, 1);
          const delIdx = deleted.findIndex((d) => d.path === r.from);
          if (delIdx >= 0) deleted.splice(delIdx, 1);
          renamed.push(r);
        }
      } catch { /* baseline unreachable (history rewritten) — fall back to add/delete */ }
    }

    const toSha = mode === 'git' ? gitHeadSha(args.repoPath) : undefined;
    const changes: ChangeSet = {
      project: args.project, repoPath: args.repoPath, mode,
      fromSha: baseSha ?? undefined, toSha, added, changed, renamed, deleted, ignored,
    };
    const plan = buildPlan(changes);
    const run = await this.store.createSyncRun({
      project: args.project, mode, plan, trigger: args.trigger, fromSha: baseSha, toSha: toSha ?? null,
    });
    return { planId: run.id, plan };
  }

  async apply(args: ApplyArgs): Promise<ApplyResult> {
    const run = await this.store.getSyncRun(args.planId);
    if (!run) throw new Error(`sync run ${args.planId} not found`);
    if (run.plan.destructive && !args.allowDestructive) {
      throw new Error('Plan is destructive (archives knowledge for deleted files); pass allowDestructive to apply.');
    }
    const result = await applyPlan({
      store: this.store, ingestion: this.ingestion, plan: run.plan, syncRunId: run.id,
      readFile: (p) => readFile(join(run.plan.repoPath, p), 'utf8'),
    });
    await this.store.markSyncRunApplied(run.id);
    return result;
  }
}
```

Note: confirm `inferItemTypeFromPath` is exported from `src/ingest/item-type-inference.js` (it is referenced by `IngestionService.buildDocumentKnowledgeInput`). If it lives elsewhere, import it from there. Remove the duplicate `readFile`/`stat` import lines if your linter flags them — keep a single import from `node:fs/promises`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/source-sync-service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole source-sync suite + build**

Run: `node --test --import tsx test/source-sync-*.test.ts && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Expected: all PASS, clean build.

- [ ] **Step 6: Commit**

```bash
git add src/source-sync/service.ts test/source-sync-service.test.ts
git commit -m "feat(source-sync): SourceSyncService orchestrator (sync + guarded apply)"
```

---

## Task 10: MCP tool `tuberosa_sync_sources`

**Files:**
- Modify: `src/mcp/server.ts` (add a `case` near the other tool cases ~line 143+, and a tool definition in the definitions array ~line 901+)
- Test: `test/source-sync-mcp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/source-sync-mcp.test.ts` (call the dispatch the same way existing MCP tests do — match the pattern in an existing `test/*mcp*` or the handler export used by `src/mcp/server.ts`; the snippet below assumes a `handleToolCall(name, args, deps)` style. If the repo wires tools differently, adapt to the existing test harness for MCP tools.):

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceSyncService } from '../src/source-sync/service.js';

// This test exercises the service the MCP tool delegates to, asserting the response
// shape the tool returns (plan summary + planId). The MCP case is a thin wrapper.
test('tuberosa_sync_sources delegates to SourceSyncService and returns plan + planId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-'));
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  const store = new MemoryKnowledgeStore();
  const svc = new SourceSyncService({ store, ingestion: new IngestionService(store, new HashModelProvider()) });
  const { planId, plan } = await svc.sync({ project: 'p', repoPath: root, trigger: 'mcp' });
  assert.ok(planId);
  assert.equal(plan.summary.added, 1);
});
```

- [ ] **Step 2: Run it to verify it passes the service contract**

Run: `node --test --import tsx test/source-sync-mcp.test.ts`
Expected: PASS (validates the contract the MCP wrapper relies on).

- [ ] **Step 3: Add the tool case in `src/mcp/server.ts`**

In the tool dispatch switch (near the other `case 'tuberosa_*'` blocks), add:

```ts
    case 'tuberosa_sync_sources': {
      const project = String(args.project ?? '');
      const repoPath = String(args.path ?? process.cwd());
      const service = new SourceSyncService({ store, ingestion });
      if (args.apply === true && args.planId) {
        const result = await service.apply({ planId: String(args.planId), allowDestructive: true });
        return textResult(JSON.stringify({ applied: true, result }, null, 2));
      }
      const { planId, plan } = await service.sync({ project, repoPath, trigger: 'mcp' });
      return textResult(JSON.stringify({ planId, plan }, null, 2));
    }
```

Use whatever the file's existing helpers are for `store`, `ingestion`, and the success-result wrapper (shown here as `textResult`) — match the surrounding cases exactly. Add the import at the top: `import { SourceSyncService } from '../source-sync/service.js';` and ensure an `IngestionService` instance is in scope (construct it the same way other ingest-using code paths do, or add it to the server deps).

- [ ] **Step 4: Add the tool definition in the definitions array (~line 901+)**

```ts
    {
      name: 'tuberosa_sync_sources',
      description: 'Detect added/changed/renamed/deleted files for a project and return a reviewable cleanup plan. Pass apply:true with a planId to apply it (archives for deleted files are always surfaced for the user to confirm).',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          path: { type: 'string', description: 'Repo root; defaults to the server cwd.' },
          apply: { type: 'boolean', description: 'Apply a previously returned planId.' },
          planId: { type: 'string' },
        },
        required: ['project'],
      },
    },
```

- [ ] **Step 5: Build + confirm MCP stdout stays protocol-only**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Then grep to confirm no stray stdout writes were added: `grep -n "console.log\|process.stdout.write" src/mcp/server.ts`
Expected: clean build; grep returns nothing new in the added code.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts test/source-sync-mcp.test.ts
git commit -m "feat(source-sync): tuberosa_sync_sources MCP tool"
```

---

## Task 11: CLI `tuberosa sync` + `tuberosa hook install`

**Files:**
- Create: `bin/commands/sync.ts`
- Modify: `bin/tuberosa.ts` (dispatch), `bin/commands/parser.ts` (only if it enumerates known commands)
- Test: `test/source-sync-cli.test.ts`

The CLI command constructs a real store + ingestion from config, runs `sync`, prints the plan, and applies per flags. Tests inject a fake `SourceSyncService` via the command's options to avoid spawning Postgres (mirror the `CommandIo` injection pattern used by `init.ts`).

- [ ] **Step 1: Write the failing test**

Create `test/source-sync-cli.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { syncCommand } from '../bin/commands/sync.js';
import type { SyncPlan } from '../src/source-sync/types.js';

function fakeIo() {
  const out: string[] = []; const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), cwd: '/repo', env: {} } as any, out, err };
}

const emptyPlan: SyncPlan = {
  project: 'p', repoPath: '/repo', mode: 'git',
  added: [{ path: 'a.ts', sizeBytes: 1, willIngestAs: 'code_ref' }], changed: [], renamed: [],
  deleted: [], ignored: [], summary: { added: 1, changed: 0, renamed: 0, deleted: 0, ignored: 0 }, destructive: false,
};

test('tuberosa sync (dry-run) prints the plan and does not apply', async () => {
  const { io, out } = fakeIo();
  let applied = false;
  const result = await syncCommand(
    { command: 'sync', options: { project: 'p' }, args: [] } as any,
    io,
    { makeService: async () => ({ sync: async () => ({ planId: 'PID', plan: emptyPlan }), apply: async () => { applied = true; return {} as any; } }) as any },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(applied, false, 'dry-run must not apply');
  assert.ok(out.join('\n').includes('added: 1'));
});

test('tuberosa sync --apply applies non-destructive plan', async () => {
  const { io } = fakeIo();
  let applyArgs: any = null;
  await syncCommand(
    { command: 'sync', options: { project: 'p', apply: true }, args: [] } as any,
    io,
    { makeService: async () => ({ sync: async () => ({ planId: 'PID', plan: emptyPlan }),
      apply: async (a: any) => { applyArgs = a; return { ingested: 1, reingested: 0, repointed: 0, archived: 0, skipped: [] }; } }) as any },
  );
  assert.equal(applyArgs.planId, 'PID');
  assert.equal(applyArgs.allowDestructive, false);
});

test('tuberosa sync --apply on destructive plan requires --yes', async () => {
  const { io, err } = fakeIo();
  const destructive = { ...emptyPlan, deleted: [{ path: 'gone.ts', knowledgeIds: [], atomIds: [], chunkCount: 0 }], destructive: true,
    summary: { ...emptyPlan.summary, deleted: 1 } };
  const result = await syncCommand(
    { command: 'sync', options: { project: 'p', apply: true }, args: [] } as any,
    io,
    { makeService: async () => ({ sync: async () => ({ planId: 'PID', plan: destructive }), apply: async () => { throw new Error('should not apply'); } }) as any },
  );
  assert.equal(result.exitCode, 1);
  assert.ok(err.join('\n').toLowerCase().includes('--yes'));
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test --import tsx test/source-sync-cli.test.ts`
Expected: FAIL — cannot find `bin/commands/sync.js`.

- [ ] **Step 3: Implement `bin/commands/sync.ts`**

```ts
import type { CliInvocation, CommandIo, CommandResult } from './types.js';
import type { SourceSyncService } from '../../src/source-sync/service.js';
import type { SyncPlan } from '../../src/source-sync/types.js';

export interface SyncCommandDeps {
  /** Build a fully-wired SourceSyncService from config. Injected in tests. */
  makeService: (project: string, repoPath: string) => Promise<Pick<SourceSyncService, 'sync' | 'apply'>>;
}

function renderPlan(plan: SyncPlan): string[] {
  const s = plan.summary;
  return [
    `Sync plan for ${plan.project} (${plan.mode}${plan.toSha ? ` @ ${plan.toSha.slice(0, 8)}` : ''}):`,
    `  added: ${s.added}   changed: ${s.changed}   renamed: ${s.renamed}   deleted: ${s.deleted}   ignored: ${s.ignored}`,
    ...plan.deleted.map((d) => `  - DELETE → archive: ${d.path} (${d.knowledgeIds.length} knowledge, ${d.atomIds.length} atoms)`),
  ];
}

export async function syncCommand(
  invocation: CliInvocation,
  io: CommandIo,
  deps: SyncCommandDeps,
): Promise<CommandResult> {
  const project = String(invocation.options.project ?? '');
  if (!project) { io.err('tuberosa sync requires --project <name>'); return { exitCode: 1 }; }
  const repoPath = typeof invocation.options.path === 'string' ? invocation.options.path : io.cwd;
  const apply = invocation.options.apply === true;
  const yes = invocation.options.yes === true;
  const asJson = invocation.options.json === true;

  const service = await deps.makeService(project, repoPath);
  const { planId, plan } = await service.sync({ project, repoPath, trigger: 'cli' });

  if (asJson) io.out(JSON.stringify({ planId, plan }, null, 2));
  else for (const line of renderPlan(plan)) io.out(line);

  if (!apply) { io.out('\nDry-run. Re-run with --apply to execute (archives also need --yes).'); return { exitCode: 0 }; }
  if (plan.destructive && !yes) {
    io.err('Plan archives knowledge for deleted files. Re-run with --apply --yes to confirm.');
    return { exitCode: 1 };
  }
  const result = await service.apply({ planId, allowDestructive: plan.destructive && yes });
  io.out(`Applied: ingested ${result.ingested}, reingested ${result.reingested}, repointed ${result.repointed}, archived ${result.archived}, skipped ${result.skipped.length}.`);
  return { exitCode: 0 };
}

/** `tuberosa hook install` — writes a post-commit + post-merge hook that runs an additive-only sync. */
export async function hookCommand(invocation: CliInvocation, io: CommandIo): Promise<CommandResult> {
  if (invocation.args[0] !== 'install') { io.err('usage: tuberosa hook install'); return { exitCode: 1 }; }
  if (!io.fs) { io.err('hook install requires fs adapter'); return { exitCode: 1 }; }
  const project = String(invocation.options.project ?? '');
  if (!project) { io.err('tuberosa hook install requires --project <name>'); return { exitCode: 1 }; }
  const script = [
    '#!/bin/sh',
    '# Tuberosa source-sync hook (additive-only; deletes are queued for review).',
    `npx tuberosa sync --project ${project} --apply --json > .tuberosa/last-sync.json 2>/dev/null || true`,
    '',
  ].join('\n');
  for (const hook of ['post-commit', 'post-merge']) {
    const p = `${io.cwd}/.git/hooks/${hook}`;
    await io.fs.writeFile(p, script);
    io.out(`Wrote ${p}`);
  }
  io.out('Note: the hook applies additive changes; deleted-file cleanup is left for `tuberosa sync --apply --yes`.');
  return { exitCode: 0 };
}
```

(The hook intentionally runs `--apply` *without* `--yes`, so the CLI auto-applies adds/changes/renames and refuses the destructive part — honoring "never auto-archive.")

- [ ] **Step 4: Wire dispatch in `bin/tuberosa.ts`**

Add imports and cases:

```ts
import { syncCommand, hookCommand } from './commands/sync.js';
import { makeSyncService } from './commands/sync-factory.js'; // see note below
```

```ts
    case 'sync':
      return syncCommand(invocation, io, { makeService: (project, repoPath) => makeSyncService(io, project, repoPath) });
    case 'hook':
      return hookCommand(invocation, io);
```

Create `bin/commands/sync-factory.ts` that builds the real store + ingestion from `loadConfig()` (mirror how `scripts/migrate.ts` / the HTTP server construct `StorageFactory` + `IngestionService` + the configured `ModelProvider`) and returns `new SourceSyncService({ store, ingestion })`. Keep it out of `sync.ts` so the command stays unit-testable without a DB.

If `bin/commands/parser.ts` maintains an allow-list of commands or per-command flags, add `sync` and `hook` with flags `--project`, `--path`, `--apply`, `--yes`, `--json`. Update `usage()` text to list them.

- [ ] **Step 5: Run the CLI test + build**

Run: `node --test --import tsx test/source-sync-cli.test.ts && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Expected: PASS (3 tests), clean build.

- [ ] **Step 6: Commit**

```bash
git add bin/commands/sync.ts bin/commands/sync-factory.ts bin/tuberosa.ts bin/commands/parser.ts test/source-sync-cli.test.ts
git commit -m "feat(source-sync): tuberosa sync + hook install CLI"
```

---

## Task 12: Workbench Source Health surface

**Files:**
- Modify: `src/operations/workbench-summary.ts` (add source-health counts + tombstones to the summary)
- Test: `test/source-sync-workbench.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/source-sync-workbench.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { buildSourceHealth } from '../src/operations/workbench-summary.js';

test('buildSourceHealth: counts ledger statuses and lists tombstones', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'a.ts', contentHash: 'h', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'gone.ts', contentHash: null, status: 'archived' });
  const health = await buildSourceHealth(store, { project: 'p', limit: 100 });
  assert.equal(health.counts.tracked, 1);
  assert.equal(health.counts.archived, 1);
  assert.deepEqual(health.tombstones.map((t) => t.path), ['gone.ts']);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test --import tsx test/source-sync-workbench.test.ts`
Expected: FAIL — `buildSourceHealth` is not exported.

- [ ] **Step 3: Implement `buildSourceHealth` in `src/operations/workbench-summary.ts`**

Add (and export) a focused helper, then include its result in the assembled `WorkbenchSummary` object (add a `sourceHealth` field to the summary type in the same module's type definition):

```ts
import type { KnowledgeStore } from '../storage/store.js';
import type { SourceFileStatus } from '../source-sync/types.js';

export interface SourceHealth {
  counts: Record<SourceFileStatus, number>;
  tombstones: Array<{ path: string; archivedAt: string | null }>;
}

export async function buildSourceHealth(
  store: KnowledgeStore,
  options: { project?: string; limit: number },
): Promise<SourceHealth> {
  const files = await store.listSourceFiles({ project: options.project, limit: options.limit });
  const counts: Record<SourceFileStatus, number> = { tracked: 0, changed: 0, missing: 0, archived: 0, ignored: 0 };
  const tombstones: SourceHealth['tombstones'] = [];
  for (const f of files) {
    counts[f.status] += 1;
    if (f.status === 'archived') tombstones.push({ path: f.path, archivedAt: f.archivedAt });
  }
  return { counts, tombstones };
}
```

Then, in `buildWorkbenchSummary`, call `buildSourceHealth(store, { project, limit: 200 })` and attach it as `summary.sourceHealth`. Add `sourceHealth?: SourceHealth` to the `WorkbenchSummary` type (in `src/operations/` types) and render a one-line "Source health: tracked N · changed N · missing N · archived N" in `formatWorkbenchSummary`.

- [ ] **Step 4: Run the test + the workbench tests**

Run: `node --test --import tsx test/source-sync-workbench.test.ts`
Then the existing workbench tests so the summary shape change didn't break them:
`node --test --import tsx test/*workbench*.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operations/workbench-summary.ts test/source-sync-workbench.test.ts
git commit -m "feat(source-sync): workbench Source Health counts + tombstones"
```

---

## Task 13: Retrieval freshness eval fixture

**Files:**
- Modify: `eval/retrieval-fixtures.json`
- Verify: `pnpm run eval:retrieval`

This proves the core win: a knowledge item whose source file was deleted (and thus archived) must NOT be retrieved. Per the repo rule, the fixture must fail without the archive behavior.

- [ ] **Step 1: Inspect the fixture format**

Run: `node -e "const f=require('./eval/retrieval-fixtures.json'); console.log(Object.keys(f)); console.log(JSON.stringify((f.cases?f.cases[0]:f[0]),null,2).slice(0,1200))"`
Expected: prints the top-level keys and one example case so you can mirror its exact shape (seed knowledge, prompt, expected hits, stale assertions).

- [ ] **Step 2: Add a deleted-then-archived case**

Add one case mirroring the existing schema: seed a knowledge item with `metadata.sourcePath = "src/removed.ts"` and `status = "archived"` (or whatever the fixture's mechanism is for marking an item archived/stale), a prompt that would otherwise match it, and an assertion that it is absent from results / counted as stale-rejected. Reuse the existing `staleRejectionRate` assertion machinery — the fixture file already asserts `staleRejectionRate=1`, so the new archived item must be excluded for the eval to pass.

If the fixture has no "status" seed field, add the minimal field needed and the corresponding seeding path in the eval harness (`eval/` runner) so an `archived` item is loaded and then expected to be filtered. Keep the change additive.

- [ ] **Step 3: Run the eval**

Run: `pnpm run eval:retrieval`
Expected: PASS with `hitRate=1`, `staleRejectionRate=1`, and all classification rates at 1. Temporarily flip the new item's status to `approved` locally to confirm the case WOULD fail (proving coverage), then revert to `archived`.

- [ ] **Step 4: Commit**

```bash
git add eval/retrieval-fixtures.json eval/
git commit -m "test(source-sync): retrieval eval fixture for deleted-then-archived freshness"
```

---

## Task 14: End-to-end round-trip + full verification

**Files:**
- Create: `test/source-sync-roundtrip.test.ts`
- Verify: full unit suite + build (+ integration if Docker is up)

- [ ] **Step 1: Write the round-trip test**

Create `test/source-sync-roundtrip.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { SourceSyncService } from '../src/source-sync/service.js';

test('round-trip: first sync ingests, deleting a file archives it, resurrect restores it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.ts'), 'export const keep = 1;\n');
  await writeFile(join(root, 'src', 'gone.ts'), 'export const gone = 1;\n');

  const store = new MemoryKnowledgeStore();
  const ingestion = new IngestionService(store, new HashModelProvider());
  const svc = new SourceSyncService({ store, ingestion });

  // 1. First sync → both files ingested.
  const first = await svc.sync({ project: 'p', repoPath: root, trigger: 'cli' });
  assert.equal(first.plan.summary.added, 2);
  await svc.apply({ planId: first.planId, allowDestructive: false });
  const goneBefore = await store.listKnowledgeBySourcePath({ project: 'p', path: 'src/gone.ts' });
  assert.ok(goneBefore.length >= 1);

  // 2. Delete a file on disk → second sync plans a deletion.
  await rm(join(root, 'src', 'gone.ts'));
  const second = await svc.sync({ project: 'p', repoPath: root, trigger: 'cli' });
  assert.equal(second.plan.summary.deleted, 1);
  assert.equal(second.plan.destructive, true);

  // 3. Apply → knowledge archived, excluded from approved listing.
  await svc.apply({ planId: second.planId, allowDestructive: true });
  const approved = await store.listKnowledge({ project: 'p', limit: 100 });
  assert.equal(approved.find((k) => k.id === goneBefore[0].id), undefined);

  // 4. Resurrect → back in approved listing.
  await store.updateKnowledge(goneBefore[0].id, { status: 'approved' });
  const afterResurrect = await store.listKnowledge({ project: 'p', limit: 100 });
  assert.ok(afterResurrect.find((k) => k.id === goneBefore[0].id));
});
```

- [ ] **Step 2: Run it**

Run: `node --test --import tsx test/source-sync-roundtrip.test.ts`
Expected: PASS.

- [ ] **Step 3: Full unit suite + build**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Expected: entire suite green; clean compile.

- [ ] **Step 4: Retrieval eval gate**

Run: `pnpm run eval:retrieval`
Expected: PASS (hitRate=1, staleRejectionRate=1, classification rates 1).

- [ ] **Step 5: Integration (only if Docker is up)**

Run: `docker compose up --build -d && pnpm run migrate && pnpm run test:integration`
Expected: `011_source_files.sql` applies; postgres-store ledger/sync_run tests pass; archived items excluded from `searchContext`. If Docker is down, state that this step was skipped.

- [ ] **Step 6: Commit**

```bash
git add test/source-sync-roundtrip.test.ts
git commit -m "test(source-sync): end-to-end ingest→delete→archive→resurrect round-trip"
```

---

## Self-review checklist (completed during planning)

- **Spec coverage:** §3 engine+wrappers → Tasks 9/10/11; §4 data model → Tasks 1/3; §5 SyncPlan+apply+policy → Tasks 2/4/7/8; §6 surfaces → Tasks 10/11/12; §7 verification → Tasks 3,5,6,8,9,13,14; §8 safety invariants → Task 8 (archive-not-delete, hash re-validate), Task 9 (destructive guard), Task 11 (hook never auto-archives), Task 4 (no silent exclusion → `ignored` in plan). Atlas (P1) and capabilities #3/#4 correctly absent.
- **Placeholder scan:** every code step has concrete code; no TBD/TODO. Two explicit "match the existing pattern" notes (MCP result wrapper in Task 10; sync-factory wiring in Task 11) are integration points where copying the surrounding convention is safer than guessing a signature — each names the exact file and the pattern to mirror.
- **Type consistency:** `SyncPlan`, `SourceFileRecord`, `ApplyResult`, `ChangeSet` defined in Task 2 and used unchanged in Tasks 7–14; store method names (`upsertSourceFile`, `renameSourceFile`, `setSourceFileStatus`, `listKnowledgeBySourcePath`, `createSyncRun`, `getSyncRun`, `markSyncRunApplied`) defined in Task 3 and called identically in Tasks 8/9/12.
- **Open integration risks flagged in-task:** (a) `KnowledgePatchInput` may need a `metadata` field (Task 8 note); (b) `inferItemTypeFromPath` export location (Task 9 note); (c) MCP server's exact result-wrapper + how it constructs `ingestion`/`store` (Task 10 note); (d) eval fixture's archived-seed mechanism (Task 13). Each is a "verify then adapt" point, not a blank.
