# Project Knowledge-Book — Phase 2 (Recall) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface `type:'convention'` atoms (scope `team` or `project`) in retrieval as a dedicated lane that bypasses the namespace filter for team scope, trigger-matches the task, pins matched conventions to the top of the context pack, resolves cross-layer conflicts via `resolveLayeredConflicts`, and reports a `handbook` status on `start_session`.

**Architecture:** Mirror the shipped **user-style lane** end-to-end. User-style already proves every seam we need: a cross-project candidate source that skips `applyNamespaceFilter`, an atom→candidate mapper, a fusion group, and a ranking multiplier. Conventions are the same shape with `source:'convention'` and `metadata.conventionScope`. Pinning is a new pre-step in `assembleContextPack`. The conflict-resolver swap reuses Phase-1's `resolveLayeredConflicts`. The whole lane is **additive**: with no convention atoms present (the current eval fixtures), existing ranking is unchanged, so `eval:retrieval` stays green until a convention fixture is added in Task 6.

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import suffixes; tests import `.js`), `node --test` + `tsx`, the `KnowledgeStore` interface (`postgres-store.ts` + `memory-store.ts`), the retrieval pipeline in `src/retrieval/`.

**Spec:** `docs/superpowers/specs/2026-05-31-project-knowledge-book-design.md` (§6.1, §9, §10). **Builds on:** Phase 1 (`feat/project-knowledge-book`, PR #28) — `scope:'team'`, `teamId`, `config.teamId`, `resolveLayeredConflicts`.

> **Before coding:** `npx gitnexus analyze` to refresh the index (repo CLAUDE.md). After ANY task touching `src/retrieval/` or `src/storage/`, run `pnpm run eval:retrieval` and confirm `hitRate=1`, `staleRejectionRate=1` — per CLAUDE.md this gate is mandatory and thresholds must never be lowered.

---

### Task 1: Widen atom-search store methods for `team` scope

**Files:**
- Modify: `src/storage/store.ts` (the `searchAtomsByEmbedding` ~line 246 and `searchAtomsByTrigger` ~line 247 option types)
- Modify: `src/storage/memory-store.ts` (`searchAtomsByEmbedding` ~line 1390, `searchAtomsByTrigger` ~line 1411)
- Modify: `src/storage/postgres-store.ts` (the corresponding methods — locate via `grep -n "searchAtomsByTrigger\|searchAtomsByEmbedding" src/storage/postgres-store.ts`)
- Test: `test/atom-team-search.test.ts`

The option type today is `{ project?: string; limit: number; scope?: 'project' | 'user'; userId?: string }` (plus `threshold?` on embedding). Widen `scope` to include `'team'` and add `teamId?: string`, then make both stores filter on `teamId` exactly as they filter on `userId`.

- [ ] **Step 1: Write the failing test** at `test/atom-team-search.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('searchAtomsByTrigger filters team atoms by teamId', async () => {
  const store = new MemoryKnowledgeStore();
  await store.createAtom({
    project: 'demo', claim: 'Team A uses tabs', type: 'convention',
    evidence: [], trigger: { taskTypes: ['implementation'] }, producedBy: 'user',
    scope: 'team', teamId: 'team-a',
  });
  await store.createAtom({
    project: 'demo', claim: 'Team B uses spaces', type: 'convention',
    evidence: [], trigger: { taskTypes: ['implementation'] }, producedBy: 'user',
    scope: 'team', teamId: 'team-b',
  });
  const a = await store.searchAtomsByTrigger(
    { taskTypes: ['implementation'] },
    { project: undefined, scope: 'team', teamId: 'team-a', limit: 10 },
  );
  assert.equal(a.length, 1);
  assert.equal(a[0].teamId, 'team-a');
});
```

- [ ] **Step 2: Run it — confirm FAIL** (`teamId` not a valid option / both atoms returned): `node --test --import tsx test/atom-team-search.test.ts`

- [ ] **Step 3: Widen the interface in `src/storage/store.ts`.** In both `searchAtomsByEmbedding` and `searchAtomsByTrigger` option objects, change `scope?: 'project' | 'user'` to `scope?: 'project' | 'user' | 'team'` and add `teamId?: string;` after `userId?: string;`.

- [ ] **Step 4: Implement memory-store filtering.** In `src/storage/memory-store.ts`, in BOTH `searchAtomsByEmbedding` (~1390) and `searchAtomsByTrigger` (~1411), find the existing `.filter((atom) => !options.userId || atom.userId === options.userId)` and add immediately after it:
```typescript
      .filter((atom) => !options.teamId || atom.teamId === options.teamId)
```
Also widen those methods' local option types if they declare `scope?: 'project' | 'user'` inline (match the store.ts change). Read the exact method bodies first; the `scope` filter line is your anchor.

- [ ] **Step 5: Implement postgres-store filtering.** In `src/storage/postgres-store.ts`, in both search methods, find where `scope`/`user_id` are added to the SQL `WHERE` (anchor: `options.userId` / `a.user_id = $`). Add a sibling guarded clause:
```typescript
    if (options.teamId) {
      values.push(options.teamId);
      filters.push(`a.team_id = $${values.length}`);
    }
```
Match the exact variable names used in each method (some use `filters`/`values`, confirm by reading). If a method passes `scope` into the SQL, ensure `'team'` flows through unchanged (it's a plain string bind).

- [ ] **Step 6: Run the test — confirm PASS**, then `pnpm run build && pnpm test`. Expect build clean and all tests pass.

- [ ] **Step 7: Commit** (no AI-attribution trailer):
```bash
git add src/storage/store.ts src/storage/memory-store.ts src/storage/postgres-store.ts test/atom-team-search.test.ts
git commit -m "feat(store): atom search filters by team scope + teamId"
```

---

### Task 2: Convention candidate source + retrieval lane

**Files:**
- Modify: `src/types/retrieval.ts` (`CandidateSource` ~line 165)
- Modify: the `KnowledgeSearchResult` type (locate: `grep -rn "interface KnowledgeSearchResult\|type KnowledgeSearchResult" src/`)
- Modify: `src/retrieval/service.ts` (Promise.all ~566-574, safeResults ~575-591, fusion groups ~720-729, add `searchConventionCandidates` + `conventionAtomToCandidate`)
- Test: `test/convention-lane.test.ts`

This mirrors the user-style lane. The lane fetches **team** conventions (`scope:'team'`, `teamId:config.teamId`, `project:undefined` → cross-project) and **project** conventions (`scope:'project'`, the current project, filtered to `type==='convention'`), both via `searchAtomsByTrigger` (so trigger-matching happens in the store), maps them to `source:'convention'` candidates carrying `metadata.conventionScope`, and bypasses `applyNamespaceFilter` like user-style.

- [ ] **Step 1: Write the failing test** at `test/convention-lane.test.ts`. This is an integration-style test using the real `RetrievalService` with `MemoryKnowledgeStore` + `HashModelProvider`. Read an existing retrieval test (e.g. `test/retrieval.test.ts` or `test/user-style-*.test.ts`) FIRST to copy the exact service-construction boilerplate (store, model provider, config with `teamId`), then assert: a team-scope convention atom whose trigger matches the prompt's taskType appears in `searchContext(...)` results with `source:'convention'`, even when the search project differs from the atom's. Write the test to match the real constructor signature you find — do not invent it.

- [ ] **Step 2: Run it — confirm FAIL.**

- [ ] **Step 3: Add the source.** In `src/types/retrieval.ts` line ~165:
```typescript
export type CandidateSource = 'lexical' | 'vector' | 'metadata' | 'memory' | 'graph' | 'worktree' | 'atoms' | 'userStyle' | 'convention';
```
Add `convention: SearchCandidate[];` to the `KnowledgeSearchResult` type (wherever the `userStyle:` field is declared).

- [ ] **Step 4: Add `conventionAtomToCandidate`** in `src/retrieval/service.ts` (near `userStyleAtomToCandidate` ~1402), mirroring it:
```typescript
function conventionAtomToCandidate(atom: KnowledgeAtom, index: number): SearchCandidate {
  return {
    knowledgeId: atom.id,
    title: atom.claim,
    summary: atom.claim,
    content: atom.claim,
    contextualContent: atom.claim,
    itemType: 'rule',
    project: atom.project,
    labels: [],
    references: [],
    tokenEstimate: Math.max(1, Math.ceil(atom.claim.length / 4)),
    trustLevel: 1,
    source: 'convention',
    rawScore: 1,
    rank: index + 1,
    metadata: {
      conventionAtomId: atom.id,
      conventionScope: atom.scope, // 'team' | 'project'
      conventionTier: atom.tier,
      conventionSteps: (atom.metadata && (atom.metadata as Record<string, unknown>).steps) ?? undefined,
      conventionCategory: (atom.metadata && (atom.metadata as Record<string, unknown>).category) ?? undefined,
    },
  };
}
```

- [ ] **Step 5: Add `searchConventionCandidates`** in `src/retrieval/service.ts` (near `searchUserStyleCandidates` ~644 and `searchAtomCandidates` ~695). Read both first to match style.
```typescript
private async searchConventionCandidates(
  classified: ClassifiedQuery,
  options: SearchOptions,
  project?: string,
): Promise<SearchCandidate[]> {
  const trigger = {
    errors: classified.errors,
    files: classified.files,
    symbols: classified.symbols,
    taskTypes: classified.taskType && classified.taskType !== 'unknown' ? [classified.taskType] : undefined,
  };
  const hasTrigger =
    (trigger.errors?.length ?? 0) > 0 || (trigger.files?.length ?? 0) > 0 ||
    (trigger.symbols?.length ?? 0) > 0 || (trigger.taskTypes?.length ?? 0) > 0;
  if (!hasTrigger) return [];

  const [teamAtoms, projectAtoms] = await Promise.all([
    this.store.searchAtomsByTrigger(trigger, {
      project: undefined, scope: 'team', teamId: this.config.teamId, limit: options.limit,
    }),
    this.store.searchAtomsByTrigger(trigger, {
      project: project ?? classified.project, scope: 'project', limit: options.limit,
    }),
  ]);
  const rejected = new Set(options.rejectedKnowledgeIds ?? []);
  return [...teamAtoms, ...projectAtoms]
    .filter((atom) => atom.type === 'convention' && atom.status === 'active' && !rejected.has(atom.id))
    .map((atom, index) => conventionAtomToCandidate(atom, index));
}
```

- [ ] **Step 6: Wire into the parallel search.** In the `Promise.all` (~566-574) add an 8th/9th entry:
```typescript
      timed('convention', this.searchConventionCandidates(classified, options, project), debug),
```
destructure it (`..., userStyle, convention] = await Promise.all([...])`). In `safeResults` (~575-591), add — BYPASSING the namespace filter like user-style (team conventions are cross-project; project conventions are already project-correct from the query):
```typescript
      // Knowledge-Book — conventions bypass the namespace filter: team scope is
      // cross-project and project scope is already constrained by the query.
      convention: this.safety.sanitizeSearchCandidates(convention),
```

- [ ] **Step 7: Add to fusion groups** in `rankCandidates` (~720-729):
```typescript
      disabled.has('convention') ? [] : candidates.convention,
```
Search for every other place that enumerates the `KnowledgeSearchResult` sources (e.g. an empty-result constructor, ablation lists, debug stage recording near line 634) and add `convention: []` / `'convention'` so the type stays exhaustive — the build will tell you which spots need it. Run `pnpm run build` and fix each TS error by adding the convention entry.

- [ ] **Step 8: Run the test — confirm PASS.** Then `pnpm run build && pnpm test && pnpm run eval:retrieval`. Eval MUST stay green (no convention atoms in the fixture yet → no ranking change). If eval regresses, the lane is leaking into existing cases — investigate, do not adjust thresholds.

- [ ] **Step 9: Commit:**
```bash
git add src/types/retrieval.ts src/retrieval/service.ts test/convention-lane.test.ts <any other source files the build required>
git commit -m "feat(retrieval): convention candidate lane (team + project, namespace-bypass)"
```

---

### Task 3: Pin trigger-matched conventions to the top of `essential`

**Files:**
- Modify: `src/retrieval/context-pack.ts` (`assembleContextPack` ~62-115)
- Test: `test/convention-pinning.test.ts`

Conventions that survived to pack assembly should be pinned to the FRONT of the `essential` section (ahead of normal ranked items), within budget. Identify them by `source === 'convention'`.

- [ ] **Step 1: Write the failing test** at `test/convention-pinning.test.ts` — call `assembleContextPack` directly with a candidate list mixing one `source:'convention'` RankedCandidate and several normal ones, assert the convention is the FIRST item in the `essential` section. Read `context-pack.ts` to copy the exact `RankedCandidate` fields the function requires (use a small factory like the eval/test helpers do).

- [ ] **Step 2: Run it — confirm FAIL.**

- [ ] **Step 3: Implement pinning.** In `assembleContextPack`, after `accepted` is computed (line ~69) and before the `essential` split:
```typescript
  const pinned = accepted.filter((c) => c.source === 'convention');
  const rest = without(accepted, pinned);
  const pinnedTokens = sumTokens(pinned);
  const essentialRest = takeWithinBudget(rest, Math.max(0, essentialBudget - pinnedTokens), 0, 4);
  const essential = [...pinned, ...essentialRest];
  const supporting = takeWithinBudget(without(rest, essentialRest), supportingBudget, 0, 6);
  const optional = takeWithinBudget(without(rest, [...essentialRest, ...supporting]), optionalBudget, 0, 8);
```
(Replace the existing `essential`/`supporting`/`optional` lines. `sumTokens`/`without`/`takeWithinBudget` already exist in this file.) Keep `const selected = [...essential, ...supporting, ...optional];` as-is.

- [ ] **Step 4: Run the test — confirm PASS.** Then `pnpm run build && pnpm test && pnpm run eval:retrieval` (eval green — no conventions in fixture).

- [ ] **Step 5: Commit:**
```bash
git add src/retrieval/context-pack.ts test/convention-pinning.test.ts
git commit -m "feat(retrieval): pin convention candidates to top of essential section"
```

---

### Task 4: Swap to `resolveLayeredConflicts`

**Files:**
- Modify: `src/retrieval/service.ts` (the `resolveStyleConflicts(...)` call site ~line 285)
- Test: extend `test/layered-conflict-resolver.test.ts` is unit-level; add a retrieval-level check in `test/convention-lane.test.ts` or a new `test/convention-conflict.test.ts`

The layered resolver reads `metadata.conventionScope === 'team'` to identify the team layer (set in Task 2) and `metadata.userStylePriority` for personal. Project conventions are `source:'convention'` with `conventionScope:'project'` → they fall to the `project` layer in `layerOf` (no `conventionScope:'team'`, not `userStyle`), which is correct.

- [ ] **Step 1: Write/extend a failing test** asserting that through `searchContext`, a team convention and a contradicting personal `coding_preference` user-style atom resolve so the user-style candidate is suppressed (team wins over coding_preference). Use the real service boilerplate. Confirm it FAILS while the code still calls `resolveStyleConflicts` (which doesn't know the team layer).

- [ ] **Step 2: Implement the swap.** In `src/retrieval/service.ts` ~line 285, change the import and call:
```typescript
// import: add resolveLayeredConflicts alongside the existing import
const styleConflict = resolveLayeredConflicts(fitEvaluation.candidates);
```
Update the import line `import { resolveStyleConflicts } from '../user-style/conflict-resolver.js';` to import `resolveLayeredConflicts` (keep `resolveStyleConflicts` imported only if still referenced elsewhere — grep to confirm; if not, replace it). The downstream `suppressedByStyleConflict`/`instructionLines` handling is unchanged (same `ConflictResolution` shape).

- [ ] **Step 3: Run the new test — PASS.** Then run the existing user-style tests explicitly to ensure no regression in 2-layer behavior: `node --test --import tsx test/user-style-*.test.ts` (list them with `ls test/user-style-*.test.ts`). If any asserts the exact old instruction string and now sees the layered string, decide: the layered messages are intentional copy — update the assertion to the new string ONLY if the test is asserting copy, not behavior; if it asserts suppression behavior, it should still pass unchanged.

- [ ] **Step 4: Full gate:** `pnpm run build && pnpm test && pnpm run eval:retrieval`. All green.

- [ ] **Step 5: Commit:**
```bash
git add src/retrieval/service.ts test/*.test.ts
git commit -m "feat(retrieval): resolve pack conflicts via 3-layer resolveLayeredConflicts"
```

---

### Task 5: `handbook` status on `start_session`

**Files:**
- Modify: `src/types/session.ts` (`AgentSessionStartResult` ~262-266)
- Modify: `src/agent-session/service.ts` (`startSession` ~62-83)
- Test: `test/session-handbook-status.test.ts`

Report whether the project has conventions and how many surfaced, so the agent knows to read/bootstrap. Derive it from the assembled pack's convention items — no extra query.

- [ ] **Step 1: Write the failing test** at `test/session-handbook-status.test.ts`: start a session in a project that has ≥1 matching convention atom; assert `result.handbook.exists === true` and `result.handbook.conventionCount >= 1`. Start a session in a project with no conventions; assert `result.handbook.exists === false` and a non-empty `result.handbook.suggestion`. Copy service boilerplate from an existing agent-session test (`ls test/*agent-session*.test.ts` / `test/user-style-finish-session.test.ts`).

- [ ] **Step 2: Run it — confirm FAIL.**

- [ ] **Step 3: Add the type.** In `src/types/session.ts`:
```typescript
export interface HandbookStatus {
  exists: boolean;
  conventionCount: number;
  suggestion?: string;
}
export interface AgentSessionStartResult {
  session: AgentSession;
  contextPack: ContextPack;
  policy: AgentSessionPolicy;
  handbook: HandbookStatus;
}
```

- [ ] **Step 4: Populate it** in `startSession` (`src/agent-session/service.ts`). After `contextPack` is built, count convention items across its sections:
```typescript
const conventionCount = contextPack.sections
  .flatMap((s) => s.items)
  .filter((it) => (it as { source?: string }).source === 'convention').length;
const handbook: HandbookStatus = conventionCount > 0
  ? { exists: true, conventionCount }
  : { exists: false, conventionCount: 0, suggestion: 'No project handbook yet — run tuberosa_bootstrap_handbook to capture conventions.' };
```
Add `handbook` to the returned object. (If pack section items do not carry `source`, instead derive the count from the candidates before pack assembly — read the `ContextPackItem` type in `src/types/retrieval.ts` to confirm whether `source` survives into items; if not, thread a `conventionCount` out of `buildContextPack`. Read first, then choose the path that needs the least surface.)

- [ ] **Step 5: Run the test — PASS.** Then `pnpm run build && pnpm test`. Fix any other constructor of `AgentSessionStartResult` the build flags (add `handbook`).

- [ ] **Step 6: Commit:**
```bash
git add src/types/session.ts src/agent-session/service.ts test/session-handbook-status.test.ts
git commit -m "feat(session): report handbook status (convention count / bootstrap suggestion) on start"
```

---

### Task 6: Eval fixtures — cross-project surfacing, pinning, no project leak

**Files:**
- Modify: `eval/retrieval-fixtures.json`
- Verify: `pnpm run eval:retrieval`

Add fixture atoms + a case proving: a `team` convention surfaces and is selected/pinned for a matching task in ANY project, and a `project` convention does NOT surface in a different project. Read the existing fixture's `atoms` array and a `cases` entry (e.g. `verified-atom-outranks-draft`) to match the exact field names (`evalId`, `claim`, `type`, `scope`, `tier`, `status`, `trigger`, and case fields `expectedKnowledgeIds`/`expectedSelectedKnowledgeIds`/`unexpectedKnowledgeIds`/`expectedClassification`).

- [ ] **Step 1: Read** `eval/retrieval-fixtures.json` — the `atoms` array shape and one representative `cases` entry. Confirm whether fixtures support `scope`/`teamId` on atoms (Phase-1 added them to the atom model; check `src/evaluation/fixture-loader.ts` `RetrievalEvalAtom` ~72-87 to see if it passes `scope`/`teamId` through to `createAtom` — if not, extend the loader to forward `scope`/`teamId`/`type`, with a failing test on the loader first).

- [ ] **Step 2 (if loader needs it): Extend the fixture loader** to forward `scope`, `teamId`, and `type` from fixture atoms into `createAtom`, with a unit test in `test/` that loads a fixture atom with `scope:'team'` and asserts the created atom has `teamId`. TDD: failing test first.

- [ ] **Step 3: Add fixture atoms** (in the fixture `atoms` array):
```json
{ "evalId": "team-named-exports", "claim": "Use named exports across the codebase; avoid default exports.", "type": "convention", "scope": "team", "teamId": "default", "tier": "verified", "status": "active", "trigger": { "taskTypes": ["implementation"], "symbols": ["export"] } },
{ "evalId": "proj-only-secret-rotation", "claim": "Rotate the billing webhook secret via the ops runbook only.", "type": "convention", "scope": "project", "tier": "verified", "status": "active", "trigger": { "taskTypes": ["implementation"], "businessAreas": ["billing"] } }
```

- [ ] **Step 4: Add a case** proving cross-project surfacing + pinning of the team convention:
```json
{
  "id": "team-convention-surfaces-and-pins",
  "prompt": "Implement a new export in src/widgets/list.ts using our export conventions.",
  "expectedKnowledgeIds": ["team-named-exports"],
  "expectedSelectedKnowledgeIds": ["team-named-exports"],
  "expectedClassification": { "taskType": "implementation", "files": ["src/widgets/list.ts"], "symbols": ["export"] }
}
```
(If the fixture's `project` differs from the team atom's stored project, this also proves cross-project surfacing. The `expectedSelectedKnowledgeIds` assertion proves it was pinned into the selected sections.)

- [ ] **Step 5: Run** `pnpm run eval:retrieval`. Confirm the new case passes AND the pre-existing 23 cases still pass with `hitRate=1`, `staleRejectionRate=1`, all exact-match rates 1. If the new convention atoms leak into other cases' top-K, tighten their `trigger` so they only match the intended case (do NOT lower thresholds).

- [ ] **Step 6: Full gate + commit:**
```bash
pnpm run build && pnpm test && pnpm run eval:retrieval
git add eval/retrieval-fixtures.json src/evaluation/fixture-loader.ts test/*.test.ts
git commit -m "test(eval): team convention surfaces cross-project + pins; project convention scoped"
```

---

## Phase 2 Definition of Done
- `CandidateSource` includes `'convention'`; a convention lane fetches team (cross-project, by `config.teamId`) + project conventions via `searchAtomsByTrigger`, bypassing the namespace filter.
- Matched conventions pin to the front of the pack's `essential` section.
- Pack conflicts resolve via `resolveLayeredConflicts` (team layer recognized via `conventionScope`).
- `start_session` returns a `handbook` status (count or bootstrap suggestion).
- New eval fixtures prove cross-project team surfacing + pinning + project-scope isolation; `pnpm run build && pnpm test && pnpm run eval:retrieval` all green (`hitRate=1`, `staleRejectionRate=1`).

## Risks
| Risk | Mitigation |
|---|---|
| Convention lane changes existing eval rankings | Lane is additive; fixtures have no conventions until Task 6; eval run after every retrieval task. |
| Conflict-swap breaks a user-style test asserting copy | Task 4 Step 3 inspects each user-style test; update only copy-asserting tests, never behavior. |
| `source` doesn't survive into `ContextPackItem` (Task 5) | Read the item type first; fall back to threading a count out of `buildContextPack`. |
| Exhaustive-source switch/constructors miss `convention` | Build is the guard — fix each TS error; Task 2 Step 7 calls this out. |
```
