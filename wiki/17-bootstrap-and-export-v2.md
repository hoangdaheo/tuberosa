# 17 — Bootstrap & Export V2

`tuberosa bootstrap` is the one command a new user runs to turn a repo into useful project knowledge — no need to discover `sync`, `atlas`, and `export` separately. With `--export` it also produces a **two-layer handoff pack** another person can read *and* import.

```bash
tuberosa bootstrap --project myapp
```

That single call: syncs sources (additive), regenerates the atlas, builds a health summary, and prints next actions.

## What bootstrap does

`BootstrapService.run` (`src/bootstrap/service.ts`) composes the subsystems you've already seen:

1. **Sync** the repo → get a plan.
2. **Apply additive ops** (add/change/rename). Deletions are **deferred**, never archived (`allowDestructive: false`).
3. *(optional `--deep`)* bounded graph enrichment — see below.
4. **Regenerate the atlas** to `.tuberosa/atlas/` (non-fatal).
5. **Build a health summary** (source counts, tombstones, open conflicts, maintenance items, gaps).
6. *(optional `--export`)* write the Export V2 pack.
7. Generate **next actions**.

```
$ tuberosa bootstrap --project myapp
Bootstrap for myapp:
  sync: 128 added, 0 changed, 0 renamed, 0 deleted
  atlas: 5 files (input 7c1a…)
  health: 128 tracked sources, 0 tombstones, 0 conflicts, 3 gaps
  next: run `tuberosa atlas --project myapp` to inspect the map
```

### Flags

| Flag | Effect |
|---|---|
| `--project <name>` | Required. |
| `--path <repo>` | Repo root (defaults to cwd). |
| `--export` | Also write an Export V2 pack under `.tuberosa/exports/<project>-bootstrap/`. |
| `--out <dir>` | Override the export destination (safe-path confined). |
| `--deep` | Run bounded graph enrichment before atlas/export. |
| `--json` | Emit the full `BootstrapReport` instead of prose. |

### Error handling

| Step | On failure |
|---|---|
| Sync plan / apply | **Fatal** — bootstrap fails. |
| Atlas, health, maintenance, `--deep` | **Non-fatal** — recorded as a warning, partial report still returned. |
| `--export` | **Fatal** — you explicitly asked for it. |

If any deletion was detected and deferred, the report names `.tuberosa/pending-sync.json` and adds a next action — deferred deletions are never hidden.

## `--deep` graph enrichment

`--deep` prepares the project for richer graph retrieval **without** changing retrieval ranking. It's bounded and non-fatal:

1. Run co-change inference over the repo (`infer-co-change`).
2. Compute atom-graph density.
3. Report edges/atom and which areas have weak graph context.

```bash
tuberosa bootstrap --project myapp --deep
```

```
  deep: 47 co-change edges, 1.83 edges/atom
  deep-warning: stale-edge pruning skipped (deferred to Graph RAG Deepening)
```

## Export V2 layout

`tuberosa bootstrap --project myapp --export` writes a **two-layer** bundle — a human layer to read and a machine layer to import:

```
.tuberosa/exports/myapp-bootstrap/
├─ START-HERE.md            ← human entry point
├─ atlas/                   ← the five atlas files (copied)
│   ├─ project-map.md  flows.md  commands.md  risks.md  open-gaps.md
├─ health/
│   ├─ summary.md           ← prose health report
│   ├─ source-health.json
│   └─ maintenance-preview.json
└─ pack/                    ← the importable machine layer
    ├─ manifest.json        ← layout: "categorized-v2", areas index, atlas + health summary
    ├─ areas/
    │   ├─ src-retrieval/
    │   │   ├─ atoms/<slug>-<id>.md
    │   │   └─ knowledge/<slug>-<id>.md
    │   ├─ src-storage/
    │   └─ _unassigned/
    ├─ edges.jsonl          ← unchanged machine edge file
    ├─ chunks/              ← unchanged
    └─ README.md
```

The **human layer** (`START-HERE.md`, `atlas/`, `health/`) is for a teammate to scan before importing. The **machine layer** (`pack/`) is the importable bundle.

Key differences from the flat [v1 bundle](08-export-import-bundle.md):

- Atoms and knowledge live under `pack/areas/<slug>/` (folders are filesystem-safe slugs of area keys from `buildAreaModel`) instead of flat `atoms/` + `knowledge/`.
- `manifest.json` gains `layout: "categorized-v2"`, an `areas` index (`{ key, label, atomCount, knowledgeCount }`), an `atlas` block, and a `healthSummary`.
- The atom/knowledge Markdown bodies, `edges.jsonl`, and `chunks/` formats are **unchanged** — so a categorized pack and a flat pack import to identical store state.

### `START-HERE.md`

```markdown
# Tuberosa Bootstrap Pack — myapp

Source commit: `a1b2c3d4`

## Quick import
tuberosa import --from <this-dir>/pack --project myapp

## Project areas
- `src-retrieval` (4 atoms, 9 knowledge)
- `src-storage` (2 atoms, 5 knowledge)

## Health
Tracked sources: 128 · open conflicts: 0 · gaps: 3
```

## Importing a pack

Import is **backward compatible** — the importer reads `manifest.layout`:

- **absent / `"flat"`** → walk `atoms/` + `knowledge/` as before. Old packs keep importing unchanged.
- **`"categorized-v2"`** → walk `areas/*/atoms/*.md` + `areas/*/knowledge/*.md`.

Point the importer at the `pack/` subdirectory:

```jsonc
{ "name": "tuberosa_import_pack",
  "arguments": { "from": "myapp-bootstrap/pack", "project": "myapp", "dryRun": true } }
```

```bash
curl -sX POST http://localhost:3027/operations/import-pack -d \
  '{"from":"myapp-bootstrap/pack","project":"myapp","dryRun":true,"onConflict":"review"}'
```

See [08-export-import-bundle.md](08-export-import-bundle.md) for the full import flow, dry-run reports, and path confinement.

### Same-ID conflict handling

- A same atom ID with **different content** queues an import conflict for review (never a silent overwrite).
- Resolving with `take_imported` updates the imported atom's **content fields** (claim, type, evidence, trigger, verification, pitfalls, links) — not just tier/status.
- `merged` may update any of those fields from a merged snapshot.
- Local state only changes after an explicit resolution.

> Semantic-duplicate detection (similarity-scored conflicts + a `keep_both` action) is designed and partially scaffolded but not part of the first Export V2 slice; same-ID conflicts above are what ships today.

## Report shape (`--json`)

```jsonc
{
  "project": "myapp",
  "repoPath": "/abs/path",
  "sync": { "planId": "...", "summary": { "added": 128, ... }, "applied": { ... } },
  "atlas": { "inputHash": "7c1a...", "files": [{ "name": "project-map.md", "bytes": 4821 }, ...] },
  "health": {
    "sourceCounts": { "tracked": 128, "changed": 0, "missing": 0, "archived": 0, "ignored": 12 },
    "tombstones": 0, "openImportConflicts": 0, "maintenanceItems": 2, "gaps": 3
  },
  "deep": { "coChangeEdgesEmitted": 47, "graphDensity": { ... }, "warnings": [ ... ] },
  "export": { "out": ".tuberosa/exports/myapp-bootstrap", "atoms": 6, "knowledge": 14, "edges": 9, "chunks": 40, "areas": 3 },
  "warnings": [],
  "nextActions": [ "..." ]
}
```

## Invariants

1. **Never archives silently** — bootstrap always applies additive ops and defers deletions to `.tuberosa/pending-sync.json`.
2. **No silent import overwrite** — same-ID content changes queue a conflict for review.
3. **Backward compatible** — old flat export packs still import unchanged.
4. **No retrieval change** — bootstrap and Export V2 touch no classifier/fusion/rerank/context logic.

## Configuration

Reuses existing keys — no new env required:

| Variable | Default | Used for |
|---|---|---|
| `TUBEROSA_EXPORT_BASE_DIR` | `.tuberosa/exports` | Default `--export` destination + safe-path base. |
| `TUBEROSA_ATLAS_DIR` | `.tuberosa/atlas` | Atlas output (copied into the pack). |
| `TUBEROSA_ATLAS_AUTO_REGEN` | `true` | Atlas regen during bootstrap. |

## Read next

- [15-source-lifecycle-sync.md](15-source-lifecycle-sync.md) — the sync engine bootstrap drives.
- [16-project-atlas.md](16-project-atlas.md) — the atlas it regenerates and bundles.
- [08-export-import-bundle.md](08-export-import-bundle.md) — the underlying pack format, import flow, and conflict resolution.
