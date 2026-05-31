# Project Knowledge-Book — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `team` scope to knowledge atoms and a pure 3-layer (Personal → Team → Project) conflict-resolution function, so the rest of the knowledge-book feature has a foundation to build on.

**Architecture:** Extend the existing `knowledge_atoms` table and its `scope` discriminator (which today is `'project' | 'user'`) with a third value `'team'` plus a `team_id` column — mirroring how migration `010` added the `'user'` scope. Add a `teamId` to the atom types, store (Postgres + memory), and config (`TUBEROSA_TEAM_ID`). Then add `resolveLayeredConflicts`, a pure function that generalizes the existing `resolveStyleConflicts` to three layers with the precedence `personal_workflow` > Project > Team > `coding_preference`. No retrieval wiring in this phase — the merge function is tested in isolation against synthetic candidates.

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import suffixes), `node --test` + `tsx`, Postgres (pgvector), the existing `KnowledgeStore` interface with `PostgresKnowledgeStore` + `MemoryKnowledgeStore`.

**Spec:** `docs/superpowers/specs/2026-05-31-project-knowledge-book-design.md` (§4, §5, §9).

> **Before coding:** the GitNexus index is stale. Run `npx gitnexus analyze` once so impact analysis is accurate, per repo CLAUDE.md.

---

### Task 1: Extend atom types with the `team` scope

**Files:**
- Modify: `src/types/atoms.ts:11` (`AtomScope`), `:48-76` (`KnowledgeAtom`), `:78-109` (`KnowledgeAtomInput`), `:126-134` (`ListAtomsOptions`)
- Test: `test/atom-team-scope.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/atom-team-scope.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AtomScope, KnowledgeAtom, KnowledgeAtomInput, ListAtomsOptions } from '../src/types/atoms.ts';

test('AtomScope accepts team and atom carries teamId', () => {
  const scope: AtomScope = 'team';
  const input: KnowledgeAtomInput = {
    project: 'demo', claim: 'Use Conventional Commits', type: 'convention',
    evidence: [], trigger: {}, producedBy: 'user', scope, teamId: 'default',
  };
  assert.equal(input.scope, 'team');
  assert.equal(input.teamId, 'default');
  const atom = { scope, teamId: 'default' } as Pick<KnowledgeAtom, 'scope' | 'teamId'>;
  assert.equal(atom.teamId, 'default');
  const opts: ListAtomsOptions = { limit: 10, scope: 'team', teamId: 'default' };
  assert.equal(opts.teamId, 'default');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/atom-team-scope.test.ts`
Expected: FAIL — TS error `'team' is not assignable to AtomScope` / `teamId` does not exist.

- [ ] **Step 3: Implement the type changes**

In `src/types/atoms.ts`, change line 11 and add `teamId` everywhere `userId` appears:

```typescript
export type AtomScope = 'project' | 'user' | 'team';
```

In `interface KnowledgeAtom` (after `userId?: string;` at line 69):
```typescript
  userId?: string;
  teamId?: string;
```
In `interface KnowledgeAtomInput` (after `userId?: string;` at line 106):
```typescript
  userId?: string;
  teamId?: string;
```
In `interface ListAtomsOptions` (after `userId?: string;` at line 132):
```typescript
  userId?: string;
  teamId?: string;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/atom-team-scope.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/atoms.ts test/atom-team-scope.test.ts
git commit -m "feat(atoms): add team scope + teamId to atom types"
```

---

### Task 2: Migration — `team` scope value + `team_id` column

**Files:**
- Create: `migrations/013_team_scope.sql`

- [ ] **Step 1: Write the migration**

The existing `scope` CHECK constraint (from `010`) is named `knowledge_atoms_scope_check` by Postgres default. Drop and recreate it, then add `team_id` and an index mirroring `idx_atoms_scope_user`.

```sql
-- migrations/013_team_scope.sql
-- Knowledge-Book Phase 1: add a 'team' scope between 'user' and 'project'.
--   scope='team' atoms have project_id NULL, user_id NULL, and a non-null team_id.
-- Mirrors migration 010 (user-style layer).

ALTER TABLE knowledge_atoms
  DROP CONSTRAINT IF EXISTS knowledge_atoms_scope_check;

ALTER TABLE knowledge_atoms
  ADD CONSTRAINT knowledge_atoms_scope_check CHECK (scope IN ('project','user','team'));

ALTER TABLE knowledge_atoms
  ADD COLUMN IF NOT EXISTS team_id text;

CREATE INDEX IF NOT EXISTS idx_atoms_scope_team
  ON knowledge_atoms (scope, team_id, tier) WHERE status='active';
```

- [ ] **Step 2: Apply the migration to verify it is valid SQL**

Run: `pnpm run migrate`
Expected: completes without error; re-running is idempotent (`IF EXISTS` / `IF NOT EXISTS`). If no Postgres is available, instead run `cat migrations/013_team_scope.sql` and confirm by inspection, then verify in Task 3's integration step.

- [ ] **Step 3: Commit**

```bash
git add migrations/013_team_scope.sql
git commit -m "feat(db): migration for team atom scope + team_id"
```

---

### Task 3: Store support for `team` scope (memory + Postgres)

**Files:**
- Modify: `src/storage/memory-store.ts:1305-1360` (`createAtom`, `listAtoms`)
- Modify: `src/storage/postgres-store.ts:1874-1980` (`createAtom`, `listAtoms`), `:3432-3465` (`rowToAtom`)
- Test: `test/atom-team-store.test.ts`

- [ ] **Step 1: Write the failing test (memory store — the deterministic path)**

```typescript
// test/atom-team-store.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.ts';

test('memory store persists team-scope atom and filters by teamId', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await store.createAtom({
    project: 'demo', claim: 'Use Conventional Commits', type: 'convention',
    evidence: [], trigger: {}, producedBy: 'user', scope: 'team', teamId: 'default',
  });
  assert.equal(atom.scope, 'team');
  assert.equal(atom.teamId, 'default');
  assert.equal(atom.userId, undefined);

  const hit = await store.listAtoms({ limit: 10, scope: 'team', teamId: 'default' });
  assert.equal(hit.length, 1);
  const miss = await store.listAtoms({ limit: 10, scope: 'team', teamId: 'other' });
  assert.equal(miss.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/atom-team-store.test.ts`
Expected: FAIL — `atom.teamId` is `undefined` (memory store does not set it) and the `teamId` list filter is ignored.

- [ ] **Step 3: Implement memory-store support**

In `src/storage/memory-store.ts` `createAtom` (around line 1305-1331), where it currently sets `userId`/`priority`, add `teamId`:

```typescript
    const scope: KnowledgeAtom['scope'] = input.scope ?? 'project';
    // ... existing fields ...
      scope,
      userId: scope === 'user' ? input.userId : undefined,
      priority: scope === 'user' ? input.priority : undefined,
      teamId: scope === 'team' ? input.teamId : undefined,
```

In `listAtoms` (around line 1345-1352), add the `teamId` filter alongside the `userId` filter:

```typescript
      .filter((atom) => !options.userId || atom.userId === options.userId)
      .filter((atom) => !options.teamId || atom.teamId === options.teamId)
```

- [ ] **Step 4: Implement Postgres-store support**

In `src/storage/postgres-store.ts` `createAtom` (line 1874-1919):

Add the column and value. Change `isUserScope` usage so the project lookup is skipped for team scope too (team atoms have null `project_id`):

```typescript
    const isUserScope = input.scope === 'user';
    const isTeamScope = input.scope === 'team';
    const projectId = (isUserScope || isTeamScope) ? null : await this.ensureProject(this.pool, input.project);
    const columns = [
      'project_id', 'parent_knowledge_id', 'claim', 'type', 'evidence', 'trigger',
      'verification', 'pitfalls', 'links', 'produced_by', 'produced_session_id', 'embedding',
      'scope', 'user_id', 'priority', 'metadata', 'team_id',
    ];
    const placeholders = [
      '$1', '$2', '$3', '$4', '$5::jsonb', '$6::jsonb', '$7::jsonb', '$8::jsonb', '$9::jsonb',
      '$10', '$11', '$12::vector', '$13', '$14', '$15', '$16::jsonb', '$17',
    ];
    const values: unknown[] = [
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
      input.embedding ? `[${input.embedding.join(',')}]` : null,
      input.scope ?? 'project',
      isUserScope ? input.userId ?? null : null,
      isUserScope ? input.priority ?? null : null,
      JSON.stringify(input.metadata ?? {}),
      isTeamScope ? input.teamId ?? null : null,
    ];
```

> Note: the `$17` for `team_id` is appended **after** `metadata`'s `$16::jsonb`. The `if (input.id)` block below that unshifts `id`/`$N` and pushes to `values` — leave it unchanged; it still computes the correct trailing placeholder.

In `listAtoms` (line 1934-1961), add the `teamId` filter after the `userId` filter block:

```typescript
    if (options.userId) {
      values.push(options.userId);
      filters.push(`a.user_id = $${values.length}`);
    }
    if (options.teamId) {
      values.push(options.teamId);
      filters.push(`a.team_id = $${values.length}`);
    }
```

In `rowToAtom` (line 3432-3464), map `team_id` and resolve the synthetic project name for team scope:

```typescript
  const scope = (row.scope as KnowledgeAtom['scope']) ?? 'project';
  const userId = row.user_id ? String(row.user_id) : undefined;
  const teamId = row.team_id ? String(row.team_id) : undefined;
  const resolvedProject =
    scope === 'user' ? `__user:${userId ?? ''}`
    : scope === 'team' ? `__team:${teamId ?? ''}`
    : project;
```
and add to the returned object (next to `userId`):
```typescript
    userId,
    teamId,
    priority: (row.priority as KnowledgeAtom['priority']) ?? undefined,
```

- [ ] **Step 5: Run the memory-store test to verify it passes**

Run: `node --test --import tsx test/atom-team-store.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full unit suite + build to verify no regressions**

Run: `pnpm run build && pnpm test`
Expected: build succeeds; all existing tests pass.

- [ ] **Step 7: (If Docker available) verify the Postgres path**

Run: `pnpm run test:integration`
Expected: passes, or skips cleanly if the stack is down (do not block on this if no Docker).

- [ ] **Step 8: Commit**

```bash
git add src/storage/memory-store.ts src/storage/postgres-store.ts test/atom-team-store.test.ts
git commit -m "feat(store): persist + filter team-scope atoms in both stores"
```

---

### Task 4: Config — `TUBEROSA_TEAM_ID`

**Files:**
- Modify: `src/config.ts:66` (interface), `:134` (env read)
- Test: `test/config-team-id.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/config-team-id.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('teamId defaults to "default" and reads TUBEROSA_TEAM_ID', () => {
  delete process.env.TUBEROSA_TEAM_ID;
  assert.equal(loadConfig().teamId, 'default');
  process.env.TUBEROSA_TEAM_ID = 'acme';
  assert.equal(loadConfig().teamId, 'acme');
  delete process.env.TUBEROSA_TEAM_ID;
});
```

> Confirmed: `src/config.ts` exports `loadConfig(): AppConfig` (line 77); the interface is `AppConfig` (line 1).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/config-team-id.test.ts`
Expected: FAIL — `teamId` is `undefined`.

- [ ] **Step 3: Implement**

In `src/config.ts`, add to the `AppConfig` interface near line 66 (next to `userId?: string;`):
```typescript
  userId?: string;
  teamId: string;
```
And in the object built near line 134 (next to the `userId:` line):
```typescript
    userId: process.env.TUBEROSA_USER_ID || undefined,
    teamId: process.env.TUBEROSA_TEAM_ID || 'default',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/config-team-id.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config-team-id.test.ts
git commit -m "feat(config): add teamId from TUBEROSA_TEAM_ID (default 'default')"
```

---

### Task 5: 3-layer conflict resolution (`resolveLayeredConflicts`)

**Files:**
- Modify: `src/user-style/conflict-resolver.ts` (add new export, keep `resolveStyleConflicts` untouched)
- Test: `test/layered-conflict-resolver.test.ts`

The existing `resolveStyleConflicts` handles two layers (userStyle vs everything-else). Add a 3-layer resolver. A candidate's layer is read from metadata:
- **personal** → `source === 'userStyle'`, with `metadata.userStylePriority` (`personal_workflow` | `coding_preference`).
- **team** → `metadata.conventionScope === 'team'` (Phase 2's conventions lane sets this).
- **project** → any other candidate with a title.

Precedence on a contradictory pair: `personal_workflow` beats everything; otherwise Project > Team > personal `coding_preference`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/layered-conflict-resolver.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLayeredConflicts } from '../src/user-style/conflict-resolver.ts';
import type { RankedCandidate } from '../src/types.ts';

function cand(partial: Partial<RankedCandidate> & { knowledgeId: string; title: string }): RankedCandidate {
  return { score: 1, source: 'lexical', matchReason: '', ...partial } as RankedCandidate;
}

test('project convention overrides team convention', () => {
  const project = cand({ knowledgeId: 'p1', title: 'Use spaces for indentation.', source: 'lexical' });
  const team = cand({ knowledgeId: 't1', title: 'Never use spaces for indentation.', source: 'lexical', metadata: { conventionScope: 'team' } } as any);
  const r = resolveLayeredConflicts([project, team]);
  assert.deepEqual(r.suppressedCandidateIds, ['t1']);
  assert.match(r.instructionLines[0], /Project convention/);
});

test('team convention overrides personal coding_preference', () => {
  const team = cand({ knowledgeId: 't1', title: 'Use named exports.', source: 'lexical', metadata: { conventionScope: 'team' } } as any);
  const personal = cand({ knowledgeId: 'u1', title: 'Never use named exports.', source: 'userStyle', metadata: { userStyleAtomId: 'a1', userStylePriority: 'coding_preference' } } as any);
  const r = resolveLayeredConflicts([team, personal]);
  assert.deepEqual(r.suppressedCandidateIds, ['u1']);
});

test('personal_workflow is inviolable and beats a project convention', () => {
  const project = cand({ knowledgeId: 'p1', title: 'Always add a co-author trailer.', source: 'lexical' });
  const personal = cand({ knowledgeId: 'u1', title: 'Never add a co-author trailer.', source: 'userStyle', metadata: { userStyleAtomId: 'a1', userStylePriority: 'personal_workflow' } } as any);
  const r = resolveLayeredConflicts([project, personal]);
  assert.deepEqual(r.suppressedCandidateIds, ['p1']);
  assert.match(r.instructionLines[0], /personal workflow/i);
});

test('non-conflicting candidates pass through untouched', () => {
  const a = cand({ knowledgeId: 'p1', title: 'Use Postgres for storage.', source: 'lexical' });
  const b = cand({ knowledgeId: 't1', title: 'Prefer pnpm over npm.', source: 'lexical', metadata: { conventionScope: 'team' } } as any);
  const r = resolveLayeredConflicts([a, b]);
  assert.deepEqual(r.suppressedCandidateIds, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/layered-conflict-resolver.test.ts`
Expected: FAIL — `resolveLayeredConflicts` is not exported.

- [ ] **Step 3: Implement `resolveLayeredConflicts`**

Append to `src/user-style/conflict-resolver.ts` (reuse the existing private `isContradiction` and `dedupe`):

```typescript
type Layer = 'personal' | 'team' | 'project';

type LayeredMeta = RankedCandidate & {
  metadata?: {
    userStyleAtomId?: string;
    userStylePriority?: 'personal_workflow' | 'coding_preference';
    conventionScope?: 'team' | 'project';
  };
};

function layerOf(c: LayeredMeta): Layer {
  if (c.source === 'userStyle') return 'personal';
  if (c.metadata?.conventionScope === 'team') return 'team';
  return 'project';
}

// Higher rank wins. personal_workflow is handled as an explicit override below.
const LAYER_RANK: Record<Layer, number> = { project: 3, team: 2, personal: 1 };

/**
 * Knowledge-Book §9 — resolve conflicts across the three layers.
 * Precedence: personal_workflow (inviolable) > Project > Team > personal coding_preference.
 * Only directly contradictory pairs (per isContradiction) are touched; everything
 * else passes through. Shape matches ConflictResolution for drop-in use in retrieval.
 */
export function resolveLayeredConflicts(candidates: RankedCandidate[]): ConflictResolution {
  const cast = candidates as LayeredMeta[];
  const withTitle = cast.filter((c) => (c.title?.length ?? 0) > 0);
  const suppressed = new Set<string>();
  const lines: string[] = [];

  for (let i = 0; i < withTitle.length; i++) {
    for (let j = i + 1; j < withTitle.length; j++) {
      const a = withTitle[i];
      const b = withTitle[j];
      if (!isContradiction(a.title ?? '', b.title ?? '')) continue;

      // Rule 1: an inviolable personal_workflow atom wins over anything.
      const pwA = a.source === 'userStyle' && a.metadata?.userStylePriority === 'personal_workflow';
      const pwB = b.source === 'userStyle' && b.metadata?.userStylePriority === 'personal_workflow';
      if (pwA !== pwB) {
        const winner = pwA ? a : b;
        const loser = pwA ? b : a;
        suppressed.add(loser.knowledgeId);
        lines.push(`Following your personal workflow: ${winner.title}`);
        continue;
      }

      // Rule 2: most-specific layer wins (Project > Team > Personal coding_preference).
      const la = layerOf(a);
      const lb = layerOf(b);
      if (LAYER_RANK[la] === LAYER_RANK[lb]) continue; // same layer — leave both
      const winner = LAYER_RANK[la] > LAYER_RANK[lb] ? a : b;
      const loser = LAYER_RANK[la] > LAYER_RANK[lb] ? b : a;
      suppressed.add(loser.knowledgeId);
      const winLayer = layerOf(winner);
      if (winLayer === 'project') {
        lines.push(`Project convention: ${winner.title}. "${loser.title}" is parked for this codebase.`);
      } else {
        lines.push(`Team convention: ${winner.title}. "${loser.title}" is parked here.`);
      }
    }
  }

  return { suppressedCandidateIds: [...suppressed], instructionLines: dedupe(lines) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/layered-conflict-resolver.test.ts`
Expected: PASS (all 4 cases)

- [ ] **Step 5: Run the full suite + retrieval eval (no regressions)**

Run: `pnpm run build && pnpm test && pnpm run eval:retrieval`
Expected: build + all unit tests pass; `eval:retrieval` reports `hitRate=1`, `staleRejectionRate=1`, classification rates `1`. (`resolveStyleConflicts` is unchanged, so no retrieval behavior shifts in Phase 1.)

- [ ] **Step 6: Commit**

```bash
git add src/user-style/conflict-resolver.ts test/layered-conflict-resolver.test.ts
git commit -m "feat(conventions): add 3-layer resolveLayeredConflicts (personal_workflow>project>team>coding_preference)"
```

---

## Phase 1 Definition of Done
- `AtomScope` includes `'team'`; atoms carry `teamId`; both stores persist & filter by it; migration `013` applied.
- `config.teamId` reads `TUBEROSA_TEAM_ID` (default `"default"`).
- `resolveLayeredConflicts` is exported, pure, and unit-tested for all four precedence cases.
- `pnpm run build && pnpm test && pnpm run eval:retrieval` all green.

---

## Roadmap — later phases (each gets its own plan once Phase 1 lands)

These are intentionally **not** expanded into TDD steps yet: each depends on Phase 1 types/store existing and on reading the relevant subsystem (atlas builders, retrieval lane wiring, MCP/HTTP tool registration, recommendation gates) to produce no-placeholder code. They are listed so the decomposition and spec coverage are auditable.

- **Phase 2 — Recall (spec §6.1, §9, §10):**
  - New conventions candidate lane in `src/retrieval/service.ts` that fetches `scope IN ('team','project')` convention atoms and **bypasses `applyNamespaceFilter`** for team (mirrors the `userStyle` lane at service.ts:590).
  - Trigger-match against the classified task; pin matched conventions to the front of `accepted` in `src/retrieval/context-pack.ts` (essential section).
  - Swap the conflict call site to `resolveLayeredConflicts`.
  - `tuberosa_start_session` response gains a `handbook` status field (`exists`, `conventionCount`, `suggestion`).
  - Eval fixtures: team convention surfaces cross-project + pinned; project convention does not leak; precedence deterministic.

- **Phase 3 — Handbook view (spec §6.2):**
  - `conventions.md` builder in `src/atlas/builders.ts` — pure `(AtlasInputs) => string`, grouped by `category`, badged by layer/author; wire into `AtlasService.regenerate` and `tuberosa_get_atlas`.
  - Golden-snapshot test under `HashModelProvider`.

- **Phase 4 — Capture (spec §7, §8):**
  - `distillation_evidence` hard gate in `src/reflection/recommendation.ts` (≥2 evidence, non-empty trigger/steps).
  - `src/conventions/curation.ts` (cluster un-curated atoms, reuse write-gate math) + `tuberosa_propose_curation` (MCP + HTTP).
  - Convention-extraction stage on `tuberosa bootstrap` + `tuberosa_bootstrap_handbook`.
  - Curation nudge from `finish_session` and `start_session` (threshold-based, informational).
  - Governance routing: project auto-activate vs team/bootstrap → reviewable draft.
