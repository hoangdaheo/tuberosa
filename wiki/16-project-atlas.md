# 16 — Project Atlas & Area Model

The **atlas** is five Markdown files that explain a project at a glance — what its areas are, how they depend on each other, how to operate it, and where the knowledge is thin. It's synthesized **deterministically** from already-ingested knowledge, so it works with `HashModelProvider` and no API key, and the same inputs always produce the same files.

```
.tuberosa/atlas/
├─ project-map.md   # the areas: files, key symbols, counts, dependencies
├─ flows.md         # area dependency map + co-change coupling (best-effort)
├─ commands.md      # package.json scripts, grouped
├─ risks.md         # gotchas, stale knowledge, open conflicts
└─ open-gaps.md     # undocumented areas, thin coverage, unverified atoms
```

## The area model (the shared backbone)

Everything starts with one deterministic module: `buildAreaModel` (`src/knowledge-areas/area-model.ts`). It partitions a project's knowledge into **areas**.

- **Spine:** top-level repo directories from the `source_files` ledger (e.g. `src/retrieval`, `src/storage`). Always present, deterministic, matches how developers navigate.
- **Overlays:** `domain`/`business_area` labels and atom-graph relations *annotate* an area but never define it.
- **Fallback:** anything with no resolvable path collects under a sentinel `_unassigned` area — never silently dropped.

The same partition powers two things: atlas sections and [Export V2](17-bootstrap-and-export-v2.md#export-v2-layout) area folders. Built once, reused both ways.

## The five files

| File | Built from | When sparse |
|---|---|---|
| `project-map.md` | Each area: purpose line, labels, key files, key symbols, counts, "depends on" links. | Always populated (the ledger is authoritative). |
| `flows.md` | Area dependency map (`depends_on`/`refines` relations) + `co_changes_with` coupling. Best-effort. | A short note + a pointer to `open-gaps.md`. |
| `commands.md` | `package.json` scripts, grouped by prefix (Build & Dev, Test & Eval, …) + a README "Commands" section if present. | Empty scripts → empty section with a note. |
| `risks.md` | `gotcha` atoms + their pitfalls, knowledge tied to `changed`/`missing` files, open conflicts. | Always derivable. |
| `open-gaps.md` | Areas with no description, thin coverage, the `knowledge_gaps` table, atoms with no verification command. | Always derivable. |

### Example — a `project-map.md` area block

```
## src/retrieval — Retrieval
Search pipeline area. labels: domain/retrieval, business_area/search
key files:   service.ts, fusion.ts, context-fit.ts
key symbols: searchContext, assembleContextPack, classifyQuery
files 12 · knowledge 9 · atoms 4 (2 verified) · crossing edges 6
→ depends on: src/storage, src/model
```

The **purpose line** uses a fallback chain and never fabricates: top wiki/spec summary → dominant labels → `(no description — see open-gaps.md)`. A missing description feeds `open-gaps.md` rather than inventing prose.

Every file opens with a header so you can tell how fresh it is:

```
<!-- atlas_run 3f9c… · input a1b2c3d4 · generated 2026-05-29T12:00:00Z -->
```

## Generating the atlas

### On demand — CLI

```bash
# Dry-run: print file names + sizes, write nothing
tuberosa atlas --project tuberosa

# Persist the five files to .tuberosa/atlas/
tuberosa atlas --project tuberosa --write

# JSON (input hash + file list)
tuberosa atlas --project tuberosa --json
```

```
$ tuberosa atlas --project tuberosa --write
Atlas for tuberosa (written to disk):
  project-map.md — 4821 bytes
  flows.md — 1203 bytes
  commands.md — 2044 bytes
  risks.md — 1577 bytes
  open-gaps.md — 988 bytes
```

### On demand — MCP

```jsonc
// All five files
{ "name": "tuberosa_get_atlas", "arguments": { "project": "tuberosa" } }

// A single file
{ "name": "tuberosa_get_atlas",
  "arguments": { "project": "tuberosa", "file": "project-map.md" } }
```

`tuberosa_get_atlas` regenerates in-memory (no disk write) and returns `{ inputHash, files }`. The five files are also exposed as MCP resources (`tuberosa://atlas/project-map.md`, …).

### Automatically — after every `sync --apply`

The atlas regenerates as the final step of a sync apply, so it always tracks the ledger. This is **non-fatal**: if the build fails, the failure is logged to stderr and the sync result is unaffected — the atlas is derived, never authoritative. Toggle with `TUBEROSA_ATLAS_AUTO_REGEN` (default `true`).

## Staleness

Migration `012_atlas_runs.sql` records one `atlas_runs` row per generation, with an `input_hash` computed over the area model + source tables (but **not** the timestamp, so an unchanged project yields a stable hash). The atlas is **stale** when the current input hash differs from the last recorded run.

## Invariants

1. **Derived, never authoritative** — a failed atlas build never fails a sync.
2. **No fabrication** — every line traces to stored data; absent data becomes an explicit gap note.
3. **Deterministic** — identical inputs produce byte-identical files (modulo the `generated` header line).
4. **No silent exclusion** — `_unassigned` areas and empty sections are rendered with honest notes.

> LLM "gloss" (optional narrative prose around the deterministic skeleton) is designed but deferred until the model provider gains a text-generation seam. Today the atlas is deterministic-only.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_ATLAS_DIR` | `.tuberosa/atlas` | Where the five files are written. |
| `TUBEROSA_ATLAS_AUTO_REGEN` | `true` | Regenerate automatically after `sync --apply`. |

## Read next

- [15-source-lifecycle-sync.md](15-source-lifecycle-sync.md) — the ledger and apply step that trigger auto-regen.
- [17-bootstrap-and-export-v2.md](17-bootstrap-and-export-v2.md) — bundle the atlas into a handoff pack.
- [03-knowledge-model.md](03-knowledge-model.md) — labels and relations the overlays read.
