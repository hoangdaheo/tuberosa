# P1 Area Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic `buildAreaModel` primitive that partitions a project's knowledge into directory-spine "areas" — the shared backbone that the P1 atlas, categorized export, and health dashboard all read.

**Architecture:** A single pure module, `src/knowledge-areas/area-model.ts`, exposes `buildAreaModel(store, project)`. It reads the P0 `source_files` ledger (the spine), then assigns `StoredKnowledge` (by `metadata.sourcePath`) and `KnowledgeAtom` (by trigger/evidence file paths) into areas keyed by top-level directory, with `domain`/`business_area` labels and atom-graph relations as overlays. No model calls — fully deterministic and eval-gated. Items with no resolvable path collect under a sentinel `_unassigned` area; repo-root files collect under `_root`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, `MemoryKnowledgeStore` for tests, `pnpm` / `tsx`.

> **Node version note:** `.nvmrc` pins 22.21.1. If the shell uses an older Node, prefix every command with `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH`.

> **Scope note:** This is Plan 1 of four (spec §9). It produces a standalone, tested module with no consumers yet — the atlas/export/dashboard plans will import it. This plan is independently shippable and adds no behavior change to existing code paths.

---

## File Structure

- **Create:** `src/knowledge-areas/area-model.ts` — the `ProjectArea` type, the `buildAreaModel` function, and two small pure helpers (`deriveAreaKey`, `areaLabel`).
- **Create:** `test/area-model.test.ts` — unit tests for helpers and the builder.

Single focused module: one responsibility (partition knowledge into areas), one public function plus two pure helpers that are exported for direct unit testing.

---

## Reference: existing types this plan depends on (do not redefine)

From `src/storage/store.ts` (`KnowledgeStore` interface):
```ts
listSourceFiles(options: { project?: string; status?: SourceFileStatus; limit: number }): Promise<SourceFileRecord[]>;
listKnowledge(options: { project?: string; status?: KnowledgeStatus; review?: KnowledgeReviewFilter; query?: string; limit: number }): Promise<StoredKnowledge[]>;
listAtoms(options: { project?: string; tier?: AtomTier; status?: AtomStatus; scope?: AtomScope; userId?: string; parentKnowledgeId?: string; limit: number }): Promise<KnowledgeAtom[]>;
listAtomRelations(options: { project?: string; fromAtomId?: string; targetAtomId?: string; relationType?: ...; inferenceSource?: ...; limit: number }): Promise<AtomRelationRow[]>;
```

`SourceFileRecord` (`src/source-sync/types.ts`): `{ id, project, path, contentHash, status, lastSyncedSha, priorPaths, knowledgeCount, firstSeenAt, lastSeenAt, archivedAt, metadata }`. `status: 'tracked' | 'changed' | 'missing' | 'archived' | 'ignored'`.

`StoredKnowledge` (`src/types/knowledge.ts`): has `id`, `project`, `itemType`, `metadata: Record<string, unknown>` (ingest stores the file path at `metadata.sourcePath`, see `src/ingest/service.ts:210`), `labels: LabelInput[]`. `LabelInput = { type: LabelType; value: string; ... }`, `LabelType` includes `'domain'` and `'business_area'`.

`KnowledgeAtom` (`src/types/atoms.ts`): has `id`, `project`, `tier: AtomTier` (`'draft' | 'verified' | 'canonical'`), `trigger: { files?: string[]; symbols?: string[]; ... }`, `evidence: Evidence[]` where a file evidence is `{ kind: 'file'; path: string; ... }`.

`AtomRelationRow` (`src/storage/store.ts`): `{ id, fromAtomId, targetAtomId, relationType, confidence, inferenceSource, createdAt }`.

---

### Task 1: Pure key + label helpers

**Files:**
- Create: `src/knowledge-areas/area-model.ts`
- Test: `test/area-model.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/area-model.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { deriveAreaKey, areaLabel } from '../src/knowledge-areas/area-model.js';

test('deriveAreaKey: src files key on the second segment', () => {
  assert.equal(deriveAreaKey('src/retrieval/service.ts'), 'src/retrieval');
  assert.equal(deriveAreaKey('src/storage/postgres-store.ts'), 'src/storage');
});

test('deriveAreaKey: non-src files key on the top segment', () => {
  assert.equal(deriveAreaKey('migrations/011_source_files.sql'), 'migrations');
  assert.equal(deriveAreaKey('docs/superpowers/specs/x.md'), 'docs');
});

test('deriveAreaKey: repo-root files collect under _root', () => {
  assert.equal(deriveAreaKey('README.md'), '_root');
  assert.equal(deriveAreaKey('./package.json'), '_root');
});

test('deriveAreaKey: bare src/ file keys on src', () => {
  assert.equal(deriveAreaKey('src/index.ts'), 'src');
});

test('areaLabel: humanizes the last segment', () => {
  assert.equal(areaLabel('src/retrieval'), 'Retrieval');
  assert.equal(areaLabel('migrations'), 'Migrations');
  assert.equal(areaLabel('_root'), 'Root');
  assert.equal(areaLabel('_unassigned'), 'Unassigned');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/area-model.test.ts`
Expected: FAIL — cannot find module `../src/knowledge-areas/area-model.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/knowledge-areas/area-model.ts`:

```ts
/**
 * The shared P1 area model: partition project knowledge into directory-spine
 * "areas". Pure and deterministic — no model calls — so it is eval-gated.
 */

/** Normalize a repo-relative path to its canonical area key. */
export function deriveAreaKey(path: string): string {
  const clean = path.replace(/^\.\//, '');
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 0) return '_unassigned';
  if (segments.length === 1) return '_root';
  if (segments[0] === 'src') {
    return segments.length >= 2 ? `src/${segments[1]}` : 'src';
  }
  return segments[0];
}

/** Human label for an area key (title-cased last segment). */
export function areaLabel(key: string): string {
  if (key === '_root') return 'Root';
  if (key === '_unassigned') return 'Unassigned';
  const last = key.split('/').filter(Boolean).pop() ?? key;
  return last.charAt(0).toUpperCase() + last.slice(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/area-model.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/knowledge-areas/area-model.ts test/area-model.test.ts
git commit -m "feat(area-model): deriveAreaKey + areaLabel helpers"
```

---

### Task 2: `buildAreaModel` spine from the ledger

**Files:**
- Modify: `src/knowledge-areas/area-model.ts`
- Test: `test/area-model.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/area-model.test.ts`:

```ts
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { buildAreaModel } from '../src/knowledge-areas/area-model.js';

test('buildAreaModel: spine groups ledger paths into areas', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/service.ts', contentHash: 'h1', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/fusion.ts', contentHash: 'h2', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'src/storage/store.ts', contentHash: 'h3', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'migrations/001_init.sql', contentHash: 'h4', status: 'tracked' });

  const areas = await buildAreaModel(store, 'p');
  const byKey = Object.fromEntries(areas.map((a) => [a.key, a]));

  assert.deepEqual(Object.keys(byKey).sort(), ['migrations', 'src/retrieval', 'src/storage']);
  assert.equal(byKey['src/retrieval'].label, 'Retrieval');
  assert.equal(byKey['src/retrieval'].counts.files, 2);
  assert.deepEqual(byKey['src/retrieval'].paths, ['src/retrieval/fusion.ts', 'src/retrieval/service.ts']);
});

test('buildAreaModel: archived ledger rows are excluded from the spine', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/dead/gone.ts', contentHash: 'h', status: 'archived' });
  await store.upsertSourceFile({ project: 'p', path: 'src/live/here.ts', contentHash: 'h', status: 'tracked' });

  const areas = await buildAreaModel(store, 'p');
  assert.deepEqual(areas.map((a) => a.key), ['src/live']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/area-model.test.ts`
Expected: FAIL — `buildAreaModel` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/knowledge-areas/area-model.ts` (imports at top of file, function below the helpers):

```ts
import type { KnowledgeStore } from '../storage/store.js';

export interface ProjectArea {
  key: string;
  label: string;
  paths: string[];
  knowledgeIds: string[];
  atomIds: string[];
  labels: { type: string; value: string }[];
  crossingRelations: number;
  counts: { files: number; knowledge: number; atoms: number; verifiedAtoms: number };
}

interface MutableArea extends ProjectArea {
  labelSet: Set<string>; // dedup key "type:value"
}

function ensureArea(map: Map<string, MutableArea>, key: string): MutableArea {
  let area = map.get(key);
  if (!area) {
    area = {
      key,
      label: areaLabel(key),
      paths: [],
      knowledgeIds: [],
      atomIds: [],
      labels: [],
      crossingRelations: 0,
      counts: { files: 0, knowledge: 0, atoms: 0, verifiedAtoms: 0 },
      labelSet: new Set<string>(),
    };
    map.set(key, area);
  }
  return area;
}

export async function buildAreaModel(store: KnowledgeStore, project: string): Promise<ProjectArea[]> {
  const areas = new Map<string, MutableArea>();

  const files = await store.listSourceFiles({ project, limit: 100_000 });
  for (const file of files) {
    if (file.status === 'archived') continue;
    const area = ensureArea(areas, deriveAreaKey(file.path));
    area.paths.push(file.path);
    area.counts.files += 1;
  }

  return finalize(areas);
}

function finalize(areas: Map<string, MutableArea>): ProjectArea[] {
  const result: ProjectArea[] = [];
  for (const area of areas.values()) {
    area.paths.sort();
    area.knowledgeIds.sort();
    area.atomIds.sort();
    area.labels.sort((a, b) => `${a.type}:${a.value}`.localeCompare(`${b.type}:${b.value}`));
    const { labelSet: _labelSet, ...clean } = area;
    result.push(clean);
  }
  result.sort((a, b) => a.key.localeCompare(b.key));
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/area-model.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/knowledge-areas/area-model.ts test/area-model.test.ts
git commit -m "feat(area-model): buildAreaModel spine from source_files ledger"
```

---

### Task 3: Assign knowledge and atoms into areas

**Files:**
- Modify: `src/knowledge-areas/area-model.ts`
- Test: `test/area-model.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/area-model.test.ts`:

```ts
test('buildAreaModel: assigns knowledge by metadata.sourcePath and atoms by trigger/evidence', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/service.ts', contentHash: 'h', status: 'tracked' });

  await store.upsertKnowledge({
    project: 'p', sourceType: 'manual', sourceUri: 'u', itemType: 'code_ref',
    title: 'svc', summary: '', content: 'c', labels: [], references: [],
    metadata: { sourcePath: 'src/retrieval/service.ts' },
  }, []);

  await store.createAtom({
    project: 'p', claim: 'A', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/retrieval/service.ts' }],
    trigger: { files: ['src/retrieval/service.ts'] }, producedBy: 'agent_session',
  });

  const areas = await buildAreaModel(store, 'p');
  const retrieval = areas.find((a) => a.key === 'src/retrieval')!;
  assert.equal(retrieval.counts.knowledge, 1);
  assert.equal(retrieval.counts.atoms, 1);
  assert.equal(retrieval.knowledgeIds.length, 1);
  assert.equal(retrieval.atomIds.length, 1);
});

test('buildAreaModel: pathless knowledge and atoms fall under _unassigned', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertKnowledge({
    project: 'p', sourceType: 'manual', sourceUri: 'u', itemType: 'wiki',
    title: 'floating', summary: '', content: 'c', labels: [], references: [], metadata: {},
  }, []);
  await store.createAtom({
    project: 'p', claim: 'B', type: 'fact', evidence: [], trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });

  const areas = await buildAreaModel(store, 'p');
  const un = areas.find((a) => a.key === '_unassigned')!;
  assert.equal(un.counts.knowledge, 1);
  assert.equal(un.counts.atoms, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/area-model.test.ts`
Expected: FAIL — `_unassigned` area absent / knowledge & atom counts are 0.

- [ ] **Step 3: Write minimal implementation**

In `src/knowledge-areas/area-model.ts`, add a path-extraction helper for atoms and extend `buildAreaModel`. Add this helper above `buildAreaModel`:

```ts
import type { KnowledgeAtom } from '../types/atoms.js';

/** Best-effort file path for an atom: first trigger file, else first file evidence. */
function atomPath(atom: KnowledgeAtom): string | undefined {
  const triggerFile = atom.trigger.files?.find((f) => f.length > 0);
  if (triggerFile) return triggerFile;
  for (const ev of atom.evidence) {
    if (ev.kind === 'file' && ev.path) return ev.path;
  }
  return undefined;
}
```

Then, inside `buildAreaModel`, after the ledger loop and before `return finalize(areas)`:

```ts
  const knowledge = await store.listKnowledge({ project, limit: 100_000 });
  for (const item of knowledge) {
    const path = (item.metadata as { sourcePath?: string }).sourcePath;
    const key = path ? deriveAreaKey(path) : '_unassigned';
    const area = ensureArea(areas, key);
    area.knowledgeIds.push(item.id);
    area.counts.knowledge += 1;
  }

  const atoms = await store.listAtoms({ project, limit: 100_000 });
  for (const atom of atoms) {
    const path = atomPath(atom);
    const key = path ? deriveAreaKey(path) : '_unassigned';
    const area = ensureArea(areas, key);
    area.atomIds.push(atom.id);
    area.counts.atoms += 1;
    if (atom.tier === 'verified' || atom.tier === 'canonical') {
      area.counts.verifiedAtoms += 1;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/area-model.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/knowledge-areas/area-model.ts test/area-model.test.ts
git commit -m "feat(area-model): assign knowledge + atoms into areas"
```

---

### Task 4: Label and graph-relation overlays

**Files:**
- Modify: `src/knowledge-areas/area-model.ts`
- Test: `test/area-model.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/area-model.test.ts`:

```ts
test('buildAreaModel: overlays domain/business_area labels and counts crossing relations', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/service.ts', contentHash: 'h', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'src/storage/store.ts', contentHash: 'h', status: 'tracked' });

  await store.upsertKnowledge({
    project: 'p', sourceType: 'manual', sourceUri: 'u', itemType: 'code_ref',
    title: 'svc', summary: '', content: 'c',
    labels: [
      { type: 'domain', value: 'retrieval' },
      { type: 'business_area', value: 'search' },
      { type: 'technology', value: 'typescript' }, // must NOT appear as an overlay
    ],
    references: [], metadata: { sourcePath: 'src/retrieval/service.ts' },
  }, []);

  const a = await store.createAtom({
    project: 'p', claim: 'A', type: 'fact', evidence: [{ kind: 'file', path: 'src/retrieval/service.ts' }],
    trigger: { files: ['src/retrieval/service.ts'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'p', claim: 'B', type: 'fact', evidence: [{ kind: 'file', path: 'src/storage/store.ts' }],
    trigger: { files: ['src/storage/store.ts'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(
    a.id,
    [{ fromAtomId: a.id, targetAtomId: b.id, relationType: 'depends_on', confidence: 0.7, inferenceSource: 'semantic' }],
    { source: 'semantic' },
  );

  const areas = await buildAreaModel(store, 'p');
  const retrieval = areas.find((x) => x.key === 'src/retrieval')!;
  const storage = areas.find((x) => x.key === 'src/storage')!;

  assert.deepEqual(retrieval.labels, [
    { type: 'business_area', value: 'search' },
    { type: 'domain', value: 'retrieval' },
  ]);
  assert.equal(retrieval.crossingRelations, 1);
  assert.equal(storage.crossingRelations, 1);
});

test('buildAreaModel: relations within one area do not count as crossing', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'p', claim: 'A', type: 'fact', evidence: [{ kind: 'file', path: 'src/x/a.ts' }],
    trigger: { files: ['src/x/a.ts'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'p', claim: 'B', type: 'fact', evidence: [{ kind: 'file', path: 'src/x/b.ts' }],
    trigger: { files: ['src/x/b.ts'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(
    a.id,
    [{ fromAtomId: a.id, targetAtomId: b.id, relationType: 'related_to', confidence: 0.5, inferenceSource: 'semantic' }],
    { source: 'semantic' },
  );

  const areas = await buildAreaModel(store, 'p');
  assert.equal(areas.find((x) => x.key === 'src/x')!.crossingRelations, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx test/area-model.test.ts`
Expected: FAIL — `labels` empty and `crossingRelations` is 0.

- [ ] **Step 3: Write minimal implementation**

In `buildAreaModel`, inside the knowledge loop add label collection right after `area.counts.knowledge += 1;`:

```ts
    for (const label of item.labels) {
      if (label.type !== 'domain' && label.type !== 'business_area') continue;
      const dedup = `${label.type}:${label.value}`;
      if (!area.labelSet.has(dedup)) {
        area.labelSet.add(dedup);
        area.labels.push({ type: label.type, value: label.value });
      }
    }
```

While building atoms, record each atom's area key for the relation pass. Declare `const atomArea = new Map<string, string>();` before the atoms loop, and inside it (after computing `key`) add `atomArea.set(atom.id, key);`.

Then, after the atoms loop and before `return finalize(areas)`:

```ts
  const relations = await store.listAtomRelations({ project, limit: 1_000_000 });
  const seen = new Set<string>();
  for (const rel of relations) {
    const fromKey = atomArea.get(rel.fromAtomId);
    const toKey = atomArea.get(rel.targetAtomId);
    if (!fromKey || !toKey || fromKey === toKey) continue;
    // Dedup undirected edges so a single relation counts once per endpoint area.
    const canonical = [rel.fromAtomId, rel.targetAtomId].sort().join('|');
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    ensureArea(areas, fromKey).crossingRelations += 1;
    ensureArea(areas, toKey).crossingRelations += 1;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx test/area-model.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/knowledge-areas/area-model.ts test/area-model.test.ts
git commit -m "feat(area-model): label + crossing-relation overlays"
```

---

### Task 5: Determinism guarantee + full-suite verification

**Files:**
- Test: `test/area-model.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/area-model.test.ts`:

```ts
test('buildAreaModel: output is deterministic across runs (stable sort)', async () => {
  const store = new MemoryKnowledgeStore();
  // Insert in deliberately non-sorted order.
  await store.upsertSourceFile({ project: 'p', path: 'src/storage/z.ts', contentHash: 'h', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/b.ts', contentHash: 'h', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/a.ts', contentHash: 'h', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'migrations/x.sql', contentHash: 'h', status: 'tracked' });

  const first = JSON.stringify(await buildAreaModel(store, 'p'));
  const second = JSON.stringify(await buildAreaModel(store, 'p'));
  assert.equal(first, second);

  const areas = await buildAreaModel(store, 'p');
  assert.deepEqual(areas.map((a) => a.key), ['migrations', 'src/retrieval', 'src/storage']);
  assert.deepEqual(areas.find((a) => a.key === 'src/retrieval')!.paths, ['src/retrieval/a.ts', 'src/retrieval/b.ts']);
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `node --test --import tsx test/area-model.test.ts`
Expected: PASS (12 tests) — the sort logic from Task 2/4 already guarantees this. If it FAILS, the bug is a missing sort in `finalize`; fix `finalize` so all arrays and the area list are sorted, then re-run.

- [ ] **Step 3: Run the full unit suite (no regressions)**

Run: `pnpm test`
Expected: PASS — all existing tests plus the new `test/area-model.test.ts`.

- [ ] **Step 4: Typecheck / build**

Run: `pnpm run build`
Expected: TypeScript compiles with no errors (the new module is type-clean).

- [ ] **Step 5: Retrieval eval gate (must stay green)**

Run: `pnpm run eval:retrieval`
Expected: PASS — this plan adds no retrieval-ranking code, so the eval is unchanged and green. (Per spec §8, no new retrieval fixture is required for P1.)

- [ ] **Step 6: Commit**

```bash
git add test/area-model.test.ts
git commit -m "test(area-model): determinism guarantee + suite green"
```

---

## Self-Review

**Spec coverage (spec §3 — the area model):**
- `ProjectArea` shape (key, label, paths, knowledgeIds, atomIds, labels, crossingRelations, counts) — Task 2 (type) + Tasks 3–4 (population). ✅
- Spine from `source_files` ledger, directory-keyed — Task 2; `deriveAreaKey` rule (1 segment under `src/`, else top segment) — Task 1. ✅
- Knowledge assigned by `metadata.sourcePath`; atoms by trigger/evidence path — Task 3. ✅
- `_unassigned` fallback for pathless items — Task 3. ✅
- `domain`/`business_area` labels as overlay (not definition); graph relations crossing boundaries — Task 4. ✅
- `counts.verifiedAtoms` (tier verified/canonical) — Task 3. ✅
- Pure, deterministic, eval-gated — Task 5. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**Type consistency:** `buildAreaModel(store, project)` signature, `ProjectArea`/`MutableArea` fields, and helper names (`deriveAreaKey`, `areaLabel`, `atomPath`, `ensureArea`, `finalize`) are used identically across Tasks 1–5. Store methods (`listSourceFiles`, `listKnowledge`, `listAtoms`, `listAtomRelations`, `upsertSourceFile`, `upsertKnowledge`, `createAtom`, `replaceAtomRelations`) match `src/storage/store.ts` exactly. ✅

**Not in this plan (later plans, by design):** atlas synthesis, categorized export, dashboard — all import `buildAreaModel` from `src/knowledge-areas/area-model.js`.
