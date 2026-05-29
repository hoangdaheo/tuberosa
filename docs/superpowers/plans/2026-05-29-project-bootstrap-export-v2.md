# Project Bootstrap + Export V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single `tuberosa bootstrap` command that builds first-run project knowledge (sync → atlas → health → next actions), plus an optional human-readable, importable Export V2 pack and a bounded `--deep` graph-enrichment mode.

**Architecture:** A new `BootstrapService` orchestrates existing subsystems (`SourceSyncService`, `AtlasService`, a focused health helper, the export writer) behind one injectable CLI command following the established `sync.ts` / `atlas.ts` pattern. Export V2 is a layout improvement: it reuses the existing atom/knowledge/edge codecs but writes them into a categorized two-layer bundle derived from `buildAreaModel`. Import gains a categorized reader and a conflict-resolution content fix; nothing in the retrieval ranking path changes.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 22, `node:test` + `node:assert/strict`, `MemoryKnowledgeStore` for tests, pnpm scripts.

**Source spec:** `docs/superpowers/specs/2026-05-29-project-bootstrap-export-v2-design.md`

---

## Scope Note (read before starting)

This plan covers four loosely-coupled subsystems. Each **Phase** is independently shippable, testable, and mergeable on its own:

- **Phase 1 — Bootstrap standard flow** (spec §2 goals 1–3, §15 criteria 1, 2, 7). Foundation; ship first.
- **Phase 2 — Export V2 categorized pack** (spec §10, §15 criteria 3, 5). Depends on Phase 1.
- **Phase 3 — Import V2 + conflict-resolution fix** (spec §11, §15 criterion 4). Independent of Phase 1/2 except the manifest type from Phase 2 Task 2.1.
- **Phase 4 — `--deep` graph enrichment** (spec §12, §15 criterion 6). Depends on Phase 1.

If you prefer four separate plan files, split on these phase boundaries. Otherwise execute in order; commit at the end of every task.

**Global invariants (never break):**
- Bootstrap **never** archives deleted-file knowledge silently — it always applies additive ops and defers deletions to `.tuberosa/pending-sync.json` (`allowDestructive: false`).
- MCP stdout stays protocol-only — no `console.log` in any `src/mcp/**` path (this plan touches none).
- Do **not** change retrieval ranking, classifier, fusion, reranking, context-pack, or context-fit logic. `pnpm run eval:retrieval` is therefore **not** required for this plan, but `pnpm test` and `pnpm run build` must stay green.

**Node version:** if your shell is on an older Node, prefix every command with
`PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH`.

---

## File Structure

**Phase 1 — Bootstrap**
- Create `src/bootstrap/types.ts` — `BootstrapHealth`, `BootstrapReport`, `BootstrapRunArgs`.
- Create `src/bootstrap/health.ts` — `buildBootstrapHealthSummary` (reads store primitives directly; reuses `buildSourceHealth`).
- Create `src/bootstrap/service.ts` — `BootstrapService.run`.
- Create `bin/commands/bootstrap.ts` — CLI command (parse args, call service, render).
- Create `bin/commands/bootstrap-factory.ts` — wire store/models/ingestion/sync/atlas/maintenance.
- Modify `bin/commands/types.ts` — add `'bootstrap'` to `CliInvocation['command']`.
- Modify `bin/commands/parser.ts` — recognize `bootstrap` + update usage text.
- Modify `bin/tuberosa.ts` — dispatch `bootstrap`.
- Create tests: `test/bootstrap-health.test.ts`, `test/bootstrap-service.test.ts`, `test/bootstrap-cli.test.ts`.

**Phase 2 — Export V2**
- Modify `src/types/export-bundle.ts` — add optional V2 manifest fields.
- Create `src/export/bootstrap-pack.ts` — `slugifyAreaKey`, `exportBootstrapPack`.
- Modify `src/bootstrap/service.ts` — wire `--export` into `run`.
- Modify `src/bootstrap/types.ts` — already has `export?` field (defined in Phase 1).
- Modify `bin/commands/bootstrap.ts` + `bin/commands/bootstrap-factory.ts` — pass `exportBaseDir` + flags.
- Create tests: `test/bootstrap-export-v2.test.ts`.

**Phase 3 — Import V2 + conflict fix**
- Modify `src/types/atoms.ts` — extend `KnowledgeAtomPatch` with content fields.
- Modify `src/storage/postgres-store.ts` — `updateAtom` SET branches + conflict-resolution content fix.
- Modify `src/storage/memory-store.ts` — conflict-resolution content fix (updateAtom already spreads).
- Create `src/storage/atom-import-patch.ts` — `importedSnapshotToPatch` (shared by both stores).
- Modify `src/export/importer.ts` — categorized reader + `listAreaFiles`.
- Create tests: `test/bootstrap-import-v2.test.ts`, extend `test/export-importer-conflicts.test.ts` semantics in a new file `test/atom-conflict-content.test.ts`.

**Phase 4 — Deep mode**
- Modify `src/bootstrap/service.ts` — `runDeep` + deep branch in `run`.
- Modify `src/bootstrap/types.ts` — `deep?` already defined in Phase 1.
- Modify `bin/commands/bootstrap.ts` — already forwards `--deep` (Phase 1 wires the flag; Phase 4 makes it do work).
- Create tests: `test/bootstrap-deep.test.ts`.

---

# Phase 1 — Bootstrap Standard Flow

## Task 1.1: Bootstrap types

**Files:**
- Create: `src/bootstrap/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
import type { SourceFileStatus, SyncPlan, ApplyResult } from '../source-sync/types.js';
import type { AtomGraphDensity } from '../operations/atom-graph-density.js';

/** Focused first-run health snapshot, read directly from store primitives. */
export interface BootstrapHealth {
  sourceCounts: Record<SourceFileStatus, number>;
  tombstones: number;
  openImportConflicts: number;
  maintenanceItems: number;
  gaps: number;
}

export interface BootstrapRunArgs {
  project: string;
  repoPath: string;
  /** ISO timestamp; injected so the service stays deterministic in tests. */
  generatedAt: string;
  export?: boolean;
  deep?: boolean;
  /** Optional explicit output dir for `--export`; resolved safely against exportBaseDir. */
  out?: string;
}

export interface BootstrapReport {
  project: string;
  repoPath: string;
  sync: { planId: string; summary: SyncPlan['summary']; applied: ApplyResult };
  atlas?: { inputHash: string; files: { name: string; bytes: number }[] };
  health: BootstrapHealth;
  deep?: {
    coChangeEdgesEmitted?: number;
    graphDensity?: AtomGraphDensity;
    warnings: string[];
  };
  export?: {
    out: string;
    atoms: number;
    knowledge: number;
    edges: number;
    chunks: number;
    areas: number;
  };
  warnings: string[];
  nextActions: string[];
}
```

- [ ] **Step 2: Verify it compiles**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Expected: PASS (no TS errors). `AtomGraphDensity` is exported from `src/operations/atom-graph-density.ts:9`; `SourceFileStatus`/`SyncPlan`/`ApplyResult` from `src/source-sync/types.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/bootstrap/types.ts
git commit -m "feat(bootstrap): add BootstrapReport/BootstrapHealth types"
```

---

## Task 1.2: Health summary helper

**Files:**
- Create: `src/bootstrap/health.ts`
- Test: `test/bootstrap-health.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MaintenanceService } from '../src/maintenance/service.js';
import { buildBootstrapHealthSummary } from '../src/bootstrap/health.js';

test('buildBootstrapHealthSummary: counts sources, conflicts, gaps', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/a.ts', contentHash: 'h1' });
  await store.upsertSourceFile({ project: 'p', path: 'src/b.ts', contentHash: 'h2' });

  const health = await buildBootstrapHealthSummary(
    { store, maintenance: new MaintenanceService(store) },
    { project: 'p' },
  );

  assert.equal(health.sourceCounts.tracked, 2);
  assert.equal(health.openImportConflicts, 0);
  assert.equal(health.gaps, 0);
  assert.equal(typeof health.maintenanceItems, 'number');
});

test('buildBootstrapHealthSummary: maintenance is optional', async () => {
  const store = new MemoryKnowledgeStore();
  const health = await buildBootstrapHealthSummary({ store }, { project: 'p' });
  assert.equal(health.maintenanceItems, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/bootstrap-health.test.ts`
Expected: FAIL — cannot find module `../src/bootstrap/health.js`.

(Note: `upsertSourceFile` defaults new rows to status `tracked` — see `MemoryKnowledgeStore`. If the helper signature differs at runtime, adjust the seed call, not the assertion.)

- [ ] **Step 3: Write the implementation**

```typescript
import type { KnowledgeStore } from '../storage/store.js';
import type { MaintenanceService } from '../maintenance/service.js';
import { buildSourceHealth } from '../operations/workbench-summary.js';
import type { BootstrapHealth } from './types.js';

export interface HealthDeps {
  store: KnowledgeStore;
  /** Optional — when omitted, maintenanceItems is 0 (matches workbench behavior). */
  maintenance?: Pick<MaintenanceService, 'propose'>;
}

export async function buildBootstrapHealthSummary(
  deps: HealthDeps,
  options: { project: string },
): Promise<BootstrapHealth> {
  const sourceHealth = await buildSourceHealth(deps.store, { project: options.project, limit: 100_000 });
  const conflicts = await deps.store.listAtomImportConflicts({
    project: options.project,
    status: 'open',
    limit: 1000,
  });
  const gaps = await deps.store.listKnowledgeGaps({ project: options.project, limit: 1000 });

  let maintenanceItems = 0;
  if (deps.maintenance) {
    const batch = await deps.maintenance.propose({ project: options.project });
    maintenanceItems = batch.items.length;
  }

  return {
    sourceCounts: sourceHealth.counts,
    tombstones: sourceHealth.tombstones.length,
    openImportConflicts: conflicts.length,
    maintenanceItems,
    gaps: gaps.length,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/bootstrap-health.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/health.ts test/bootstrap-health.test.ts
git commit -m "feat(bootstrap): focused health summary helper"
```

---

## Task 1.3: BootstrapService standard flow

**Files:**
- Create: `src/bootstrap/service.ts`
- Test: `test/bootstrap-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/hash-provider.js';
import { KnowledgeSafetyService } from '../src/security/knowledge-safety.js';
import { IngestionService } from '../src/ingest/service.js';
import { SourceSyncService } from '../src/source-sync/service.js';
import { AtlasService } from '../src/atlas/service.js';
import { MaintenanceService } from '../src/maintenance/service.js';
import { BootstrapService } from '../src/bootstrap/service.js';

async function fixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bootstrap-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(dir, 'README.md'), '# Title\n\nProse.\n', 'utf8');
  return dir;
}

function makeService(store: MemoryKnowledgeStore, atlasDir: string): BootstrapService {
  const models = new HashModelProvider();
  const ingestion = new IngestionService(store, models, { safety: new KnowledgeSafetyService() });
  const atlas = new AtlasService(store, { atlasDir });
  // atlasAutoRegen:false — BootstrapService regenerates the atlas explicitly.
  const sync = new SourceSyncService({ store, ingestion, atlasAutoRegen: false });
  return new BootstrapService({ store, sync, atlas, maintenance: new MaintenanceService(store), exportBaseDir: atlasDir });
}

test('BootstrapService.run: applies additive sync and regenerates atlas', async () => {
  const repo = await fixtureRepo();
  const store = new MemoryKnowledgeStore();
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-'));
  const service = makeService(store, atlasDir);

  const report = await service.run({ project: 'p', repoPath: repo, generatedAt: '2026-05-29T00:00:00.000Z' });

  assert.ok(report.sync.applied.ingested >= 2, 'ingests added files');
  assert.equal(report.sync.applied.deferredDeletions.length, 0);
  assert.ok(report.atlas, 'atlas present');
  assert.equal(report.atlas?.files.length, 5);
  assert.equal(report.health.sourceCounts.tracked >= 2, true);
  assert.ok(report.nextActions.length >= 1);
  assert.equal(report.export, undefined, 'no export without --export');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/bootstrap-service.test.ts`
Expected: FAIL — cannot find module `../src/bootstrap/service.js`.

(If `HashModelProvider` import path differs, confirm with `grep -rn "class HashModelProvider" src/model/`. The provider used in all tests is the hash provider.)

- [ ] **Step 3: Write the implementation**

```typescript
import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { SourceSyncService } from '../source-sync/service.js';
import type { AtlasService } from '../atlas/service.js';
import type { MaintenanceService } from '../maintenance/service.js';
import type { ApplyResult } from '../source-sync/types.js';
import { assertSafeBundlePath } from '../security/safe-paths.js';
import { buildBootstrapHealthSummary } from './health.js';
import type { BootstrapHealth, BootstrapReport, BootstrapRunArgs } from './types.js';

export interface BootstrapServiceDeps {
  store: KnowledgeStore;
  sync: Pick<SourceSyncService, 'sync' | 'apply'>;
  atlas: Pick<AtlasService, 'regenerate'>;
  maintenance?: Pick<MaintenanceService, 'propose'>;
  /** Base dir for `--export` output; default `.tuberosa/exports`. */
  exportBaseDir: string;
}

const EMPTY_HEALTH: BootstrapHealth = {
  sourceCounts: { tracked: 0, changed: 0, missing: 0, archived: 0, ignored: 0 },
  tombstones: 0,
  openImportConflicts: 0,
  maintenanceItems: 0,
  gaps: 0,
};

export class BootstrapService {
  constructor(private readonly deps: BootstrapServiceDeps) {}

  async run(args: BootstrapRunArgs): Promise<BootstrapReport> {
    const warnings: string[] = [];

    // 1–3. Source sync, then apply additive ops only. Deletions are deferred —
    // bootstrap NEVER archives silently (allowDestructive:false).
    const { planId, plan } = await this.deps.sync.sync({
      project: args.project,
      repoPath: args.repoPath,
      trigger: 'cli',
    });
    const applied = await this.deps.sync.apply({ planId, allowDestructive: false });

    // 4. Atlas regeneration (non-fatal after sync succeeds).
    let atlas: BootstrapReport['atlas'];
    try {
      const result = await this.deps.atlas.regenerate({
        project: args.project,
        repoPath: args.repoPath,
        generatedAt: args.generatedAt,
        write: true,
      });
      atlas = { inputHash: result.inputHash, files: result.files };
    } catch (err) {
      warnings.push(`atlas regeneration failed (non-fatal): ${(err as Error).message}`);
    }

    // 5. Health summary (non-fatal).
    let health: BootstrapHealth = EMPTY_HEALTH;
    try {
      health = await buildBootstrapHealthSummary(
        { store: this.deps.store, maintenance: this.deps.maintenance },
        { project: args.project },
      );
    } catch (err) {
      warnings.push(`health summary failed (non-fatal): ${(err as Error).message}`);
    }

    const nextActions = this.buildNextActions(args, applied, health);

    return {
      project: args.project,
      repoPath: args.repoPath,
      sync: { planId, summary: plan.summary, applied },
      atlas,
      health,
      warnings,
      nextActions,
    };
  }

  private buildNextActions(args: BootstrapRunArgs, applied: ApplyResult, health: BootstrapHealth): string[] {
    const actions: string[] = [];
    if (applied.deferredDeletions.length > 0) {
      actions.push(
        `Review ${applied.deferredDeletions.length} deferred deletion(s) in ${join(args.repoPath, '.tuberosa', 'pending-sync.json')}, then archive with \`tuberosa sync --apply --yes\`.`,
      );
    }
    if (health.openImportConflicts > 0) {
      actions.push(`Resolve ${health.openImportConflicts} open import conflict(s) before relying on imported knowledge.`);
    }
    if (health.gaps > 0) {
      actions.push('Fill knowledge gaps surfaced in .tuberosa/atlas/open-gaps.md.');
    }
    if (actions.length === 0) {
      actions.push('Bootstrap complete. Use `tuberosa atlas` or start an agent session to consume project knowledge.');
    }
    return actions;
  }

  /** Resolve a safe export output dir against exportBaseDir (reused by Phase 2). */
  protected async resolveExportOut(args: BootstrapRunArgs): Promise<string> {
    const candidate = args.out ?? `${args.project}-bootstrap`;
    return assertSafeBundlePath(this.deps.exportBaseDir, candidate);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/bootstrap-service.test.ts`
Expected: PASS (1 test). `report.atlas.files.length === 5` (five atlas builders).

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap/service.ts test/bootstrap-service.test.ts
git commit -m "feat(bootstrap): BootstrapService standard flow (sync+atlas+health)"
```

---

## Task 1.4: CLI command, parser, dispatch, factory

**Files:**
- Modify: `bin/commands/types.ts:55` (CliInvocation union)
- Modify: `bin/commands/parser.ts:48-58` (command whitelist) and `bin/commands/parser.ts:68-97` (usage)
- Create: `bin/commands/bootstrap.ts`
- Create: `bin/commands/bootstrap-factory.ts`
- Modify: `bin/tuberosa.ts`
- Test: `test/bootstrap-cli.test.ts`

- [ ] **Step 1: Add `'bootstrap'` to the command union**

In `bin/commands/types.ts`, change:

```typescript
export interface CliInvocation {
  command: 'init' | 'doctor' | 'mcp' | 'sync' | 'hook' | 'atlas' | 'help';
  options: Record<string, string | boolean>;
  positional: string[];
}
```

to:

```typescript
export interface CliInvocation {
  command: 'init' | 'doctor' | 'mcp' | 'sync' | 'hook' | 'atlas' | 'bootstrap' | 'help';
  options: Record<string, string | boolean>;
  positional: string[];
}
```

- [ ] **Step 2: Recognize `bootstrap` in the parser**

In `bin/commands/parser.ts`, change the command-resolution condition:

```typescript
      if (
        token === 'init' || token === 'doctor' || token === 'mcp'
        || token === 'sync' || token === 'hook' || token === 'atlas' || token === 'help'
      ) {
```

to:

```typescript
      if (
        token === 'init' || token === 'doctor' || token === 'mcp'
        || token === 'sync' || token === 'hook' || token === 'atlas'
        || token === 'bootstrap' || token === 'help'
      ) {
```

And add a usage line. In the `Commands:` block of `usage()`, after the `atlas` line add (note: there is no `atlas` line today — insert after `hook`):

```typescript
    '  bootstrap First-run project knowledge: sync (additive) + atlas + health summary, optional --export / --deep.',
```

- [ ] **Step 3: Write the failing CLI test**

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { bootstrapCommand } from '../bin/commands/bootstrap.js';
import type { BootstrapServiceLike } from '../bin/commands/bootstrap.js';
import type { CliInvocation, CommandIo } from '../bin/commands/types.js';
import type { BootstrapReport } from '../src/bootstrap/types.js';

function fakeIo(over: Partial<CommandIo> = {}): CommandIo & { lines: string[] } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(`ERR:${l}`), cwd: process.cwd(), env: {}, ...over };
}

const REPORT: BootstrapReport = {
  project: 'p',
  repoPath: '/repo',
  sync: { planId: 'plan1', summary: { added: 2, changed: 0, renamed: 0, deleted: 0, ignored: 0 }, applied: { ingested: 2, reingested: 0, repointed: 0, archived: 0, skipped: [], deferredDeletions: [] } },
  atlas: { inputHash: 'sha256:abc', files: [{ name: 'project-map.md', bytes: 10 }] },
  health: { sourceCounts: { tracked: 2, changed: 0, missing: 0, archived: 0, ignored: 0 }, tombstones: 0, openImportConflicts: 0, maintenanceItems: 0, gaps: 0 },
  warnings: [],
  nextActions: ['Bootstrap complete.'],
};

test('bootstrapCommand: --json prints the report', async () => {
  const io = fakeIo();
  const inv: CliInvocation = { command: 'bootstrap', options: { project: 'p', json: true }, positional: [] };
  const service: BootstrapServiceLike = { run: async () => REPORT };
  const code = await bootstrapCommand(inv, io, { makeService: async () => service });
  assert.equal(code.exitCode, 0);
  const out = JSON.parse(io.lines.join('\n')) as BootstrapReport;
  assert.equal(out.project, 'p');
  assert.equal(out.sync.summary.added, 2);
});

test('bootstrapCommand: requires --project', async () => {
  const io = fakeIo();
  const inv: CliInvocation = { command: 'bootstrap', options: {}, positional: [] };
  const code = await bootstrapCommand(inv, io, { makeService: async () => { throw new Error('should not build'); } });
  assert.equal(code.exitCode, 1);
  assert.ok(io.lines.some((l) => l.includes('--project')));
});

test('bootstrapCommand: prose render names deferred deletions next action', async () => {
  const io = fakeIo();
  const withDefer: BootstrapReport = { ...REPORT, nextActions: ['Review 1 deferred deletion(s) in /repo/.tuberosa/pending-sync.json, then archive with `tuberosa sync --apply --yes`.'] };
  const inv: CliInvocation = { command: 'bootstrap', options: { project: 'p' }, positional: [] };
  const code = await bootstrapCommand(inv, io, { makeService: async () => ({ run: async () => withDefer }) });
  assert.equal(code.exitCode, 0);
  assert.ok(io.lines.some((l) => l.includes('pending-sync.json')));
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test --import tsx test/bootstrap-cli.test.ts`
Expected: FAIL — cannot find module `../bin/commands/bootstrap.js`.

- [ ] **Step 5: Write the command**

Create `bin/commands/bootstrap.ts`:

```typescript
import type { CliInvocation, CommandIo, CommandResult } from './types.js';
import type { BootstrapService } from '../../src/bootstrap/service.js';
import type { BootstrapReport } from '../../src/bootstrap/types.js';

/** The subset of BootstrapService the command needs — injectable for tests. */
export type BootstrapServiceLike = Pick<BootstrapService, 'run'>;

export interface BootstrapCommandDeps {
  makeService: (project: string, repoPath: string) => Promise<BootstrapServiceLike>;
}

function renderReport(report: BootstrapReport): string[] {
  const lines: string[] = [];
  const s = report.sync.summary;
  lines.push(`Bootstrap for ${report.project}:`);
  lines.push(`  sync: added ${s.added}, changed ${s.changed}, renamed ${s.renamed}, deleted ${s.deleted}, ignored ${s.ignored}`);
  lines.push(`  applied: ingested ${report.sync.applied.ingested}, reingested ${report.sync.applied.reingested}, repointed ${report.sync.applied.repointed}, archived ${report.sync.applied.archived}`);
  if (report.atlas) lines.push(`  atlas: ${report.atlas.files.length} files (input ${report.atlas.inputHash.replace(/^sha256:/, '').slice(0, 8)})`);
  const h = report.health;
  lines.push(`  health: ${h.sourceCounts.tracked} tracked, ${h.tombstones} tombstones, ${h.openImportConflicts} open conflicts, ${h.maintenanceItems} maintenance, ${h.gaps} gaps`);
  if (report.deep) lines.push(`  deep: ${report.deep.coChangeEdgesEmitted ?? 0} co-change edges, ${report.deep.graphDensity?.edgesPerAtom?.toFixed(2) ?? 'n/a'} edges/atom`);
  if (report.export) lines.push(`  export: ${report.export.out} (${report.export.areas} areas, ${report.export.atoms} atoms, ${report.export.knowledge} knowledge)`);
  for (const w of report.warnings) lines.push(`  warning: ${w}`);
  lines.push('Next actions:');
  for (const a of report.nextActions) lines.push(`  - ${a}`);
  return lines;
}

export async function bootstrapCommand(
  invocation: CliInvocation,
  io: CommandIo,
  deps: BootstrapCommandDeps,
): Promise<CommandResult> {
  const project = typeof invocation.options.project === 'string' ? invocation.options.project : '';
  if (!project) {
    io.err('tuberosa bootstrap requires --project <name>');
    return { exitCode: 1 };
  }
  const repoPath = typeof invocation.options.path === 'string' ? invocation.options.path : io.cwd;
  const asJson = invocation.options.json === true;
  const wantExport = invocation.options.export === true;
  const deep = invocation.options.deep === true;
  const out = typeof invocation.options.out === 'string' ? invocation.options.out : undefined;

  const service = await deps.makeService(project, repoPath);
  const report = await service.run({
    project,
    repoPath,
    generatedAt: new Date().toISOString(),
    export: wantExport,
    deep,
    out,
  });

  if (asJson) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    for (const line of renderReport(report)) io.out(line);
  }
  return { exitCode: 0 };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test --import tsx test/bootstrap-cli.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Write the factory**

Create `bin/commands/bootstrap-factory.ts`:

```typescript
import { loadConfig } from '../../src/config.js';
import { createKnowledgeStore } from '../../src/storage/factory.js';
import { createModelProvider } from '../../src/model/factory.js';
import { KnowledgeSafetyService } from '../../src/security/knowledge-safety.js';
import { IngestionService } from '../../src/ingest/service.js';
import { SourceSyncService } from '../../src/source-sync/service.js';
import { AtlasService } from '../../src/atlas/service.js';
import { MaintenanceService } from '../../src/maintenance/service.js';
import { BootstrapService } from '../../src/bootstrap/service.js';
import type { BootstrapServiceLike } from './bootstrap.js';

/**
 * Build a fully-wired BootstrapService from config. The sync service is built
 * with atlasAutoRegen:false because BootstrapService regenerates the atlas
 * explicitly (and, in --deep mode, after graph enrichment).
 */
export async function makeBootstrapService(): Promise<BootstrapServiceLike> {
  const config = loadConfig();
  const store = createKnowledgeStore(config);
  const models = createModelProvider(config);
  const safety = new KnowledgeSafetyService();
  const ingestion = new IngestionService(store, models, {
    safety,
    maxContentBytes: config.maxIngestContentBytes,
  });
  const atlas = new AtlasService(store, { atlasDir: config.atlasDir ?? '.tuberosa/atlas' });
  const sync = new SourceSyncService({ store, ingestion, atlasAutoRegen: false });
  return new BootstrapService({
    store,
    sync,
    atlas,
    maintenance: new MaintenanceService(store),
    exportBaseDir: config.exportBaseDir,
  });
}
```

- [ ] **Step 8: Dispatch the command**

In `bin/tuberosa.ts`, add imports after the atlas imports (lines 9–10):

```typescript
import { bootstrapCommand } from './commands/bootstrap.js';
import { makeBootstrapService } from './commands/bootstrap-factory.js';
```

And add a case in `dispatch` after the `atlas` case (line 41):

```typescript
    case 'bootstrap':
      return bootstrapCommand(invocation, io, { makeService: () => makeBootstrapService() });
```

- [ ] **Step 9: Build + run the full suite**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test`
Expected: PASS — build clean; all tests green including the three new bootstrap test files.

- [ ] **Step 10: Commit**

```bash
git add bin/commands/types.ts bin/commands/parser.ts bin/commands/bootstrap.ts bin/commands/bootstrap-factory.ts bin/tuberosa.ts test/bootstrap-cli.test.ts
git commit -m "feat(bootstrap): tuberosa bootstrap CLI command + factory + dispatch"
```

---

# Phase 2 — Export V2 Categorized Pack

## Task 2.1: Manifest V2 additions

**Files:**
- Modify: `src/types/export-bundle.ts:18-32` (BundleManifest)

- [ ] **Step 1: Extend the manifest interface**

In `src/types/export-bundle.ts`, append these optional fields to `BundleManifest` (after `userStyleScopes?`):

```typescript
  /** Export V2 — present only on categorized packs; absent/`'flat'` means legacy flat layout. */
  layout?: 'flat' | 'categorized-v2';
  /** Export V2 — per-area counts for human orientation. */
  areas?: Array<{ key: string; label: string; atomCount: number; knowledgeCount: number }>;
  /** Export V2 — atlas files copied alongside the pack. */
  atlas?: { files: Array<{ name: string; bytes: number }>; inputHash?: string };
  /** Export V2 — health snapshot at export time. */
  healthSummary?: {
    sourceCounts: Record<string, number>;
    openImportConflicts: number;
    maintenanceItems: number;
    gaps: number;
  };
```

(Named `healthSummary` not `health` to avoid colliding with any future top-level `health`; the spec text §221 is satisfied by an additive field.)

- [ ] **Step 2: Verify build**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build`
Expected: PASS. `readManifest` still requires `schemaVersion === 2`; V2 packs keep `schemaVersion: 2` and add `layout`.

- [ ] **Step 3: Commit**

```bash
git add src/types/export-bundle.ts
git commit -m "feat(export): add optional Export V2 manifest fields"
```

---

## Task 2.2: Categorized export writer

**Files:**
- Create: `src/export/bootstrap-pack.ts`
- Test: `test/bootstrap-export-v2.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { exportBootstrapPack, slugifyAreaKey } from '../src/export/bootstrap-pack.js';
import type { BootstrapHealth } from '../src/bootstrap/types.js';

const HEALTH: BootstrapHealth = {
  sourceCounts: { tracked: 1, changed: 0, missing: 0, archived: 0, ignored: 0 },
  tombstones: 0, openImportConflicts: 0, maintenanceItems: 0, gaps: 0,
};

test('slugifyAreaKey: path keys become safe slugs', () => {
  assert.equal(slugifyAreaKey('src/retrieval'), 'src-retrieval');
  assert.equal(slugifyAreaKey('_unassigned'), '_unassigned');
  assert.equal(slugifyAreaKey('_root'), '_root');
});

test('exportBootstrapPack: writes two-layer categorized bundle', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/service.ts', contentHash: 'h' });
  await store.createAtom({
    project: 'p', claim: 'Fusion is weighted RRF.', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/retrieval/service.ts' }],
    trigger: { files: ['src/retrieval/service.ts'] }, producedBy: 'user',
  });

  const out = await mkdtemp(join(tmpdir(), 'v2-'));
  const report = await exportBootstrapPack(store, {
    project: 'p',
    out,
    atlasContents: [{ name: 'project-map.md', content: '# Map\n' }],
    atlasInputHash: 'sha256:deadbeef',
    health: HEALTH,
  });

  // Human layer
  const startHere = await readFile(join(out, 'START-HERE.md'), 'utf8');
  assert.ok(startHere.includes('p'), 'START-HERE names the project');
  await readFile(join(out, 'atlas', 'project-map.md'), 'utf8');
  await readFile(join(out, 'health', 'summary.md'), 'utf8');

  // Machine layer
  const manifest = JSON.parse(await readFile(join(out, 'pack', 'manifest.json'), 'utf8'));
  assert.equal(manifest.layout, 'categorized-v2');
  assert.equal(manifest.schemaVersion, 2);
  assert.ok(Array.isArray(manifest.areas));
  const areaDirs = await readdir(join(out, 'pack', 'areas'));
  assert.ok(areaDirs.includes('src-retrieval'), 'atom routed to its area slug');
  const atomFiles = await readdir(join(out, 'pack', 'areas', 'src-retrieval', 'atoms'));
  assert.equal(atomFiles.length, 1);
  assert.equal(report.atoms, 1);
  assert.equal(report.areas >= 1, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/bootstrap-export-v2.test.ts`
Expected: FAIL — cannot find module `../src/export/bootstrap-pack.js`.

- [ ] **Step 3: Write the implementation**

```typescript
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';
import type { StoredKnowledge } from '../types.js';
import type { BundleManifest, BundleEdge } from '../types/export-bundle.js';
import type { BootstrapHealth } from '../bootstrap/types.js';
import type { AtomGraphDensity } from '../operations/atom-graph-density.js';
import { serializeAtom } from './atom-codec.js';
import { serializeKnowledge } from './knowledge-codec.js';
import { serializeEdges } from './edges-codec.js';
import { sha256OfBuffer, writeManifest, SCHEMA_VERSION } from './manifest.js';
import { README_TEMPLATE } from './readme-template.js';
import { buildAreaModel } from '../knowledge-areas/area-model.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';

export interface ExportBootstrapPackOptions {
  project: string;
  out: string;
  atlasContents: { name: string; content: string }[];
  atlasInputHash?: string;
  health: BootstrapHealth;
  sourceCommit?: string;
  graphDensity?: AtomGraphDensity;
  includeArchived?: boolean;
  includeChunks?: boolean;
}

export interface ExportBootstrapPackReport {
  out: string;
  atoms: number;
  knowledge: number;
  edges: number;
  chunks: number;
  areas: number;
}

const EXPORTED_KNOWLEDGE_TYPES = new Set(['wiki', 'spec', 'code_ref', 'workflow', 'rule', 'conversation']);

/** Map an area key (e.g. "src/retrieval") to a filesystem-safe slug. */
export function slugifyAreaKey(key: string): string {
  const slug = key.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : '_unassigned';
}

export async function exportBootstrapPack(
  store: KnowledgeStore,
  opts: ExportBootstrapPackOptions,
): Promise<ExportBootstrapPackReport> {
  const safety = new KnowledgeSafetyService();
  const packDir = join(opts.out, 'pack');

  // Area model → id→slug maps for routing atoms/knowledge into folders.
  const areas = await buildAreaModel(store, opts.project);
  const atomAreaSlug = new Map<string, string>();
  const knowledgeAreaSlug = new Map<string, string>();
  for (const area of areas) {
    const slug = slugifyAreaKey(area.key);
    for (const id of area.atomIds) atomAreaSlug.set(id, slug);
    for (const id of area.knowledgeIds) knowledgeAreaSlug.set(id, slug);
  }

  await mkdir(join(opts.out, 'atlas'), { recursive: true });
  await mkdir(join(opts.out, 'health'), { recursive: true });
  await mkdir(join(packDir, 'areas'), { recursive: true });

  // --- Machine layer: categorized atoms ---
  const allAtoms = await store.listAtoms({ project: opts.project, limit: 10_000 });
  const atoms = opts.includeArchived ? allAtoms : allAtoms.filter((a) => a.status === 'active');
  const perArea = new Map<string, { atoms: number; knowledge: number; label: string }>();
  const bump = (slug: string, key: 'atoms' | 'knowledge') => {
    const cur = perArea.get(slug) ?? { atoms: 0, knowledge: 0, label: slug };
    cur[key] += 1;
    perArea.set(slug, cur);
  };
  for (const atom of atoms) {
    const slug = atomAreaSlug.get(atom.id) ?? '_unassigned';
    const dir = join(packDir, 'areas', slug, 'atoms');
    await mkdir(dir, { recursive: true });
    const safe: KnowledgeAtom = { ...atom, claim: safety.redactSecrets(atom.claim) };
    const { content, filename } = serializeAtom(safe, { revision: atom.reuseCount + 1 });
    await writeFile(join(dir, filename), content, 'utf8');
    bump(slug, 'atoms');
  }

  // --- Machine layer: categorized knowledge ---
  const allKnowledge = await store.listKnowledge({ project: opts.project, limit: 10_000 });
  const knowledge = allKnowledge.filter((k) => {
    if (!EXPORTED_KNOWLEDGE_TYPES.has(k.itemType)) return false;
    if (k.status && k.status !== 'approved') return false;
    if ((k.metadata as { legacyStatus?: string } | undefined)?.legacyStatus) return false;
    return true;
  });
  for (const item of knowledge) {
    const slug = knowledgeAreaSlug.get(item.id) ?? '_unassigned';
    const dir = join(packDir, 'areas', slug, 'knowledge');
    await mkdir(dir, { recursive: true });
    const safe: StoredKnowledge = { ...item, content: safety.redactSecrets(item.content) };
    const { content, filename } = serializeKnowledge(safe);
    await writeFile(join(dir, filename), content, 'utf8');
    bump(slug, 'knowledge');
  }

  // --- Machine layer: edges (unchanged format) ---
  const atomIds = new Set(atoms.map((a) => a.id));
  const allRelations = await store.listAtomRelations({ limit: 100_000 });
  const bundleEdges: BundleEdge[] = allRelations
    .filter((r) => atomIds.has(r.fromAtomId) && atomIds.has(r.targetAtomId))
    .map((r) => ({ from: r.fromAtomId, to: r.targetAtomId, kind: r.relationType, confidence: r.confidence, inferenceSource: r.inferenceSource }));
  const edgesContent = serializeEdges(bundleEdges);
  await writeFile(join(packDir, 'edges.jsonl'), edgesContent, 'utf8');

  // --- Machine layer: chunks (unchanged format) ---
  let chunks = 0;
  if (opts.includeChunks !== false && knowledge.length > 0) {
    const chunkRecords = await store.listKnowledgeChunks(knowledge.map((k) => k.id));
    await mkdir(join(packDir, 'chunks'), { recursive: true });
    for (const chunk of chunkRecords) {
      await mkdir(join(packDir, 'chunks', chunk.knowledgeId), { recursive: true });
      await writeFile(join(packDir, 'chunks', chunk.knowledgeId, `${chunk.chunkIndex}.txt`), safety.redactSecrets(chunk.content), 'utf8');
      chunks += 1;
    }
  }

  await writeFile(join(packDir, 'README.md'), README_TEMPLATE, 'utf8');

  // --- Human layer: atlas copies ---
  for (const file of opts.atlasContents) {
    await writeFile(join(opts.out, 'atlas', file.name), file.content, 'utf8');
  }

  // --- Human layer: health ---
  await writeFile(
    join(opts.out, 'health', 'source-health.json'),
    JSON.stringify({ sourceCounts: opts.health.sourceCounts, tombstones: opts.health.tombstones }, null, 2),
    'utf8',
  );
  await writeFile(
    join(opts.out, 'health', 'maintenance-preview.json'),
    JSON.stringify({ maintenanceItems: opts.health.maintenanceItems, openImportConflicts: opts.health.openImportConflicts, gaps: opts.health.gaps }, null, 2),
    'utf8',
  );
  const areaSummaryRows = [...perArea.entries()].sort().map(([slug, c]) => `- **${slug}** — ${c.atoms} atoms, ${c.knowledge} knowledge`);
  await writeFile(
    join(opts.out, 'health', 'summary.md'),
    [
      `# Health Summary — ${opts.project}`,
      '',
      `- Tracked sources: ${opts.health.sourceCounts.tracked}`,
      `- Tombstones: ${opts.health.tombstones}`,
      `- Open import conflicts: ${opts.health.openImportConflicts}`,
      `- Maintenance items: ${opts.health.maintenanceItems}`,
      `- Knowledge gaps: ${opts.health.gaps}`,
      '',
      '## Areas',
      ...areaSummaryRows,
      '',
    ].join('\n'),
    'utf8',
  );

  // --- Human layer: START-HERE ---
  const areaList = [...perArea.entries()].sort().map(([slug, c]) => `- \`${slug}\` (${c.atoms} atoms, ${c.knowledge} knowledge)`);
  await writeFile(
    join(opts.out, 'START-HERE.md'),
    [
      `# Tuberosa Bootstrap Pack — ${opts.project}`,
      '',
      opts.sourceCommit ? `Source commit: \`${opts.sourceCommit}\`` : 'Source commit: (not available)',
      '',
      '## Quick import',
      '',
      '```bash',
      `# Point the importer at the machine pack (the pack/ subdirectory):`,
      `tuberosa import --from <this-dir>/pack --project ${opts.project}`,
      '```',
      '',
      '## Project areas',
      '',
      ...areaList,
      '',
      '## Health',
      '',
      `Tracked sources: ${opts.health.sourceCounts.tracked} · open conflicts: ${opts.health.openImportConflicts} · gaps: ${opts.health.gaps}`,
      opts.graphDensity ? `\nGraph density: ${opts.graphDensity.edgesPerAtom.toFixed(2)} edges/atom (${opts.graphDensity.edges} edges).` : '',
      '',
      'See `atlas/` for the project map and flows, `health/` for the health report, and `pack/` for the importable data.',
      '',
    ].join('\n'),
    'utf8',
  );

  // --- Manifest (in pack/, the importable root) ---
  const manifest: BundleManifest = {
    schemaVersion: SCHEMA_VERSION,
    project: opts.project,
    generated: new Date().toISOString(),
    sourceCommit: opts.sourceCommit,
    counts: { atoms: atoms.length, knowledge: knowledge.length, edges: bundleEdges.length, chunks },
    integrity: { 'edges.jsonl': sha256OfBuffer(edgesContent) },
    tierPolicy: {
      exportedTiers: ['draft', 'verified', 'canonical'],
      excludedStatuses: opts.includeArchived ? [] : ['archived', 'legacy_archived', 'superseded'],
    },
    includesChunks: opts.includeChunks !== false,
    safetyRedactionVersion: '1',
    layout: 'categorized-v2',
    areas: [...perArea.entries()].sort().map(([slug, c]) => ({ key: slug, label: c.label, atomCount: c.atoms, knowledgeCount: c.knowledge })),
    atlas: { files: opts.atlasContents.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.content, 'utf8') })), inputHash: opts.atlasInputHash },
    healthSummary: {
      sourceCounts: opts.health.sourceCounts,
      openImportConflicts: opts.health.openImportConflicts,
      maintenanceItems: opts.health.maintenanceItems,
      gaps: opts.health.gaps,
    },
  };
  await writeManifest(join(packDir, 'manifest.json'), manifest);

  return { out: opts.out, atoms: atoms.length, knowledge: knowledge.length, edges: bundleEdges.length, chunks, areas: perArea.size };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/bootstrap-export-v2.test.ts`
Expected: PASS (2 tests). If `serializeAtom`/`serializeKnowledge` import names differ, confirm with `grep -n "export function serialize" src/export/atom-codec.ts src/export/knowledge-codec.ts` (both are exported — see `src/export/exporter.ts:7-8`).

- [ ] **Step 5: Commit**

```bash
git add src/export/bootstrap-pack.ts test/bootstrap-export-v2.test.ts
git commit -m "feat(export): categorized Export V2 two-layer pack writer"
```

---

## Task 2.3: Wire `--export` into BootstrapService

**Files:**
- Modify: `src/bootstrap/service.ts`
- Test: extend `test/bootstrap-service.test.ts`

- [ ] **Step 1: Write the failing test (append to `test/bootstrap-service.test.ts`)**

```typescript
test('BootstrapService.run: --export writes a two-layer pack', async () => {
  const repo = await fixtureRepo();
  const store = new MemoryKnowledgeStore();
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-'));
  const service = makeService(store, atlasDir);

  const report = await service.run({
    project: 'p',
    repoPath: repo,
    generatedAt: '2026-05-29T00:00:00.000Z',
    export: true,
  });

  assert.ok(report.export, 'export present');
  assert.ok(report.export!.out.endsWith('p-bootstrap'));
  // Bundle files exist
  await (await import('node:fs/promises')).readFile(join(report.export!.out, 'START-HERE.md'), 'utf8');
  await (await import('node:fs/promises')).readFile(join(report.export!.out, 'pack', 'manifest.json'), 'utf8');
});

test('BootstrapService.run: --export rejects unsafe --out', async () => {
  const repo = await fixtureRepo();
  const store = new MemoryKnowledgeStore();
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-'));
  const service = makeService(store, atlasDir);

  await assert.rejects(
    () => service.run({ project: 'p', repoPath: repo, generatedAt: '2026-05-29T00:00:00.000Z', export: true, out: '../../etc/evil' }),
    /.*/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/bootstrap-service.test.ts`
Expected: FAIL — `report.export` is `undefined` (export not wired yet).

- [ ] **Step 3: Wire export into `run`**

In `src/bootstrap/service.ts`, add the import:

```typescript
import { exportBootstrapPack } from '../export/bootstrap-pack.js';
```

Change the atlas block to also capture `contents` (needed for the export atlas layer). Replace:

```typescript
    let atlas: BootstrapReport['atlas'];
    try {
      const result = await this.deps.atlas.regenerate({
        project: args.project,
        repoPath: args.repoPath,
        generatedAt: args.generatedAt,
        write: true,
      });
      atlas = { inputHash: result.inputHash, files: result.files };
    } catch (err) {
      warnings.push(`atlas regeneration failed (non-fatal): ${(err as Error).message}`);
    }
```

with:

```typescript
    let atlas: BootstrapReport['atlas'];
    let atlasContents: { name: string; content: string }[] = [];
    let atlasInputHash: string | undefined;
    try {
      const result = await this.deps.atlas.regenerate({
        project: args.project,
        repoPath: args.repoPath,
        generatedAt: args.generatedAt,
        write: true,
      });
      atlas = { inputHash: result.inputHash, files: result.files };
      atlasContents = result.contents;
      atlasInputHash = result.inputHash;
    } catch (err) {
      warnings.push(`atlas regeneration failed (non-fatal): ${(err as Error).message}`);
    }
```

Then, after the health block and before `const nextActions = ...`, insert the export step:

```typescript
    // 6. Optional Export V2. Unlike atlas/health, a requested export that fails
    //    FAILS the bootstrap (the user explicitly asked for it — spec §9).
    let exportResult: BootstrapReport['export'];
    if (args.export) {
      const out = await this.resolveExportOut(args);
      const report = await exportBootstrapPack(this.deps.store, {
        project: args.project,
        out,
        atlasContents,
        atlasInputHash,
        health,
      });
      exportResult = {
        out: report.out,
        atoms: report.atoms,
        knowledge: report.knowledge,
        edges: report.edges,
        chunks: report.chunks,
        areas: report.areas,
      };
    }
```

Finally add `export: exportResult,` to the returned object (after `health,`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/bootstrap-service.test.ts`
Expected: PASS (now 3 tests). The unsafe-`--out` test passes because `assertSafeBundlePath` (used by `resolveExportOut`) rejects parent-escaping candidates — the same guard the HTTP export endpoint uses (`src/http/server.ts:620-621`).

- [ ] **Step 5: Build + full suite + commit**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
git add src/bootstrap/service.ts test/bootstrap-service.test.ts
git commit -m "feat(bootstrap): wire --export to Export V2 pack"
```

---

# Phase 3 — Import V2 + Conflict-Resolution Content Fix

## Task 3.1: Extend `KnowledgeAtomPatch` + `updateAtom`

**Files:**
- Modify: `src/types/atoms.ts:111-119` (KnowledgeAtomPatch)
- Modify: `src/storage/postgres-store.ts` (updateAtom)
- Test: `test/atom-patch-content.test.ts`

> **Impact note (GitNexus):** `updateAtom` is widely called. The change is **purely additive** — new optional patch fields applied only when present. Run `gitnexus_impact({target: "updateAtom", direction: "upstream"})` and report the blast radius before editing. Existing callers pass only the old fields, so behavior is unchanged for them.

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('updateAtom: applies content fields (claim/type/evidence/trigger)', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.createAtom({
    project: 'p', claim: 'old claim', type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }], trigger: { files: ['a.ts'] }, producedBy: 'user',
  });

  const updated = await store.updateAtom(created.id, {
    claim: 'new claim',
    type: 'gotcha',
    evidence: [{ kind: 'file', path: 'b.ts' }],
    trigger: { files: ['b.ts'] },
  });

  assert.equal(updated?.claim, 'new claim');
  assert.equal(updated?.type, 'gotcha');
  assert.equal(updated?.evidence[0]?.kind === 'file' && updated.evidence[0].path, 'b.ts');
  assert.deepEqual(updated?.trigger.files, ['b.ts']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atom-patch-content.test.ts`
Expected: FAIL — `KnowledgeAtomPatch` does not accept `claim`/`type`/`evidence`/`trigger` (TS compile error inside the test).

- [ ] **Step 3: Extend the patch type**

In `src/types/atoms.ts`, replace the `KnowledgeAtomPatch` interface:

```typescript
export interface KnowledgeAtomPatch {
  tier?: AtomTier;
  status?: AtomStatus;
  reuseCount?: number;
  lastReusedAt?: string;
  verification?: Verification;
  pitfalls?: string[];
  links?: AtomLink[];
}
```

with:

```typescript
export interface KnowledgeAtomPatch {
  /** Export V2 — content fields, updated only on conflict take_imported / merged. */
  claim?: string;
  type?: AtomType;
  evidence?: Evidence[];
  trigger?: Trigger;
  tier?: AtomTier;
  status?: AtomStatus;
  reuseCount?: number;
  lastReusedAt?: string;
  verification?: Verification;
  pitfalls?: string[];
  links?: AtomLink[];
}
```

(`AtomType`, `Evidence`, `Trigger` are already declared in this file.)

- [ ] **Step 4: Add Postgres SET branches**

In `src/storage/postgres-store.ts`, in `updateAtom`, add four branches at the top of the conditional block (right after `const values: unknown[] = [];`):

```typescript
    if (patch.claim !== undefined)    { values.push(patch.claim);    sets.push(`claim = $${values.length}`); }
    if (patch.type !== undefined)     { values.push(patch.type);     sets.push(`type = $${values.length}`); }
    if (patch.evidence !== undefined) { values.push(JSON.stringify(patch.evidence)); sets.push(`evidence = $${values.length}::jsonb`); }
    if (patch.trigger !== undefined)  { values.push(JSON.stringify(patch.trigger));  sets.push(`trigger = $${values.length}::jsonb`); }
```

(The `MemoryKnowledgeStore.updateAtom` already spreads `definedPatch` onto the atom, so `claim/type/evidence/trigger` apply with no memory-store change.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --import tsx test/atom-patch-content.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src/types/atoms.ts src/storage/postgres-store.ts test/atom-patch-content.test.ts
git commit -m "feat(atoms): allow updateAtom to patch claim/type/evidence/trigger"
```

---

## Task 3.2: Conflict-resolution content fix

**Files:**
- Create: `src/storage/atom-import-patch.ts`
- Modify: `src/storage/memory-store.ts:1644-1676` (resolveAtomImportConflict)
- Modify: `src/storage/postgres-store.ts:2470-2536` (resolveAtomImportConflict)
- Test: `test/atom-conflict-content.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('resolveAtomImportConflict take_imported: applies imported content', async () => {
  const store = new MemoryKnowledgeStore();
  const local = await store.createAtom({
    project: 'p', claim: 'local claim', type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }], trigger: { files: ['a.ts'] }, producedBy: 'user',
  });

  const conflict = await store.createAtomImportConflict({
    project: 'p', atomId: local.id, localSnapshot: local,
    importedSnapshot: {
      id: local.id, revision: 2, project: 'p', type: 'gotcha', tier: 'verified', status: 'active',
      trigger: { files: ['b.ts'] }, evidence: [{ kind: 'file', path: 'b.ts' }],
      audit: { producedBy: 'user', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      body: 'imported claim',
    },
    bundleSource: '/tmp/pack',
  });

  await store.resolveAtomImportConflict(conflict.id, 'take_imported');
  const after = await store.getAtom(local.id);
  assert.equal(after?.claim, 'imported claim');
  assert.equal(after?.type, 'gotcha');
  assert.deepEqual(after?.trigger.files, ['b.ts']);
  assert.equal(after?.tier, 'verified');
});

test('resolveAtomImportConflict merged: applies merged content fields', async () => {
  const store = new MemoryKnowledgeStore();
  const local = await store.createAtom({
    project: 'p', claim: 'local claim', type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }], trigger: { files: ['a.ts'] }, producedBy: 'user',
  });
  const conflict = await store.createAtomImportConflict({
    project: 'p', atomId: local.id, localSnapshot: local,
    importedSnapshot: {
      id: local.id, revision: 2, project: 'p', type: 'fact', tier: 'draft', status: 'active',
      trigger: { files: ['a.ts'] }, evidence: [{ kind: 'file', path: 'a.ts' }],
      audit: { producedBy: 'user', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      body: 'x',
    },
    bundleSource: '/tmp/pack',
  });
  await store.resolveAtomImportConflict(conflict.id, 'merged', { claim: 'merged claim', tier: 'canonical' });
  const after = await store.getAtom(local.id);
  assert.equal(after?.claim, 'merged claim');
  assert.equal(after?.tier, 'canonical');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/atom-conflict-content.test.ts`
Expected: FAIL — `take_imported` currently sets only `tier`/`status`, so `after.claim` is still `'local claim'`.

- [ ] **Step 3: Create the shared patch builder**

Create `src/storage/atom-import-patch.ts`:

```typescript
import type { AtomFrontmatter } from '../types/export-bundle.js';
import type { KnowledgeAtomPatch } from '../types/atoms.js';

/**
 * Build a full content patch from an imported atom snapshot so `take_imported`
 * updates claim/type/evidence/trigger (not just tier/status). Mirrors
 * `toAtomInputFromParsed`: claim falls back to the markdown body.
 */
export function importedSnapshotToPatch(imp: AtomFrontmatter & { body: string }): KnowledgeAtomPatch {
  return {
    claim: imp.claim ?? imp.body.trim(),
    type: imp.type,
    evidence: imp.evidence,
    trigger: imp.trigger,
    verification: imp.verification,
    pitfalls: imp.pitfalls,
    links: imp.links,
    tier: imp.tier,
    status: imp.status,
  };
}
```

- [ ] **Step 4: Fix the memory store**

In `src/storage/memory-store.ts`, add the import at the top (with the other imports):

```typescript
import { importedSnapshotToPatch } from './atom-import-patch.js';
```

Replace the `take_imported` branch in `resolveAtomImportConflict`:

```typescript
    if (action === 'take_imported') {
      const imp = next.importedSnapshot;
      await this.updateAtom(next.atomId, {
        tier: imp.tier,
        status: imp.status,
      });
    } else if (action === 'merged' && mergedSnapshot) {
```

with:

```typescript
    if (action === 'take_imported') {
      await this.updateAtom(next.atomId, importedSnapshotToPatch(next.importedSnapshot));
    } else if (action === 'merged' && mergedSnapshot) {
```

(The `merged` branch already does `await this.updateAtom(next.atomId, m)`; with the extended `KnowledgeAtomPatch` it now applies content fields too — no change needed there.)

- [ ] **Step 5: Fix the Postgres store**

In `src/storage/postgres-store.ts`, add the import near the top:

```typescript
import { importedSnapshotToPatch } from './atom-import-patch.js';
import type { AtomFrontmatter } from '../types/export-bundle.js';
```

Add a module-level helper near the other private helpers (e.g. just below the `import` block or above the class — any module scope is fine):

```typescript
/** Apply a KnowledgeAtomPatch's content+meta fields to one atom inside an open transaction. */
async function applyAtomPatchInTx(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  atomId: string,
  patch: KnowledgeAtomPatch,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.claim !== undefined)        { vals.push(patch.claim);        sets.push(`claim = $${vals.length}`); }
  if (patch.type !== undefined)         { vals.push(patch.type);         sets.push(`type = $${vals.length}`); }
  if (patch.evidence !== undefined)     { vals.push(JSON.stringify(patch.evidence));     sets.push(`evidence = $${vals.length}::jsonb`); }
  if (patch.trigger !== undefined)      { vals.push(JSON.stringify(patch.trigger));      sets.push(`trigger = $${vals.length}::jsonb`); }
  if (patch.verification !== undefined) { vals.push(JSON.stringify(patch.verification)); sets.push(`verification = $${vals.length}::jsonb`); }
  if (patch.pitfalls !== undefined)     { vals.push(JSON.stringify(patch.pitfalls));     sets.push(`pitfalls = $${vals.length}::jsonb`); }
  if (patch.links !== undefined)        { vals.push(JSON.stringify(patch.links));        sets.push(`links = $${vals.length}::jsonb`); }
  if (patch.tier !== undefined)         { vals.push(patch.tier);         sets.push(`tier = $${vals.length}`); }
  if (patch.status !== undefined)       { vals.push(patch.status);       sets.push(`status = $${vals.length}`); }
  if (sets.length === 0) return;
  vals.push(atomId);
  await client.query(`UPDATE knowledge_atoms SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
}
```

Then replace the two resolution branches in `resolveAtomImportConflict`:

```typescript
      if (action === 'take_imported') {
        const imp = row.imported_snapshot as { tier?: string; status?: string };
        if (imp?.tier && imp?.status) {
          await client.query(
            `UPDATE knowledge_atoms SET tier = $1, status = $2, updated_at = now() WHERE id = $3`,
            [imp.tier, imp.status, row.atom_id],
          );
        }
      } else if (action === 'merged' && mergedSnapshot) {
        const m = mergedSnapshot as KnowledgeAtomPatch;
        const sets: string[] = [];
        const vals: unknown[] = [];
        if (m.tier !== undefined) { vals.push(m.tier); sets.push(`tier = $${vals.length}`); }
        if (m.status !== undefined) { vals.push(m.status); sets.push(`status = $${vals.length}`); }
        if (m.verification !== undefined) { vals.push(JSON.stringify(m.verification)); sets.push(`verification = $${vals.length}::jsonb`); }
        if (m.pitfalls !== undefined) { vals.push(JSON.stringify(m.pitfalls)); sets.push(`pitfalls = $${vals.length}::jsonb`); }
        if (m.links !== undefined) { vals.push(JSON.stringify(m.links)); sets.push(`links = $${vals.length}::jsonb`); }
        if (sets.length > 0) {
          vals.push(row.atom_id);
          await client.query(
            `UPDATE knowledge_atoms SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`,
            vals,
          );
        }
      }
```

with:

```typescript
      if (action === 'take_imported') {
        const patch = importedSnapshotToPatch(row.imported_snapshot as AtomFrontmatter & { body: string });
        await applyAtomPatchInTx(client, row.atom_id, patch);
      } else if (action === 'merged' && mergedSnapshot) {
        await applyAtomPatchInTx(client, row.atom_id, mergedSnapshot as KnowledgeAtomPatch);
      }
```

(If `KnowledgeAtomPatch` is not already imported in `postgres-store.ts`, it is — see the existing `merged` branch using `KnowledgeAtomPatch`.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test --import tsx test/atom-conflict-content.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Run existing conflict tests (no regressions)**

Run: `node --test --import tsx test/export-importer-conflicts.test.ts`
Expected: PASS (unchanged behavior for tier/status; content now also applied).

- [ ] **Step 8: Commit**

```bash
git add src/storage/atom-import-patch.ts src/storage/memory-store.ts src/storage/postgres-store.ts test/atom-conflict-content.test.ts
git commit -m "fix(import): take_imported/merged update atom content fields, not just tier/status"
```

---

## Task 3.3: Categorized import reader

**Files:**
- Modify: `src/export/importer.ts:79-157` (atom + knowledge readers)
- Test: `test/bootstrap-import-v2.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { exportBootstrapPack } from '../src/export/bootstrap-pack.js';
import { importPack } from '../src/export/importer.js';
import type { BootstrapHealth } from '../src/bootstrap/types.js';

const HEALTH: BootstrapHealth = {
  sourceCounts: { tracked: 1, changed: 0, missing: 0, archived: 0, ignored: 0 },
  tombstones: 0, openImportConflicts: 0, maintenanceItems: 0, gaps: 0,
};

test('importPack: reads a categorized-v2 pack from pack/', async () => {
  const src = new MemoryKnowledgeStore();
  await src.upsertSourceFile({ project: 'p', path: 'src/retrieval/service.ts', contentHash: 'h' });
  await src.createAtom({
    project: 'p', claim: 'Fusion is weighted RRF.', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/retrieval/service.ts' }],
    trigger: { files: ['src/retrieval/service.ts'] }, producedBy: 'user',
  });
  const bundle = await mkdtemp(join(tmpdir(), 'v2-imp-'));
  await exportBootstrapPack(src, { project: 'p', out: bundle, atlasContents: [{ name: 'project-map.md', content: '# Map\n' }], health: HEALTH });

  const dst = new MemoryKnowledgeStore();
  const report = await importPack(dst, { from: join(bundle, 'pack'), project: 'p2' });

  assert.equal(report.atomsInserted, 1);
  const atoms = await dst.listAtoms({ project: 'p2', limit: 100 });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].claim, 'Fusion is weighted RRF.');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/bootstrap-import-v2.test.ts`
Expected: FAIL — `importPack` reads only flat `atoms/`; a `categorized-v2` pack has no top-level `atoms/` dir, so `report.atomsInserted` is 0 (or `readdir` throws).

- [ ] **Step 3: Add the categorized reader helper**

In `src/export/importer.ts`, add this helper at the bottom of the file (next to `safeListUserStyleDirs`):

```typescript
/** List relative paths to atom/knowledge markdown for a categorized-v2 pack: areas/<slug>/<kind>/*.md. */
async function listAreaFiles(from: string, kind: 'atoms' | 'knowledge'): Promise<string[]> {
  const root = join(from, 'areas');
  const rel: string[] = [];
  let areaDirs: string[];
  try {
    areaDirs = await readdir(root);
  } catch {
    return rel;
  }
  for (const area of areaDirs) {
    try { assertSafeChildName(area); } catch { continue; }
    const kindDir = join(root, area, kind);
    let files: string[];
    try { files = await readdir(kindDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      try { assertSafeChildName(f); } catch { continue; }
      rel.push(join('areas', area, kind, f));
    }
  }
  return rel.sort();
}
```

- [ ] **Step 4: Branch the atom + knowledge loops on layout**

In `importPack`, replace:

```typescript
  const atomFiles = (await readdir(join(opts.from, 'atoms'))).filter((f) => f.endsWith('.md'));
  for (const file of atomFiles) {
    const raw = await readFile(join(opts.from, 'atoms', file), 'utf8');
    const parsed = parseAtomMarkdown(raw, { filename: `atoms/${file}` });
```

with:

```typescript
  const layout = (manifest as { layout?: string }).layout;
  const atomRel = layout === 'categorized-v2'
    ? await listAreaFiles(opts.from, 'atoms')
    : (await readdir(join(opts.from, 'atoms'))).filter((f) => f.endsWith('.md')).map((f) => join('atoms', f));
  for (const rel of atomRel) {
    const raw = await readFile(join(opts.from, rel), 'utf8');
    const parsed = parseAtomMarkdown(raw, { filename: rel });
```

And replace:

```typescript
  const kFiles = (await readdir(join(opts.from, 'knowledge'))).filter((f) => f.endsWith('.md'));
  for (const file of kFiles) {
    const raw = await readFile(join(opts.from, 'knowledge', file), 'utf8');
    const parsed = parseKnowledgeMarkdown(raw, { filename: `knowledge/${file}` });
```

with:

```typescript
  const kRel = layout === 'categorized-v2'
    ? await listAreaFiles(opts.from, 'knowledge')
    : (await readdir(join(opts.from, 'knowledge'))).filter((f) => f.endsWith('.md')).map((f) => join('knowledge', f));
  for (const rel of kRel) {
    const raw = await readFile(join(opts.from, rel), 'utf8');
    const parsed = parseKnowledgeMarkdown(raw, { filename: rel });
```

Inside the knowledge loop, the existing code references `file` for the source URI. Update that single reference: change

```typescript
            sourceUri: `bundle://${opts.from}/${file}`,
```

to

```typescript
            sourceUri: `bundle://${opts.from}/${rel}`,
```

- [ ] **Step 5: Run the new test + the existing flat importer test**

Run: `node --test --import tsx test/bootstrap-import-v2.test.ts && node --test --import tsx test/export-importer.test.ts`
Expected: PASS — categorized pack imports; flat packs still import (the `else` branch is byte-identical to the old behavior, with the `atoms/`/`knowledge/` prefix moved into `rel`).

- [ ] **Step 6: Build + full suite + commit**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
git add src/export/importer.ts test/bootstrap-import-v2.test.ts
git commit -m "feat(import): read categorized-v2 packs (areas/<slug>/{atoms,knowledge})"
```

---

# Phase 4 — `--deep` Graph Enrichment

## Task 4.1: Deep mode in BootstrapService

**Files:**
- Modify: `src/bootstrap/service.ts` (add `runDeep` + deep branch)
- Test: `test/bootstrap-deep.test.ts`

> **Scope note (no silent caps):** This slice wires **co-change inference** (`inferCoChangeLinks`) and **graph density** (`computeAtomGraphDensity`) only. Stale-edge pruning (spec §12 action 2) is **explicitly deferred** to the later Graph RAG Deepening spec; `runDeep` logs that it was skipped via a warning so the report never implies pruning ran.

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/hash-provider.js';
import { KnowledgeSafetyService } from '../src/security/knowledge-safety.js';
import { IngestionService } from '../src/ingest/service.js';
import { SourceSyncService } from '../src/source-sync/service.js';
import { AtlasService } from '../src/atlas/service.js';
import { BootstrapService } from '../src/bootstrap/service.js';

test('BootstrapService.run: --deep reports graph density and is non-fatal', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'deep-'));
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');

  const store = new MemoryKnowledgeStore();
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-'));
  const models = new HashModelProvider();
  const ingestion = new IngestionService(store, models, { safety: new KnowledgeSafetyService() });
  const atlas = new AtlasService(store, { atlasDir });
  const sync = new SourceSyncService({ store, ingestion, atlasAutoRegen: false });
  const service = new BootstrapService({ store, sync, atlas, exportBaseDir: atlasDir });

  const report = await service.run({ project: 'p', repoPath: repo, generatedAt: '2026-05-29T00:00:00.000Z', deep: true });

  assert.ok(report.deep, 'deep present');
  assert.ok(report.deep!.graphDensity, 'graph density computed');
  assert.equal(typeof report.deep!.graphDensity!.edgesPerAtom, 'number');
  assert.ok(Array.isArray(report.deep!.warnings));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/bootstrap-deep.test.ts`
Expected: FAIL — `report.deep` is `undefined` (deep not wired).

- [ ] **Step 3: Add imports + `runDeep` + the deep branch**

In `src/bootstrap/service.ts`, add imports:

```typescript
import { inferCoChangeLinks } from '../atoms/inference/co-change.js';
import { computeAtomGraphDensity } from '../operations/atom-graph-density.js';
import type { BootstrapReport } from './types.js';
```

(If `BootstrapReport` is already imported, keep the existing import and don't duplicate.)

Add the `runDeep` method to the class:

```typescript
  /**
   * Bounded graph enrichment for --deep: co-change inference + density snapshot.
   * Non-fatal — failures become warnings; standard bootstrap still completes.
   * Stale-edge pruning is intentionally deferred to the Graph RAG Deepening spec.
   */
  private async runDeep(args: BootstrapRunArgs): Promise<NonNullable<BootstrapReport['deep']>> {
    const warnings: string[] = ['stale-edge pruning skipped (deferred to Graph RAG Deepening)'];
    let coChangeEdgesEmitted: number | undefined;
    try {
      const report = await inferCoChangeLinks(this.deps.store, { project: args.project, cwd: args.repoPath });
      coChangeEdgesEmitted = report.edgesEmitted;
    } catch (err) {
      warnings.push(`co-change inference failed (non-fatal): ${(err as Error).message}`);
    }
    let graphDensity;
    try {
      graphDensity = await computeAtomGraphDensity(this.deps.store, { project: args.project });
    } catch (err) {
      warnings.push(`graph density failed (non-fatal): ${(err as Error).message}`);
    }
    return { coChangeEdgesEmitted, graphDensity, warnings };
  }
```

In `run`, insert the deep step **after `apply` and before the atlas block** (so enrichment is reflected in the generated atlas — spec §7), capturing it for the report:

```typescript
    // Deep graph enrichment runs before atlas so density is reflected in generated docs.
    let deep: BootstrapReport['deep'];
    if (args.deep) {
      deep = await this.runDeep(args);
    }
```

Add `deep,` to the returned object (after `health,` / before `warnings,`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/bootstrap-deep.test.ts`
Expected: PASS (1 test). `inferCoChangeLinks` reads git history via `readGitCommits`; on a fresh non-committed repo it returns `edgesEmitted: 0` without throwing — density is still computed.

- [ ] **Step 5: Build + full suite + commit**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
git add src/bootstrap/service.ts test/bootstrap-deep.test.ts
git commit -m "feat(bootstrap): --deep co-change inference + graph density (non-fatal)"
```

---

## Final Verification (run after all phases)

- [ ] **Build, full suite, diff check**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
git diff --check
```

Expected: build clean, all tests pass, no whitespace errors.

- [ ] **Confirm eval gate is NOT triggered**

This plan changes no retrieval ranking / classifier / fusion / reranking / context-pack / context-fit code, so `pnpm run eval:retrieval` is not required. If a reviewer disagrees, run it — it must stay green:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
```

---

## Spec Coverage Map (self-review)

| Spec requirement | Task |
|---|---|
| §5 `tuberosa bootstrap` command + flags (`--export`, `--deep`, `--out`, `--json`) | 1.4 (flags), 2.3 (`--export`), 4.1 (`--deep`) |
| §7 data flow: sync → apply additive → (deep) → atlas → health → export → next actions | 1.3, 2.3, 4.1 |
| §8 `BootstrapReport` shape | 1.1 |
| §6/§15.2 additive sync default, deletions deferred, never silent | 1.3 (`allowDestructive:false`), next-action names `pending-sync.json` |
| §9 error handling: atlas/health non-fatal, export failure fatal | 1.3, 2.3 |
| §8/§317 health: source counts, tombstones, conflicts, maintenance, gaps | 1.2 |
| §10 Export V2 two-layer layout (START-HERE, atlas/, health/, pack/areas) | 2.2 |
| §10 manifest V2 additions | 2.1, 2.2 |
| §11 categorized import (`areas/*/atoms`, `areas/*/knowledge`); flat still imports | 3.3 |
| §11 conflict fix: take_imported + merged update content fields | 3.1, 3.2 |
| §12 `--deep` co-change + density, non-fatal | 4.1 |
| §12 stale-edge pruning | **Deferred** — logged as a warning in 4.1; tracked under §16 follow-ups |
| §14 verification (unit tests for parser, command, service, export, import, conflict, deep, unsafe out) | every task |
| §15.5 old flat pack still imports | 3.3 Step 5 |

**Known deferrals (carry to spec §16 follow-ups):** stale-edge pruning in `--deep`; semantic duplicate import conflicts; MCP `tuberosa_bootstrap_project` tool; LLM atlas gloss. `health/maintenance-preview.json` is written as a count summary, not the full maintenance preview — note for a future enrichment if a richer artifact is needed.
