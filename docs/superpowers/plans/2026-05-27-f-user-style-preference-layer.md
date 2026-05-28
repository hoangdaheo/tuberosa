# User-Style Preference Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a cross-project, single-user style atom layer on top of B's atom schema. New `scope='user'` discriminator with `user_id` + `priority` columns; four capture sources (explicit MCP/HTTP, clustered user-correction feedback, clustered agent-output rejection feedback, agent-emitted `user_preference` learning signals at `finish_session`); critic adjustments for the user namespace; retrieval as a separate candidate source with `personal_workflow` vs `coding_preference` conflict resolution against project conventions.

**Architecture:** `knowledge_atoms` gains `scope`, `user_id`, `priority` columns. A new `src/user-style/` module wraps the atom-write path with user-scope invariants and the four capture sources. The 4-stage critic from D learns three small adjustments when `scope='user'`. Retrieval pulls user-style atoms as a 7th candidate source with its own fusion weight and tier multipliers. A conflict-resolution pass detects user-style ↔ project-convention contradictions and surfaces the resolution in `pack.instruction`.

**Tech Stack:** TypeScript (Node 22), Postgres + pgvector, `node:test` runner with `tsx`, existing `ModelProvider` + `KnowledgeStore`.

**Spec:** [`docs/superpowers/specs/2026-05-27-user-style-preference-layer-design.md`](../specs/2026-05-27-user-style-preference-layer-design.md)

**Depends on:** B, D, A, C1, C2 plans should be merged first. E is independent — F's `--include-user-style` extension is additive to E's exporter and can land in any order relative to E execution.

---

## File Structure

**Create:**
- `migrations/010_user_style_atoms.sql` — scope/user_id/priority columns
- `src/user-style/store-helpers.ts` — `createUserStyleAtom`, invariant guards
- `src/user-style/triviality-rules.ts` — `personal_pronoun_only` rule
- `src/user-style/clusterer.ts` — correction + rejection clustering job
- `src/user-style/finish-session-router.ts` — routes `user_preference` learning signals
- `src/user-style/conflict-resolver.ts` — detects user ↔ project convention conflicts
- `scripts/cluster-user-corrections.ts` — CLI entry
- `test/user-style-store.test.ts`
- `test/user-style-triviality.test.ts`
- `test/user-style-clusterer.test.ts`
- `test/user-style-conflict.test.ts`
- `test/user-style-retrieval.test.ts`
- `test/user-style-finish-session.test.ts`

**Modify:**
- `src/types/atoms.ts` — add `scope`, `userId`, `priority` to `KnowledgeAtom` and `KnowledgeAtomInput`
- `src/storage/store.ts` — `createAtom` accepts the new fields; `searchAtomsByTrigger` gains `scope`/`userId` filters; new `listUserStyleAtoms`
- `src/storage/memory-store.ts` — impls
- `src/storage/postgres-store.ts` — impls
- `src/atoms/critic.ts` — skip cross-type dedup for `scope='user'`; per-user atom dedup; integrate new triviality rule
- `src/atoms/extractor.ts` — recognize `scope='user'` candidates from finish_session signals
- `src/agent-session/service.ts` — call F's finish-session router for `user_preference` signals
- `src/retrieval/policy.ts` — `sourceWeights.userStyle` + `userStyle.tierMultipliers` + `personalWorkflowBoost`
- `src/retrieval/service.ts` — pull user-style candidates as a 7th source; apply tier multiplier + boost in `applyRankingAdjustments`; call `resolveStyleConflicts` after fusion
- `src/retrieval/context-pack.ts` — surface conflict-resolution instructions and `userStyle:<priority>:` match reasons
- `src/mcp/server.ts` — register `tuberosa_record_user_style`, `tuberosa_list_user_style`
- `src/http/server.ts` — `POST /user-style-atoms`, `GET /user-style-atoms`, `PATCH /user-style-atoms/:id`
- `src/export/exporter.ts` — honor `--include-user-style=<userId>`; write under `user-style/<userId>/`
- `src/export/importer.ts` — recognize user-style files; force `tier='draft'`, `priority='coding_preference'` on import unless `--preserve-user-id` AND `--preserve-priority` are both passed
- `src/config.ts` — `TUBEROSA_USER_ID`, `TUBEROSA_USER_STYLE_ENABLED`, `TUBEROSA_USER_STYLE_*` cluster vars
- `src/worker.ts` — schedule `cluster-user-corrections`
- `package.json` — `cluster-user-corrections` script
- `eval/retrieval-fixtures.json` — conflict-resolution + priority-boost fixtures

---

## Task 1: Migration

**Files:**
- Create: `migrations/010_user_style_atoms.sql`

- [x] **Step 1: Create the migration**

```sql
ALTER TABLE knowledge_atoms
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'project'
    CHECK (scope IN ('project','user')),
  ADD COLUMN IF NOT EXISTS user_id text,
  ADD COLUMN IF NOT EXISTS priority text
    CHECK (priority IN ('personal_workflow','coding_preference'));

CREATE INDEX IF NOT EXISTS idx_atoms_scope_user
  ON knowledge_atoms (scope, user_id, tier) WHERE status='active';
```

- [x] **Step 2: Apply migration**

Run: `pnpm run migrate`

- [x] **Step 3: Commit**

```bash
git add migrations/010_user_style_atoms.sql
git commit -m "feat(user-style): migration 010 — scope/user_id/priority on knowledge_atoms"
```

---

## Task 2: Type extensions + store invariants

**Files:**
- Modify: `src/types/atoms.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/storage/memory-store.ts`
- Modify: `src/storage/postgres-store.ts`
- Create: `src/user-style/store-helpers.ts`
- Test: `test/user-style-store.test.ts`

- [x] **Step 1: Extend types**

Edit `src/types/atoms.ts`:

```typescript
export type AtomScope = 'project' | 'user';
export type StylePriority = 'personal_workflow' | 'coding_preference';

export interface KnowledgeAtom {
  // … existing
  scope: AtomScope;
  userId?: string;
  priority?: StylePriority;          // set iff scope='user'
}

export interface KnowledgeAtomInput {
  // … existing
  scope?: AtomScope;                 // default 'project'
  userId?: string;
  priority?: StylePriority;
}
```

- [x] **Step 2: Write the failing store test**

Create `test/user-style-store.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { createUserStyleAtom } from '../src/user-style/store-helpers.js';

test('createUserStyleAtom: creates atom with scope=user, user_id set, project_id null', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await createUserStyleAtom(store, {
    userId: 'alice@example.com',
    claim: 'Prefer named exports.',
    type: 'convention',
    priority: 'coding_preference',
    trigger: { intentTags: ['style'] },
  });
  assert.equal(atom.scope, 'user');
  assert.equal(atom.userId, 'alice@example.com');
  assert.equal(atom.priority, 'coding_preference');
});

test('createUserStyleAtom: rejects type=procedure', async () => {
  const store = new MemoryKnowledgeStore();
  await assert.rejects(
    createUserStyleAtom(store, {
      userId: 'a', claim: 'Multi-step.', type: 'procedure' as never,
      priority: 'coding_preference', trigger: { intentTags: ['x'] },
    }),
    /procedure/,
  );
});

test('createUserStyleAtom: auto-inserts prior_session evidence when sessionId is passed', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await createUserStyleAtom(store, {
    userId: 'a', claim: 'Use Conventional Commits.', type: 'convention',
    priority: 'personal_workflow', trigger: { intentTags: ['commit'] },
    sessionId: 'sess-1',
  });
  assert.ok(atom.evidence.some((e) => e.kind === 'prior_session' && e.sessionId === 'sess-1'));
});

test('createUserStyleAtom: when no evidence and no sessionId, sets low_evidence metadata', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await createUserStyleAtom(store, {
    userId: 'a', claim: 'Always use pnpm.', type: 'convention',
    priority: 'personal_workflow', trigger: { intentTags: ['tools'] },
  });
  // The store does not yet support a metadata field on atoms; assert via the
  // returned atom shape that low_evidence flag is present in audit or a sibling field.
  // Adjust per actual atom shape: this test pins behavior, fix in impl.
  assert.equal(atom.evidence.length, 0);
  assert.ok((atom as unknown as { metadata?: { lowEvidence?: boolean } }).metadata?.lowEvidence === true);
});

test('searchAtomsByTrigger: scope=user filter returns only user atoms for the given userId', async () => {
  const store = new MemoryKnowledgeStore();
  await createUserStyleAtom(store, {
    userId: 'alice@example.com', claim: 'P1', type: 'convention',
    priority: 'coding_preference', trigger: { taskTypes: ['refactor'] },
  });
  await createUserStyleAtom(store, {
    userId: 'bob@example.com', claim: 'P2', type: 'convention',
    priority: 'coding_preference', trigger: { taskTypes: ['refactor'] },
  });
  await store.createAtom({
    project: 'tuberosa', claim: 'Project atom', type: 'convention',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { taskTypes: ['refactor'] }, producedBy: 'agent_session',
  });
  const found = await store.searchAtomsByTrigger(
    { taskTypes: ['refactor'] },
    { project: undefined, scope: 'user', userId: 'alice@example.com', limit: 10 } as never,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].userId, 'alice@example.com');
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `node --test --import tsx test/user-style-store.test.ts`
Expected: FAIL — helper not implemented; `searchAtomsByTrigger` does not yet accept `scope`/`userId`.

- [x] **Step 4: Implement `createUserStyleAtom`**

Create `src/user-style/store-helpers.ts`:

```typescript
import type { KnowledgeStore } from '../storage/store.js';
import type { Evidence, KnowledgeAtom, KnowledgeAtomInput, StylePriority, Trigger } from '../types/atoms.js';

export interface CreateUserStyleAtomInput {
  userId: string;
  claim: string;
  type: 'convention' | 'gotcha' | 'decision' | 'fact';
  priority: StylePriority;
  trigger: Trigger;
  evidence?: Evidence[];
  pitfalls?: string[];
  sessionId?: string;
}

export async function createUserStyleAtom(
  store: KnowledgeStore,
  input: CreateUserStyleAtomInput,
): Promise<KnowledgeAtom> {
  if ((input.type as string) === 'procedure') {
    throw new Error('User-style atoms cannot be of type=procedure; use a project workflow or wiki instead.');
  }
  const evidence: Evidence[] = input.evidence ? [...input.evidence] : [];
  if (evidence.length === 0 && input.sessionId) {
    evidence.push({ kind: 'prior_session', sessionId: input.sessionId });
  }
  const lowEvidence = evidence.length === 0;
  const atomInput: KnowledgeAtomInput & { scope: 'user'; metadata?: Record<string, unknown> } = {
    project: `__user:${input.userId}`,    // satisfies project NOT NULL constraint at storage layer for memory store
    claim: input.claim,
    type: input.type,
    evidence,
    trigger: input.trigger,
    pitfalls: input.pitfalls,
    producedBy: 'user',
    scope: 'user',
    userId: input.userId,
    priority: input.priority,
    metadata: lowEvidence ? { lowEvidence: true } : {},
  };
  return store.createAtom(atomInput);
}
```

(Postgres path: `createAtom` enforces `scope='user' ⇒ project_id IS NULL` by leaving `project_id` null when `scope='user'`. Memory store keeps a sentinel project string for indexing; queries filter by `scope`/`userId`.)

- [x] **Step 5: Extend store interface to accept scope/userId filters**

Edit `src/storage/store.ts` and the two implementations:

```typescript
// In KnowledgeStore.searchAtomsByTrigger options:
options: { project?: string; scope?: 'project' | 'user'; userId?: string; limit: number; status?: 'active' | 'archived' | 'all' }
```

`createAtom` learns to accept and persist `scope`, `userId`, `priority`. `MemoryKnowledgeStore.createAtom` defaults `scope='project'`. `PostgresKnowledgeStore.createAtom` updates the INSERT to include the new columns and sets `project_id=NULL` when `scope='user'`.

`searchAtomsByTrigger` learns the new filters:

```typescript
// Memory store inside the filter pipeline:
.filter((atom) => !options.scope  || atom.scope  === options.scope)
.filter((atom) => !options.userId || atom.userId === options.userId)
```

Postgres adds equivalent `AND scope = $N AND user_id = $N` clauses.

- [x] **Step 6: Run the test**

Run: `node --test --import tsx test/user-style-store.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/types/atoms.ts src/storage/store.ts src/storage/memory-store.ts src/storage/postgres-store.ts src/user-style/store-helpers.ts test/user-style-store.test.ts
git commit -m "feat(user-style): scope/userId/priority on atoms + createUserStyleAtom helper"
```

---

## Task 3: Triviality rule + critic adjustments

**Files:**
- Create: `src/user-style/triviality-rules.ts`
- Modify: `src/atoms/critic.ts`
- Test: `test/user-style-triviality.test.ts`

- [x] **Step 1: Write the failing test**

Create `test/user-style-triviality.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { MemoryCache } from '../src/cache.js';
import { AtomCritic } from '../src/atoms/critic.js';

test('critic: scope=user rejects bare-ego claim via personal_pronoun_only rule', async () => {
  const store = new MemoryKnowledgeStore();
  const critic = new AtomCritic(store, new HashModelProvider(), { cache: new MemoryCache() });
  const result = await critic.evaluate({
    project: '__user:a', claim: "I'm the best",
    type: 'convention', evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { intentTags: ['style'] },
    producedBy: 'user', scope: 'user', userId: 'a', priority: 'coding_preference',
  } as never);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('personal_pronoun_only')));
});

test('critic: scope=user accepts "I prefer named exports" (has verb + object)', async () => {
  const store = new MemoryKnowledgeStore();
  const critic = new AtomCritic(store, new HashModelProvider(), { cache: new MemoryCache() });
  const result = await critic.evaluate({
    project: '__user:a', claim: 'I prefer named exports for module clarity.',
    type: 'convention', evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { intentTags: ['style'], symbols: ['export'] },
    producedBy: 'user', scope: 'user', userId: 'a', priority: 'coding_preference',
  } as never);
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
});

test('critic: scope=user skips cross-type legacy dedup', async () => {
  const store = new MemoryKnowledgeStore();
  // Pre-existing legacy memory item with matching content
  await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u', itemType: 'memory',
    title: 't', summary: '', content: 'Prefer named exports.', labels: [], references: [], metadata: {},
  }, []);
  const critic = new AtomCritic(store, new HashModelProvider(), { cache: new MemoryCache(), legacyDedupThreshold: 0.0 });
  const result = await critic.evaluate({
    project: '__user:a', claim: 'Prefer named exports.',
    type: 'convention', evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { intentTags: ['style'] },
    producedBy: 'user', scope: 'user', userId: 'a', priority: 'coding_preference',
  } as never);
  // For scope='user', cross-type dedup is skipped — the legacy item should NOT block this.
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/user-style-triviality.test.ts`
Expected: FAIL — critic does not know about `scope='user'` yet.

- [x] **Step 3: Add the new triviality rule**

Create `src/user-style/triviality-rules.ts`:

```typescript
import type { TrivialityRule } from '../atoms/triviality-rules.js';

// Anchored at start AND end: catches "I'm the best" but not "I prefer named exports for clarity."
const BARE_EGO_RE = /^\s*(?:i\s+(?:am|like|love|hate|feel)|i'm|my)\s+[^.]{0,40}\.?\s*$/i;

export const PERSONAL_PRONOUN_ONLY_RULE: TrivialityRule = {
  name: 'personal_pronoun_only',
  test: (a) => BARE_EGO_RE.test(a.claim),
};
```

- [x] **Step 4: Wire the rule + scope handling into `AtomCritic`**

Edit `src/atoms/critic.ts`:

```typescript
import { PERSONAL_PRONOUN_ONLY_RULE } from '../user-style/triviality-rules.js';

// In the constructor, when scope can be 'user' on inputs, build a per-input rule list:
private rulesForInput(input: KnowledgeAtomInput): TrivialityRule[] {
  const base = this.rules;
  if (input.scope === 'user') return [...base, PERSONAL_PRONOUN_ONLY_RULE];
  return base;
}

// In evaluate(), replace the rules call:
const triviality = evaluateTriviality(input, this.rulesForInput(input));

// In evaluateDedup(), skip cross-type legacy dedup for scope='user':
if (input.scope === 'user') {
  // Only atom-vs-atom dedup; same-user only.
  const atomMatches = await this.store.searchAtomsByEmbedding(embedding, {
    project: undefined, limit: 5, threshold: this.atomDedupThreshold,
    scope: 'user', userId: input.userId,
  } as never);
  if (atomMatches.length > 0) {
    return { outcome: 'rejected', reason: `duplicate of user-style atom ${atomMatches[0].atom.id}` };
  }
  return { outcome: 'pass' };
}
```

- [x] **Step 5: Run the test**

Run: `node --test --import tsx test/user-style-triviality.test.ts`
Expected: PASS.

- [x] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS — project atom critic behavior is unchanged.

- [x] **Step 7: Commit**

```bash
git add src/user-style/triviality-rules.ts src/atoms/critic.ts test/user-style-triviality.test.ts
git commit -m "feat(user-style): critic adjustments — bare-ego rule + per-user dedup, skip legacy"
```

---

## Task 4: Retrieval integration

**Files:**
- Modify: `src/retrieval/policy.ts`
- Modify: `src/retrieval/service.ts`
- Modify: `src/retrieval/context-pack.ts`
- Modify: `src/config.ts`
- Test: `test/user-style-retrieval.test.ts`

- [x] **Step 1: Policy defaults**

Edit `src/retrieval/policy.ts`:

```typescript
  sourceWeights: {
    // … existing
    userStyle: 0.12,
  },
  userStyle: {
    tierMultipliers: { draft: 0.4, verified: 0.8, canonical: 1.1 },
    personalWorkflowBoost: 1.3,
  },
```

- [x] **Step 2: Write the failing test**

Create `test/user-style-retrieval.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { defaultConfig } from '../src/config.js';
import { createUserStyleAtom } from '../src/user-style/store-helpers.js';

test('searchContext: matching user-style atom surfaces with userStyle:<priority>: matchReason', async () => {
  const store = new MemoryKnowledgeStore();
  await createUserStyleAtom(store, {
    userId: 'alice@example.com',
    claim: 'Prefer named exports.', type: 'convention',
    priority: 'coding_preference', trigger: { intentTags: ['style'], symbols: ['export'] },
  });
  const config = { ...defaultConfig(), userId: 'alice@example.com' };
  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), config);
  const pack = await service.searchContext({
    project: 'tuberosa', prompt: 'how should I export this module',
    symbols: ['export'],
  });
  const items = pack.sections.flatMap((s) => s.items);
  const styleHit = items.find((i) => i.matchReasons?.some((r) => r.startsWith('userStyle:')));
  assert.ok(styleHit, 'expected at least one userStyle hit');
});

test('searchContext: TUBEROSA_USER_ID unset → no user-style hits', async () => {
  const store = new MemoryKnowledgeStore();
  await createUserStyleAtom(store, {
    userId: 'alice@example.com', claim: 'X', type: 'convention',
    priority: 'coding_preference', trigger: { intentTags: ['x'] },
  });
  const config = { ...defaultConfig(), userId: undefined };
  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), config);
  const pack = await service.searchContext({ project: 'tuberosa', prompt: 'x' });
  const items = pack.sections.flatMap((s) => s.items);
  assert.equal(items.find((i) => i.matchReasons?.some((r) => r.startsWith('userStyle:'))), undefined);
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `node --test --import tsx test/user-style-retrieval.test.ts`
Expected: FAIL.

- [x] **Step 4: Wire user-style into `findCandidates` and ranking**

Edit `src/retrieval/service.ts`. Pull user-style candidates as a 7th source:

```typescript
// In findCandidates(), alongside the existing parallel searches:
const userStyleResults = config.userId
  ? await timed('userStyle', this.store.searchAtomsByTrigger(
      { taskTypes: classified.taskType ? [classified.taskType] : undefined,
        files: classified.files, symbols: classified.symbols },
      { project: undefined, scope: 'user', userId: config.userId, limit: SEARCH_LIMIT } as never,
    ), debug)
  : [];

const userStyleCandidates: SearchCandidate[] = (userStyleResults as Awaited<ReturnType<typeof this.store.listAtoms>>).map((atom, index) => ({
  knowledgeId: atom.id,
  source: 'userStyle',
  rank: index + 1,
  rawScore: 1.0,
  title: atom.claim, summary: atom.claim, itemType: 'memory',
  project: atom.project, labels: [], references: [],
  content: atom.claim, contextualContent: atom.claim,
  tokenEstimate: Math.ceil(atom.claim.length / 4),
  metadata: { userStyleTier: atom.tier, userStylePriority: atom.priority, userStyleAtomId: atom.id },
  matchReasons: [`userStyle:${atom.priority}:`],
}));
safeResults.userStyle = userStyleCandidates;
```

In `applyRankingAdjustments`, apply tier multiplier + `personalWorkflowBoost`:

```typescript
.map((candidate) => {
  const meta = candidate.metadata as { userStyleTier?: 'draft'|'verified'|'canonical'; userStylePriority?: 'personal_workflow'|'coding_preference' } | undefined;
  if (!meta?.userStyleTier) return candidate;
  const policy = getRetrievalPolicy().userStyle;
  let multiplier = policy.tierMultipliers[meta.userStyleTier] ?? 0;
  if (meta.userStylePriority === 'personal_workflow') multiplier *= policy.personalWorkflowBoost;
  return { ...candidate, finalScore: candidate.finalScore * multiplier };
})
```

Update `KnowledgeSearchResult` to include `userStyle: SearchCandidate[]` and feed it into the fusion candidate groups.

- [x] **Step 5: Add `userId` to `AppConfig`**

Edit `src/config.ts`:

```typescript
  userId: process.env.TUBEROSA_USER_ID || undefined,
  userStyleEnabled: process.env.TUBEROSA_USER_STYLE_ENABLED !== 'false',
```

- [x] **Step 6: Run the test**

Run: `node --test --import tsx test/user-style-retrieval.test.ts`
Expected: PASS.

- [x] **Step 7: Retrieval eval green**

Run: `pnpm run eval:retrieval`
Expected: PASS — existing cases unaffected (user-style absent without `TUBEROSA_USER_ID`).

- [x] **Step 8: Commit**

```bash
git add src/retrieval/policy.ts src/retrieval/service.ts src/retrieval/context-pack.ts src/config.ts test/user-style-retrieval.test.ts
git commit -m "feat(user-style): user atoms as a 7th candidate source with tier + workflow boost"
```

---

## Task 5: Conflict resolver

**Files:**
- Create: `src/user-style/conflict-resolver.ts`
- Modify: `src/retrieval/service.ts`
- Test: `test/user-style-conflict.test.ts`

- [x] **Step 1: Write the failing test**

Create `test/user-style-conflict.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { defaultConfig } from '../src/config.js';
import { createUserStyleAtom } from '../src/user-style/store-helpers.js';

async function setup(priority: 'personal_workflow' | 'coding_preference') {
  const store = new MemoryKnowledgeStore();
  // Project convention atom
  await store.createAtom({
    project: 'tuberosa', claim: 'Use default exports.', type: 'convention',
    evidence: [{ kind: 'file', path: 'src/index.ts' }],
    trigger: { intentTags: ['style'], symbols: ['export'] }, producedBy: 'agent_session',
  });
  // User-style atom that DIRECTLY contradicts
  await createUserStyleAtom(store, {
    userId: 'alice@example.com', claim: 'Never use default exports.', type: 'convention',
    priority, trigger: { intentTags: ['style'], symbols: ['export'] },
  });
  const config = { ...defaultConfig(), userId: 'alice@example.com' };
  return new RetrievalService(store, new MemoryCache(), new HashModelProvider(), config);
}

test('conflict: personal_workflow user style wins; pack.instruction mentions override', async () => {
  const service = await setup('personal_workflow');
  const pack = await service.searchContext({
    project: 'tuberosa', prompt: 'how should I export this',
    symbols: ['export'],
  });
  const items = pack.sections.flatMap((s) => s.items);
  const userHit = items.find((i) => i.matchReasons?.some((r) => r.startsWith('userStyle:personal_workflow:')));
  const projectHit = items.find((i) => i.title?.includes('Use default exports'));
  assert.ok(userHit);
  // Project atom should be suppressed
  assert.equal(projectHit, undefined);
  assert.ok(pack.instruction?.toLowerCase().includes('personal workflow'));
});

test('conflict: coding_preference user style yields; project wins; pack.instruction parks the preference', async () => {
  const service = await setup('coding_preference');
  const pack = await service.searchContext({
    project: 'tuberosa', prompt: 'how should I export this',
    symbols: ['export'],
  });
  const items = pack.sections.flatMap((s) => s.items);
  const projectHit = items.find((i) => i.title?.includes('Use default exports'));
  const userHit = items.find((i) => i.matchReasons?.some((r) => r.startsWith('userStyle:coding_preference:')));
  assert.ok(projectHit);
  assert.equal(userHit, undefined);
  assert.ok(pack.instruction?.toLowerCase().includes('project convention'));
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/user-style-conflict.test.ts`
Expected: FAIL — no conflict resolver yet.

- [x] **Step 3: Implement the resolver**

Create `src/user-style/conflict-resolver.ts`:

```typescript
import type { RankedCandidate } from '../types.js';

const NEGATION_RE = /\b(not|never|don't|avoid|without|no\b)/i;

function isContradiction(userClaim: string, projectClaim: string): boolean {
  // Heuristic 1: negation imbalance
  const userNeg = NEGATION_RE.test(userClaim);
  const projNeg = NEGATION_RE.test(projectClaim);
  const negationContrast = userNeg !== projNeg;

  // Strip negations and compare overlap of remaining content words.
  const tokensA = userClaim.toLowerCase().replace(NEGATION_RE, '').split(/\W+/).filter((w) => w.length > 3);
  const tokensB = projectClaim.toLowerCase().replace(NEGATION_RE, '').split(/\W+/).filter((w) => w.length > 3);
  const setA = new Set(tokensA);
  const overlap = tokensB.filter((t) => setA.has(t)).length;
  const minLen = Math.min(tokensA.length, tokensB.length);
  const jaccardEnough = minLen > 0 && overlap / minLen >= 0.5;

  return negationContrast && jaccardEnough;
}

export interface ConflictResolution {
  suppressedCandidateIds: string[];
  instructionLines: string[];
}

export function resolveStyleConflicts(candidates: RankedCandidate[]): ConflictResolution {
  const suppressed: string[] = [];
  const lines: string[] = [];

  type WithMeta = RankedCandidate & { metadata?: { userStyleAtomId?: string; userStylePriority?: 'personal_workflow' | 'coding_preference' } };
  const userStyleCandidates = (candidates as WithMeta[]).filter((c) => c.metadata?.userStyleAtomId);
  const projectConventionCandidates = (candidates as WithMeta[]).filter((c) =>
    !c.metadata?.userStyleAtomId
    && (c.itemType === 'memory')
    && (c.title?.length ?? 0) > 0,
  );

  for (const user of userStyleCandidates) {
    for (const proj of projectConventionCandidates) {
      if (!isContradiction(user.title ?? '', proj.title ?? '')) continue;
      if (user.metadata!.userStylePriority === 'personal_workflow') {
        suppressed.push(proj.knowledgeId);
        lines.push(`Following your personal workflow: ${user.title}`);
      } else {
        suppressed.push(user.knowledgeId);
        lines.push(`Project convention: ${proj.title}. Your usual preference "${user.title}" is parked for this codebase.`);
      }
    }
  }
  return { suppressedCandidateIds: suppressed, instructionLines: lines };
}
```

- [x] **Step 4: Wire into `searchContext`**

Edit `src/retrieval/service.ts`. After fusion + rerank + ranking adjustments, before pack assembly:

```typescript
import { resolveStyleConflicts } from '../user-style/conflict-resolver.js';

const conflict = resolveStyleConflicts(rankedCandidates);
const suppressed = new Set(conflict.suppressedCandidateIds);
const filteredCandidates = rankedCandidates.filter((c) => !suppressed.has(c.knowledgeId));

// Pack assembly:
const pack = this.buildContextPack({
  /* … */
  candidates: filteredCandidates,
  extraInstructionLines: conflict.instructionLines,
});
```

In `context-pack.ts`, accept and append `extraInstructionLines` to `pack.instruction`.

- [x] **Step 5: Run the test**

Run: `node --test --import tsx test/user-style-conflict.test.ts`
Expected: PASS.

- [x] **Step 6: Retrieval eval green**

Run: `pnpm run eval:retrieval`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/user-style/conflict-resolver.ts src/retrieval/service.ts src/retrieval/context-pack.ts test/user-style-conflict.test.ts
git commit -m "feat(user-style): conflict resolver — personal_workflow wins, coding_preference yields"
```

---

## Task 6: HTTP + MCP authoring surfaces

**Files:**
- Modify: `src/http/server.ts`
- Modify: `src/mcp/server.ts`

- [x] **Step 1: HTTP routes**

```typescript
  app.post('/user-style-atoms', requireAuth, async (req, res) => {
    const body = req.body ?? {};
    const userId = body.userId ?? config.userId;
    if (!userId) return res.status(400).json({ error: 'userId required (set TUBEROSA_USER_ID or include in body)' });
    const atom = await createUserStyleAtom(store, {
      userId,
      claim: body.claim, type: body.type,
      priority: body.priority ?? 'coding_preference',
      trigger: body.trigger ?? {},
      evidence: body.evidence,
      pitfalls: body.pitfalls,
      sessionId: body.sessionId,
    });
    res.json({ atom });
  });

  app.get('/user-style-atoms', requireAuth, async (req, res) => {
    const userId = typeof req.query.userId === 'string' ? req.query.userId : config.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json(await store.listAtoms({ project: undefined, limit: 100 }
      // memory + postgres listAtoms learns to filter by scope/userId per Task 2 step 5
      as never));
  });

  app.patch('/user-style-atoms/:id', requireAuth, async (req, res) => {
    const patch = req.body ?? {};
    const updated = await store.updateAtom(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });
```

- [x] **Step 2: MCP tools**

```typescript
  server.registerTool('tuberosa_record_user_style', {
    description: 'Record a cross-project personal style preference (atom with scope=user).',
    inputSchema: {
      type: 'object',
      properties: {
        userId:   { type: 'string' },
        claim:    { type: 'string' },
        type:     { type: 'string', enum: ['convention', 'gotcha', 'decision', 'fact'] },
        priority: { type: 'string', enum: ['personal_workflow', 'coding_preference'], default: 'coding_preference' },
        trigger:  { type: 'object' },
        evidence: { type: 'array' },
        pitfalls: { type: 'array' },
        sessionId: { type: 'string' },
      },
      required: ['claim', 'type', 'trigger'],
    },
  }, async ({ userId, claim, type, priority, trigger, evidence, pitfalls, sessionId }) => {
    const effectiveUserId = userId ?? config.userId;
    if (!effectiveUserId) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'userId required (set TUBEROSA_USER_ID)' }) }], isError: true };
    }
    const atom = await createUserStyleAtom(store, {
      userId: effectiveUserId, claim, type,
      priority: priority ?? 'coding_preference',
      trigger, evidence, pitfalls, sessionId,
    });
    return { content: [{ type: 'text', text: JSON.stringify(atom, null, 2) }] };
  });

  server.registerTool('tuberosa_list_user_style', {
    description: 'List user-style atoms for the given user (or current TUBEROSA_USER_ID).',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' } } },
  }, async ({ userId }) => {
    const effective = userId ?? config.userId;
    if (!effective) return { content: [{ type: 'text', text: JSON.stringify({ error: 'userId required' }) }], isError: true };
    const atoms = await store.listAtoms({ project: undefined, limit: 100 } as never);
    return { content: [{ type: 'text', text: JSON.stringify(atoms, null, 2) }] };
  });
```

- [x] **Step 3: Smoke-test**

Run: `pnpm test`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add src/http/server.ts src/mcp/server.ts
git commit -m "feat(user-style): HTTP + MCP authoring surfaces (record + list)"
```

---

## Task 7: Finish-session router for `user_preference` signals

**Files:**
- Create: `src/user-style/finish-session-router.ts`
- Modify: `src/agent-session/service.ts`
- Test: `test/user-style-finish-session.test.ts`

- [x] **Step 1: Write the failing test**

Create `test/user-style-finish-session.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { AgentSessionService } from '../src/agent-session/service.js';
import { defaultConfig } from '../src/config.js';

test('finishSession: user_preference learning signal becomes a draft user-style atom', async () => {
  const store = new MemoryKnowledgeStore();
  const config = { ...defaultConfig(), userId: 'alice@example.com' };
  const retrieval = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), config);
  const session = await store.createAgentSession({
    prompt: 'commit message style', project: 'tuberosa',
  });
  const service = new AgentSessionService(store, retrieval, new HashModelProvider(), config);
  await service.finishSession({
    sessionId: session.id,
    outcome: 'completed',
    summary: 'set up commits',
    learningSignals: [{
      kind: 'user_preference',
      text: 'I commit with Conventional Commits and no Claude co-author trailer.',
      source: 'agent',
    }],
  });
  const atoms = await store.listAtoms({ project: undefined, limit: 10 } as never);
  const userAtom = atoms.find((a) => a.scope === 'user' && a.userId === 'alice@example.com');
  assert.ok(userAtom);
  assert.equal(userAtom!.tier, 'draft');
  assert.equal(userAtom!.priority, 'coding_preference');
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/user-style-finish-session.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement the router**

Create `src/user-style/finish-session-router.ts`:

```typescript
import type { AtomCritic } from '../atoms/critic.js';
import type { KnowledgeStore } from '../storage/store.js';
import { createUserStyleAtom } from './store-helpers.js';

export interface UserPreferenceSignal {
  text: string;
  type?: 'convention' | 'gotcha' | 'decision' | 'fact';
}

export async function routeUserPreferenceSignal(
  store: KnowledgeStore,
  critic: AtomCritic,
  input: {
    userId: string;
    sessionId: string;
    signal: UserPreferenceSignal;
  },
): Promise<{ atomId?: string; rejected?: boolean; reasons?: string[] }> {
  // Critic dry-run on the candidate to decide whether to persist or queue a gap.
  const candidate = {
    project: `__user:${input.userId}`,
    claim: input.signal.text,
    type: input.signal.type ?? 'convention',
    evidence: [{ kind: 'prior_session' as const, sessionId: input.sessionId }],
    trigger: { intentTags: ['user_preference'] },
    producedBy: 'agent_session' as const,
    scope: 'user' as const,
    userId: input.userId,
    priority: 'coding_preference' as const,
  };
  const verdict = await critic.evaluate(candidate as never, input.sessionId);
  if (verdict.outcome !== 'accepted') {
    await store.createKnowledgeGap({
      sourceSessionId: input.sessionId,
      prompt: input.signal.text,
      reason: verdict.reasons.join('; '),
      metadata: { source: 'user_style_critic' },
    });
    return { rejected: true, reasons: verdict.reasons };
  }
  const atom = await createUserStyleAtom(store, {
    userId: input.userId,
    claim: input.signal.text,
    type: input.signal.type ?? 'convention',
    priority: 'coding_preference',
    trigger: { intentTags: ['user_preference'] },
    sessionId: input.sessionId,
  });
  return { atomId: atom.id };
}
```

- [x] **Step 4: Call from `finishSession`**

Edit `src/agent-session/service.ts`. In the `finishSession` flow, after the existing atom extraction:

```typescript
import { routeUserPreferenceSignal } from '../user-style/finish-session-router.js';

if (this.config.userId && this.config.userStyleEnabled) {
  const signals = (input.learningSignals ?? []).filter((s) => s.kind === 'user_preference');
  for (const signal of signals) {
    await routeUserPreferenceSignal(this.store, this.critic, {
      userId: this.config.userId,
      sessionId: input.sessionId,
      signal: { text: signal.text },
    });
  }
}
```

- [x] **Step 5: Run the test**

Run: `node --test --import tsx test/user-style-finish-session.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/user-style/finish-session-router.ts src/agent-session/service.ts test/user-style-finish-session.test.ts
git commit -m "feat(user-style): finishSession routes user_preference signals to user-style critic"
```

---

## Task 8: Correction + rejection clustering job

**Files:**
- Create: `src/user-style/clusterer.ts`
- Create: `scripts/cluster-user-corrections.ts`
- Modify: `src/worker.ts`
- Modify: `package.json`
- Test: `test/user-style-clusterer.test.ts`

- [x] **Step 1: Write the failing test**

Create `test/user-style-clusterer.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { clusterUserCorrections } from '../src/user-style/clusterer.js';

test('clusterUserCorrections: 3 similar correction events produce one user_style_candidate proposal', async () => {
  const store = new MemoryKnowledgeStore();
  for (let i = 0; i < 3; i += 1) {
    await store.recordFeedback({
      project: 'tuberosa',
      feedbackType: 'rejected',
      rejectedKnowledgeIds: [],
      reason: 'Stop adding JSDoc to trivial setters.',
      metadata: { userId: 'alice@example.com' },
    });
  }
  const report = await clusterUserCorrections(store, new HashModelProvider(), {
    userId: 'alice@example.com', windowDays: 30, minClusterEvents: 3,
  });
  assert.equal(report.proposalsCreated, 1);
  const proposals = await store.listLearningProposals({ project: undefined, status: 'open', limit: 10 });
  assert.ok(proposals.some((p) => p.proposalType === 'user_style_candidate' || (p.metadata as { source?: string }).source === 'user_style_clusterer'));
});

test('clusterUserCorrections: below min cluster threshold produces no proposal', async () => {
  const store = new MemoryKnowledgeStore();
  for (let i = 0; i < 2; i += 1) {
    await store.recordFeedback({
      project: 'tuberosa',
      feedbackType: 'rejected',
      rejectedKnowledgeIds: [],
      reason: 'Avoid JSDoc.',
      metadata: { userId: 'alice@example.com' },
    });
  }
  const report = await clusterUserCorrections(store, new HashModelProvider(), {
    userId: 'alice@example.com', windowDays: 30, minClusterEvents: 3,
  });
  assert.equal(report.proposalsCreated, 0);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/user-style-clusterer.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement clusterer**

Create `src/user-style/clusterer.ts`:

```typescript
import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';

export interface ClusterReport {
  scannedEvents: number;
  clusters: number;
  proposalsCreated: number;
}

export async function clusterUserCorrections(
  store: KnowledgeStore,
  models: ModelProvider,
  options: { userId: string; windowDays: number; minClusterEvents: number },
): Promise<ClusterReport> {
  const cutoff = Date.now() - options.windowDays * 24 * 60 * 60 * 1000;
  const events = (await store.listFeedbackEvents({ limit: 5000 }))
    .filter((e) => ['rejected', 'irrelevant', 'stale', 'selected_but_noisy'].includes(e.feedbackType))
    .filter((e) => (e.metadata as { userId?: string } | undefined)?.userId === options.userId)
    .filter((e) => new Date(e.createdAt).getTime() >= cutoff)
    .filter((e) => Boolean(e.reason));

  if (events.length === 0) return { scannedEvents: 0, clusters: 0, proposalsCreated: 0 };

  // Single-link greedy cosine clustering
  const embedded = await Promise.all(events.map(async (e) => ({
    event: e,
    embedding: await models.embed(e.reason ?? ''),
  })));
  const clusters: Array<typeof embedded> = [];
  for (const item of embedded) {
    let placed = false;
    for (const cluster of clusters) {
      const centroid = cluster[0].embedding;
      const cosine = cosineSimilarity(centroid, item.embedding);
      if (cosine >= 0.85) {
        cluster.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([item]);
  }

  let proposals = 0;
  for (const cluster of clusters) {
    if (cluster.length < options.minClusterEvents) continue;
    const claim = cluster[0].event.reason!;       // simplest centroid summary
    const quotes = cluster.map((c) => c.event.reason!).slice(0, 6);
    await store.createLearningProposal({
      proposalType: 'user_style_candidate' as never,
      reason: `Clustered ${cluster.length} corrections for user ${options.userId}: ${claim}`,
      evidence: { quotes, sampleFeedbackIds: cluster.map((c) => c.event.id) },
      metadata: { source: 'user_style_clusterer', userId: options.userId, defaultPriority: 'coding_preference' },
    } as never);
    proposals += 1;
  }
  return { scannedEvents: events.length, clusters: clusters.length, proposalsCreated: proposals };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
```

(If `user_style_candidate` is not yet a valid `proposalType` in the existing `LearningProposalType` enum, extend the type union in `src/types.ts`. The proposal-table schema already supports arbitrary string types — only the TS union needs extending.)

- [x] **Step 4: Add CLI**

Create `scripts/cluster-user-corrections.ts`:

```typescript
import { parseArgs } from 'node:util';
import { createAppServices } from '../src/app.js';
import { clusterUserCorrections } from '../src/user-style/clusterer.js';

const { values } = parseArgs({
  options: { user: { type: 'string' }, windowDays: { type: 'string', default: '30' }, min: { type: 'string', default: '3' } },
});

if (!values.user) { console.error('--user is required'); process.exit(2); }

const services = await createAppServices();
const report = await clusterUserCorrections(services.store, services.models, {
  userId: values.user!,
  windowDays: Number(values.windowDays),
  minClusterEvents: Number(values.min),
});
console.log(JSON.stringify(report, null, 2));
await services.close();
```

- [x] **Step 5: Schedule in worker + npm script**

Edit `src/worker.ts`:

```typescript
import { clusterUserCorrections } from './user-style/clusterer.js';

const clusterIntervalMs = (services.config.userStyleClusterIntervalHours ?? 1) * 60 * 60 * 1000;
let clusterInterval: NodeJS.Timeout | undefined;
if (services.config.userStyleEnabled && services.config.userId) {
  const run = async () => {
    try {
      await clusterUserCorrections(services.store, services.models, {
        userId: services.config.userId!,
        windowDays: services.config.userStyleClusterWindowDays ?? 30,
        minClusterEvents: services.config.userStyleMinClusterEvents ?? 3,
      });
    } catch (error) {
      process.stderr.write(`[user-style-clusterer] ${(error as Error).message}\n`);
    }
  };
  clusterInterval = setInterval(() => void run(), clusterIntervalMs);
}
```

`package.json`:

```json
    "cluster-user-corrections": "node --import tsx scripts/cluster-user-corrections.ts"
```

- [x] **Step 6: Run the test**

Run: `node --test --import tsx test/user-style-clusterer.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/user-style/clusterer.ts scripts/cluster-user-corrections.ts src/worker.ts package.json src/types.ts test/user-style-clusterer.test.ts
git commit -m "feat(user-style): correction-clustering job + CLI + scheduled worker"
```

---

## Task 9: Export/import integration

**Files:**
- Modify: `src/export/exporter.ts`
- Modify: `src/export/importer.ts`
- Modify: `scripts/export-pack.ts`
- Modify: `scripts/import-pack.ts`

- [x] **Step 1: Exporter — honor `--include-user-style`**

Edit `src/export/exporter.ts`:

```typescript
export interface ExportOptions {
  // … existing
  includeUserStyle?: string;   // userId; when set, also export user-style atoms under user-style/<id>/
}
```

After the atoms loop, when `opts.includeUserStyle` is set, fetch user-style atoms and write them under `user-style/<userId>/`. Manifest gains `userStyleScopes: [userId]`.

Edit `scripts/export-pack.ts` to accept `--include-user-style=<id>` and pass it through.

- [x] **Step 2: Importer — recognize user-style directory**

Edit `src/export/importer.ts`. Add a pass that processes `user-style/<userId>/*.md`:

- Parse the atom Markdown via the same atom codec.
- Force `tier='draft'` and `priority='coding_preference'` regardless of source unless `--preserve-priority` is passed.
- Rewrite `userId` to the importer's `TUBEROSA_USER_ID` unless `--preserve-user-id` is passed.
- Conflicts (same atom id) follow the same review-queue path as project atoms.

Edit `scripts/import-pack.ts` to accept `--preserve-user-id` and `--preserve-priority` flags.

- [x] **Step 3: Smoke-test**

```bash
pnpm run export-pack -- --project tuberosa --out /tmp/pack --include-user-style=alice@example.com
ls /tmp/pack/user-style/alice@example.com/
```

- [x] **Step 4: Commit**

```bash
git add src/export/exporter.ts src/export/importer.ts scripts/export-pack.ts scripts/import-pack.ts
git commit -m "feat(user-style): export/import integration with priority + userId reset on import"
```

---

## Task 10: Eval fixtures + final verification

**Files:**
- Modify: `eval/retrieval-fixtures.json`

- [x] **Step 1: Add fixtures**

```jsonc
{
  "name": "user-style: personal_workflow wins on conflict",
  "configOverride": { "userId": "alice@example.com" },
  "ingest": {
    "atoms": [
      { "scope": "user", "userId": "alice@example.com", "claim": "Never use default exports.",
        "type": "convention", "priority": "personal_workflow",
        "trigger": { "intentTags": ["style"], "symbols": ["export"] } },
      { "scope": "project", "claim": "Use default exports.",
        "type": "convention", "evidence": [{"kind":"file","path":"src/index.ts"}],
        "trigger": { "intentTags": ["style"], "symbols": ["export"] } }
    ]
  },
  "query": { "prompt": "exports", "symbols": ["export"] },
  "expect": { "topClaimsContain": ["Never use default exports."], "instructionContains": "personal workflow" }
},
{
  "name": "user-style: coding_preference yields to project convention",
  "configOverride": { "userId": "alice@example.com" },
  "ingest": {
    "atoms": [
      { "scope": "user", "userId": "alice@example.com", "claim": "Never use default exports.",
        "type": "convention", "priority": "coding_preference",
        "trigger": { "intentTags": ["style"], "symbols": ["export"] } },
      { "scope": "project", "claim": "Use default exports.",
        "type": "convention", "evidence": [{"kind":"file","path":"src/index.ts"}],
        "trigger": { "intentTags": ["style"], "symbols": ["export"] } }
    ]
  },
  "query": { "prompt": "exports", "symbols": ["export"] },
  "expect": { "topClaimsContain": ["Use default exports."], "instructionContains": "project convention" }
}
```

- [x] **Step 2: Run eval**

Run: `pnpm run eval:retrieval`
Expected: PASS.

- [x] **Step 3: Full suite**

Run: `pnpm test && pnpm run eval:retrieval && pnpm run eval:agent-context`
Expected: PASS across the board.

- [x] **Step 4: Integration tests if Docker is up**

Run: `pnpm run test:integration`
Expected: PASS or skipped.

- [x] **Step 5: End-to-end smoke**

```bash
TUBEROSA_USER_ID=alice@example.com pnpm run mcp &
# call tuberosa_record_user_style via MCP inspector or a curl-equivalent
# Verify atom shows up in GET /user-style-atoms
```

- [x] **Step 6: Commit any final touch-ups**

```bash
git add -A
git commit -m "test(user-style): green eval suite after concern F"
```

---

## Follow-up (deferred)

- **Workbench "My style" UI.** Backend ships here; UI is a separate task.
- **Bulk import from a teammate's style** with a vetting flow ("review these 14 atoms before importing").
- **`tuberosa_promote_user_style({ atomId, to: 'personal_workflow' })`** explicit MCP tool for the workbench-less environments.
- **Style versioning** beyond tier demotion — for now, "I changed my mind" means archive the old and write a new one.
- **Detecting style drift** ("you've been writing tests differently for 3 weeks, want me to update the relevant atom?").
- **Cross-user style merging** ("inherit Bob's commit style"). Out of scope for v1.
- **Per-project disables** without deleting the atom (e.g. "don't apply my style on this one repo, just here"). Future polish on top of conflict resolution.

---

## Deviations from the plan (execution log)

All Plan F tasks were executed end-to-end with `pnpm test` (570 pass) and `pnpm run eval:retrieval` (hit@5 100%, MRR 1.0, stale rejection 100%) green. The following items diverged from the literal plan; each is recorded so future readers can reconcile spec and implementation.

1. **Migration 010 also adds a `metadata jsonb` column** (`knowledge_atoms.metadata` defaulting to `{}`). Plan Task 2 step 2's last test assertion needs a `metadata.lowEvidence` flag on the returned atom, but the existing schema had no metadata bag. Adding it inside the same migration keeps the change atomic and avoids a follow-up migration. The column is generic — any future per-atom metadata feature can use it.
2. **Postgres `createAtom` skips `ensureProject` for `scope='user'`** and stores `project_id = NULL`. The in-memory `KnowledgeAtom.project` carries a sentinel `__user:<userId>` string so callers see a stable project field; `rowToAtom` re-synthesises that sentinel on Postgres reads. This matches the plan note ("Memory store keeps a sentinel project string for indexing; queries filter by scope/userId").
3. **`AppConfig.userStyleEnabled` is `boolean | undefined` rather than `boolean`** (and `userStyleCluster*` knobs likewise optional). Twenty-plus tests construct `AppConfig` literals; making the new fields optional keeps those literals compiling. Code paths treat `userStyleEnabled === false` as the only disable signal; `undefined` defaults to enabled.
4. **`no_concrete_trigger` triviality rule accepts `intentTags`.** The plan's finish-session router creates atoms with only `{ intentTags: ['user_preference'] }`. Without this change the existing triviality rule rejected those candidates before they reached dedup. The change is generic (helps any atom whose trigger is an intent tag).
5. **`pack.instruction` is a new top-level field on `ContextPack`**, not an `orientation` sub-field. The plan's tests assert `pack.instruction?.toLowerCase().includes(...)`. Adding it at the top level matches the plan; the field is currently only populated by the user-style conflict resolver.
6. **`test/user-style-*.test.ts` use `loadConfig()` rather than a `defaultConfig()` helper** (the latter doesn't exist in the codebase). Each test passes overrides on top of `loadConfig()`. The in-test `claim` strings were also slightly lengthened (e.g. "Prefer named exports." → "Prefer named exports for clarity in module loading.") so they pass the existing `sparse_claim` triviality rule.
7. **Task 10 retrieval-fixtures.json fixtures NOT added.** The current eval harness (`scripts/eval-retrieval.ts`, `src/evaluation/fixture-loader.ts`, `src/evaluation/retrieval-evaluator.ts`) has no per-case `configOverride`/`userId` support and the JSON schema has no `ingest.atoms[].scope` field. Adding the two fixtures requires extending three layers of the eval pipeline. Since the user-style retrieval + conflict-resolution behavior is already covered by `test/user-style-retrieval.test.ts` and `test/user-style-conflict.test.ts` (both directly exercise `RetrievalService.searchContext` with overrides), the gap was deferred. A follow-up task should extend the eval harness with `configOverride` + `scope`-aware ingest so the same scenarios land in `eval/retrieval-fixtures.json` for reporter visibility.
8. **HTTP/MCP `tuberosa_export_pack` / `tuberosa_import_pack` routes were not extended with the new flags.** Plan Task 9 only explicitly lists the CLI scripts (`scripts/export-pack.ts`, `scripts/import-pack.ts`); both gained `--include-user-style`, `--preserve-user-id`, `--preserve-priority`, and `--target-user-id`. The HTTP and MCP wrappers around the same operations still ship with the Plan E shape — they can be extended in a follow-up if the workbench needs them.

All other plan steps landed as written, with the per-task commits intentionally squashed into a single set of files staged together (the harness runs validation between tasks but commits are deferred to the user, per CLAUDE.md guidance on never auto-creating commits).
