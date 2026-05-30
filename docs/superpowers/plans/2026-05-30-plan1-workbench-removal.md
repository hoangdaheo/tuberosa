# Plan 1 — Workbench Full Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every workbench artifact from Tuberosa — the Preact UI, its HTTP route, its build tooling, and the `workbench-summary` data concept (MCP tool + operations + types) — while preserving all surviving non-workbench behavior.

**Architecture:** Removal proceeds in dependency-safe order. The single load-bearing helper (`buildSourceHealth`, used by `bootstrap/health.ts`) is relocated to `src/source-sync/source-health.ts` FIRST and verified green; then the `/operations/catchup` summary field is dropped and the replay route renamed; then HTTP/MCP/validation references are removed; then the UI tree, summary data concept, CLI, scripts, and tests are deleted; finally `package.json`/tsconfig/`.npmrc` are simplified to a single-`tsc` build and 10 npm deps are pruned. Every task ends green against the verify gate.

**Tech Stack:** TypeScript (NodeNext, ES2022), Node 22, pnpm 11, `node --test` + `tsx`. Deletions remove Preact/signals/cytoscape/dagre/cose-bilkent/motionone/lucide-preact/esbuild/playwright-core/@types/cytoscape.

**Branch:** `chore/workbench-removal-and-audit` (already created; spec committed here).

**Verify gate (referenced as "VERIFY GATE" below):**
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
```
(The `PATH=` prefix is only needed if `node -v` is not already 22.x.)

---

## File Structure

**Created:**
- `src/source-sync/source-health.ts` — neutral home for `buildSourceHealth` + the `SourceHealth` type (the only logic extracted from the deleted `workbench-summary.ts`).
- `test/source-health.test.ts` — relocated test (replaces `test/source-sync-workbench.test.ts`).

**Modified:**
- `src/bootstrap/health.ts` — re-point one import.
- `src/http/server.ts` — drop catchup `summary` field; rename replay route; remove UI routes, summary route, summary import + validation helper.
- `src/mcp/server.ts` — remove `tuberosa_get_workbench_summary` handler + tool definition + imports.
- `src/validation.ts` — remove `validateWorkbenchSummaryInput` + import.
- `src/types.ts` — drop the `./types/workbench.js` re-export.
- `test/operations.test.ts` — carve out the two workbench test blocks.
- `test/api-boundary.test.ts` — remove the `WorkbenchSummary` import + its boundary assertion.
- `package.json`, `tsconfig.json`, `.npmrc` — single-`tsc` build, drop deps/scripts.
- `CLAUDE.md`, `wiki/09-mcp-reference.md`, `wiki/13-operations-runbook.md` — remove `tuberosa_get_workbench_summary` references.

**Deleted:**
- `src/workbench-v2/**` (whole tree), `src/http/workbench-v2.ts`
- `src/operations/workbench-summary.ts`, `src/types/workbench.ts`, `src/operations/workbench-cli.ts`
- `scripts/workbench.ts`, `scripts/build-workbench-v2.ts`, `scripts/gen-demo-replays.ts`
- `tsconfig.workbench.json`
- `test/workbench-v2/**`, `test/browser/workbench-v2-browser.test.ts`, `test/workbench-cli.test.ts`, `test/source-sync-workbench.test.ts`

**Untouched (explicitly NOT removed):** `src/operations/session-replay.ts` (SessionReplayService), `migrations/004_agent_session_replays.sql`, `src/operations/context-quality-cli.ts` (`ContextQualityWorkbench*` is a surviving context-quality feature, name only).

---

## Task 1: Relocate `buildSourceHealth` to `source-sync/source-health.ts`

**Files:**
- Create: `src/source-sync/source-health.ts`
- Create: `test/source-health.test.ts`
- Delete: `test/source-sync-workbench.test.ts`
- Modify: `src/bootstrap/health.ts:3`

- [ ] **Step 1: Create the relocated test (it will fail to import — new module does not exist yet)**

Create `test/source-health.test.ts`:
```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { buildSourceHealth } from '../src/source-sync/source-health.js';

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

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/source-health.test.ts`
Expected: FAIL — `Cannot find module '../src/source-sync/source-health.js'`.

- [ ] **Step 3: Create the new module**

Create `src/source-sync/source-health.ts`:
```typescript
import type { KnowledgeStore } from '../storage/store.js';
import type { SourceFileStatus } from './types.js';

/** Aggregated source-ledger health: per-status counts plus archived-file tombstones. */
export interface SourceHealth {
  counts: {
    tracked: number;
    changed: number;
    missing: number;
    archived: number;
    ignored: number;
  };
  tombstones: Array<{ path: string; archivedAt: string | null }>;
}

export async function buildSourceHealth(
  store: Pick<KnowledgeStore, 'listSourceFiles'>,
  options: { project?: string; limit: number },
): Promise<SourceHealth> {
  const files = await store.listSourceFiles({ project: options.project, limit: options.limit });
  const counts: Record<SourceFileStatus, number> = { tracked: 0, changed: 0, missing: 0, archived: 0, ignored: 0 };
  const tombstones: SourceHealth['tombstones'] = [];
  for (const file of files) {
    counts[file.status] += 1;
    if (file.status === 'archived') {
      tombstones.push({ path: file.path, archivedAt: file.archivedAt });
    }
  }
  return { counts, tombstones };
}
```

- [ ] **Step 4: Re-point the bootstrap import**

In `src/bootstrap/health.ts`, replace line 3:
```typescript
import { buildSourceHealth } from '../operations/workbench-summary.js';
```
with:
```typescript
import { buildSourceHealth } from '../source-sync/source-health.js';
```
(Leave the rest of `health.ts` unchanged — it uses `sourceHealth.counts` and `sourceHealth.tombstones`, both preserved by the `SourceHealth` shape.)

- [ ] **Step 5: Delete the old test**

Run: `git rm test/source-sync-workbench.test.ts`

- [ ] **Step 6: Run the new test + bootstrap health test to verify they pass**

Run: `node --test --import tsx test/source-health.test.ts test/bootstrap-health.test.ts`
Expected: PASS (both). `workbench-summary.ts` still exists at this point so its own `buildSourceHealth` is now dead but compiles; that file is deleted in Task 7.

- [ ] **Step 7: Commit**

```bash
git add src/source-sync/source-health.ts test/source-health.test.ts src/bootstrap/health.ts
git rm test/source-sync-workbench.test.ts
git commit -m "refactor: relocate buildSourceHealth to source-sync/source-health.ts"
```

---

## Task 2: Drop the workbench summary from `/operations/catchup`

**Files:**
- Modify: `src/http/server.ts` (catchup handler ~`805-813`; `buildWorkbenchSummary` import ~`6`)

- [ ] **Step 1: Locate the catchup handler**

Run: `grep -n "buildWorkbenchSummary\|/operations/catchup\|getCatchupMetadata" src/http/server.ts`
This finds the import line (~6), the route registration (~`/operations/catchup`), and the handler body that builds `const summary = await buildWorkbenchSummary(...)` and returns `{ catchup, summary }`.

- [ ] **Step 2: Edit the handler to return only `{ catchup }`**

In the catchup handler, remove the `const summary = await buildWorkbenchSummary(...)` statement and any `readWorkbenchSummaryOptions(...)` call feeding it, and change the response object from `{ catchup, summary }` to `{ catchup }`. Remove the now-unused `import { buildWorkbenchSummary } from '../operations/workbench-summary.js';` at the top of the file.

- [ ] **Step 3: Run build to verify no dangling references in this file's catchup path**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build 2>&1 | head -30`
Expected: `buildWorkbenchSummary` may still be referenced elsewhere in `server.ts` (the `/operations/workbench/summary` route, removed in Task 4) — so a "declared but never read" or unused-import error is acceptable ONLY if you removed the import; if tsc complains that `buildWorkbenchSummary` is still used, that is the summary route handled in Task 4. If so, leave the import for now and re-run after Task 4. Otherwise expect success.

> Note: if removing the import breaks Task 4's not-yet-removed route, keep the import in this task and delete it in Task 4 Step 3 instead. Either ordering is fine; the VERIFY GATE at the end is the real check.

- [ ] **Step 4: Commit**

```bash
git add src/http/server.ts
git commit -m "refactor(http): drop workbench summary field from /operations/catchup"
```

---

## Task 3: Rename the replay route to `/operations/session/:id/replay`

**Files:**
- Modify: `src/http/server.ts` (replay route ~`771-782`)

- [ ] **Step 1: Locate the replay route**

Run: `grep -n "workbench/session\|replay\|sessionReplay\|readReplay" src/http/server.ts`
Find the route whose path matches `/operations/workbench/session/:id/replay` (or its regex form). It calls `services.sessionReplay.readReplay(...)`.

- [ ] **Step 2: Rename only the URL**

Change the route path from `/operations/workbench/session/...` to `/operations/session/...`, preserving the `:id` segment and the `services.sessionReplay.readReplay(...)` handler body verbatim. Do NOT touch `src/operations/session-replay.ts` or migration `004`.

- [ ] **Step 3: Update any test that hits the old replay URL**

Run: `grep -rn "operations/workbench/session" test/`
For each hit, change the URL to `/operations/session/...`. (If none, skip.)

- [ ] **Step 4: Run the affected tests**

Run: `node --test --import tsx test/api-boundary.test.ts` (and any test file from Step 3)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/server.ts test/
git commit -m "refactor(http): rename workbench replay route to /operations/session/:id/replay"
```

---

## Task 4: Remove HTTP workbench UI routes, summary route, and the static asset module

**Files:**
- Modify: `src/http/server.ts` (imports ~`53`, `51`; routes ~`173-190`, `766-770`; helper `readWorkbenchSummaryOptions` ~`1342-1347`)
- Delete: `src/http/workbench-v2.ts`

- [ ] **Step 1: Locate every workbench reference in server.ts**

Run: `grep -n "workbench\|Workbench" src/http/server.ts`

- [ ] **Step 2: Remove the UI + summary routes and their imports**

Remove:
- the import of `readWorkbenchAsset, workbenchHtml` from `./workbench-v2.js` (~line 53),
- the `GET /workbench` and `GET /workbench/static/(.+)` route objects (~173-190),
- the `GET /operations/workbench/summary` route (~766-770),
- the `validateWorkbenchSummaryInput` import (~51) and the `readWorkbenchSummaryOptions` helper (~1342-1347),
- the `buildWorkbenchSummary` import if not already removed in Task 2.

After this, `grep -n "workbench\|Workbench" src/http/server.ts` should return nothing (or only unrelated substrings — verify each).

- [ ] **Step 3: Delete the static-asset module**

Run: `git rm src/http/workbench-v2.ts`

- [ ] **Step 4: Build to verify server.ts compiles**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build 2>&1 | head -30`
Expected: server.ts compiles. Remaining errors should only be in files deleted in later tasks (e.g. `mcp/server.ts` still importing summary helpers — handled in Task 5). If errors are confined to not-yet-edited workbench files, proceed.

- [ ] **Step 5: Commit**

```bash
git add src/http/server.ts
git rm src/http/workbench-v2.ts
git commit -m "refactor(http): remove /workbench UI routes, summary route, and static asset module"
```

---

## Task 5: Remove the `tuberosa_get_workbench_summary` MCP tool

**Files:**
- Modify: `src/mcp/server.ts` (imports ~`3`, `48`; handler `case` ~`229-235`; tool definition ~`1296+`)

- [ ] **Step 1: Locate every workbench reference in mcp/server.ts**

Run: `grep -n "workbench\|Workbench" src/mcp/server.ts`

- [ ] **Step 2: Remove the handler, the tool definition, and imports**

Remove:
- `import { buildWorkbenchSummary } ...` (~line 3),
- `validateWorkbenchSummaryInput` import (~line 48),
- the `case 'tuberosa_get_workbench_summary': { ... }` dispatch block (~229-235),
- the tool-definition object whose `name` is `'tuberosa_get_workbench_summary'` (~1296+) — read from `name:` to the object's matching closing brace/comma so the surrounding tool array stays valid.

After this, `grep -n "workbench\|Workbench" src/mcp/server.ts` should return nothing.

- [ ] **Step 3: Build to verify mcp/server.ts compiles**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build 2>&1 | head -30`
Expected: `mcp/server.ts` compiles. Remaining errors only in `validation.ts`/`workbench-summary.ts`/`types/workbench.ts` (later tasks).

- [ ] **Step 4: Commit**

```bash
git add src/mcp/server.ts
git commit -m "refactor(mcp): remove tuberosa_get_workbench_summary tool"
```

---

## Task 6: Remove `validateWorkbenchSummaryInput` from validation

**Files:**
- Modify: `src/validation.ts` (import ~`63`; validator ~`593-601`)

- [ ] **Step 1: Locate**

Run: `grep -n "Workbench" src/validation.ts`

- [ ] **Step 2: Remove the validator and its type import**

Remove the `export function validateWorkbenchSummaryInput(...)` function (~593-601) and the `WorkbenchSummaryInput` type import (~63). After this, `grep -n "Workbench" src/validation.ts` returns nothing.

- [ ] **Step 3: Build**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build 2>&1 | head -30`
Expected: errors now confined to `src/operations/workbench-summary.ts` and `src/types/workbench.ts` (deleted next) and the still-present workbench test files (Task 10).

- [ ] **Step 4: Commit**

```bash
git add src/validation.ts
git commit -m "refactor(validation): remove validateWorkbenchSummaryInput"
```

---

## Task 7: Delete the workbench-summary data concept

**Files:**
- Delete: `src/operations/workbench-summary.ts`, `src/types/workbench.ts`
- Modify: `src/types.ts:9`

- [ ] **Step 1: Confirm nothing outside deleted/test files still imports these**

Run:
```bash
grep -rn "workbench-summary\|types/workbench" src/ | grep -v "src/workbench-v2/"
```
Expected: only `src/types.ts` (the re-export, line ~9). If `buildWorkbenchSummary` / `WorkbenchSummary*` appear anywhere else in non-deleted `src/`, STOP and resolve before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm src/operations/workbench-summary.ts src/types/workbench.ts
```

- [ ] **Step 3: Remove the re-export in src/types.ts**

In `src/types.ts`, delete line 9: `export * from './types/workbench.js';`

- [ ] **Step 4: Build**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build 2>&1 | head -30`
Expected: `src/` compiles cleanly. Remaining errors only in workbench test files + `src/workbench-v2/**` is excluded by tsconfig, so the source tree should now build. (Tests are not compiled by tsc here; the `node --test` run in Task 10 covers them.)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git rm src/operations/workbench-summary.ts src/types/workbench.ts
git commit -m "refactor: delete workbench-summary data concept and types"
```

---

## Task 8: Delete workbench CLI and build/gen scripts

**Files:**
- Delete: `src/operations/workbench-cli.ts`, `scripts/workbench.ts`, `scripts/build-workbench-v2.ts`, `scripts/gen-demo-replays.ts`

- [ ] **Step 1: Confirm no surviving importers**

Run:
```bash
grep -rn "workbench-cli\|scripts/workbench\|build-workbench-v2\|gen-demo-replays" src/ scripts/ test/ package.json | grep -v "src/workbench-v2/"
```
Expected: only `package.json` script entries (removed in Task 11) and `test/workbench-cli.test.ts` (removed in Task 10).

- [ ] **Step 2: Delete**

```bash
git rm src/operations/workbench-cli.ts scripts/workbench.ts scripts/build-workbench-v2.ts scripts/gen-demo-replays.ts
```

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor: delete workbench CLI and build/gen scripts"
```

---

## Task 9: Delete the workbench UI tree

**Files:**
- Delete: `src/workbench-v2/**`

- [ ] **Step 1: Confirm nothing outside the tree imports into it**

Run: `grep -rn "workbench-v2" src/ scripts/ | grep -v "src/workbench-v2/"`
Expected: nothing (the HTTP static module that referenced it was deleted in Task 4).

- [ ] **Step 2: Delete the tree**

```bash
git rm -r src/workbench-v2
```

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor: delete workbench-v2 UI tree"
```

---

## Task 10: Delete and trim workbench tests

**Files:**
- Delete: `test/workbench-v2/**`, `test/browser/workbench-v2-browser.test.ts`, `test/workbench-cli.test.ts`
- Modify: `test/operations.test.ts` (import ~`20`; two workbench test blocks ~`615-665`)
- Modify: `test/api-boundary.test.ts` (import ~`10`; assertion ~`626`)

- [ ] **Step 1: Delete workbench-only test files**

```bash
git rm -r test/workbench-v2
git rm test/browser/workbench-v2-browser.test.ts test/workbench-cli.test.ts
```
(If `test/browser/` is now empty, `git rm -r test/browser` too.)

- [ ] **Step 2: Carve workbench blocks out of test/operations.test.ts**

Run: `grep -n "workbench\|Workbench" test/operations.test.ts`
Remove the `WorkbenchSummary`/`buildWorkbenchSummary` import (~line 20) and the two `test(...)` blocks that assert the workbench summary and the API-key protection of `/operations/workbench/summary` (~615-665). Keep every other test in the file.

- [ ] **Step 3: Remove the workbench assertion from test/api-boundary.test.ts**

Run: `grep -n "Workbench" test/api-boundary.test.ts`
Remove the `WorkbenchSummary` type import (~line 10) and the boundary assertion using `structuredContent?: WorkbenchSummary` for `get_workbench_summary` (~626). Keep the rest.

- [ ] **Step 4: Run the trimmed test files**

Run: `node --test --import tsx test/operations.test.ts test/api-boundary.test.ts`
Expected: PASS, no reference errors.

- [ ] **Step 5: Commit**

```bash
git add test/operations.test.ts test/api-boundary.test.ts
git rm -r test/workbench-v2
git rm test/browser/workbench-v2-browser.test.ts test/workbench-cli.test.ts
git commit -m "test: remove workbench tests and trim workbench assertions"
```

---

## Task 11: Simplify build, drop deps, prune lockfile

**Files:**
- Modify: `package.json`, `tsconfig.json`, `.npmrc`
- Delete: `tsconfig.workbench.json`

- [ ] **Step 1: Edit package.json scripts**

Set `build` to a single tsc:
```json
"build": "tsc -p tsconfig.json",
```
Delete these script lines entirely: `build:workbench`, `dev:workbench`, `gen:demo-replays`, `workbench`, `test:workbench-browser`.

- [ ] **Step 2: Remove workbench dependencies**

From `dependencies`, delete: `@motionone/dom`, `@preact/signals`, `cytoscape`, `cytoscape-cose-bilkent`, `cytoscape-dagre`, `lucide-preact`, `preact`.
From `devDependencies`, delete: `@types/cytoscape`, `esbuild`, `playwright-core`.
Keep: `js-yaml`, `pg`, `redis`, `@types/js-yaml`, `@types/node`, `@types/pg`, `tsx`, `typescript`.

- [ ] **Step 3: Remove the esbuild build-allow entry**

In `package.json`, remove the `pnpm.onlyBuiltDependencies` block (its only entry is `esbuild`):
```json
"pnpm": {
  "onlyBuiltDependencies": [
    "esbuild"
  ]
}
```
Then in `.npmrc`, remove any `onlyBuiltDependencies`/`allowBuilds` line mentioning `esbuild`.
Run: `grep -n "esbuild\|allowBuild\|onlyBuilt" .npmrc package.json` → expect nothing.

- [ ] **Step 4: Remove the workbench tsconfig**

```bash
git rm tsconfig.workbench.json
```
In `tsconfig.json`, remove the `"src/workbench-v2/**"` entry from the `exclude` array (line ~17). Leave the rest of the config unchanged.

- [ ] **Step 5: Prune the lockfile**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm install`
Expected: lockfile updated, 10 packages removed, no errors.

- [ ] **Step 6: Build with the simplified single-tsc pipeline**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Expected: clean compile, no esbuild step.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .npmrc pnpm-lock.yaml
git rm tsconfig.workbench.json
git commit -m "build: collapse to single tsc and drop 10 workbench-only deps"
```

---

## Task 12: Update docs

**Files:**
- Modify: `CLAUDE.md` (startup-rule tool list), `wiki/09-mcp-reference.md`, `wiki/13-operations-runbook.md`

- [ ] **Step 1: Find doc references**

Run: `grep -rln "tuberosa_get_workbench_summary\|/workbench\|workbench" CLAUDE.md wiki/ README.md AGENTS.md`

- [ ] **Step 2: Remove the MCP tool from CLAUDE.md startup rule**

In `CLAUDE.md`, the Tuberosa startup-rule tool list and any reference instructing agents to call `tuberosa_get_workbench_summary` must be removed. Remove `/workbench` UI mentions and `/operations/workbench/summary`. Update the renamed replay route reference to `/operations/session/:id/replay` if present. Leave unrelated content intact.

- [ ] **Step 3: Update wiki references**

In `wiki/09-mcp-reference.md` remove the `tuberosa_get_workbench_summary` entry. In `wiki/13-operations-runbook.md` remove workbench-UI/summary references and update the replay route name. Do not invent replacement content; just remove the removed surfaces.

- [ ] **Step 4: Verify**

Run: `grep -rn "tuberosa_get_workbench_summary" . --include='*.md' | grep -v node_modules | grep -v docs/superpowers`
Expected: nothing (the spec/plan under `docs/superpowers/` may still mention it historically — that's fine).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md wiki/
git commit -m "docs: remove workbench UI + tuberosa_get_workbench_summary references"
```

---

## Task 13: Final verification gate

- [ ] **Step 1: Confirm zero functional workbench references remain in shipped code**

Run:
```bash
grep -rin "workbench" src/ scripts/ test/ migrations/ | grep -viE "context.?quality|^[^:]*:[0-9]+:\s*//" | head -40
```
Review each remaining hit: acceptable survivors are the `ContextQualityWorkbench*` names (context-quality CLI) and harmless comment/string mentions. No live `workbench-summary`/UI/route code should remain.

- [ ] **Step 2: Run the full VERIFY GATE**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
```
Expected: build clean; full test suite green (workbench tests removed; count drops accordingly); both evals green.

- [ ] **Step 3: Sanity-boot the server (no workbench route)**

Run:
```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash PORT=3099 \
  node dist/src/index.js & sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3099/workbench   # expect 404
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3099/health      # expect 200
kill %1
```
Expected: `/workbench` → 404, `/health` → 200.

- [ ] **Step 4: Final commit (if any uncommitted cleanup remains)**

```bash
git add -A && git commit -m "chore: finalize workbench removal" || echo "nothing to commit"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** Plan 1 section of the spec maps task-by-task — relocate `buildSourceHealth` (T1), drop catchup summary (T2), rename replay route (T3), remove HTTP UI/summary routes + static module (T4), remove MCP tool (T5), remove validation (T6), delete summary data concept (T7), delete CLI/scripts (T8), delete UI (T9), trim tests (T10), build/deps cleanup (T11), docs (T12), verify (T13). All spec Plan-1 steps covered.

**Placeholder scan:** No TBD/TODO. Deletions specify exact paths; the one authored module (`source-health.ts`) and the relocated test contain full code. Edit-out tasks give grep anchors + exact import strings + the tsc gate.

**Type consistency:** `buildSourceHealth(store, { project?, limit })` → `Promise<SourceHealth>` is consistent across the new module, the re-pointed `bootstrap/health.ts` (uses `.counts`/`.tombstones`), and the relocated test. `SourceHealth` replaces `WorkbenchSourceHealth` with the identical shape from `types/workbench.ts:201-210`.

**Ordering note:** Tasks 2 and 4 both touch the `buildWorkbenchSummary` import in `server.ts`; the plan flags that the import removal may land in whichever task removes its last use — the final VERIFY GATE is authoritative.
