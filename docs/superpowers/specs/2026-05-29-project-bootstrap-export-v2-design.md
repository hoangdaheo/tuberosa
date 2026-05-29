# Project Bootstrap + Export V2

**Date:** 2026-05-29
**Status:** Design approved in brainstorming, pending user spec review
**Scope:** First-run project knowledge bootstrap plus a human-readable, importable Export V2 pack.
**Depends on:** P0 source lifecycle sync, P1 atlas, existing export/import pack, area model, maintenance preview, atom graph utilities.

---

## 1. Background

Tuberosa now has the building blocks for project knowledge lifecycle:

- `SourceSyncService` can detect added, changed, renamed, and deleted files, apply additive changes, and defer destructive deletion cleanup.
- `AtlasService` can generate the deterministic five-file atlas.
- `exportPack` and `importPack` can move atoms, knowledge, chunks, and edges between Tuberosa instances.
- Maintenance and workbench summaries can surface duplicate memories, stale relations, weak labels, source health, gaps, and conflicts.

The problem is that these pieces are still scattered. A new user has to discover the correct order: sync, atlas, health, export, import conflict review, and optional graph enrichment. The current export pack is also too flat for human handoff; it is importable, but not structured enough to help another user quickly understand accumulated work.

This design creates one explicit first-run command and improves export structure without replacing the existing data model.

## 2. Goals

1. Give users a single command that builds useful first-run project knowledge.
2. Keep `tuberosa init` focused on service setup; put project knowledge ingestion in a separate command.
3. Make the default bootstrap useful and safe: apply additive sync, regenerate atlas, summarize health, and defer deletions.
4. Make export optional via `--export`, producing both human-facing handoff docs and machine-stable import data.
5. Add a `--deep` mode that improves graph readiness without making standard bootstrap slow or noisy.
6. Preserve all current safety rules: no silent destructive cleanup and no silent import overwrite.

## 3. Non-Goals

- Do not rewrite retrieval ranking in this slice.
- Do not make `tuberosa init` scan or ingest the codebase by default.
- Do not make Graph RAG a fully new retrieval engine yet.
- Do not auto-resolve semantic conflicts or imported atom conflicts.
- Do not hard-delete archived or deleted-file knowledge.

## 4. Decisions

| Decision | Choice | Reason |
|---|---|---|
| Command surface | Add `tuberosa bootstrap` | Keeps `init` fast and service-focused. |
| Default sync behavior | Apply additive changes by default | Bootstrap should produce usable knowledge on first run. |
| Deletion behavior | Always defer unless explicitly archived by existing sync path | Preserves the no-silent-destructive-cleanup invariant. |
| Export behavior | Flag-based: `--export` | Avoids writing large packs unless requested. |
| Export shape | Two layers | Human handoff docs plus machine import data serve different users. |
| Deep graph behavior | `--deep` only | Graph enrichment can be slower and noisier than standard bootstrap. |
| Retrieval changes | None in Bootstrap V2 | Graph RAG deepening is a later design slice. |

## 5. Command Contract

```bash
tuberosa bootstrap --project <name> [--path <repo>] [--export] [--deep] [--out <dir>] [--json]
```

Default behavior:

1. Run source sync.
2. Apply additive operations immediately.
3. Defer deletions to `.tuberosa/pending-sync.json`.
4. Regenerate the atlas on disk.
5. Build a bootstrap health summary.
6. Print a concise report with next actions.

With `--export`:

- Write an Export V2 bundle under `.tuberosa/exports/<project>-bootstrap/` by default.
- If `--out` is provided, write under that path after applying the same safe-path rules as the existing export endpoint.

With `--deep`:

- Run bounded graph enrichment and graph-health reporting before the final atlas/export step.
- Failures are warnings; standard bootstrap still completes when sync succeeds.

`--json` returns the full `BootstrapReport` shape instead of prose.

## 6. Architecture

Add a small orchestration service rather than placing logic in the CLI command:

```text
src/bootstrap/service.ts
  BootstrapService.run(args): Promise<BootstrapReport>

bin/commands/bootstrap.ts
  Parse CLI args, call BootstrapService, render report.

bin/commands/bootstrap-factory.ts
  Build store, models, ingestion, sync, atlas, maintenance, and export dependencies.
```

The CLI follows the existing command pattern used by `sync.ts` and `atlas.ts`: command modules are injectable and easy to unit test.

## 7. Data Flow

`BootstrapService.run` composes existing subsystems:

1. `SourceSyncService.sync({ project, repoPath, trigger: 'cli' })`
2. `SourceSyncService.apply({ planId, allowDestructive: false })`
3. optional deep graph steps
4. `AtlasService.regenerate({ project, repoPath, write: true })`
5. health summary build
6. optional `exportBootstrapPack`
7. next-action generation

The standard flow applies additive sync before atlas generation, so the atlas reflects the latest ingested project state. Deep mode runs before the final atlas/export so graph enrichment can appear in the generated docs.

## 8. Report Shape

```ts
interface BootstrapReport {
  project: string;
  repoPath: string;
  sync: {
    planId: string;
    summary: SyncPlan['summary'];
    applied: ApplyResult;
  };
  atlas?: {
    inputHash: string;
    files: { name: string; bytes: number }[];
  };
  health: {
    sourceCounts: Record<SourceFileStatus, number>;
    tombstones: number;
    openImportConflicts: number;
    maintenanceItems: number;
    gaps: number;
  };
  deep?: {
    coChangeEdgesEmitted?: number;
    staleEdgesPruned?: number;
    graphDensity?: unknown;
    warnings: string[];
  };
  export?: {
    out: string;
    atoms: number;
    knowledge: number;
    edges: number;
    chunks: number;
  };
  warnings: string[];
  nextActions: string[];
}
```

`health` should reuse existing workbench summary computations where possible. If that surface is too UI-shaped, add a focused `buildBootstrapHealthSummary` helper that reads the same store primitives directly.

## 9. Error Handling

| Step | Failure behavior |
|---|---|
| Sync plan creation | Fail bootstrap. |
| Sync apply | Fail bootstrap. |
| Atlas regeneration | Non-fatal after sync succeeds; add warning. |
| Health summary | Non-fatal; add warning and render partial report. |
| Maintenance preview | Non-fatal; add warning. |
| `--deep` graph enrichment | Non-fatal; add warning. |
| `--export` pack writing | Fail bootstrap because the user explicitly requested export. |

The command should never hide deferred deletions. If any deletion was detected and not archived, the report must name `.tuberosa/pending-sync.json` and include a next action.

## 10. Export V2 Layout

Export V2 is a layout improvement over the current pack. Atom and knowledge markdown formats remain unchanged. `edges.jsonl` remains the machine edge file. Flat packs continue to import.

```text
.tuberosa/exports/<project>-bootstrap/
  START-HERE.md
  atlas/
    project-map.md
    flows.md
    commands.md
    risks.md
    open-gaps.md
  health/
    summary.md
    source-health.json
    maintenance-preview.json
  pack/
    manifest.json
    areas/
      src-retrieval/
        atoms/
        knowledge/
      src-storage/
        atoms/
        knowledge/
      _unassigned/
        atoms/
        knowledge/
    edges.jsonl
    chunks/
    README.md
```

### Human Layer

`START-HERE.md` should include:

- project name
- generated timestamp
- source commit when available
- quick import command
- top project areas
- health summary
- open gaps
- deferred deletions or tombstones
- graph density when `--deep` ran
- where to inspect the machine pack

`atlas/` copies the current five atlas files.

`health/summary.md` translates the bootstrap health report into prose that a teammate can scan before importing.

### Machine Layer

`pack/manifest.json` adds:

```ts
interface ExportV2ManifestAdditions {
  layout: 'categorized-v2';
  areas: Array<{ key: string; label: string; atomCount: number; knowledgeCount: number }>;
  atlas: { files: Array<{ name: string; bytes: number }>; inputHash?: string };
  health: {
    sourceCounts: Record<string, number>;
    openImportConflicts: number;
    maintenanceItems: number;
    gaps: number;
  };
}
```

`pack/areas/*` is derived from `buildAreaModel`. Area folder names are safe slugs of the area key.

`pack/edges.jsonl`, `pack/chunks/`, and atom/knowledge markdown bodies preserve the existing importable formats.

## 11. Import Behavior

Importer changes:

1. If `manifest.layout` is absent or flat, use the current `atoms/` and `knowledge/` readers.
2. If `manifest.layout === 'categorized-v2'`, recursively read `areas/*/atoms/*.md` and `areas/*/knowledge/*.md`.
3. Same atom ID with different content queues an import conflict.
4. Same knowledge ID remains unchanged unless a future review flow is added.
5. Edge merge behavior stays max-confidence by relation kind and source.

Conflict-resolution fix:

- `take_imported` must update imported atom content fields, not only `tier` and `status`.
- `merged` must allow updating `claim`, `type`, `evidence`, `trigger`, `verification`, `pitfalls`, `links`, `tier`, and `status`.
- Local state still changes only after explicit conflict resolution.

Semantic duplicate detection is allowed as a follow-up inside Export V2 if the first implementation slice gets too large. The manifest and conflict APIs should leave room for `conflictType` and `similarity`, but the initial acceptance criteria focus on categorized layout and safe same-ID conflict behavior.

## 12. Deep Mode

`--deep` prepares the project for better Graph RAG without changing retrieval ranking.

Deep actions:

1. Run co-change inference with the repo path.
2. Run stale-edge pruning when the helper is available.
3. Compute atom graph density.
4. Add graph coverage to the bootstrap report.
5. Include graph health in `START-HERE.md` and `health/summary.md`.

`--deep` is bounded and non-fatal. It should answer:

- how many graph edges exist
- which relation kinds dominate
- whether graph coverage is too sparse
- which areas have weak graph context

This sets up the later Graph RAG Deepening spec, which should handle retrieval ranking, relation confidence calibration, richer path explanations, and graph evaluation fixtures.

## 13. Surfaces

### CLI

- Add `bootstrap` to the parser and usage text.
- Add `bin/commands/bootstrap.ts`.
- Add `bin/commands/bootstrap-factory.ts`.
- Dispatch `bootstrap` in `bin/tuberosa.ts`.

### MCP and HTTP

No MCP or HTTP surface is required for the first Bootstrap V2 slice. A future MCP tool can wrap `BootstrapService.run` after CLI behavior stabilizes.

### Config

Use existing:

- `TUBEROSA_EXPORT_BASE_DIR`
- `TUBEROSA_ATLAS_DIR`
- `TUBEROSA_ATLAS_AUTO_REGEN`
- existing graph inference policy values

Add only if implementation needs them:

- `TUBEROSA_BOOTSTRAP_DEFAULT_EXPORT_OUT`
- `TUBEROSA_BOOTSTRAP_DEEP_ENABLED`

## 14. Verification

Unit tests:

- CLI parser recognizes `bootstrap`, `--export`, `--deep`, `--out`, and `--json`.
- `bootstrapCommand` calls the service and renders concise text output.
- `bootstrapCommand --json` emits report JSON.
- `BootstrapService` applies additive sync by default.
- Deleted files are deferred, not archived.
- Atlas regeneration appears in the report.
- Health summary includes source counts, gaps, conflicts, and maintenance count.
- `--export` writes the two-layer pack.
- Categorized import reads `areas/*/atoms` and `areas/*/knowledge`.
- Old flat packs still import.
- Conflict resolution updates imported atom content fields.
- `--deep` calls graph enrichment hooks and records warnings on failures.
- Export V2 rejects unsafe output paths using existing safe-path rules.

Integration tests:

- Fresh repo fixture: `bootstrap --project p` ingests files, writes atlas, and reports no export.
- `bootstrap --project p --export` writes `START-HERE.md`, `atlas/`, `health/`, and `pack/`.
- Export V2 round-trips into a fresh store.
- Existing flat pack fixture still imports unchanged.

Commands:

```bash
pnpm run build
pnpm test
git diff --check
```

Run `pnpm run eval:retrieval` only if retrieval ranking, classifier behavior, fusion, reranking, context-pack assembly, or context-fit logic changes. The intended Bootstrap V2 slice should not require retrieval eval because it does not change retrieval ranking.

## 15. Acceptance Criteria

1. A user can run `tuberosa bootstrap --project p` on a repo and receive usable project knowledge, atlas files, health summary, and next actions without discovering separate commands.
2. Bootstrap applies additive source changes by default and never silently archives deleted-file knowledge.
3. A user can run `tuberosa bootstrap --project p --export` and hand another user a readable, importable two-layer pack.
4. Another user can import the pack, preserve local safety rules, and review conflicts instead of receiving silent overwrites.
5. The old flat export pack remains importable.
6. `--deep` improves graph coverage reporting without blocking standard bootstrap.
7. The implementation follows existing service boundaries and CLI testability patterns.

## 16. Open Follow-Ups

- Design and implement Graph RAG Deepening after Bootstrap V2, using deep-mode graph health as input.
- Add semantic duplicate import conflicts with similarity scores and `keep_both` resolution.
- Add a future MCP `tuberosa_bootstrap_project` tool after CLI behavior is stable.
- Consider optional LLM atlas gloss after the model provider gains a generation seam.
