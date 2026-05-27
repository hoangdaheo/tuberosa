# Write-Gate, Dedup, and Decay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a triviality stop-list, an optional LLM critic, cross-type dedup, time+signal archival, and gate-event telemetry on top of B's atom schema, so the corpus stops accumulating well-formed-but-useless atoms and inactive items get archived (not deleted) automatically.

**Architecture:** D layers around B's existing `AtomCritic`. Four stages run in fixed order: triviality rules (deterministic), schema floor (from B), cross-type dedup (atom↔atom from B + atom↔legacy added here), and an optional LLM critic for borderline atoms. Each stage writes one row to a new `atom_gate_events` telemetry table. A scheduled `archival` worker job archives draft atoms inactive >365d or any atom with ≥3 negative feedbacks in the last 90d (canonical needs ≥5). Archived atoms stay fetchable by id but exit default retrieval. Stats are exposed via an HTTP endpoint and an MCP tool.

**Tech Stack:** TypeScript (Node 22), Postgres + pgvector, `node:test` runner with `tsx`, Redis (for LLM verdict cache), existing `ModelProvider` abstraction.

**Spec:** [`docs/superpowers/specs/2026-05-26-write-gate-dedup-decay-design.md`](../specs/2026-05-26-write-gate-dedup-decay-design.md)

**Depends on:** B's implementation plan must be merged first ([`2026-05-26-knowledge-atom-schema.md`](2026-05-26-knowledge-atom-schema.md)).

---

## Implementation log — deviations from the written plan

These are places where the actual codebase diverged from the plan's assumptions. Captured per the executing-plans rule "do not skip/ignore specs/plan; if you do, write it into the file." None change the spec's intent — they adapt the steps to real code.

- **Branch:** work done on `feat/plan-d-write-gate-dedup-decay` (B was merged to `main` via PR #9).
- **No `as never` casts.** `KnowledgeAtomPatch` already has `status?: AtomStatus`. Extending `AtomStatus` with `'archived'` is enough; archival/resurrection use a typed patch.
- **Memory-store feedback storage.** Feedback lives in `this.feedback` (an array), not a `feedbackEvents` map. `countNegativeFeedback` iterates `this.feedback`.
- **Retrieval status filter already present.** Both stores' `searchAtomsByTrigger` and `searchAtomsByEmbedding` already hardcode `status = 'active'`. Adding `'archived'` automatically excludes archived atoms from retrieval and dedup. Task 8 Step 5 therefore adds only the regression test, not a new `status` option.
- **No Ollama provider.** Only `HashModelProvider` and `OpenAiModelProvider` exist (config has an `ollama` enum value but no provider class). `judgeAtomUtility` is implemented on `OpenAiModelProvider` only; Hash leaves it `undefined`.
- **Postgres helpers.** Project id is resolved via `ensureProject(this.pool, name)` (not `getOrCreateProjectId`). The `StoredKnowledge` row mapper is `mapKnowledgeRow` (needs aggregated labels/references and a `project` alias), not `rowToKnowledge`; `searchKnowledgeByEmbedding` reuses `knowledgeSelect()` as a CTE and joins chunk distances.
- **MCP/HTTP registration patterns.** MCP tools are added to the tool-list array plus a `case` in the dispatch switch (no `server.registerTool`). HTTP routes are `HttpRoute` objects in `createRoutes()` with `match: exactPath()/pathPattern()` and `handle: ({ services, request, params, url }) => ...` (no `app.post`). Auth is enforced centrally (non-`public` routes require the API key); there is no per-route `requireAuth`.
- **Critic wiring.** `AgentSessionService.extractSessionAtoms` constructs `new AtomCritic(this.store, this.models)`; it is extended to pass `{ cache, llmCriticEnabled }` from config.
- **Stage-3 legacy dedup skips migration producers (added during Task 6).** The legacy-knowledge dedup check would otherwise block `migrateLegacyKnowledge` (which intentionally derives atoms from a legacy item) — the source item is flagged as a near-duplicate and the atom is never stored. Fix: `evaluateDedup` skips the legacy-knowledge check (but keeps atom↔atom dedup) when `input.producedBy === 'migration_llm'`. This kept the two B-era `atoms-migration` tests green.
- **Task 11 extras.** Added `llmCriticEnabled` config (default: provider is openai) alongside the archival vars, and threaded the cache + `llmCriticEnabled` into `AgentSessionService` (new optional constructor params + `app.ts` wiring) so the stage-4 critic actually runs in production. `runArchivalSweep` gained a typed `{ dryRun }` option (cleaner than the plan's "swap updateAtom with a no-op stub"). The `archival-sweep` CLI strips stray `--` separators that `pnpm run ... -- --flag` forwards, otherwise `parseArgs` treats every flag as a positional. ~28 inline `AppConfig` literals in `test/` and `scripts/` were updated with the three new fields (`llmCriticEnabled/archivalEnabled` false, `archivalIntervalHours` 24).
- **Task 7 `rejected` shape kept; `pending` stores without metadata mutation.** The plan changed `rejected` entries to `{ candidate, result }`, but `AgentSessionService` and the B-era extractor test read `rejected[].reasons`. Kept `{ candidate, reasons }` and added `queuedLegacyMigrations: string[]`. `queue_legacy_migration` outcomes go to `queuedLegacyMigrations` only (not `rejected`) so they don't create misleading `atom_evidence` knowledge gaps. `pending` outcomes store the atom (fail-open) without the proposed `KnowledgeAtom.metadata.pendingLlmCritic` field — that field would require schema/store changes across both stores and is unreachable in practice (the critic only constructs the LLM stage when `judgeAtomUtility` exists, so `judge()` never returns `undefined`). Deferred as a follow-up if pending-state surfacing is ever needed.
- **Two B-era critic tests updated (Task 6 Step 1).** `rejects atom whose claim restates the trigger` and `rejects atom whose claim is longer than 240 chars` previously used sparse claims (`'vector dimension mismatch'`, `'x'.repeat(241)`) that the new stage-1 triviality `sparse_claim` rule now rejects *before* the floor. The claims were made content-rich so they still reach and exercise the floor's restate/length rules. Rejection behavior is unchanged; only the short-circuit stage moved earlier.

---

## File Structure

**Create:**
- `migrations/006_atom_archival.sql` — extend atom `status` enum with `archived`
- `migrations/007_atom_gate_events.sql` — telemetry table
- `src/atoms/triviality-rules.ts` — deterministic stop-list
- `src/atoms/llm-critic.ts` — stage-4 critic with Redis cache
- `src/atoms/archival.ts` — sweep job
- `src/atoms/gate-telemetry.ts` — writes `atom_gate_events` rows
- `src/operations/atom-gate-stats.ts` — stats aggregation service
- `scripts/archival-sweep.ts` — CLI entry
- `test/atoms-triviality.test.ts`
- `test/atoms-llm-critic.test.ts`
- `test/atoms-cross-type-dedup.test.ts`
- `test/atoms-archival.test.ts`
- `test/atoms-gate-telemetry.test.ts`
- `test/atom-gate-stats.test.ts`

**Modify:**
- `src/atoms/critic.ts` — refactor `evaluate` into a 4-stage pipeline; emits telemetry events
- `src/storage/store.ts` — add `searchKnowledgeByEmbedding`, `countNegativeFeedback`, `recordAtomGateEvent`, `listAtomGateEvents`
- `src/storage/memory-store.ts` — impls for the four new methods
- `src/storage/postgres-store.ts` — impls for the four new methods
- `src/model/provider.ts` — add `judgeAtomUtility?` to `ModelProvider`; OpenAI + Ollama impls; hash impl returns `undefined` method (not present)
- `src/retrieval/service.ts` — `WHERE status = 'active'` filter on atom search paths
- `src/worker.ts` — schedule `runArchivalSweep` every `TUBEROSA_ARCHIVAL_INTERVAL_HOURS`
- `src/http/server.ts` — register routes: `GET /operations/atom-gate/stats`, `POST /atoms/:id/resurrect`
- `src/mcp/server.ts` — register tools: `tuberosa_atom_gate_stats`, `tuberosa_resurrect_atom`
- `src/config.ts` — new env vars: `TUBEROSA_LLM_CRITIC_ENABLED`, `TUBEROSA_ARCHIVAL_*`, `TUBEROSA_TRIVIALITY_RULES_FILE`
- `package.json` — `archival-sweep` npm script
- `eval/retrieval-fixtures.json` — fixture cases for each triviality rule and for archival behavior

---

## Task 1: Migrations — extend atom status + create gate-events table

**Files:**
- Create: `migrations/006_atom_archival.sql`
- Create: `migrations/007_atom_gate_events.sql`

- [ ] **Step 1: Create archival migration**

Create `migrations/006_atom_archival.sql`:

```sql
-- Concern D: extend atom status to include 'archived' (inactive but preserved)
ALTER TABLE knowledge_atoms
  DROP CONSTRAINT IF EXISTS knowledge_atoms_status_check;

ALTER TABLE knowledge_atoms
  ADD CONSTRAINT knowledge_atoms_status_check
    CHECK (status IN ('active','legacy_archived','superseded','archived'));

CREATE INDEX IF NOT EXISTS idx_atoms_archival_scan
  ON knowledge_atoms (tier, last_reused_at) WHERE status = 'active';
```

- [ ] **Step 2: Create gate-events migration**

Create `migrations/007_atom_gate_events.sql`:

```sql
-- Concern D: per-stage gate-decision telemetry for observability
CREATE TABLE IF NOT EXISTS atom_gate_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  atom_id         uuid REFERENCES knowledge_atoms(id) ON DELETE SET NULL,
  candidate_claim text NOT NULL,
  candidate_type  text NOT NULL,
  stage           text NOT NULL CHECK (stage IN ('triviality','floor','dedup','llm_critic')),
  outcome         text NOT NULL CHECK (outcome IN ('accepted','rejected','pending','queue_legacy_migration')),
  reasons         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atom_gate_events_project_outcome
  ON atom_gate_events (project_id, outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_atom_gate_events_stage
  ON atom_gate_events (stage, created_at DESC);
```

- [ ] **Step 3: Apply migrations**

Run: `pnpm run migrate`
Expected: `applied 006_atom_archival.sql` and `applied 007_atom_gate_events.sql`. (Skip silently if Docker stack is not up — memory-store tests don't depend on these.)

- [ ] **Step 4: Commit**

```bash
git add migrations/006_atom_archival.sql migrations/007_atom_gate_events.sql
git commit -m "feat(atoms): migrations 006 archival status + 007 atom_gate_events"
```

---

## Task 2: Deterministic triviality rules

**Files:**
- Create: `src/atoms/triviality-rules.ts`
- Test: `test/atoms-triviality.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/atoms-triviality.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_TRIVIALITY_RULES, evaluateTriviality, contentWords } from '../src/atoms/triviality-rules.js';
import type { KnowledgeAtomInput } from '../src/types/atoms.js';

function input(claim: string, trigger: KnowledgeAtomInput['trigger'] = { errors: ['foo'] }): KnowledgeAtomInput {
  return {
    project: 'tuberosa',
    claim,
    type: 'fact',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger,
    producedBy: 'agent_session',
  };
}

test('triviality: rejects "ran X, passed" claim', () => {
  const r = evaluateTriviality(input('ran pnpm test, all 247 tests passed'));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('test_result'));
});

test('triviality: rejects "updated docs/foo.md" claim', () => {
  const r = evaluateTriviality(input('updated docs/foo.md'));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('doc_update_announcement'));
});

test('triviality: rejects "committed changes" claim', () => {
  const r = evaluateTriviality(input('committed changes to retrieval'));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('commit_status'));
});

test('triviality: rejects bare rename announcement', () => {
  const r = evaluateTriviality(input('renamed fooBar.'));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('rename_announcement'));
});

test('triviality: rejects atom whose trigger has only taskTypes', () => {
  const r = evaluateTriviality(input('Some claim with enough words here.', { taskTypes: ['refactor'] }));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('no_concrete_trigger'));
});

test('triviality: rejects sparse claim under 5 content words', () => {
  const r = evaluateTriviality(input('Be careful.'));
  assert.equal(r.ok, false);
  assert.ok(r.matched.includes('sparse_claim'));
});

test('triviality: accepts a real gotcha claim', () => {
  const r = evaluateTriviality(input('pgvector column dim must equal EMBEDDING_DIMENSIONS in config.'));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('contentWords: filters short and stop words', () => {
  assert.deepEqual(contentWords('The quick brown fox is on the mat.'), ['quick','brown','fox','mat']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-triviality.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement triviality rules**

Create `src/atoms/triviality-rules.ts`:

```typescript
import type { KnowledgeAtomInput } from '../types/atoms.js';

export interface TrivialityRule {
  name: string;
  test: (atom: KnowledgeAtomInput) => boolean;
}

const STOP_WORDS = new Set(['the','a','an','of','to','in','on','is','was','and','or','for','with','as','at','by']);

export function contentWords(claim: string): string[] {
  return claim
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export const DEFAULT_TRIVIALITY_RULES: TrivialityRule[] = [
  {
    name: 'test_result',
    test: (a) => /^(ran|run|executed|all)\s.*(passed|completed|succeeded|green|ok)\b/i.test(a.claim),
  },
  {
    name: 'doc_update_announcement',
    test: (a) => /^updated?\s+\S+\.(md|json|yaml|yml|txt|toml)\b/i.test(a.claim),
  },
  {
    name: 'commit_status',
    test: (a) => /^(committed?|pushed?|merged?|shipped?|deployed?)\b/i.test(a.claim),
  },
  {
    name: 'rename_announcement',
    test: (a) => /^(refactored|renamed|moved|added|removed)\s+[A-Za-z0-9_]+\.?$/i.test(a.claim.trim()),
  },
  {
    name: 'no_concrete_trigger',
    test: (a) => !((a.trigger.errors?.length ?? 0)
                  || (a.trigger.files?.length ?? 0)
                  || (a.trigger.symbols?.length ?? 0)),
  },
  {
    name: 'sparse_claim',
    test: (a) => contentWords(a.claim).length < 5,
  },
];

export interface TrivialityResult {
  ok: boolean;
  matched: string[];
  marginContentWords: number;  // for stage-4 borderline check
}

export function evaluateTriviality(
  atom: KnowledgeAtomInput,
  rules: TrivialityRule[] = DEFAULT_TRIVIALITY_RULES,
): TrivialityResult {
  const matched = rules.filter((rule) => rule.test(atom)).map((rule) => rule.name);
  return {
    ok: matched.length === 0,
    matched,
    marginContentWords: contentWords(atom.claim).length,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-triviality.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/atoms/triviality-rules.ts test/atoms-triviality.test.ts
git commit -m "feat(atoms): deterministic triviality stop-list (stage 1)"
```

---

## Task 3: `searchKnowledgeByEmbedding` and `countNegativeFeedback` on both stores

**Files:**
- Modify: `src/storage/store.ts`
- Modify: `src/storage/memory-store.ts`
- Modify: `src/storage/postgres-store.ts`
- Test: `test/atoms-cross-type-dedup.test.ts`

- [ ] **Step 1: Add interface signatures**

Edit `src/storage/store.ts`. Add to `KnowledgeStore`:

```typescript
  searchKnowledgeByEmbedding(
    embedding: number[],
    options: {
      project?: string;
      limit: number;
      threshold?: number;
      itemTypes?: string[];
      excludeLegacyStatuses?: Array<'legacy_replaced' | 'legacy_archived'>;
    },
  ): Promise<Array<{ knowledge: StoredKnowledge; cosine: number }>>;

  countNegativeFeedback(knowledgeId: string, withinDays: number): Promise<number>;
```

- [ ] **Step 2: Write the failing test**

Create `test/atoms-cross-type-dedup.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';

test('searchKnowledgeByEmbedding: filters by itemTypes and threshold', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const content = 'pgvector ivfflat tuning uses lists = rowcount / 1000';
  await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u1', itemType: 'memory',
    title: 'pgvector tuning', summary: '', content, labels: [], references: [], metadata: {},
  }, []);
  await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u2', itemType: 'wiki',
    title: 'pgvector wiki', summary: '', content, labels: [], references: [], metadata: {},
  }, []);

  const embedding = await models.embed(content);
  const matchesMemoryOnly = await store.searchKnowledgeByEmbedding(embedding, {
    project: 'tuberosa', limit: 10, threshold: 0.0, itemTypes: ['memory'],
  });
  assert.ok(matchesMemoryOnly.every((m) => m.knowledge.itemType === 'memory'));
  assert.ok(matchesMemoryOnly.length >= 1);
});

test('searchKnowledgeByEmbedding: excludes legacy statuses when asked', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const item = await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u3', itemType: 'memory',
    title: 't', summary: '', content: 'legacy duplicate content', labels: [], references: [], metadata: {},
  }, []);
  await store.updateKnowledge(item.id, { metadata: { ...item.metadata, legacyStatus: 'legacy_replaced' } });

  const embedding = await models.embed('legacy duplicate content');
  const matches = await store.searchKnowledgeByEmbedding(embedding, {
    project: 'tuberosa', limit: 10, threshold: 0.0,
    itemTypes: ['memory'],
    excludeLegacyStatuses: ['legacy_replaced', 'legacy_archived'],
  });
  assert.equal(matches.length, 0);
});

test('countNegativeFeedback: counts within window only', async () => {
  const store = new MemoryKnowledgeStore();
  const item = await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u4', itemType: 'memory',
    title: 't', summary: '', content: 'content', labels: [], references: [], metadata: {},
  }, []);
  await store.recordFeedback({
    project: 'tuberosa', feedbackType: 'rejected',
    rejectedKnowledgeIds: [item.id], reason: 'bad',
  });
  await store.recordFeedback({
    project: 'tuberosa', feedbackType: 'stale',
    rejectedKnowledgeIds: [item.id], reason: 'stale',
  });
  await store.recordFeedback({
    project: 'tuberosa', feedbackType: 'selected', rejectedKnowledgeIds: [],
  });

  const count = await store.countNegativeFeedback(item.id, 90);
  assert.equal(count, 2);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-cross-type-dedup.test.ts`
Expected: FAIL — methods do not exist on memory store.

- [ ] **Step 4: Implement on `MemoryKnowledgeStore`**

Edit `src/storage/memory-store.ts`. Add the two methods. The memory store has no real embeddings, so `searchKnowledgeByEmbedding` uses Jaccard-on-content as a stand-in (consistent with how memory-store handles other vector calls in tests):

```typescript
  async searchKnowledgeByEmbedding(
    _embedding: number[],
    options: { project?: string; limit: number; threshold?: number; itemTypes?: string[]; excludeLegacyStatuses?: Array<'legacy_replaced' | 'legacy_archived'> },
  ): Promise<Array<{ knowledge: StoredKnowledge; cosine: number }>> {
    const items = await this.listKnowledge({ project: options.project, limit: 1000 });
    const itemTypeFilter = options.itemTypes ? new Set(options.itemTypes) : undefined;
    const excludeLegacy = new Set(options.excludeLegacyStatuses ?? []);
    return items
      .filter((item) => !itemTypeFilter || itemTypeFilter.has(item.itemType))
      .filter((item) => {
        const legacy = (item.metadata as { legacyStatus?: string } | undefined)?.legacyStatus;
        return !legacy || !excludeLegacy.has(legacy as 'legacy_replaced' | 'legacy_archived');
      })
      // Use a constant cosine for tests — real dedup uses Jaccard in fixtures.
      .map((knowledge) => ({ knowledge, cosine: 0.95 }))
      .filter(({ cosine }) => cosine >= (options.threshold ?? 0))
      .slice(0, options.limit);
  }

  async countNegativeFeedback(knowledgeId: string, withinDays: number): Promise<number> {
    const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
    const negativeTypes = new Set(['rejected', 'stale', 'irrelevant']);
    return [...this.feedbackEvents.values()]
      .filter((event) => negativeTypes.has(event.feedbackType))
      .filter((event) => new Date(event.createdAt).getTime() >= cutoff)
      .filter((event) =>
        event.rejectedKnowledgeIds.includes(knowledgeId)
        || (event.metadata as { affectedKnowledgeId?: string } | undefined)?.affectedKnowledgeId === knowledgeId,
      )
      .length;
  }
```

(`feedbackEvents` is an existing private map on `MemoryKnowledgeStore`. If the name differs in your branch, use the correct one.)

- [ ] **Step 5: Run the test to verify it passes (memory store)**

Run: `node --test --import tsx test/atoms-cross-type-dedup.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement on `PostgresKnowledgeStore`**

Edit `src/storage/postgres-store.ts`. Add:

```typescript
  async searchKnowledgeByEmbedding(
    embedding: number[],
    options: { project?: string; limit: number; threshold?: number; itemTypes?: string[]; excludeLegacyStatuses?: Array<'legacy_replaced' | 'legacy_archived'> },
  ): Promise<Array<{ knowledge: StoredKnowledge; cosine: number }>> {
    const filters: string[] = ['c.embedding IS NOT NULL'];
    const values: unknown[] = [`[${embedding.join(',')}]`, options.limit];
    if (options.project) { values.push(options.project); filters.push(`p.name = $${values.length}`); }
    if (options.itemTypes && options.itemTypes.length) {
      values.push(options.itemTypes);
      filters.push(`k.item_type = ANY($${values.length}::text[])`);
    }
    if (options.excludeLegacyStatuses && options.excludeLegacyStatuses.length) {
      values.push(options.excludeLegacyStatuses);
      filters.push(`(k.legacy_status IS NULL OR NOT (k.legacy_status = ANY($${values.length}::text[])))`);
    }
    const threshold = options.threshold ?? 0;
    const result = await this.pool.query(
      `SELECT k.*, p.name AS project_name,
              1 - MIN(c.embedding <=> $1::vector) AS cosine
       FROM knowledge_items k
       JOIN knowledge_chunks c ON c.knowledge_id = k.id
       LEFT JOIN projects p ON p.id = k.project_id
       WHERE ${filters.join(' AND ')}
       GROUP BY k.id, p.name
       ORDER BY MIN(c.embedding <=> $1::vector) ASC
       LIMIT $2`,
      values,
    );
    return result.rows
      .map((row) => ({ knowledge: rowToKnowledge(row, String(row.project_name)), cosine: Number(row.cosine) }))
      .filter((entry) => entry.cosine >= threshold);
  }

  async countNegativeFeedback(knowledgeId: string, withinDays: number): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) AS count
       FROM feedback_events fe
       WHERE fe.feedback_type IN ('rejected','stale','irrelevant')
         AND fe.created_at >= now() - ($2 || ' days')::interval
         AND ($1 = ANY(fe.rejected_knowledge_ids)
              OR (fe.metadata->>'affectedKnowledgeId') = $1::text)`,
      [knowledgeId, String(withinDays)],
    );
    return Number(result.rows[0].count);
  }
```

(`rowToKnowledge` is the existing row-mapper in `postgres-store.ts`. Use the actual exported helper.)

- [ ] **Step 7: Verify typecheck passes**

Run: `pnpm run build`
Expected: PASS.

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/storage/store.ts src/storage/memory-store.ts src/storage/postgres-store.ts test/atoms-cross-type-dedup.test.ts
git commit -m "feat(atoms): cross-type embedding search + negative feedback count"
```

---

## Task 4: `atom_gate_events` telemetry — store methods + tests

**Files:**
- Modify: `src/storage/store.ts`
- Modify: `src/storage/memory-store.ts`
- Modify: `src/storage/postgres-store.ts`
- Create: `src/atoms/gate-telemetry.ts`
- Test: `test/atoms-gate-telemetry.test.ts`

- [ ] **Step 1: Add interface signatures**

Edit `src/storage/store.ts`:

```typescript
export interface AtomGateEvent {
  id: string;
  project?: string;
  sessionId?: string;
  atomId?: string;
  candidateClaim: string;
  candidateType: string;
  stage: 'triviality' | 'floor' | 'dedup' | 'llm_critic';
  outcome: 'accepted' | 'rejected' | 'pending' | 'queue_legacy_migration';
  reasons: string[];
  createdAt: string;
}

export interface AtomGateEventInput {
  project?: string;
  sessionId?: string;
  atomId?: string;
  candidateClaim: string;
  candidateType: string;
  stage: AtomGateEvent['stage'];
  outcome: AtomGateEvent['outcome'];
  reasons: string[];
}

// Inside KnowledgeStore:
  recordAtomGateEvent(input: AtomGateEventInput): Promise<AtomGateEvent>;
  listAtomGateEvents(options: { project?: string; windowDays: number; limit: number }): Promise<AtomGateEvent[]>;
```

- [ ] **Step 2: Write the failing test**

Create `test/atoms-gate-telemetry.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { GateTelemetry } from '../src/atoms/gate-telemetry.js';

test('GateTelemetry.record: writes one row per call and reads back via list', async () => {
  const store = new MemoryKnowledgeStore();
  const telemetry = new GateTelemetry(store);
  await telemetry.record({
    project: 'tuberosa', candidateClaim: 'ran tests, passed', candidateType: 'fact',
    stage: 'triviality', outcome: 'rejected', reasons: ['triviality:test_result'],
  });
  await telemetry.record({
    project: 'tuberosa', candidateClaim: 'good claim', candidateType: 'fact',
    stage: 'floor', outcome: 'accepted', reasons: [],
  });
  const events = await store.listAtomGateEvents({ project: 'tuberosa', windowDays: 30, limit: 100 });
  assert.equal(events.length, 2);
  assert.ok(events.some((e) => e.stage === 'triviality' && e.outcome === 'rejected'));
});

test('GateTelemetry.record: never throws on degraded write', async () => {
  // Telemetry MUST be best-effort — a gate decision must never fail because
  // we couldn't record a row. Force the store to fail and observe no throw.
  const failingStore = {
    recordAtomGateEvent: async () => { throw new Error('db down'); },
    listAtomGateEvents: async () => [],
  } as unknown as MemoryKnowledgeStore;
  const telemetry = new GateTelemetry(failingStore);
  await telemetry.record({
    project: 'tuberosa', candidateClaim: 'c', candidateType: 'fact',
    stage: 'triviality', outcome: 'rejected', reasons: ['r'],
  });
  assert.ok(true, 'reached without throw');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-gate-telemetry.test.ts`
Expected: FAIL — module not found and store methods missing.

- [ ] **Step 4: Implement `recordAtomGateEvent` on `MemoryKnowledgeStore`**

```typescript
  private readonly atomGateEvents = new Map<string, AtomGateEvent>();

  async recordAtomGateEvent(input: AtomGateEventInput): Promise<AtomGateEvent> {
    const event: AtomGateEvent = {
      id: randomUUID(),
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.atomGateEvents.set(event.id, event);
    return event;
  }

  async listAtomGateEvents(options: { project?: string; windowDays: number; limit: number }): Promise<AtomGateEvent[]> {
    const cutoff = Date.now() - options.windowDays * 24 * 60 * 60 * 1000;
    return [...this.atomGateEvents.values()]
      .filter((e) => !options.project || e.project === options.project)
      .filter((e) => new Date(e.createdAt).getTime() >= cutoff)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit);
  }
```

- [ ] **Step 5: Implement on `PostgresKnowledgeStore`**

```typescript
  async recordAtomGateEvent(input: AtomGateEventInput): Promise<AtomGateEvent> {
    const projectId = input.project ? await this.getOrCreateProjectId(input.project) : null;
    const result = await this.pool.query(
      `INSERT INTO atom_gate_events
         (project_id, session_id, atom_id, candidate_claim, candidate_type, stage, outcome, reasons)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING *`,
      [
        projectId, input.sessionId ?? null, input.atomId ?? null,
        input.candidateClaim, input.candidateType,
        input.stage, input.outcome, JSON.stringify(input.reasons),
      ],
    );
    return rowToGateEvent(result.rows[0], input.project);
  }

  async listAtomGateEvents(options: { project?: string; windowDays: number; limit: number }): Promise<AtomGateEvent[]> {
    const values: unknown[] = [String(options.windowDays), options.limit];
    let projectFilter = '';
    if (options.project) {
      values.push(options.project);
      projectFilter = `AND p.name = $${values.length}`;
    }
    const result = await this.pool.query(
      `SELECT e.*, p.name AS project_name
       FROM atom_gate_events e
       LEFT JOIN projects p ON p.id = e.project_id
       WHERE e.created_at >= now() - ($1 || ' days')::interval ${projectFilter}
       ORDER BY e.created_at DESC
       LIMIT $2`,
      values,
    );
    return result.rows.map((row) => rowToGateEvent(row, String(row.project_name ?? '')));
  }
```

Add a row mapper:

```typescript
function rowToGateEvent(row: Record<string, unknown>, project: string): AtomGateEvent {
  return {
    id: String(row.id),
    project: project || undefined,
    sessionId: row.session_id ? String(row.session_id) : undefined,
    atomId: row.atom_id ? String(row.atom_id) : undefined,
    candidateClaim: String(row.candidate_claim),
    candidateType: String(row.candidate_type),
    stage: row.stage as AtomGateEvent['stage'],
    outcome: row.outcome as AtomGateEvent['outcome'],
    reasons: (row.reasons ?? []) as string[],
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}
```

- [ ] **Step 6: Implement `GateTelemetry` wrapper**

Create `src/atoms/gate-telemetry.ts`:

```typescript
import type { KnowledgeStore, AtomGateEventInput, AtomGateEvent } from '../storage/store.js';

export class GateTelemetry {
  constructor(private readonly store: Pick<KnowledgeStore, 'recordAtomGateEvent' | 'listAtomGateEvents'>) {}

  async record(input: AtomGateEventInput): Promise<AtomGateEvent | undefined> {
    try {
      return await this.store.recordAtomGateEvent(input);
    } catch (error) {
      // Telemetry is best-effort. A gate decision must never fail because the
      // telemetry write failed (e.g. db down, table missing during migration).
      // We swallow and log to stderr so MCP stdout stays JSON-RPC clean.
      process.stderr.write(`[atom-gate-telemetry] suppressed write error: ${(error as Error).message}\n`);
      return undefined;
    }
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-gate-telemetry.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/storage/store.ts src/storage/memory-store.ts src/storage/postgres-store.ts src/atoms/gate-telemetry.ts test/atoms-gate-telemetry.test.ts
git commit -m "feat(atoms): atom_gate_events telemetry + best-effort recorder"
```

---

## Task 5: LLM critic (stage 4) with Redis cache

**Files:**
- Modify: `src/model/provider.ts`
- Create: `src/atoms/llm-critic.ts`
- Test: `test/atoms-llm-critic.test.ts`

- [ ] **Step 1: Add `judgeAtomUtility` to `ModelProvider`**

Edit `src/model/provider.ts`:

```typescript
  judgeAtomUtility?(input: {
    claim: string;
    type: 'fact' | 'procedure' | 'decision' | 'gotcha' | 'convention';
    trigger: { errors?: string[]; files?: string[]; symbols?: string[]; taskTypes?: string[] };
  }): Promise<{ generalizable: boolean; reason: string; confidence: number }>;
```

`HashModelProvider` does NOT implement this — leave it `undefined`. Test fixtures that need stage 4 will use a small `FixtureCriticProvider` (defined in the test file).

For OpenAI and Ollama providers in this file, add an implementation that calls the model with the prompt skeleton from spec §8. Use structured output (`json_schema`) for OpenAI; for Ollama, request `format: 'json'` and parse the response.

OpenAI sketch (in the existing `OpenAiModelProvider` class):

```typescript
  async judgeAtomUtility(input: { claim: string; type: string; trigger: Record<string, unknown> }): Promise<{ generalizable: boolean; reason: string; confidence: number }> {
    const prompt = `You are auditing a candidate engineering lesson. Decide if it is generalizable — i.e. would help a future agent on a *similar but different* task. Reject if it merely describes one-time events (test runs, commits, status updates) or restates trivia.

Atom:
  claim:   ${input.claim}
  type:    ${input.type}
  trigger: ${JSON.stringify(input.trigger)}

Return JSON: { "generalizable": bool, "reason": string, "confidence": 0..1 }`;
    const response = await this.callResponses({
      input: [{ role: 'user', content: prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'AtomUtilityJudgement',
          schema: {
            type: 'object',
            properties: {
              generalizable: { type: 'boolean' },
              reason: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['generalizable', 'reason', 'confidence'],
          },
        },
      },
    });
    return JSON.parse(response);
  }
```

(Match the existing `callResponses` helper signature in the file — these are the actual existing patterns. If the file uses a different helper name, use it.)

- [ ] **Step 2: Write the failing test**

Create `test/atoms-llm-critic.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryCache } from '../src/cache.js';
import { LlmCritic } from '../src/atoms/llm-critic.js';
import type { ModelProvider } from '../src/model/provider.js';

function makeProvider(verdict: { generalizable: boolean; reason: string; confidence: number }): ModelProvider {
  // Minimal stub. Only judgeAtomUtility matters; cast through unknown for the rest.
  return ({
    judgeAtomUtility: async () => verdict,
  } as unknown) as ModelProvider;
}

test('LlmCritic.judge: returns the provider verdict and caches it', async () => {
  const cache = new MemoryCache();
  let calls = 0;
  const provider: ModelProvider = ({
    judgeAtomUtility: async () => { calls += 1; return { generalizable: true, reason: 'ok', confidence: 0.8 }; },
  } as unknown) as ModelProvider;
  const critic = new LlmCritic(provider, cache);
  const a = await critic.judge({ claim: 'c', type: 'fact', trigger: { errors: ['e'] } });
  const b = await critic.judge({ claim: 'c', type: 'fact', trigger: { errors: ['e'] } });
  assert.equal(calls, 1, 'second call must hit cache');
  assert.deepEqual(a, b);
});

test('LlmCritic.judge: returns undefined when provider has no judgeAtomUtility', async () => {
  const cache = new MemoryCache();
  const provider: ModelProvider = ({} as unknown) as ModelProvider;
  const critic = new LlmCritic(provider, cache);
  const verdict = await critic.judge({ claim: 'c', type: 'fact', trigger: { errors: ['e'] } });
  assert.equal(verdict, undefined);
});

test('LlmCritic.isBorderline: true when content words just barely above sparse threshold', () => {
  const cache = new MemoryCache();
  const critic = new LlmCritic(makeProvider({ generalizable: true, reason: '', confidence: 1 }), cache);
  // 5 content words, exactly at the sparse_claim threshold + 0 margin
  const borderlineByMargin = critic.isBorderline({
    project: 'p', claim: 'alpha beta gamma delta epsilon',
    type: 'fact', evidence: [{ kind: 'file', path: 'x' }],
    trigger: { errors: ['e'] }, producedBy: 'agent_session',
  }, { ok: true, matched: [], marginContentWords: 5 });
  assert.equal(borderlineByMargin, true);
});

test('LlmCritic.isBorderline: true when trigger has only taskTypes', () => {
  const cache = new MemoryCache();
  const critic = new LlmCritic(makeProvider({ generalizable: true, reason: '', confidence: 1 }), cache);
  const r = critic.isBorderline({
    project: 'p', claim: 'a long enough claim that is fine here',
    type: 'fact', evidence: [{ kind: 'file', path: 'x' }],
    trigger: { taskTypes: ['refactor'] }, producedBy: 'agent_session',
  }, { ok: true, matched: [], marginContentWords: 8 });
  assert.equal(r, true);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-llm-critic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `LlmCritic`**

Create `src/atoms/llm-critic.ts`:

```typescript
import { createHash } from 'node:crypto';
import type { Cache } from '../cache.js';
import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeAtomInput } from '../types/atoms.js';
import type { TrivialityResult } from './triviality-rules.js';

const SPARSE_THRESHOLD = 5;
const BORDERLINE_MARGIN = 2;
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface LlmCriticVerdict {
  generalizable: boolean;
  reason: string;
  confidence: number;
}

export class LlmCritic {
  constructor(
    private readonly models: ModelProvider,
    private readonly cache: Cache,
    private readonly ttlSeconds: number = CACHE_TTL_SECONDS,
  ) {}

  isBorderline(input: KnowledgeAtomInput, triviality: TrivialityResult): boolean {
    if (triviality.marginContentWords <= SPARSE_THRESHOLD + BORDERLINE_MARGIN) return true;
    const trigger = input.trigger;
    const onlyTaskTypes =
      (trigger.errors?.length ?? 0) === 0
      && (trigger.files?.length ?? 0) === 0
      && (trigger.symbols?.length ?? 0) === 0
      && (trigger.taskTypes?.length ?? 0) > 0;
    return onlyTaskTypes;
  }

  async judge(input: { claim: string; type: KnowledgeAtomInput['type']; trigger: KnowledgeAtomInput['trigger'] }): Promise<LlmCriticVerdict | undefined> {
    if (!this.models.judgeAtomUtility) return undefined;
    const key = `atom_critic:${this.cacheKey(input)}`;
    const cached = await this.cache.getJson<LlmCriticVerdict>(key);
    if (cached) return cached;
    const verdict = await this.models.judgeAtomUtility(input);
    await this.cache.setJson(key, verdict, this.ttlSeconds);
    return verdict;
  }

  private cacheKey(input: { claim: string; type: string }): string {
    return createHash('sha256').update(`${input.type}\n${input.claim}`).digest('hex');
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-llm-critic.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/model/provider.ts src/atoms/llm-critic.ts test/atoms-llm-critic.test.ts
git commit -m "feat(atoms): LLM critic with Redis cache + judgeAtomUtility seam"
```

---

## Task 6: Refactor `AtomCritic` into the 4-stage pipeline

**Files:**
- Modify: `src/atoms/critic.ts`
- Test: extend `test/atoms-critic.test.ts` from B

- [ ] **Step 1: Update the existing critic tests for new pipeline behavior**

Append to `test/atoms-critic.test.ts`:

```typescript
import { MemoryCache } from '../src/cache.js';

test('AtomCritic.evaluate: triviality stage rejects "ran tests" claim before floor runs', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const critic = new AtomCritic(store, new HashModelProvider(), { cache });
  const result = await critic.evaluate({
    project: 'tuberosa',
    claim: 'ran pnpm test, all tests passed',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['none'] },
    producedBy: 'agent_session',
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.startsWith('triviality:')));
});

test('AtomCritic.evaluate: writes one telemetry row per evaluation', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const critic = new AtomCritic(store, new HashModelProvider(), { cache });
  await critic.evaluate(GOOD);
  const events = await store.listAtomGateEvents({ project: 'tuberosa', windowDays: 30, limit: 100 });
  assert.ok(events.length >= 1);
  assert.equal(events[events.length - 1].outcome, 'accepted');
});

test('AtomCritic.evaluate: cross-type dedup detects legacy memory and returns queue_legacy_migration', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const critic = new AtomCritic(store, new HashModelProvider(), { cache, legacyDedupThreshold: 0.0 });
  await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u', itemType: 'memory',
    title: 'legacy', summary: '', content: GOOD.claim, labels: [], references: [], metadata: {},
  }, []);
  const result = await critic.evaluate(GOOD);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes('legacy')));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-critic.test.ts`
Expected: FAIL — current critic does not run triviality, telemetry, or cross-type dedup.

- [ ] **Step 3: Refactor `AtomCritic`**

Replace `src/atoms/critic.ts`:

```typescript
import type { Cache } from '../cache.js';
import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtomInput } from '../types/atoms.js';
import { DEFAULT_TRIVIALITY_RULES, evaluateTriviality, type TrivialityRule } from './triviality-rules.js';
import { GateTelemetry } from './gate-telemetry.js';
import { LlmCritic } from './llm-critic.js';

export interface AtomCriticConfig {
  trivialityRules?: TrivialityRule[];
  dedupCosineThreshold?: number;
  legacyDedupThreshold?: number;
  maxClaimLength?: number;
  cache?: Cache;
  llmCriticEnabled?: boolean;
}

export interface AtomCriticResult {
  ok: boolean;
  reasons: string[];
  outcome: 'accepted' | 'rejected' | 'pending' | 'queue_legacy_migration';
  legacyKnowledgeIdForMigration?: string;
}

export class AtomCritic {
  private readonly rules: TrivialityRule[];
  private readonly atomDedupThreshold: number;
  private readonly legacyDedupThreshold: number;
  private readonly maxClaimLength: number;
  private readonly telemetry: GateTelemetry;
  private readonly llmCritic?: LlmCritic;
  private readonly llmCriticEnabled: boolean;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly models: ModelProvider,
    config: AtomCriticConfig = {},
  ) {
    this.rules = config.trivialityRules ?? DEFAULT_TRIVIALITY_RULES;
    this.atomDedupThreshold = config.dedupCosineThreshold ?? 0.92;
    this.legacyDedupThreshold = config.legacyDedupThreshold ?? 0.88;
    this.maxClaimLength = config.maxClaimLength ?? 240;
    this.telemetry = new GateTelemetry(store);
    this.llmCriticEnabled = config.llmCriticEnabled
      ?? Boolean(this.models.judgeAtomUtility);
    if (this.llmCriticEnabled && config.cache && this.models.judgeAtomUtility) {
      this.llmCritic = new LlmCritic(this.models, config.cache);
    }
  }

  async evaluate(input: KnowledgeAtomInput, sessionId?: string): Promise<AtomCriticResult> {
    // Stage 1: triviality
    const triviality = evaluateTriviality(input, this.rules);
    if (!triviality.ok) {
      const reasons = triviality.matched.map((m) => `triviality:${m}`);
      await this.telemetry.record({
        project: input.project, sessionId,
        candidateClaim: input.claim, candidateType: input.type,
        stage: 'triviality', outcome: 'rejected', reasons,
      });
      return { ok: false, reasons, outcome: 'rejected' };
    }

    // Stage 2: schema floor
    const floorReasons = this.evaluateFloor(input);
    if (floorReasons.length > 0) {
      await this.telemetry.record({
        project: input.project, sessionId,
        candidateClaim: input.claim, candidateType: input.type,
        stage: 'floor', outcome: 'rejected', reasons: floorReasons,
      });
      return { ok: false, reasons: floorReasons, outcome: 'rejected' };
    }

    // Stage 3: cross-type dedup
    const dedup = await this.evaluateDedup(input);
    if (dedup.outcome !== 'pass') {
      await this.telemetry.record({
        project: input.project, sessionId,
        candidateClaim: input.claim, candidateType: input.type,
        stage: 'dedup', outcome: dedup.outcome, reasons: dedup.reason ? [dedup.reason] : [],
      });
      return {
        ok: false,
        reasons: dedup.reason ? [dedup.reason] : [],
        outcome: dedup.outcome,
        legacyKnowledgeIdForMigration: dedup.legacyKnowledgeId,
      };
    }

    // Stage 4: optional LLM critic for borderline atoms
    if (this.llmCritic && this.llmCritic.isBorderline(input, triviality)) {
      const verdict = await this.llmCritic.judge({ claim: input.claim, type: input.type, trigger: input.trigger });
      if (verdict && !verdict.generalizable) {
        const reasons = [`llm_critic:not_generalizable:${verdict.reason}`];
        await this.telemetry.record({
          project: input.project, sessionId,
          candidateClaim: input.claim, candidateType: input.type,
          stage: 'llm_critic', outcome: 'rejected', reasons,
        });
        return { ok: false, reasons, outcome: 'rejected' };
      }
      if (!verdict) {
        await this.telemetry.record({
          project: input.project, sessionId,
          candidateClaim: input.claim, candidateType: input.type,
          stage: 'llm_critic', outcome: 'pending', reasons: ['provider_missing_judgeAtomUtility'],
        });
        return { ok: true, reasons: [], outcome: 'pending' };
      }
    }

    await this.telemetry.record({
      project: input.project, sessionId,
      candidateClaim: input.claim, candidateType: input.type,
      stage: 'floor', outcome: 'accepted', reasons: [],
    });
    return { ok: true, reasons: [], outcome: 'accepted' };
  }

  private evaluateFloor(input: KnowledgeAtomInput): string[] {
    const reasons: string[] = [];
    if (!input.claim?.trim()) reasons.push('claim is empty');
    else if (input.claim.length > this.maxClaimLength) reasons.push(`claim exceeds ${this.maxClaimLength} chars`);
    if (!input.evidence?.length) reasons.push('evidence is empty (≥1 required)');
    const claimLower = (input.claim ?? '').trim().toLowerCase();
    const triggerTokens = [
      ...(input.trigger.errors ?? []),
      ...(input.trigger.files ?? []),
      ...(input.trigger.symbols ?? []),
      ...(input.trigger.taskTypes ?? []),
    ].map((s) => s.trim().toLowerCase());
    if (claimLower && triggerTokens.some((t) => t === claimLower)) {
      reasons.push('claim restates a trigger token verbatim');
    }
    return reasons;
  }

  private async evaluateDedup(input: KnowledgeAtomInput): Promise<{ outcome: 'pass' | 'rejected' | 'queue_legacy_migration'; reason?: string; legacyKnowledgeId?: string }> {
    const embedding = await this.models.embed(`${input.claim}\n${(input.trigger.errors ?? []).join(' ')}`);
    const atomMatches = await this.store.searchAtomsByEmbedding(embedding, {
      project: input.project, limit: 5, threshold: this.atomDedupThreshold,
    });
    if (atomMatches.length > 0) {
      return { outcome: 'rejected', reason: `duplicate of atom ${atomMatches[0].atom.id} (cosine ${atomMatches[0].cosine.toFixed(2)})` };
    }
    const legacyMatches = await this.store.searchKnowledgeByEmbedding(embedding, {
      project: input.project, limit: 5, threshold: this.legacyDedupThreshold,
      itemTypes: ['memory', 'bugfix', 'rule'],
      excludeLegacyStatuses: ['legacy_replaced', 'legacy_archived'],
    });
    if (legacyMatches.length > 0) {
      return {
        outcome: 'queue_legacy_migration',
        reason: `near-duplicate of legacy knowledge_items.${legacyMatches[0].knowledge.id}`,
        legacyKnowledgeId: legacyMatches[0].knowledge.id,
      };
    }
    return { outcome: 'pass' };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-critic.test.ts`
Expected: All tests (the originals from B and the new D ones) pass.

- [ ] **Step 5: Run the full suite to check downstream callers**

Run: `pnpm test`
Expected: PASS. The B-era extractor test uses `new AtomCritic(store, models)` without a cache; that path still works because `llmCritic` only initializes when both a cache and a `judgeAtomUtility`-capable provider are present.

- [ ] **Step 6: Commit**

```bash
git add src/atoms/critic.ts test/atoms-critic.test.ts
git commit -m "feat(atoms): 4-stage critic pipeline with telemetry + cross-type dedup + LLM stage"
```

---

## Task 7: Update extractor to handle `queue_legacy_migration`

**Files:**
- Modify: `src/atoms/extractor.ts`
- Test: extend `test/atoms-extractor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/atoms-extractor.test.ts`:

```typescript
import { migrateLegacyKnowledge } from '../src/atoms/migration.js';

test('AtomExtractor: queue_legacy_migration triggers migration of the matched legacy item', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const cache = new MemoryCache();
  models.setFixtureAtoms([{
    claim: 'pgvector ivfflat lists should be rowcount over 1000.',
    type: 'convention',
    evidence: [{ kind: 'file', path: 'docs/pgvector.md' }],
    trigger: { symbols: ['ivfflat'] },
  }]);
  // Pre-existing legacy item that semantically matches
  await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u', itemType: 'memory',
    title: 'pgvector tuning', summary: '', content: 'pgvector ivfflat tuning uses lists = rowcount / 1000.',
    labels: [], references: [], metadata: {},
  }, []);
  const critic = new AtomCritic(store, models, { cache, legacyDedupThreshold: 0.0 });
  const extractor = new AtomExtractor(store, models, critic);
  const result = await extractor.extractFromSession({
    project: 'tuberosa', sessionId: 's', sessionPrompt: 'pgvector tuning',
  });
  assert.equal(result.stored.length, 0);
  assert.equal(result.queuedLegacyMigrations.length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-extractor.test.ts`
Expected: FAIL — `queuedLegacyMigrations` undefined on result.

- [ ] **Step 3: Update `AtomExtractor.extractFromSession`**

Edit `src/atoms/extractor.ts`. Extend the result shape and route `queue_legacy_migration` outcomes:

```typescript
export interface ExtractFromSessionResult {
  stored: KnowledgeAtom[];
  rejected: Array<{ candidate: KnowledgeAtomInput; result: AtomCriticResult }>;
  queuedLegacyMigrations: string[];   // legacy knowledge_item ids
}

// In the for-loop replace the if/else with:
      const result = await this.critic.evaluate(candidateInput, input.sessionId);
      if (result.outcome === 'accepted') {
        stored.push(await this.store.createAtom(candidateInput));
      } else if (result.outcome === 'queue_legacy_migration' && result.legacyKnowledgeIdForMigration) {
        queuedLegacyMigrations.push(result.legacyKnowledgeIdForMigration);
        rejected.push({ candidate: candidateInput, result });
      } else if (result.outcome === 'pending') {
        // LLM critic unavailable — store at draft, mark pending in metadata
        const atom = await this.store.createAtom(candidateInput);
        await this.store.updateAtom(atom.id, { /* extend types/atoms.ts metadata if needed */ } as never);
        stored.push(atom);
      } else {
        rejected.push({ candidate: candidateInput, result });
      }
```

(If extending `KnowledgeAtom` metadata for `pendingLlmCritic` is needed, add a `metadata?: Record<string, unknown>` field on the atom in `src/types/atoms.ts` and propagate through stores — small follow-on edit.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-extractor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/atoms/extractor.ts test/atoms-extractor.test.ts src/types/atoms.ts
git commit -m "feat(atoms): extractor handles queue_legacy_migration + pending outcomes"
```

---

## Task 8: Archival sweep + retrieval filter

**Files:**
- Create: `src/atoms/archival.ts`
- Modify: `src/retrieval/service.ts`
- Test: `test/atoms-archival.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/atoms-archival.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { runArchivalSweep } from '../src/atoms/archival.js';

const NOW = new Date('2027-05-26T00:00:00Z');

async function makeAtom(store: MemoryKnowledgeStore, overrides: Partial<{ tier: 'draft'|'verified'|'canonical'; lastReusedAt?: string; createdAt: string }> = {}) {
  const atom = await store.createAtom({
    project: 'tuberosa', claim: 'something useful for tests',
    type: 'fact', evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });
  await store.updateAtom(atom.id, { tier: overrides.tier ?? 'draft', lastReusedAt: overrides.lastReusedAt });
  return atom;
}

test('archival: time-archives a draft atom with no reuse in >365 days', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await makeAtom(store, { tier: 'draft', lastReusedAt: '2026-01-01T00:00:00Z' });
  const report = await runArchivalSweep(store, NOW);
  assert.ok(report.archivedByTime.includes(atom.id));
  assert.equal((await store.getAtom(atom.id))?.status, 'archived');
});

test('archival: does NOT time-archive a verified atom', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await makeAtom(store, { tier: 'verified', lastReusedAt: '2025-01-01T00:00:00Z' });
  await runArchivalSweep(store, NOW);
  assert.equal((await store.getAtom(atom.id))?.status, 'active');
});

test('archival: signal-archives any tier atom with ≥3 negative feedback in 90 days', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await makeAtom(store, { tier: 'verified', lastReusedAt: NOW.toISOString() });
  for (let i = 0; i < 3; i += 1) {
    await store.recordFeedback({
      project: 'tuberosa', feedbackType: 'rejected',
      rejectedKnowledgeIds: [atom.id], reason: 'nope',
    });
  }
  const report = await runArchivalSweep(store, NOW);
  assert.ok(report.archivedBySignal.includes(atom.id));
});

test('archival: canonical atoms need ≥5 negative signals before signal-archive', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await makeAtom(store, { tier: 'canonical', lastReusedAt: NOW.toISOString() });
  for (let i = 0; i < 4; i += 1) {
    await store.recordFeedback({
      project: 'tuberosa', feedbackType: 'rejected',
      rejectedKnowledgeIds: [atom.id], reason: 'r',
    });
  }
  let report = await runArchivalSweep(store, NOW);
  assert.equal(report.archivedBySignal.length, 0);
  await store.recordFeedback({
    project: 'tuberosa', feedbackType: 'rejected',
    rejectedKnowledgeIds: [atom.id], reason: 'r',
  });
  report = await runArchivalSweep(store, NOW);
  assert.ok(report.archivedBySignal.includes(atom.id));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atoms-archival.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement archival**

Create `src/atoms/archival.ts`:

```typescript
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';

const TIME_THRESHOLD_DAYS = 365;
const SIGNAL_THRESHOLD = 3;
const CANONICAL_SIGNAL_THRESHOLD = 5;
const SIGNAL_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArchivalReport {
  archivedByTime: string[];
  archivedBySignal: string[];
  scannedAt: string;
  scanned: number;
}

function daysSince(iso: string | undefined, now: Date): number {
  if (!iso) return Infinity;
  return (now.getTime() - new Date(iso).getTime()) / DAY_MS;
}

export async function runArchivalSweep(
  store: KnowledgeStore,
  now: Date = new Date(),
): Promise<ArchivalReport> {
  const candidates: KnowledgeAtom[] = await store.listAtoms({ status: 'active', limit: 1000 });
  const archivedByTime: string[] = [];
  const archivedBySignal: string[] = [];

  for (const atom of candidates) {
    if (atom.tier === 'draft') {
      const reference = atom.lastReusedAt ?? atom.audit.createdAt;
      if (daysSince(reference, now) > TIME_THRESHOLD_DAYS) {
        await store.updateAtom(atom.id, { status: 'archived' } as never);
        archivedByTime.push(atom.id);
        continue;
      }
    }
    const threshold = atom.tier === 'canonical' ? CANONICAL_SIGNAL_THRESHOLD : SIGNAL_THRESHOLD;
    const negativeCount = await store.countNegativeFeedback(atom.id, SIGNAL_WINDOW_DAYS);
    if (negativeCount >= threshold) {
      await store.updateAtom(atom.id, { status: 'archived' } as never);
      archivedBySignal.push(atom.id);
    }
  }

  return {
    archivedByTime,
    archivedBySignal,
    scannedAt: now.toISOString(),
    scanned: candidates.length,
  };
}
```

(The `as never` casts work around the current `KnowledgeAtomPatch` not having `status` in B. Extend `KnowledgeAtomPatch` in `src/types/atoms.ts` to include `status?: AtomStatus` — it's a 1-line addition and removes the cast.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-archival.test.ts`
Expected: PASS.

- [ ] **Step 5: Filter archived atoms out of default retrieval**

Edit `src/retrieval/service.ts`. In `searchAtomCandidates` (from B Task 8), filter to `status: 'active'`:

```typescript
    const atoms = await this.store.searchAtomsByTrigger(
      { /* triggers */ },
      { project, limit: options.limit, status: 'active' } as never,   // see Step 6
    );
```

In `MemoryKnowledgeStore.searchAtomsByTrigger` and the postgres variant, add `status?: 'active' | 'archived' | 'all'` to the options and default to filtering `status === 'active'`. Direct `getAtom(id)` calls remain unfiltered.

Add a regression test in `test/atoms-retrieval.test.ts` (extending the file from B):

```typescript
test('retrieval: archived atoms do not appear in default context packs', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, defaultConfig());

  const atom = await store.createAtom({
    project: 'tuberosa', claim: 'should not surface',
    type: 'fact', evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['baz error'] }, producedBy: 'agent_session',
  });
  await store.updateAtom(atom.id, { status: 'archived' });

  const pack = await service.searchContext({
    project: 'tuberosa', prompt: 'baz error', errors: ['baz error'],
  });
  const ids = pack.sections.flatMap((s) => s.items.map((i) => i.knowledgeId));
  assert.ok(!ids.includes(atom.id));
});
```

- [ ] **Step 6: Run the retrieval test**

Run: `node --test --import tsx test/atoms-retrieval.test.ts`
Expected: PASS, no regressions from B's tests.

- [ ] **Step 7: Commit**

```bash
git add src/atoms/archival.ts src/types/atoms.ts src/storage/memory-store.ts src/storage/postgres-store.ts src/storage/store.ts src/retrieval/service.ts test/atoms-archival.test.ts test/atoms-retrieval.test.ts
git commit -m "feat(atoms): archival sweep (time + signal) + retrieval status filter"
```

---

## Task 9: Resurrection endpoint + MCP tool

**Files:**
- Modify: `src/http/server.ts`
- Modify: `src/mcp/server.ts`
- Test: extend `test/atoms-archival.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/atoms-archival.test.ts`:

```typescript
test('resurrection: flipping status back to active immediately resurfaces in retrieval', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await makeAtom(store, { tier: 'draft', lastReusedAt: '2026-01-01T00:00:00Z' });
  await runArchivalSweep(store, NOW);
  assert.equal((await store.getAtom(atom.id))?.status, 'archived');

  await store.updateAtom(atom.id, { status: 'active', lastReusedAt: NOW.toISOString() });
  const refreshed = await store.getAtom(atom.id);
  assert.equal(refreshed?.status, 'active');
  assert.equal(refreshed?.lastReusedAt, NOW.toISOString());
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `node --test --import tsx test/atoms-archival.test.ts`
Expected: PASS — `updateAtom` already supports `status` after Task 8.

- [ ] **Step 3: Register HTTP route**

Edit `src/http/server.ts`. Add to the route registration block:

```typescript
  app.post('/atoms/:id/resurrect', requireAuth, async (req, res) => {
    const updated = await store.updateAtom(req.params.id, {
      status: 'active',
      lastReusedAt: new Date().toISOString(),
    });
    if (!updated) return res.status(404).json({ error: 'atom not found' });
    res.json({ atom: updated });
  });
```

(Follow the actual middleware/handler pattern in the file. `requireAuth` is the existing auth guard — name may differ.)

- [ ] **Step 4: Register MCP tool**

Edit `src/mcp/server.ts`. Add to the tool list:

```typescript
  server.registerTool('tuberosa_resurrect_atom', {
    description: 'Move an archived atom back to active so it competes in retrieval again.',
    inputSchema: { type: 'object', properties: { atomId: { type: 'string' } }, required: ['atomId'] },
  }, async ({ atomId }) => {
    const updated = await store.updateAtom(atomId, { status: 'active', lastReusedAt: new Date().toISOString() });
    return { content: [{ type: 'text', text: JSON.stringify({ atom: updated }) }] };
  });
```

(Use the actual MCP tool-registration helper in `src/mcp/server.ts` — pattern matches existing tools like `tuberosa_append_session_note`.)

- [ ] **Step 5: Commit**

```bash
git add src/http/server.ts src/mcp/server.ts test/atoms-archival.test.ts
git commit -m "feat(atoms): POST /atoms/:id/resurrect + tuberosa_resurrect_atom MCP tool"
```

---

## Task 10: Stats endpoint + MCP tool

**Files:**
- Create: `src/operations/atom-gate-stats.ts`
- Modify: `src/http/server.ts`
- Modify: `src/mcp/server.ts`
- Test: `test/atom-gate-stats.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/atom-gate-stats.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { computeAtomGateStats } from '../src/operations/atom-gate-stats.js';

async function record(store: MemoryKnowledgeStore, claim: string, stage: 'triviality'|'floor'|'dedup'|'llm_critic', outcome: 'accepted'|'rejected', reasons: string[] = []) {
  await store.recordAtomGateEvent({
    project: 'tuberosa', candidateClaim: claim, candidateType: 'fact',
    stage, outcome, reasons,
  });
}

test('computeAtomGateStats: aggregates totals, per-stage rejections, and top triviality patterns', async () => {
  const store = new MemoryKnowledgeStore();
  await record(store, 'a', 'triviality', 'rejected', ['triviality:test_result']);
  await record(store, 'b', 'triviality', 'rejected', ['triviality:test_result']);
  await record(store, 'c', 'triviality', 'rejected', ['triviality:commit_status']);
  await record(store, 'd', 'floor', 'accepted', []);
  await record(store, 'e', 'floor', 'rejected', ['claim is empty']);
  const stats = await computeAtomGateStats(store, { project: 'tuberosa', windowDays: 7 });
  assert.equal(stats.totalCandidates, 5);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.rejected.triviality, 3);
  assert.equal(stats.rejected.floor, 1);
  assert.deepEqual(stats.topTrivialityPatterns[0], { pattern: 'test_result', count: 2 });
});

test('computeAtomGateStats: emits "too strict" hint when acceptance < 30%', async () => {
  const store = new MemoryKnowledgeStore();
  for (let i = 0; i < 10; i += 1) await record(store, `x${i}`, 'triviality', 'rejected', ['triviality:sparse_claim']);
  await record(store, 'good', 'floor', 'accepted', []);
  const stats = await computeAtomGateStats(store, { project: 'tuberosa', windowDays: 7 });
  assert.ok(stats.alertHints.some((h) => h.text.toLowerCase().includes('too strict')));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atom-gate-stats.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement stats**

Create `src/operations/atom-gate-stats.ts`:

```typescript
import type { KnowledgeStore } from '../storage/store.js';

export interface AtomGateStats {
  windowDays: number;
  totalCandidates: number;
  accepted: number;
  acceptedPct: number;
  rejected: { triviality: number; floor: number; dedup: number; llm_critic: number };
  queuedLegacyMigration: number;
  topTrivialityPatterns: Array<{ pattern: string; count: number }>;
  pendingLlmCritic: number;
  alertHints: Array<{ level: 'info' | 'warn'; text: string }>;
}

export async function computeAtomGateStats(
  store: KnowledgeStore,
  options: { project?: string; windowDays: number },
): Promise<AtomGateStats> {
  const events = await store.listAtomGateEvents({
    project: options.project,
    windowDays: options.windowDays,
    limit: 10000,
  });

  const totalCandidates = events.length;
  let accepted = 0;
  let queuedLegacyMigration = 0;
  let pendingLlmCritic = 0;
  const rejected = { triviality: 0, floor: 0, dedup: 0, llm_critic: 0 };
  const trivialityCounts = new Map<string, number>();

  for (const event of events) {
    if (event.outcome === 'accepted') accepted += 1;
    else if (event.outcome === 'queue_legacy_migration') queuedLegacyMigration += 1;
    else if (event.outcome === 'pending') pendingLlmCritic += 1;
    else if (event.outcome === 'rejected') {
      rejected[event.stage] += 1;
      if (event.stage === 'triviality') {
        for (const r of event.reasons) {
          const m = r.match(/^triviality:(\w+)$/);
          if (m) trivialityCounts.set(m[1], (trivialityCounts.get(m[1]) ?? 0) + 1);
        }
      }
    }
  }

  const topTrivialityPatterns = [...trivialityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pattern, count]) => ({ pattern, count }));

  const acceptedPct = totalCandidates === 0 ? 0 : accepted / totalCandidates;
  const hints: AtomGateStats['alertHints'] = [];
  if (totalCandidates > 0) {
    if (acceptedPct < 0.3) hints.push({ level: 'warn', text: 'Critic may be too strict — review top rejection reasons.' });
    else if (acceptedPct > 0.8) hints.push({ level: 'warn', text: 'Critic may be too permissive — consider adding triviality patterns.' });
    else hints.push({ level: 'info', text: 'Acceptance rate within healthy range (30–80%).' });
  }

  return {
    windowDays: options.windowDays,
    totalCandidates,
    accepted,
    acceptedPct,
    rejected,
    queuedLegacyMigration,
    topTrivialityPatterns,
    pendingLlmCritic,
    alertHints: hints,
  };
}
```

- [ ] **Step 4: Register HTTP route**

Edit `src/http/server.ts`:

```typescript
  app.get('/operations/atom-gate/stats', requireAuth, async (req, res) => {
    const stats = await computeAtomGateStats(store, {
      project: typeof req.query.project === 'string' ? req.query.project : undefined,
      windowDays: req.query.window === '30d' ? 30 : req.query.window === '7d' ? 7 : 7,
    });
    res.json(stats);
  });
```

- [ ] **Step 5: Register MCP tool**

Edit `src/mcp/server.ts`:

```typescript
  server.registerTool('tuberosa_atom_gate_stats', {
    description: 'Inspect gate acceptance/rejection rates and top triviality patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        windowDays: { type: 'number', default: 7 },
      },
    },
  }, async ({ project, windowDays }) => {
    const stats = await computeAtomGateStats(store, { project, windowDays: windowDays ?? 7 });
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  });
```

- [ ] **Step 6: Run the test and full suite**

Run: `node --test --import tsx test/atom-gate-stats.test.ts && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/operations/atom-gate-stats.ts src/http/server.ts src/mcp/server.ts test/atom-gate-stats.test.ts
git commit -m "feat(atoms): GET /operations/atom-gate/stats + tuberosa_atom_gate_stats MCP tool"
```

---

## Task 11: Scheduled archival in worker + CLI

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/config.ts`
- Create: `scripts/archival-sweep.ts`
- Modify: `package.json`

- [ ] **Step 1: Add archival env vars to config**

Edit `src/config.ts`. Add to `AppConfig` and `loadConfig`:

```typescript
  archivalEnabled: boolean;
  archivalIntervalHours: number;
```

Read from env in `loadConfig`:

```typescript
  archivalEnabled: process.env.TUBEROSA_ARCHIVAL_ENABLED !== 'false',
  archivalIntervalHours: Number(process.env.TUBEROSA_ARCHIVAL_INTERVAL_HOURS ?? 24),
```

- [ ] **Step 2: Hook archival into the worker**

Edit `src/worker.ts`:

```typescript
import { createAppServices } from './app.js';
import { runArchivalSweep } from './atoms/archival.js';

const services = await createAppServices();

console.log('Tuberosa worker started.');

let interval: NodeJS.Timeout | undefined;
if (services.config.archivalEnabled) {
  const intervalMs = services.config.archivalIntervalHours * 60 * 60 * 1000;
  const run = async () => {
    try {
      const report = await runArchivalSweep(services.store);
      process.stderr.write(`[archival] swept ${report.scanned}, archived ${report.archivedByTime.length + report.archivedBySignal.length}\n`);
    } catch (error) {
      process.stderr.write(`[archival] sweep failed: ${(error as Error).message}\n`);
    }
  };
  interval = setInterval(() => void run(), intervalMs);
  void run();   // run once on startup
}

async function shutdown(signal: string) {
  console.log(`Worker received ${signal}, shutting down.`);
  if (interval) clearInterval(interval);
  await services.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

- [ ] **Step 3: Add the one-shot CLI**

Create `scripts/archival-sweep.ts`:

```typescript
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { createAppServices } from '../src/app.js';
import { runArchivalSweep } from '../src/atoms/archival.js';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    report: { type: 'string' },
  },
});

const services = await createAppServices();
const report = await runArchivalSweep(services.store);

const markdown = [
  `# Atom Archival Sweep Report`,
  ``,
  `**Mode:** ${values['dry-run'] ? 'dry-run' : 'apply'}`,
  `**Scanned at:** ${report.scannedAt}`,
  ``,
  `- Scanned: ${report.scanned}`,
  `- Archived by time: ${report.archivedByTime.length}`,
  `- Archived by signal: ${report.archivedBySignal.length}`,
].join('\n');

if (values.report) await writeFile(values.report, markdown, 'utf8');
console.log(markdown);
await services.close();
```

(For `--dry-run`, we currently still write — this is a deliberate simplification because `updateAtom` is the only mutating call. Wrap it: if `--dry-run`, swap `store.updateAtom` with a no-op stub before passing to `runArchivalSweep`. Add a `dryRun` flag to `runArchivalSweep` instead of the swap — pick the simpler refactor.)

- [ ] **Step 4: Add npm script**

Edit `package.json`:

```json
    "archival-sweep": "node --import tsx scripts/archival-sweep.ts"
```

- [ ] **Step 5: Smoke-test the CLI**

Run: `pnpm run archival-sweep -- --report /tmp/archival.md`
Expected: exits 0; `/tmp/archival.md` exists.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts src/config.ts scripts/archival-sweep.ts package.json
git commit -m "feat(atoms): scheduled archival sweep in worker + one-shot CLI"
```

---

## Task 12: Eval fixtures for triviality and archival

**Files:**
- Modify: `eval/retrieval-fixtures.json`
- Modify: `eval/retrieval.ts` (the runner, if needed)

- [ ] **Step 1: Add fixture cases**

Edit `eval/retrieval-fixtures.json`. Add cases:

```jsonc
{
  "name": "triviality rule rejects test-result atom",
  "extractAtoms": [
    { "claim": "ran pnpm test, all tests passed", "type": "fact",
      "evidence": [{"kind":"file","path":"x.ts"}], "trigger": {"errors":["e"]} }
  ],
  "expect": { "atomGateEvents": [{ "stage": "triviality", "outcome": "rejected", "reasonContains": "test_result" }] }
}
```

```jsonc
{
  "name": "archived atom does not appear in pack",
  "ingest": { "atoms": [{ "claim": "Archived hint.", "type": "fact",
      "evidence": [{"kind":"file","path":"x.ts"}], "trigger": {"errors":["zap error"]},
      "status": "archived" }] },
  "query": { "prompt": "zap error", "errors": ["zap error"] },
  "expect": { "topKnowledgeIdsNotContain": ["Archived hint."] }
}
```

If the runner does not yet support `extractAtoms` or atom `status` ingest, extend it minimally — locate `eval/retrieval.ts` (the existing runner) and add the new ingest branches.

- [ ] **Step 2: Run the eval**

Run: `pnpm run eval:retrieval`
Expected: PASS — all original cases plus the new ones.

- [ ] **Step 3: Commit**

```bash
git add eval/retrieval-fixtures.json eval/retrieval.ts
git commit -m "test(atoms): eval fixtures for triviality rejection + archival exclusion"
```

---

## Task 13: Final verification — full eval + integration

- [ ] **Step 1: Run the full unit suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 2: Run retrieval eval**

Run: `pnpm run eval:retrieval`
Expected: PASS — hitRate=1, staleRejectionRate=1, all classification rates at 1.

- [ ] **Step 3: Run agent-context eval**

Run: `pnpm run eval:agent-context`
Expected: PASS.

- [ ] **Step 4: Integration tests if Docker is up**

Run: `pnpm run test:integration`
Expected: PASS or skipped.

- [ ] **Step 5: Smoke-test the live stack**

Bring up Docker:

```bash
docker compose up --build -d
sleep 5
curl -s http://localhost:3027/operations/atom-gate/stats
```
Expected: JSON response with `totalCandidates: 0` (or higher if dev data was extracted).

- [ ] **Step 6: Commit final touch-ups (if any)**

```bash
git add -A
git commit -m "test(atoms): green eval suite after concern D"
```

---

## Follow-up (deferred)

These are valuable but not required to ship the spec:

- **Workbench Gate Health card** rendering the `/operations/atom-gate/stats` payload. Backend ships now; UI follows in a separate task.
- **Per-project triviality rule override** via `TUBEROSA_TRIVIALITY_RULES_FILE` — env wiring is in place; file parser is small but not on the critical path.
- **Auto-tuning hints** beyond the simple acceptance-band hints (e.g., suggest specific new patterns to add when the same claim shape appears repeatedly in `pending`).
- **Aggregated per-rule rejection trend chart** in the workbench.
