# Knowledge Atom Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace free-form `itemType=memory` knowledge with strictly-shaped `KnowledgeAtom` records that have a write-time floor, three promotion tiers, an auto-critic at session finish, and a migration path for existing vague memories.

**Architecture:** New `knowledge_atoms` table (additive — does not alter `knowledge_items`). New `src/atoms/` module with `critic`, `extractor`, `tier`, and `migration` files. Atoms join the existing retrieval fusion as a 7th candidate source with a tier-based rank multiplier. The agent-session `finishSession` flow calls the new extractor after the existing reflection-draft path; produced atoms either pass the deterministic critic and land at `draft` tier or go to the existing knowledge-gap review queue. A one-shot CLI re-extracts legacy `itemType ∈ (memory, bugfix, rule)` items into atoms.

**Tech Stack:** TypeScript (Node 22), Postgres + pgvector + pg_trgm, `node:test` runner with `tsx`, existing `ModelProvider` abstraction (`hash` for tests, OpenAI/Ollama in prod), existing `KnowledgeStore` interface.

**Spec:** [`docs/superpowers/specs/2026-05-26-knowledge-atom-schema-design.md`](../specs/2026-05-26-knowledge-atom-schema-design.md)

---

## File Structure

**Create:**
- `migrations/005_knowledge_atoms.sql` — new table + legacy columns on `knowledge_items`
- `src/types/atoms.ts` — `KnowledgeAtom`, `AtomType`, `AtomTier`, `Evidence`, `Trigger`, `Verification`, `AtomLink`, input/patch shapes
- `src/atoms/critic.ts` — deterministic auto-critic (`AtomCritic.evaluate`)
- `src/atoms/extractor.ts` — `AtomExtractor` interface + `HashAtomExtractor` for tests; reads `ModelProvider.extractAtoms` in prod
- `src/atoms/tier.ts` — promotion/demotion rules (`evaluateTierTransition`)
- `src/atoms/migration.ts` — batch re-extraction of legacy knowledge items
- `scripts/migrate-knowledge-to-atoms.ts` — CLI entry
- `test/atoms-critic.test.ts`
- `test/atoms-tier.test.ts`
- `test/atoms-extractor.test.ts`
- `test/atoms-storage.test.ts`
- `test/atoms-retrieval.test.ts`
- `test/atoms-finish-session.test.ts`
- `test/atoms-migration.test.ts`

**Modify:**
- `src/types.ts` — re-export atom types
- `src/storage/store.ts` — add 8 new methods to `KnowledgeStore` interface
- `src/storage/memory-store.ts` — in-memory atom implementation
- `src/storage/postgres-store.ts` — postgres atom implementation
- `src/model/provider.ts` — add `extractAtoms` to `ModelProvider`; `HashModelProvider` impl; OpenAI/Ollama impls (return empty by default — wired up later)
- `src/retrieval/service.ts` — add atom candidate source + tier multiplier
- `src/retrieval/policy.ts` — atom source weight + tier multiplier config
- `src/retrieval/context-pack.ts` — `verifiedAtom` evidence category
- `src/agent-session/service.ts` — call extractor + critic after reflection-draft path
- `eval/retrieval-fixtures.json` — fixtures asserting critic rejections and tier multipliers
- `package.json` — `migrate-knowledge-to-atoms` npm script

---

## Task 1: Atom types and `src/atoms/` module scaffold

**Files:**
- Create: `src/types/atoms.ts`
- Modify: `src/types.ts`
- Test: none (types only — verified by `tsc` and downstream tasks)

- [ ] **Step 1: Create the atom types file**

Create `src/types/atoms.ts`:

```typescript
export type AtomType = 'fact' | 'procedure' | 'decision' | 'gotcha' | 'convention';
export type AtomTier = 'draft' | 'verified' | 'canonical';
export type AtomStatus = 'active' | 'legacy_archived' | 'superseded';
export type AtomProducer = 'agent_session' | 'user' | 'migration_llm';
export type AtomLinkKind = 'supersedes' | 'refines' | 'depends_on' | 'co_changes_with' | 'related_to';

export type Evidence =
  | { kind: 'file'; path: string; lineStart?: number; lineEnd?: number; commitSha?: string }
  | { kind: 'commit'; sha: string; message?: string }
  | { kind: 'test'; path: string; testName: string }
  | { kind: 'url'; uri: string; fetchedAt: string }
  | { kind: 'prior_session'; sessionId: string; decisionId?: string };

export interface Trigger {
  errors?: string[];
  files?: string[];
  symbols?: string[];
  taskTypes?: string[];
  intentTags?: string[];
}

export interface Verification {
  command?: string;
  testRef?: { path: string; testName: string };
  assertion?: string;
}

export interface AtomLink {
  toAtomId: string;
  kind: AtomLinkKind;
  confidence: number;
}

export interface AtomAudit {
  producedBy: AtomProducer;
  producedAtSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeAtom {
  id: string;
  project: string;
  parentKnowledgeId?: string;

  claim: string;
  type: AtomType;
  evidence: Evidence[];
  trigger: Trigger;

  verification?: Verification;
  pitfalls?: string[];
  links?: AtomLink[];

  tier: AtomTier;
  reuseCount: number;
  lastReusedAt?: string;
  status: AtomStatus;
  audit: AtomAudit;
}

export interface KnowledgeAtomInput {
  project: string;
  parentKnowledgeId?: string;
  claim: string;
  type: AtomType;
  evidence: Evidence[];
  trigger: Trigger;
  verification?: Verification;
  pitfalls?: string[];
  links?: AtomLink[];
  producedBy: AtomProducer;
  producedAtSessionId?: string;
}

export interface KnowledgeAtomPatch {
  tier?: AtomTier;
  status?: AtomStatus;
  reuseCount?: number;
  lastReusedAt?: string;
  verification?: Verification;
  pitfalls?: string[];
  links?: AtomLink[];
}

export interface ListAtomsOptions {
  project?: string;
  tier?: AtomTier;
  status?: AtomStatus;
  parentKnowledgeId?: string;
  limit: number;
}
```

- [ ] **Step 2: Re-export atom types from `src/types.ts`**

Add to the end of `src/types.ts`:

```typescript
export * from './types/atoms.js';
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `pnpm run build`
Expected: PASS (zero errors). If `tsc` complains about the export, ensure the file uses `.js` extensions in imports as the rest of the repo does.

- [ ] **Step 4: Commit**

```bash
git add src/types/atoms.ts src/types.ts
git commit -m "feat(atoms): add KnowledgeAtom type definitions"
```

---

## Task 2: Migration SQL — `knowledge_atoms` table and legacy columns

**Files:**
- Create: `migrations/005_knowledge_atoms.sql`
- Test: `test/atoms-storage.test.ts` (created in Task 3; this task verifies migration applies cleanly)

- [ ] **Step 1: Create the migration file**

Create `migrations/005_knowledge_atoms.sql`:

```sql
-- Concern B: Knowledge Atom Schema
-- Adds a new knowledge_atoms table for actionable, schema-floored memory units.
-- Adds legacy_status and migrated_at columns to knowledge_items for the
-- one-shot migration of vague memories.

CREATE TABLE IF NOT EXISTS knowledge_atoms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid REFERENCES projects(id) ON DELETE CASCADE,
  parent_knowledge_id  uuid REFERENCES knowledge_items(id) ON DELETE SET NULL,

  claim                text NOT NULL,
  type                 text NOT NULL CHECK (type IN ('fact','procedure','decision','gotcha','convention')),
  evidence             jsonb NOT NULL DEFAULT '[]'::jsonb,
  trigger              jsonb NOT NULL DEFAULT '{}'::jsonb,

  verification         jsonb,
  pitfalls             jsonb,
  links                jsonb,

  tier                 text NOT NULL DEFAULT 'draft' CHECK (tier IN ('draft','verified','canonical')),
  reuse_count          integer NOT NULL DEFAULT 0,
  last_reused_at       timestamptz,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','legacy_archived','superseded')),

  produced_by          text NOT NULL CHECK (produced_by IN ('agent_session','user','migration_llm')),
  produced_session_id  uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  embedding            vector(1536),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atoms_project_tier ON knowledge_atoms(project_id, tier);
CREATE INDEX IF NOT EXISTS idx_atoms_status      ON knowledge_atoms(status);
CREATE INDEX IF NOT EXISTS idx_atoms_parent      ON knowledge_atoms(parent_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_atoms_embedding   ON knowledge_atoms USING hnsw (embedding vector_cosine_ops);

-- Legacy migration tracking on existing knowledge_items
ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS migrated_at  timestamptz,
  ADD COLUMN IF NOT EXISTS legacy_status text CHECK (legacy_status IN ('legacy_replaced','legacy_archived'));

CREATE INDEX IF NOT EXISTS idx_knowledge_items_legacy_status ON knowledge_items(legacy_status);
```

- [ ] **Step 2: Apply the migration locally**

Run: `pnpm run migrate`
Expected: log line `applied 005_knowledge_atoms.sql`. If the Docker stack is up, this hits real Postgres. If not, the next task's tests use `MemoryKnowledgeStore` and do not depend on this step.

- [ ] **Step 3: Verify the schema exists**

Run (only if Docker stack is up): `docker compose exec -T db psql -U tuberosa -d tuberosa -c "\\d knowledge_atoms"`
Expected: table description includes all columns listed above.

- [ ] **Step 4: Commit**

```bash
git add migrations/005_knowledge_atoms.sql
git commit -m "feat(atoms): add knowledge_atoms table + legacy columns on knowledge_items"
```

---

## Task 3: Extend `KnowledgeStore` interface and add `MemoryKnowledgeStore` atom impl

**Files:**
- Modify: `src/storage/store.ts`
- Modify: `src/storage/memory-store.ts`
- Test: `test/atoms-storage.test.ts`

- [ ] **Step 1: Add new method signatures to `KnowledgeStore`**

Edit `src/storage/store.ts`. Add at the top of the file alongside other type imports:

```typescript
import type {
  KnowledgeAtom,
  KnowledgeAtomInput,
  KnowledgeAtomPatch,
  ListAtomsOptions,
} from '../types/atoms.js';
```

Add these methods to the `KnowledgeStore` interface (place them after `listKnowledgeRelations`, near the other knowledge methods):

```typescript
  createAtom(input: KnowledgeAtomInput): Promise<KnowledgeAtom>;
  getAtom(id: string): Promise<KnowledgeAtom | undefined>;
  listAtoms(options: ListAtomsOptions): Promise<KnowledgeAtom[]>;
  updateAtom(id: string, patch: KnowledgeAtomPatch): Promise<KnowledgeAtom | undefined>;
  deleteAtom(id: string): Promise<boolean>;
  incrementAtomReuse(id: string, when: string): Promise<KnowledgeAtom | undefined>;
  searchAtomsByEmbedding(embedding: number[], options: { project?: string; limit: number; threshold?: number }): Promise<Array<{ atom: KnowledgeAtom; cosine: number }>>;
  searchAtomsByTrigger(trigger: { errors?: string[]; files?: string[]; symbols?: string[]; taskTypes?: string[] }, options: { project?: string; limit: number }): Promise<KnowledgeAtom[]>;
```

- [ ] **Step 2: Write the failing storage test**

Create `test/atoms-storage.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type { KnowledgeAtomInput } from '../src/types/atoms.js';

const BASE_INPUT: KnowledgeAtomInput = {
  project: 'tuberosa',
  claim: 'EMBEDDING_DIMENSIONS must equal the vector(N) column dim.',
  type: 'fact',
  evidence: [{ kind: 'file', path: 'migrations/001_init.sql', lineStart: 14 }],
  trigger: { errors: ['vector dimension mismatch'] },
  producedBy: 'agent_session',
  producedAtSessionId: undefined,
};

test('MemoryKnowledgeStore: createAtom returns an atom at draft tier with reuseCount=0', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await store.createAtom(BASE_INPUT);
  assert.equal(atom.tier, 'draft');
  assert.equal(atom.reuseCount, 0);
  assert.equal(atom.status, 'active');
  assert.equal(atom.project, 'tuberosa');
  assert.equal(atom.claim, BASE_INPUT.claim);
  assert.ok(atom.id);
  assert.ok(atom.audit.createdAt);
});

test('MemoryKnowledgeStore: getAtom returns the stored atom', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.createAtom(BASE_INPUT);
  const fetched = await store.getAtom(created.id);
  assert.deepEqual(fetched, created);
});

test('MemoryKnowledgeStore: listAtoms filters by project and tier', async () => {
  const store = new MemoryKnowledgeStore();
  await store.createAtom(BASE_INPUT);
  await store.createAtom({ ...BASE_INPUT, project: 'other-project' });
  const found = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(found.length, 1);
  assert.equal(found[0].project, 'tuberosa');
});

test('MemoryKnowledgeStore: updateAtom mutates tier and reuseCount', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.createAtom(BASE_INPUT);
  const updated = await store.updateAtom(created.id, { tier: 'verified', reuseCount: 2 });
  assert.equal(updated?.tier, 'verified');
  assert.equal(updated?.reuseCount, 2);
});

test('MemoryKnowledgeStore: incrementAtomReuse bumps the counter and sets lastReusedAt', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.createAtom(BASE_INPUT);
  const when = '2026-05-26T00:00:00.000Z';
  const updated = await store.incrementAtomReuse(created.id, when);
  assert.equal(updated?.reuseCount, 1);
  assert.equal(updated?.lastReusedAt, when);
});

test('MemoryKnowledgeStore: deleteAtom removes the atom', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.createAtom(BASE_INPUT);
  const removed = await store.deleteAtom(created.id);
  assert.equal(removed, true);
  assert.equal(await store.getAtom(created.id), undefined);
});

test('MemoryKnowledgeStore: searchAtomsByTrigger matches errors substrings case-insensitively', async () => {
  const store = new MemoryKnowledgeStore();
  await store.createAtom(BASE_INPUT);
  const found = await store.searchAtomsByTrigger(
    { errors: ['VECTOR DIMENSION MISMATCH'] },
    { project: 'tuberosa', limit: 10 },
  );
  assert.equal(found.length, 1);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-storage.test.ts`
Expected: FAIL with `store.createAtom is not a function` (or similar — the memory store does not implement these methods yet).

- [ ] **Step 4: Implement atom CRUD on `MemoryKnowledgeStore`**

Edit `src/storage/memory-store.ts`. Add a private map and the eight methods. Place the map near the other private maps:

```typescript
  private readonly atoms = new Map<string, KnowledgeAtom>();
```

Add imports at the top:

```typescript
import type {
  KnowledgeAtom,
  KnowledgeAtomInput,
  KnowledgeAtomPatch,
  ListAtomsOptions,
} from '../types/atoms.js';
import { randomUUID } from 'node:crypto';
```

Then add the methods inside the class:

```typescript
  async createAtom(input: KnowledgeAtomInput): Promise<KnowledgeAtom> {
    const now = new Date().toISOString();
    const atom: KnowledgeAtom = {
      id: randomUUID(),
      project: input.project,
      parentKnowledgeId: input.parentKnowledgeId,
      claim: input.claim,
      type: input.type,
      evidence: input.evidence,
      trigger: input.trigger,
      verification: input.verification,
      pitfalls: input.pitfalls,
      links: input.links,
      tier: 'draft',
      reuseCount: 0,
      lastReusedAt: undefined,
      status: 'active',
      audit: {
        producedBy: input.producedBy,
        producedAtSessionId: input.producedAtSessionId,
        createdAt: now,
        updatedAt: now,
      },
    };
    this.atoms.set(atom.id, atom);
    return atom;
  }

  async getAtom(id: string): Promise<KnowledgeAtom | undefined> {
    return this.atoms.get(id);
  }

  async listAtoms(options: ListAtomsOptions): Promise<KnowledgeAtom[]> {
    return [...this.atoms.values()]
      .filter((atom) => !options.project || atom.project === options.project)
      .filter((atom) => !options.tier || atom.tier === options.tier)
      .filter((atom) => !options.status || atom.status === options.status)
      .filter((atom) => !options.parentKnowledgeId || atom.parentKnowledgeId === options.parentKnowledgeId)
      .slice(0, options.limit);
  }

  async updateAtom(id: string, patch: KnowledgeAtomPatch): Promise<KnowledgeAtom | undefined> {
    const existing = this.atoms.get(id);
    if (!existing) return undefined;
    const updated: KnowledgeAtom = {
      ...existing,
      ...patch,
      audit: { ...existing.audit, updatedAt: new Date().toISOString() },
    };
    this.atoms.set(id, updated);
    return updated;
  }

  async deleteAtom(id: string): Promise<boolean> {
    return this.atoms.delete(id);
  }

  async incrementAtomReuse(id: string, when: string): Promise<KnowledgeAtom | undefined> {
    const existing = this.atoms.get(id);
    if (!existing) return undefined;
    return this.updateAtom(id, {
      reuseCount: existing.reuseCount + 1,
      lastReusedAt: when,
    });
  }

  async searchAtomsByEmbedding(): Promise<Array<{ atom: KnowledgeAtom; cosine: number }>> {
    // Memory store has no real embeddings; tests use trigger search instead.
    return [];
  }

  async searchAtomsByTrigger(
    trigger: { errors?: string[]; files?: string[]; symbols?: string[]; taskTypes?: string[] },
    options: { project?: string; limit: number },
  ): Promise<KnowledgeAtom[]> {
    const wantErrors = (trigger.errors ?? []).map((s) => s.toLowerCase());
    const wantFiles = (trigger.files ?? []).map((s) => s.toLowerCase());
    const wantSymbols = (trigger.symbols ?? []).map((s) => s.toLowerCase());
    const wantTaskTypes = (trigger.taskTypes ?? []).map((s) => s.toLowerCase());

    const matchesAny = (haystack: string[] | undefined, needles: string[]): boolean => {
      if (needles.length === 0) return false;
      const lowered = (haystack ?? []).map((s) => s.toLowerCase());
      return needles.some((n) => lowered.some((h) => h.includes(n) || n.includes(h)));
    };

    return [...this.atoms.values()]
      .filter((atom) => !options.project || atom.project === options.project)
      .filter((atom) =>
        matchesAny(atom.trigger.errors, wantErrors)
        || matchesAny(atom.trigger.files, wantFiles)
        || matchesAny(atom.trigger.symbols, wantSymbols)
        || matchesAny(atom.trigger.taskTypes, wantTaskTypes),
      )
      .slice(0, options.limit);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-storage.test.ts`
Expected: 7 tests pass.

- [ ] **Step 6: Run the full test suite to verify nothing else regressed**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage/store.ts src/storage/memory-store.ts test/atoms-storage.test.ts
git commit -m "feat(atoms): KnowledgeStore atom CRUD + MemoryKnowledgeStore impl"
```

---

## Task 4: Postgres atom implementation

**Files:**
- Modify: `src/storage/postgres-store.ts`
- Test: integration-only — covered by `test/integration.test.ts` if Docker is up (skipped otherwise)

- [ ] **Step 1: Implement `createAtom` on `PostgresKnowledgeStore`**

Edit `src/storage/postgres-store.ts`. Add the imports if missing:

```typescript
import type {
  KnowledgeAtom,
  KnowledgeAtomInput,
  KnowledgeAtomPatch,
  ListAtomsOptions,
} from '../types/atoms.js';
```

Add a row-mapper helper near the other mappers:

```typescript
function rowToAtom(row: Record<string, unknown>, project: string): KnowledgeAtom {
  return {
    id: String(row.id),
    project,
    parentKnowledgeId: row.parent_knowledge_id ? String(row.parent_knowledge_id) : undefined,
    claim: String(row.claim),
    type: row.type as KnowledgeAtom['type'],
    evidence: (row.evidence ?? []) as KnowledgeAtom['evidence'],
    trigger: (row.trigger ?? {}) as KnowledgeAtom['trigger'],
    verification: (row.verification ?? undefined) as KnowledgeAtom['verification'],
    pitfalls: (row.pitfalls ?? undefined) as KnowledgeAtom['pitfalls'],
    links: (row.links ?? undefined) as KnowledgeAtom['links'],
    tier: row.tier as KnowledgeAtom['tier'],
    reuseCount: Number(row.reuse_count ?? 0),
    lastReusedAt: row.last_reused_at ? new Date(row.last_reused_at as string).toISOString() : undefined,
    status: row.status as KnowledgeAtom['status'],
    audit: {
      producedBy: row.produced_by as KnowledgeAtom['audit']['producedBy'],
      producedAtSessionId: row.produced_session_id ? String(row.produced_session_id) : undefined,
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
    },
  };
}
```

Add the methods. Use the existing `getOrCreateProjectId` helper pattern in the file:

```typescript
  async createAtom(input: KnowledgeAtomInput): Promise<KnowledgeAtom> {
    const projectId = await this.getOrCreateProjectId(input.project);
    const result = await this.pool.query(
      `INSERT INTO knowledge_atoms
        (project_id, parent_knowledge_id, claim, type, evidence, trigger,
         verification, pitfalls, links, produced_by, produced_session_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)
       RETURNING *`,
      [
        projectId,
        input.parentKnowledgeId ?? null,
        input.claim,
        input.type,
        JSON.stringify(input.evidence),
        JSON.stringify(input.trigger),
        input.verification ? JSON.stringify(input.verification) : null,
        input.pitfalls ? JSON.stringify(input.pitfalls) : null,
        input.links ? JSON.stringify(input.links) : null,
        input.producedBy,
        input.producedAtSessionId ?? null,
      ],
    );
    return rowToAtom(result.rows[0], input.project);
  }

  async getAtom(id: string): Promise<KnowledgeAtom | undefined> {
    const result = await this.pool.query(
      `SELECT a.*, p.name AS project_name
       FROM knowledge_atoms a
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [id],
    );
    if (result.rows.length === 0) return undefined;
    return rowToAtom(result.rows[0], String(result.rows[0].project_name));
  }

  async listAtoms(options: ListAtomsOptions): Promise<KnowledgeAtom[]> {
    const filters: string[] = [];
    const values: unknown[] = [];
    if (options.project) {
      values.push(options.project);
      filters.push(`p.name = $${values.length}`);
    }
    if (options.tier) {
      values.push(options.tier);
      filters.push(`a.tier = $${values.length}`);
    }
    if (options.status) {
      values.push(options.status);
      filters.push(`a.status = $${values.length}`);
    }
    if (options.parentKnowledgeId) {
      values.push(options.parentKnowledgeId);
      filters.push(`a.parent_knowledge_id = $${values.length}`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    values.push(options.limit);
    const result = await this.pool.query(
      `SELECT a.*, p.name AS project_name
       FROM knowledge_atoms a
       LEFT JOIN projects p ON p.id = a.project_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => rowToAtom(row, String(row.project_name)));
  }

  async updateAtom(id: string, patch: KnowledgeAtomPatch): Promise<KnowledgeAtom | undefined> {
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    if (patch.tier !== undefined)         { values.push(patch.tier);         sets.push(`tier = $${values.length}`); }
    if (patch.status !== undefined)       { values.push(patch.status);       sets.push(`status = $${values.length}`); }
    if (patch.reuseCount !== undefined)   { values.push(patch.reuseCount);   sets.push(`reuse_count = $${values.length}`); }
    if (patch.lastReusedAt !== undefined) { values.push(patch.lastReusedAt); sets.push(`last_reused_at = $${values.length}`); }
    if (patch.verification !== undefined) { values.push(JSON.stringify(patch.verification)); sets.push(`verification = $${values.length}::jsonb`); }
    if (patch.pitfalls !== undefined)     { values.push(JSON.stringify(patch.pitfalls));     sets.push(`pitfalls = $${values.length}::jsonb`); }
    if (patch.links !== undefined)        { values.push(JSON.stringify(patch.links));        sets.push(`links = $${values.length}::jsonb`); }
    values.push(id);
    const result = await this.pool.query(
      `UPDATE knowledge_atoms SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (result.rows.length === 0) return undefined;
    const projectResult = await this.pool.query(
      `SELECT name FROM projects WHERE id = $1`,
      [result.rows[0].project_id],
    );
    return rowToAtom(result.rows[0], String(projectResult.rows[0]?.name ?? ''));
  }

  async deleteAtom(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM knowledge_atoms WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async incrementAtomReuse(id: string, when: string): Promise<KnowledgeAtom | undefined> {
    const result = await this.pool.query(
      `UPDATE knowledge_atoms
       SET reuse_count = reuse_count + 1, last_reused_at = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, when],
    );
    if (result.rows.length === 0) return undefined;
    const projectResult = await this.pool.query(
      `SELECT name FROM projects WHERE id = $1`,
      [result.rows[0].project_id],
    );
    return rowToAtom(result.rows[0], String(projectResult.rows[0]?.name ?? ''));
  }

  async searchAtomsByEmbedding(
    embedding: number[],
    options: { project?: string; limit: number; threshold?: number },
  ): Promise<Array<{ atom: KnowledgeAtom; cosine: number }>> {
    const threshold = options.threshold ?? 0.0;
    const projectFilter = options.project ? `WHERE p.name = $3` : '';
    const params: unknown[] = [`[${embedding.join(',')}]`, options.limit];
    if (options.project) params.push(options.project);
    const result = await this.pool.query(
      `SELECT a.*, p.name AS project_name,
              1 - (a.embedding <=> $1::vector) AS cosine
       FROM knowledge_atoms a
       LEFT JOIN projects p ON p.id = a.project_id
       ${projectFilter}
       ${projectFilter ? 'AND' : 'WHERE'} a.embedding IS NOT NULL
         AND a.status = 'active'
       ORDER BY a.embedding <=> $1::vector
       LIMIT $2`,
      params,
    );
    return result.rows
      .map((row) => ({ atom: rowToAtom(row, String(row.project_name)), cosine: Number(row.cosine) }))
      .filter((entry) => entry.cosine >= threshold);
  }

  async searchAtomsByTrigger(
    trigger: { errors?: string[]; files?: string[]; symbols?: string[]; taskTypes?: string[] },
    options: { project?: string; limit: number },
  ): Promise<KnowledgeAtom[]> {
    const filters: string[] = ["a.status = 'active'"];
    const values: unknown[] = [];
    if (options.project) {
      values.push(options.project);
      filters.push(`p.name = $${values.length}`);
    }
    const triggerFilters: string[] = [];
    for (const key of ['errors', 'files', 'symbols', 'taskTypes'] as const) {
      const arr = trigger[key];
      if (!arr || arr.length === 0) continue;
      values.push(JSON.stringify(arr));
      triggerFilters.push(`a.trigger->'${key}' ?| ARRAY(SELECT lower(value::text) FROM jsonb_array_elements_text($${values.length}::jsonb))`);
    }
    if (triggerFilters.length) {
      filters.push(`(${triggerFilters.join(' OR ')})`);
    }
    values.push(options.limit);
    const result = await this.pool.query(
      `SELECT a.*, p.name AS project_name
       FROM knowledge_atoms a
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE ${filters.join(' AND ')}
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => rowToAtom(row, String(row.project_name)));
  }
```

- [ ] **Step 2: Run typecheck to confirm both stores satisfy the interface**

Run: `pnpm run build`
Expected: PASS.

- [ ] **Step 3: Run the full test suite — memory store paths must still pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 4: (Optional) Run integration tests if Docker is up**

Run: `pnpm run test:integration`
Expected: PASS or skipped. If it fails, fix the postgres SQL before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/storage/postgres-store.ts
git commit -m "feat(atoms): PostgresKnowledgeStore atom CRUD impl"
```

---

## Task 5: Deterministic auto-critic

**Files:**
- Create: `src/atoms/critic.ts`
- Test: `test/atoms-critic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/atoms-critic.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { AtomCritic } from '../src/atoms/critic.js';
import type { KnowledgeAtomInput } from '../src/types/atoms.js';

const GOOD: KnowledgeAtomInput = {
  project: 'tuberosa',
  claim: 'EMBEDDING_DIMENSIONS must equal the vector(N) column dim.',
  type: 'fact',
  evidence: [{ kind: 'commit', sha: 'deadbeef', message: 'init schema' }],
  trigger: { errors: ['vector dimension mismatch'] },
  producedBy: 'agent_session',
};

function makeCritic() {
  return new AtomCritic(new MemoryKnowledgeStore(), new HashModelProvider());
}

test('AtomCritic.evaluate: accepts well-formed atom', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate(GOOD);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('AtomCritic.evaluate: rejects atom with empty claim', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate({ ...GOOD, claim: '' });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('claim')));
});

test('AtomCritic.evaluate: rejects atom with no evidence', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate({ ...GOOD, evidence: [] });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('evidence')));
});

test('AtomCritic.evaluate: rejects atom with empty trigger', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate({ ...GOOD, trigger: {} });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('trigger')));
});

test('AtomCritic.evaluate: rejects atom whose claim restates the trigger', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate({
    ...GOOD,
    claim: 'vector dimension mismatch',
    trigger: { errors: ['vector dimension mismatch'] },
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes('restate')));
});

test('AtomCritic.evaluate: rejects atom whose claim is longer than 240 chars', async () => {
  const critic = makeCritic();
  const result = await critic.evaluate({ ...GOOD, claim: 'x'.repeat(241) });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('240')));
});

test('AtomCritic.evaluate: rejects a near-duplicate of an existing atom in the same project', async () => {
  const store = new MemoryKnowledgeStore();
  const critic = new AtomCritic(store, new HashModelProvider(), { dedupCosineThreshold: 0.0 });
  await store.createAtom(GOOD);
  const result = await critic.evaluate(GOOD);
  // With threshold 0, ANY existing atom in the project is treated as a duplicate.
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('duplicate')));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-critic.test.ts`
Expected: FAIL — module `../src/atoms/critic.js` does not exist.

- [ ] **Step 3: Implement `AtomCritic`**

Create `src/atoms/critic.ts`:

```typescript
import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtomInput } from '../types/atoms.js';

export interface AtomCriticConfig {
  dedupCosineThreshold?: number;     // default 0.92
  maxClaimLength?: number;           // default 240
}

export interface AtomCriticResult {
  ok: boolean;
  reasons: string[];
}

export class AtomCritic {
  private readonly dedupThreshold: number;
  private readonly maxClaimLength: number;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly models: ModelProvider,
    config: AtomCriticConfig = {},
  ) {
    this.dedupThreshold = config.dedupCosineThreshold ?? 0.92;
    this.maxClaimLength = config.maxClaimLength ?? 240;
  }

  async evaluate(input: KnowledgeAtomInput): Promise<AtomCriticResult> {
    const reasons: string[] = [];

    // Floor: claim
    if (!input.claim || !input.claim.trim()) {
      reasons.push('claim is empty');
    } else if (input.claim.length > this.maxClaimLength) {
      reasons.push(`claim exceeds ${this.maxClaimLength} chars`);
    }

    // Floor: evidence
    if (!input.evidence || input.evidence.length === 0) {
      reasons.push('evidence is empty (≥1 required)');
    }

    // Floor: trigger non-trivial
    const triggerNonEmpty =
      (input.trigger.errors?.length ?? 0) > 0
      || (input.trigger.files?.length ?? 0) > 0
      || (input.trigger.symbols?.length ?? 0) > 0
      || (input.trigger.taskTypes?.length ?? 0) > 0;
    if (!triggerNonEmpty) {
      reasons.push('trigger has no concrete error/file/symbol/taskType');
    }

    // Claim must not be a verbatim restatement of any trigger token
    const claimLower = (input.claim ?? '').trim().toLowerCase();
    const triggerTokens = [
      ...(input.trigger.errors ?? []),
      ...(input.trigger.files ?? []),
      ...(input.trigger.symbols ?? []),
      ...(input.trigger.taskTypes ?? []),
    ].map((s) => s.trim().toLowerCase());
    if (claimLower && triggerTokens.some((token) => token === claimLower)) {
      reasons.push('claim restates a trigger token verbatim');
    }

    // Semantic dedup against existing atoms in the project
    if (reasons.length === 0) {
      const candidate = `${input.claim}\n${(input.trigger.errors ?? []).join(' ')}`;
      const embedding = await this.models.embed(candidate);
      const matches = await this.store.searchAtomsByEmbedding(embedding, {
        project: input.project,
        limit: 5,
        threshold: this.dedupThreshold,
      });
      if (matches.length > 0) {
        reasons.push(`duplicate of existing atom ${matches[0].atom.id} (cosine ${matches[0].cosine.toFixed(2)})`);
      }
    }

    return { ok: reasons.length === 0, reasons };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-critic.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/atoms/critic.ts test/atoms-critic.test.ts
git commit -m "feat(atoms): deterministic auto-critic with floor + dedup checks"
```

---

## Task 6: Tier transition logic

**Files:**
- Create: `src/atoms/tier.ts`
- Test: `test/atoms-tier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/atoms-tier.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { evaluateTierTransition } from '../src/atoms/tier.js';
import type { KnowledgeAtom } from '../src/types/atoms.js';

function atom(overrides: Partial<KnowledgeAtom> = {}): KnowledgeAtom {
  return {
    id: 'a1',
    project: 'tuberosa',
    claim: 'x',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }],
    trigger: { errors: ['e'] },
    tier: 'draft',
    reuseCount: 0,
    status: 'active',
    audit: { producedBy: 'agent_session', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ...overrides,
  };
}

const NOW = new Date('2026-05-26T00:00:00Z');

test('evaluateTierTransition: draft → verified when verification + reuseCount ≥ 2 + recent', () => {
  const a = atom({
    tier: 'draft',
    reuseCount: 2,
    lastReusedAt: new Date('2026-05-01T00:00:00Z').toISOString(),
    verification: { command: 'pnpm test' },
  });
  const next = evaluateTierTransition(a, NOW);
  assert.equal(next, 'verified');
});

test('evaluateTierTransition: draft stays draft without verification field', () => {
  const a = atom({ tier: 'draft', reuseCount: 5, lastReusedAt: NOW.toISOString() });
  assert.equal(evaluateTierTransition(a, NOW), 'draft');
});

test('evaluateTierTransition: verified → draft after 180 days of no reuse', () => {
  const a = atom({
    tier: 'verified',
    reuseCount: 2,
    lastReusedAt: new Date('2025-10-01T00:00:00Z').toISOString(), // > 180 days ago
    verification: { command: 'pnpm test' },
  });
  assert.equal(evaluateTierTransition(a, NOW), 'draft');
});

test('evaluateTierTransition: canonical is sticky — does not auto-demote', () => {
  const a = atom({
    tier: 'canonical',
    reuseCount: 0,
    lastReusedAt: undefined,
    links: [{ toAtomId: 'b', kind: 'related_to', confidence: 0.9 }],
  });
  assert.equal(evaluateTierTransition(a, NOW), 'canonical');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-tier.test.ts`
Expected: FAIL — module `../src/atoms/tier.js` does not exist.

- [ ] **Step 3: Implement tier evaluation**

Create `src/atoms/tier.ts`:

```typescript
import type { AtomTier, KnowledgeAtom } from '../types/atoms.js';

const VERIFIED_REUSE_MIN = 2;
const VERIFIED_RECENCY_DAYS = 90;
const DEMOTE_INACTIVITY_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso: string | undefined, now: Date): number {
  if (!iso) return Infinity;
  return (now.getTime() - new Date(iso).getTime()) / DAY_MS;
}

export function evaluateTierTransition(atom: KnowledgeAtom, now: Date = new Date()): AtomTier {
  // Canonical is a human-approval state. Demotion from canonical requires
  // explicit feedback (handled elsewhere — review queue), never time-based.
  if (atom.tier === 'canonical') return 'canonical';

  const hasVerification = Boolean(atom.verification?.command || atom.verification?.testRef || atom.verification?.assertion);
  const recentlyReused = daysSince(atom.lastReusedAt, now) <= VERIFIED_RECENCY_DAYS;
  const meetsReuseFloor = atom.reuseCount >= VERIFIED_REUSE_MIN;

  if (atom.tier === 'verified') {
    // Demote to draft if no reuse in 180 days
    if (daysSince(atom.lastReusedAt, now) > DEMOTE_INACTIVITY_DAYS) {
      return 'draft';
    }
    return 'verified';
  }

  // tier === 'draft'
  if (hasVerification && meetsReuseFloor && recentlyReused) {
    return 'verified';
  }
  return 'draft';
}

export const TIER_RANK_MULTIPLIERS: Record<AtomTier, number> = {
  draft: 0.6,
  verified: 1.0,
  canonical: 1.4,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-tier.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/atoms/tier.ts test/atoms-tier.test.ts
git commit -m "feat(atoms): tier promotion/demotion rules"
```

---

## Task 7: `ModelProvider.extractAtoms` + Hash impl + AtomExtractor

**Files:**
- Modify: `src/model/provider.ts`
- Create: `src/atoms/extractor.ts`
- Test: `test/atoms-extractor.test.ts`

- [ ] **Step 1: Add `extractAtoms` to `ModelProvider` and `HashModelProvider`**

Edit `src/model/provider.ts`. Add to the `ModelProvider` interface:

```typescript
  extractAtoms?(input: {
    project: string;
    sessionPrompt: string;
    summary?: string;
    changedFiles?: string[];
    decisions?: Array<{ decision: string; reason?: string; knowledgeIds?: string[] }>;
    verificationCommands?: string[];
  }): Promise<Array<{
    claim: string;
    type: 'fact' | 'procedure' | 'decision' | 'gotcha' | 'convention';
    evidence: Array<{ kind: 'file' | 'commit' | 'test' | 'url' | 'prior_session'; [key: string]: unknown }>;
    trigger: { errors?: string[]; files?: string[]; symbols?: string[]; taskTypes?: string[]; intentTags?: string[] };
    verification?: { command?: string; testRef?: { path: string; testName: string }; assertion?: string };
    pitfalls?: string[];
  }>>;
```

Add a stub impl to `HashModelProvider` that returns the empty array unless an injected fixture is set:

```typescript
  // Test seam — the hash provider has no real LLM. Tests inject deterministic
  // atom candidates via setFixtureAtoms when they need extractor coverage.
  private fixtureAtoms: Array<Awaited<ReturnType<NonNullable<ModelProvider['extractAtoms']>>>[number]> = [];

  setFixtureAtoms(atoms: typeof this.fixtureAtoms): void {
    this.fixtureAtoms = atoms;
  }

  async extractAtoms(): Promise<typeof this.fixtureAtoms> {
    return this.fixtureAtoms;
  }
```

- [ ] **Step 2: Write the failing extractor test**

Create `test/atoms-extractor.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { AtomCritic } from '../src/atoms/critic.js';
import { AtomExtractor } from '../src/atoms/extractor.js';

test('AtomExtractor: passes good candidates through critic and stores them as draft', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: 'EMBEDDING_DIMENSIONS must equal the vector(N) column dim.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'migrations/001_init.sql', lineStart: 14 }],
    trigger: { errors: ['vector dimension mismatch'] },
  }]);
  const extractor = new AtomExtractor(store, models, new AtomCritic(store, models));
  const result = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'sess-1',
    sessionPrompt: 'fix the dim mismatch',
    summary: 'changed EMBEDDING_DIMENSIONS to match column',
  });
  assert.equal(result.stored.length, 1);
  assert.equal(result.rejected.length, 0);
  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].tier, 'draft');
  assert.equal(atoms[0].audit.producedBy, 'agent_session');
  assert.equal(atoms[0].audit.producedAtSessionId, 'sess-1');
});

test('AtomExtractor: rejects candidates that fail the critic and records reasons', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: '',                                              // floor failure
    type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }],
    trigger: { errors: ['e'] },
  }]);
  const extractor = new AtomExtractor(store, models, new AtomCritic(store, models));
  const result = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'sess-2',
    sessionPrompt: 'p',
  });
  assert.equal(result.stored.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.ok(result.rejected[0].reasons.some((r) => r.includes('claim')));
});

test('AtomExtractor: returns empty result when provider has no extractAtoms method', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const extractor = new AtomExtractor(store, models, new AtomCritic(store, models));
  const result = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'sess-3',
    sessionPrompt: 'p',
  });
  assert.equal(result.stored.length, 0);
  assert.equal(result.rejected.length, 0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-extractor.test.ts`
Expected: FAIL — `AtomExtractor` does not exist.

- [ ] **Step 4: Implement `AtomExtractor`**

Create `src/atoms/extractor.ts`:

```typescript
import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom, KnowledgeAtomInput } from '../types/atoms.js';
import { AtomCritic, type AtomCriticResult } from './critic.js';

export interface ExtractFromSessionInput {
  project: string;
  sessionId: string;
  sessionPrompt: string;
  summary?: string;
  changedFiles?: string[];
  decisions?: Array<{ decision: string; reason?: string; knowledgeIds?: string[] }>;
  verificationCommands?: string[];
}

export interface ExtractFromSessionResult {
  stored: KnowledgeAtom[];
  rejected: Array<{ candidate: KnowledgeAtomInput; result: AtomCriticResult }>;
}

export class AtomExtractor {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly models: ModelProvider,
    private readonly critic: AtomCritic,
  ) {}

  async extractFromSession(input: ExtractFromSessionInput): Promise<ExtractFromSessionResult> {
    if (!this.models.extractAtoms) {
      return { stored: [], rejected: [] };
    }
    const candidates = await this.models.extractAtoms({
      project: input.project,
      sessionPrompt: input.sessionPrompt,
      summary: input.summary,
      changedFiles: input.changedFiles,
      decisions: input.decisions,
      verificationCommands: input.verificationCommands,
    });

    const stored: KnowledgeAtom[] = [];
    const rejected: ExtractFromSessionResult['rejected'] = [];

    for (const candidate of candidates) {
      const candidateInput: KnowledgeAtomInput = {
        project: input.project,
        claim: candidate.claim,
        type: candidate.type,
        evidence: candidate.evidence as KnowledgeAtomInput['evidence'],
        trigger: candidate.trigger,
        verification: candidate.verification,
        pitfalls: candidate.pitfalls,
        producedBy: 'agent_session',
        producedAtSessionId: input.sessionId,
      };
      const result = await this.critic.evaluate(candidateInput);
      if (result.ok) {
        stored.push(await this.store.createAtom(candidateInput));
      } else {
        rejected.push({ candidate: candidateInput, result });
      }
    }

    return { stored, rejected };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-extractor.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Run the full suite — provider interface change must not break anything**

Run: `pnpm test`
Expected: PASS. If any test fails because OpenAI/Ollama providers do not implement `extractAtoms`, the interface is `?:` optional so they should still compile.

- [ ] **Step 7: Commit**

```bash
git add src/model/provider.ts src/atoms/extractor.ts test/atoms-extractor.test.ts
git commit -m "feat(atoms): AtomExtractor + ModelProvider.extractAtoms seam"
```

---

## Task 8: Retrieval integration — atoms as a candidate source with tier multiplier

**Files:**
- Modify: `src/retrieval/service.ts`
- Modify: `src/retrieval/policy.ts`
- Modify: `src/retrieval/context-pack.ts`
- Test: `test/atoms-retrieval.test.ts`
- Modify: `eval/retrieval-fixtures.json`

- [ ] **Step 1: Write the failing retrieval test**

Create `test/atoms-retrieval.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { MemoryCache } from '../src/cache.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { defaultConfig } from '../src/config.js';
import { DEFAULT_POLICY, resetRetrievalPolicyCache, setRetrievalPolicy } from '../src/retrieval/policy.js';

test('retrieval: a verified atom surfaces above a draft atom for the same trigger', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, defaultConfig());

  const draft = await store.createAtom({
    project: 'tuberosa',
    claim: 'Draft hint.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }],
    trigger: { errors: ['vector dimension mismatch'] },
    producedBy: 'agent_session',
  });
  const verifiedRaw = await store.createAtom({
    project: 'tuberosa',
    claim: 'Verified hint.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'b.ts' }],
    trigger: { errors: ['vector dimension mismatch'] },
    producedBy: 'agent_session',
    verification: { command: 'pnpm test' },
  });
  await store.updateAtom(verifiedRaw.id, { tier: 'verified', reuseCount: 2, lastReusedAt: new Date().toISOString() });

  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'hitting vector dimension mismatch on insert',
    errors: ['vector dimension mismatch'],
  });

  const ids = pack.sections.flatMap((s) => s.items.map((i) => i.knowledgeId));
  const draftIdx = ids.indexOf(draft.id);
  const verifiedIdx = ids.indexOf(verifiedRaw.id);
  assert.ok(verifiedIdx !== -1, 'verified atom must appear in pack');
  if (draftIdx !== -1) {
    assert.ok(verifiedIdx < draftIdx, `verified (${verifiedIdx}) must outrank draft (${draftIdx})`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-retrieval.test.ts`
Expected: FAIL — atoms are not yet a retrieval source, so `pack.sections` contains neither id.

- [ ] **Step 3: Add atom source weight to `policy.ts`**

Edit `src/retrieval/policy.ts`. Find `DEFAULT_POLICY.sourceWeights` and add `atoms` after `memory`:

```typescript
  sourceWeights: {
    metadata: 0.30,
    lexical:  0.22,
    memory:   0.15,
    atoms:    0.20,
    vector:   0.18,
    graph:    0.10,
    worktree: 0.15,
  },
```

(Adjust other weights to keep them sensible — exact values are calibration; this is a starting point that `calibrate-fusion` will tune later.)

Add a tier multiplier export at the bottom of `policy.ts`:

```typescript
export { TIER_RANK_MULTIPLIERS } from '../atoms/tier.js';
```

- [ ] **Step 4: Wire atoms into `findCandidates`**

Edit `src/retrieval/service.ts`. In `findCandidates`, after the existing `Promise.all` that gathers `[metadata, lexical, memory, vector, worktree]`, add an atom lookup using the classified trigger:

```typescript
    const atomResults = await timed(
      'atoms',
      this.searchAtomCandidates(classified, options, project),
      debug,
    );
```

Add the helper method to `RetrievalService`:

```typescript
  private async searchAtomCandidates(
    classified: ClassifiedQuery,
    options: SearchOptions,
    project?: string,
  ): Promise<SearchCandidate[]> {
    const atoms = await this.store.searchAtomsByTrigger(
      {
        errors:    classified.errors,
        files:     classified.files,
        symbols:   classified.symbols,
        taskTypes: classified.taskType ? [classified.taskType] : undefined,
      },
      { project, limit: options.limit },
    );
    return atoms.map((atom, index) => ({
      knowledgeId: atom.id,
      source: 'atoms',
      rank: index + 1,
      rawScore: TIER_RANK_MULTIPLIERS[atom.tier],
      title: atom.claim,
      summary: atom.claim,
      itemType: 'memory',
      project: atom.project,
      labels: [],
      references: atom.evidence
        .filter((e): e is Extract<typeof e, { kind: 'file' }> => e.kind === 'file')
        .map((e) => ({ type: 'file' as const, uri: e.path, lineStart: e.lineStart, lineEnd: e.lineEnd })),
      content: atom.claim,
      contextualContent: atom.claim,
      tokenEstimate: Math.ceil(atom.claim.length / 4),
      metadata: { atomTier: atom.tier, atomType: atom.type },
    }));
  }
```

Add `atoms` to the `safeResults` object and pass it into `rankCandidates` candidate groups (in `KnowledgeSearchResult`, add `atoms: SearchCandidate[]` if not present; update `rankCandidates` to include the new group between `memory` and `vector`).

In `applyRankingAdjustments`, after the existing feedback-summary application, apply the tier multiplier when a candidate's `source` is `'atoms'`:

```typescript
      .map((candidate) => {
        if (candidate.source !== 'atoms') return candidate;
        const tier = (candidate.metadata as { atomTier?: AtomTier } | undefined)?.atomTier;
        if (!tier) return candidate;
        const multiplier = TIER_RANK_MULTIPLIERS[tier];
        return { ...candidate, finalScore: candidate.finalScore * multiplier };
      })
```

Imports needed at top:

```typescript
import { TIER_RANK_MULTIPLIERS } from './policy.js';
import type { AtomTier } from '../types/atoms.js';
```

- [ ] **Step 5: Add `verifiedAtom` evidence category in `context-pack.ts`**

Edit `src/retrieval/context-pack.ts`. Where `evidenceCategory` is computed for each candidate (search for `evidenceCategory:`), add a branch:

```typescript
  if (candidate.source === 'atoms') {
    const tier = (candidate.metadata as { atomTier?: AtomTier } | undefined)?.atomTier;
    if (tier === 'verified' || tier === 'canonical') {
      return 'verifiedAtom';
    }
  }
```

Update the sort order in pack assembly: `verifiedAtom` sorts ahead of `directTaskEvidence`. Find the priority table and add:

```typescript
const EVIDENCE_PRIORITY: Record<EvidenceCategory, number> = {
  verifiedAtom: 0,
  directTaskEvidence: 1,
  priorLessons: 2,
  workflowGuidance: 3,
  adjacentContext: 4,
};
```

Also extend the `EvidenceCategory` union in `src/types.ts` (or wherever it lives) to include `'verifiedAtom'`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-retrieval.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full retrieval eval**

Run: `pnpm run eval:retrieval`
Expected: PASS — `hitRate=1`, `staleRejectionRate=1`. If any classification or stale-rejection rate dips, the atom source weight or tier multiplier is interacting badly. Investigate before continuing.

- [ ] **Step 8: Add an eval fixture asserting atom tier ranking**

Edit `eval/retrieval-fixtures.json`. Add a new fixture case:

```jsonc
{
  "name": "verified atom outranks draft atom for same trigger",
  "ingest": {
    "atoms": [
      { "claim": "Draft.",    "type": "fact", "evidence": [{"kind":"file","path":"a.ts"}], "trigger": {"errors":["foo error"]}, "tier": "draft" },
      { "claim": "Verified.", "type": "fact", "evidence": [{"kind":"file","path":"b.ts"}], "trigger": {"errors":["foo error"]}, "tier": "verified", "verification": {"command":"x"}, "reuseCount": 2 }
    ]
  },
  "query": { "prompt": "hitting foo error", "errors": ["foo error"] },
  "expect": { "topKnowledgeIdsContain": ["Verified."], "verifiedAboveDraft": true }
}
```

If `eval/retrieval-fixtures.json` does not currently support an `atoms` ingest field, extend `eval/retrieval.ts` (the eval runner) to call `store.createAtom` per atom in `ingest.atoms`. The runner change is small — locate the existing ingest loop and add an atom branch.

- [ ] **Step 9: Re-run retrieval eval**

Run: `pnpm run eval:retrieval`
Expected: PASS including the new fixture.

- [ ] **Step 10: Commit**

```bash
git add src/retrieval/service.ts src/retrieval/policy.ts src/retrieval/context-pack.ts src/types.ts test/atoms-retrieval.test.ts eval/retrieval-fixtures.json eval/retrieval.ts
git commit -m "feat(atoms): retrieval integration with tier-weighted ranking"
```

---

## Task 9: Hook AtomExtractor into `finishSession`

**Files:**
- Modify: `src/agent-session/service.ts`
- Test: `test/atoms-finish-session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/atoms-finish-session.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { AgentSessionService } from '../src/agent-session/service.js';
import { defaultConfig } from '../src/config.js';

test('finishSession: extracts atoms via configured extractor and stores valid ones', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: 'Use pnpm run eval:retrieval before changing fusion weights.',
    type: 'convention',
    evidence: [{ kind: 'file', path: 'eval/retrieval-fixtures.json' }],
    trigger: { taskTypes: ['refactor'], files: ['src/retrieval/fusion.ts'] },
    verification: { command: 'pnpm run eval:retrieval' },
  }]);
  const retrieval = new RetrievalService(store, cache, models, defaultConfig());
  const session = await store.createAgentSession({
    prompt: 'refactor fusion weights',
    project: 'tuberosa',
  });
  const service = new AgentSessionService(store, retrieval, models, defaultConfig());
  await service.finishSession({
    sessionId: session.id,
    outcome: 'completed',
    summary: 'tuned weights and ran eval',
  });
  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].audit.producedAtSessionId, session.id);
});
```

(Adjust the `AgentSessionService` constructor signature to match the existing one — if it does not currently accept `models` or a `config`, add them or thread an `AtomExtractor` through differently. Read `src/agent-session/service.ts` and follow the existing wiring pattern.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-finish-session.test.ts`
Expected: FAIL — finishSession does not extract atoms yet.

- [ ] **Step 3: Wire `AtomExtractor` into `AgentSessionService.finishSession`**

Edit `src/agent-session/service.ts`. Construct an `AtomExtractor` in the service constructor (or accept one via DI). After the existing `createSessionLearning` call but before `finishAgentSession`, call:

```typescript
    const extractor = new AtomExtractor(this.store, this.models, new AtomCritic(this.store, this.models));
    const atomResult = await extractor.extractFromSession({
      project: existingSession.project ?? 'unknown',
      sessionId: input.sessionId,
      sessionPrompt: existingSession.prompt,
      summary: input.summary,
      changedFiles: input.changedFiles,
      verificationCommands: input.verificationCommands,
    });
```

For each rejected candidate, create a `KnowledgeGap` so the failure is observable (per spec §6 last bullet):

```typescript
    for (const rejected of atomResult.rejected) {
      await this.store.createKnowledgeGap({
        project: rejected.candidate.project,
        sourceSessionId: input.sessionId,
        prompt: existingSession.prompt,
        reason: rejected.result.reasons.join('; '),
        metadata: { source: 'atom_critic', candidate: rejected.candidate },
      });
    }
```

Add imports:

```typescript
import { AtomExtractor } from '../atoms/extractor.js';
import { AtomCritic } from '../atoms/critic.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-finish-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS. Pay attention to the existing `test/agent-session.test.ts` — atom extraction must not break the reflection-draft path.

- [ ] **Step 6: Commit**

```bash
git add src/agent-session/service.ts test/atoms-finish-session.test.ts
git commit -m "feat(atoms): extract atoms during finishSession; reject paths emit knowledge gaps"
```

---

## Task 10: Legacy migration runner

**Files:**
- Create: `src/atoms/migration.ts`
- Create: `scripts/migrate-knowledge-to-atoms.ts`
- Modify: `package.json`
- Test: `test/atoms-migration.test.ts`

- [ ] **Step 1: Write the failing migration test**

Create `test/atoms-migration.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { AtomCritic } from '../src/atoms/critic.js';
import { migrateLegacyKnowledge } from '../src/atoms/migration.js';

test('migrateLegacyKnowledge: re-extracts memory items into atoms and marks originals legacy_replaced', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: 'pgvector ivfflat lists should be rowcount / 1000.',
    type: 'convention',
    evidence: [{ kind: 'file', path: 'docs/pgvector.md' }],
    trigger: { taskTypes: ['refactor'], symbols: ['ivfflat'] },
  }]);
  await store.upsertKnowledge({
    project: 'tuberosa',
    sourceType: 'manual',
    sourceUri: 'tuberosa://m1',
    itemType: 'memory',
    title: 'pgvector tuning notes',
    summary: '',
    content: 'When tuning pgvector ivfflat, use lists = rowcount / 1000.',
    labels: [],
    references: [],
    metadata: {},
  }, []);

  const report = await migrateLegacyKnowledge(store, models, new AtomCritic(store, models), { project: 'tuberosa', dryRun: false });

  assert.equal(report.atomsCreated, 1);
  assert.equal(report.legacyReplaced, 1);
  assert.equal(report.legacyArchived, 0);
  const items = await store.listKnowledge({ project: 'tuberosa', limit: 10 });
  assert.equal(items[0].metadata.legacyStatus ?? items[0].status, 'legacy_replaced');
});

test('migrateLegacyKnowledge dryRun: produces a report without writing atoms', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: 'Use the freshness-policy module for stale checks.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'src/retrieval/policy.ts' }],
    trigger: { symbols: ['freshnessWindowFor'] },
  }]);
  await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'tuberosa://m2', itemType: 'memory',
    title: 'freshness', summary: '', content: 'freshness check uses freshnessWindowFor', labels: [], references: [], metadata: {},
  }, []);

  const report = await migrateLegacyKnowledge(store, models, new AtomCritic(store, models), { project: 'tuberosa', dryRun: true });

  assert.equal(report.atomsCreated, 1);
  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 0, 'dry-run must not write atoms');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-migration.test.ts`
Expected: FAIL — `migrateLegacyKnowledge` does not exist.

- [ ] **Step 3: Implement `migrateLegacyKnowledge`**

Create `src/atoms/migration.ts`:

```typescript
import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { AtomCritic } from './critic.js';
import type { KnowledgeAtomInput, KnowledgeAtom } from '../types/atoms.js';

const MIGRATABLE_ITEM_TYPES = new Set(['memory', 'bugfix', 'rule']);

export interface MigrationOptions {
  project?: string;
  dryRun?: boolean;
  batchSize?: number;
}

export interface MigrationReport {
  scanned: number;
  atomsCreated: number;
  legacyReplaced: number;
  legacyArchived: number;
  failures: Array<{ knowledgeId: string; reason: string }>;
}

export async function migrateLegacyKnowledge(
  store: KnowledgeStore,
  models: ModelProvider,
  critic: AtomCritic,
  options: MigrationOptions,
): Promise<MigrationReport> {
  const report: MigrationReport = {
    scanned: 0,
    atomsCreated: 0,
    legacyReplaced: 0,
    legacyArchived: 0,
    failures: [],
  };

  const batchSize = options.batchSize ?? 50;
  const items = await store.listKnowledge({ project: options.project, limit: batchSize });

  if (!models.extractAtoms) {
    return report;
  }

  for (const item of items) {
    if (!MIGRATABLE_ITEM_TYPES.has(item.itemType)) continue;
    if (item.metadata?.migratedAt) continue;
    report.scanned += 1;

    const candidates = await models.extractAtoms({
      project: item.project,
      sessionPrompt: item.title,
      summary: item.summary,
    });

    const createdAtoms: KnowledgeAtom[] = [];
    for (const candidate of candidates) {
      const candidateInput: KnowledgeAtomInput = {
        project: item.project,
        parentKnowledgeId: item.id,
        claim: candidate.claim,
        type: candidate.type,
        evidence: candidate.evidence as KnowledgeAtomInput['evidence'],
        trigger: candidate.trigger,
        verification: candidate.verification,
        pitfalls: candidate.pitfalls,
        producedBy: 'migration_llm',
      };
      const result = await critic.evaluate(candidateInput);
      if (!result.ok) continue;
      if (options.dryRun) {
        report.atomsCreated += 1;
      } else {
        createdAtoms.push(await store.createAtom(candidateInput));
        report.atomsCreated += 1;
      }
    }

    const legacyStatus = createdAtoms.length > 0 || (options.dryRun && candidates.length > 0)
      ? 'legacy_replaced'
      : 'legacy_archived';

    if (!options.dryRun) {
      await store.updateKnowledge(item.id, {
        metadata: { ...item.metadata, legacyStatus, migratedAt: new Date().toISOString() },
      });
    }

    if (legacyStatus === 'legacy_replaced') report.legacyReplaced += 1;
    else report.legacyArchived += 1;
  }

  return report;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the CLI script**

Create `scripts/migrate-knowledge-to-atoms.ts`:

```typescript
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { StorageFactory } from '../src/storage/factory.js';
import { ModelProviderFactory } from '../src/model/provider.js';
import { AtomCritic } from '../src/atoms/critic.js';
import { migrateLegacyKnowledge } from '../src/atoms/migration.js';
import { loadConfig } from '../src/config.js';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'batch-size': { type: 'string', default: '50' },
    report: { type: 'string', default: 'docs/migration-report.md' },
  },
});

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await StorageFactory.create(config);
  const models = ModelProviderFactory.create(config);
  const critic = new AtomCritic(store, models);

  const report = await migrateLegacyKnowledge(store, models, critic, {
    project: values.project,
    dryRun: Boolean(values['dry-run']),
    batchSize: Number(values['batch-size']),
  });

  const markdown = [
    `# Knowledge Atom Migration Report`,
    ``,
    `**Project:** ${values.project ?? 'all'}`,
    `**Mode:** ${values['dry-run'] ? 'dry-run' : 'apply'}`,
    `**Generated:** ${new Date().toISOString()}`,
    ``,
    `- Scanned: ${report.scanned}`,
    `- Atoms created: ${report.atomsCreated}`,
    `- Legacy replaced: ${report.legacyReplaced}`,
    `- Legacy archived: ${report.legacyArchived}`,
    `- Failures: ${report.failures.length}`,
  ].join('\n');

  await writeFile(values.report ?? 'docs/migration-report.md', markdown, 'utf8');
  console.log(markdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

(If `StorageFactory.create` and `ModelProviderFactory.create` are not the exact names in the repo, update the imports to match what `src/storage/factory.ts` and `src/model/provider.ts` actually export.)

- [ ] **Step 6: Add npm script**

Edit `package.json`. In `"scripts"`, add:

```json
    "migrate-knowledge-to-atoms": "node --import tsx scripts/migrate-knowledge-to-atoms.ts"
```

- [ ] **Step 7: Smoke-test the CLI in dry-run**

Run: `pnpm run migrate-knowledge-to-atoms -- --project tuberosa --dry-run --report /tmp/migration-report.md`
Expected: exits 0; `/tmp/migration-report.md` exists with the summary.

- [ ] **Step 8: Commit**

```bash
git add src/atoms/migration.ts scripts/migrate-knowledge-to-atoms.ts test/atoms-migration.test.ts package.json
git commit -m "feat(atoms): legacy knowledge migration CLI + report"
```

---

## Task 11: Apply retrieval suppression for `legacy_archived` and grace-period weight for `legacy_replaced`

**Files:**
- Modify: `src/retrieval/service.ts`
- Modify: `src/retrieval/policy.ts`
- Test: extend `test/atoms-retrieval.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/atoms-retrieval.test.ts`:

```typescript
test('retrieval: legacy_archived knowledge items are excluded from candidates', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, defaultConfig());

  const item = await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u', itemType: 'memory',
    title: 'old', summary: 'old', content: 'old memory about vector dimension mismatch', labels: [], references: [], metadata: {},
  }, []);
  await store.updateKnowledge(item.id, { metadata: { ...item.metadata, legacyStatus: 'legacy_archived' } });

  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'hitting vector dimension mismatch on insert',
    errors: ['vector dimension mismatch'],
  });
  const ids = pack.sections.flatMap((s) => s.items.map((i) => i.knowledgeId));
  assert.ok(!ids.includes(item.id), `legacy_archived item must not be in pack: ${ids.join(',')}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-retrieval.test.ts`
Expected: FAIL — legacy items still surface.

- [ ] **Step 3: Add a legacy filter in `applyRankingAdjustments`**

Edit `src/retrieval/service.ts`. In `applyRankingAdjustments`, before the existing feedback-summary step:

```typescript
    candidates = candidates.filter((candidate) => {
      const legacy = (candidate.metadata as { legacyStatus?: 'legacy_archived' | 'legacy_replaced' } | undefined)?.legacyStatus;
      return legacy !== 'legacy_archived';
    });
```

For `legacy_replaced`, apply a × 0.2 multiplier:

```typescript
      .map((candidate) => {
        const legacy = (candidate.metadata as { legacyStatus?: string } | undefined)?.legacyStatus;
        if (legacy === 'legacy_replaced') {
          return { ...candidate, finalScore: candidate.finalScore * 0.2 };
        }
        return candidate;
      })
```

Both pieces require that store candidate-builders (in `memory-store.ts` and `postgres-store.ts`) include `legacyStatus` from item metadata in `SearchCandidate.metadata`. Patch the search candidate constructors to copy this through:

```typescript
metadata: { ...item.metadata, legacyStatus: item.metadata?.legacyStatus }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-retrieval.test.ts`
Expected: PASS, including the existing tier-ranking test.

- [ ] **Step 5: Re-run retrieval eval**

Run: `pnpm run eval:retrieval`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/retrieval/service.ts src/storage/memory-store.ts src/storage/postgres-store.ts test/atoms-retrieval.test.ts
git commit -m "feat(atoms): exclude legacy_archived; downweight legacy_replaced during grace"
```

---

## Task 12: Record atom-reuse events on `selected` feedback

**Files:**
- Modify: `src/retrieval/service.ts`
- Test: append to `test/atoms-retrieval.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/atoms-retrieval.test.ts`:

```typescript
test('selected feedback on a pack increments reuseCount on contained atoms', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, defaultConfig());

  const atom = await store.createAtom({
    project: 'tuberosa',
    claim: 'Some claim.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['some error'] },
    producedBy: 'agent_session',
  });

  const pack = await service.searchContext({
    project: 'tuberosa', prompt: 'hit some error', errors: ['some error'],
  });
  assert.ok(pack.sections.flatMap((s) => s.items).some((i) => i.knowledgeId === atom.id));

  await service.recordFeedback({
    contextPackId: pack.id,
    project: 'tuberosa',
    feedbackType: 'selected',
  });

  const refreshed = await store.getAtom(atom.id);
  assert.equal(refreshed?.reuseCount, 1);
  assert.ok(refreshed?.lastReusedAt);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-retrieval.test.ts`
Expected: FAIL — `reuseCount` stays at 0.

- [ ] **Step 3: Increment reuse on selected feedback**

Edit `src/retrieval/service.ts`. In `recordFeedback`, after `recordFeedbackLearning`, when `feedbackType ∈ ('selected', 'selected_but_noisy')` and a pack is present, iterate items and call `store.incrementAtomReuse` for any item whose `source === 'atoms'`:

```typescript
    if ((input.feedbackType === 'selected' || input.feedbackType === 'selected_but_noisy') && pack) {
      const now = new Date().toISOString();
      const atomIds = pack.sections
        .flatMap((s) => s.items)
        .filter((item) => (item.metadata as { atomTier?: string } | undefined)?.atomTier)
        .map((item) => item.knowledgeId);
      for (const id of atomIds) {
        const updated = await this.store.incrementAtomReuse(id, now);
        if (updated) {
          const nextTier = evaluateTierTransition(updated, new Date(now));
          if (nextTier !== updated.tier) {
            await this.store.updateAtom(id, { tier: nextTier });
          }
        }
      }
    }
```

Import:

```typescript
import { evaluateTierTransition } from '../atoms/tier.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-retrieval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/service.ts test/atoms-retrieval.test.ts
git commit -m "feat(atoms): increment atom reuseCount on selected feedback; auto-promote on threshold"
```

---

## Task 13: Final verification — full eval and integration suite

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 2: Run the retrieval eval**

Run: `pnpm run eval:retrieval`
Expected: PASS — `hitRate=1`, `staleRejectionRate=1`, all classification rates at 1.

- [ ] **Step 3: Run the agent context eval**

Run: `pnpm run eval:agent-context`
Expected: PASS.

- [ ] **Step 4: Run integration tests if Docker is up**

Run: `pnpm run test:integration`
Expected: PASS or skipped.

- [ ] **Step 5: Verify migration CLI on real data (dry-run)**

Run: `pnpm run migrate-knowledge-to-atoms -- --dry-run --report /tmp/migration-report.md`
Expected: exits 0; `/tmp/migration-report.md` shows scanned/created/replaced/archived counts.

- [ ] **Step 6: Commit any final touch-ups**

If any of the eval runs produced fixture additions or policy tweaks, commit them:

```bash
git add -A
git commit -m "test(atoms): close out implementation with green eval suite"
```

---

## Follow-up (deferred, intentionally not in this plan)

These are valuable but not required to ship the spec:

- **OpenAI/Ollama `extractAtoms` implementations.** The `ModelProvider.extractAtoms` interface is in place; production providers can implement it with structured-output prompts. Until then, `extractAtoms` is undefined for non-hash providers and `AtomExtractor.extractFromSession` returns `{ stored: [], rejected: [] }` — safe no-op.
- **Workbench UI for canonical-tier promotion.** A button per atom that flips `tier='canonical'` after a human confirms `links.length >= 2`. Currently a manual `updateAtom` call.
- **HTTP routes** `/atoms`, `GET /atoms/:id`, `POST /atoms/:id/promote`. Easy add once tier-promotion review surfaces are designed in concern D.
- **MCP tools** `tuberosa_list_atoms`, `tuberosa_promote_atom`. Optional; agents primarily consume atoms through normal `tuberosa_search_context`.
