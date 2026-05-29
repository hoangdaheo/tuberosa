# Project Knowledge Lifecycle — P1: Atlas, Health, Export Delta

**Date:** 2026-05-29
**Status:** Design approved, pending spec review
**Scope:** P1 slice of the "Project Knowledge Lifecycle" vision. Covers three of the vision's capabilities; P2 (Graph-RAG retrieval, contributor lineage) is out of scope and specced separately.
**Depends on:** [P0 — Source Lifecycle Sync](2026-05-29-project-knowledge-lifecycle-p0-source-sync-design.md) (shipped), [Project Export Bundle](2026-05-26-project-export-bundle-design.md) (shipped).

---

## 1. Background & current state

P0 delivered the source lifecycle engine: the `source_files` ledger (`migrations/011_source_files.sql`),
`SourceSyncService` (`src/source-sync/service.ts`), three sync wrappers, and the workbench Source Health counts. The
*ingestion half* of "first-time project understanding" already ships with P0 — the first `sync` on an empty ledger
ingests the whole repo. What P0 explicitly deferred is the **synthesis layer**: turning ingested knowledge into a
human- and agent-readable project atlas.

Two adjacent subsystems are already built and P1 extends rather than rebuilds them:

- **Export bundle** (`src/export/`, shipped) writes human-readable `.md` atoms/knowledge with YAML frontmatter, a
  `manifest.json` with provenance (`sourceCommit`, counts, integrity), and a full import-conflict review flow
  (`atom_import_conflicts`, migration 009; workbench "Import conflicts" tab; `tuberosa_list/resolve_atom_import_conflict`).
  Today the layout is **flat** (`atoms/`, `knowledge/`) and conflict detection is **byte-diff only**.
- **Workbench Source Health** (`src/operations/workbench-summary.ts`, `src/types/workbench.ts`) reports
  tracked/changed/missing file counts, pending cleanup plans, and tombstones.

So P1 is mostly **synthesis and read-side surfacing over data that already exists**, plus two well-bounded deltas on
shipped subsystems. There is no change to the retrieval ranking pipeline.

### The larger vision (context, not P1 scope)

1. **Source lifecycle sync** — *shipped (P0).*
2. **First-time project understanding** — ingest shipped in P0; **synthesized atlas is P1.** ← this doc
3. **Human-readable export/import** — bundle shipped; **categorized layout + semantic-merge review is P1.** ← this doc
4. **Graph-RAG retrieval** — path-explained retrieval; contributor lineage in bundles. **P2, deferred.**

### Why these three ship together

All three need the same primitive: a way to **partition project knowledge into areas**. The atlas's section
structure, the categorized bundle's folder layout, and the dashboard's per-area rows are the same partition viewed
three ways. P1 builds that partition once (the **area model**, §3) and reuses it three times. Splitting the
capabilities across specs would fragment the shared backbone, so they share one design. Implementation may still be
sequenced as separate plans (§9).

---

## 2. Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Atlas synthesis | **Hybrid**: deterministic skeleton is canonical + eval-gated; optional LLM gloss narrates it | Keeps the no-API-key / `HashModelProvider` invariant; degrades cleanly; still gives narrative payoff |
| Categorization axis | **Directory structure as spine + labels/graph as overlays** | Always present (ledger has every path), deterministic, matches how devs navigate; robust when labels are sparse |
| Atlas lifecycle | **Auto after every `sync --apply`, written to `.tuberosa/atlas/`, + on-demand** | Tracks the ledger automatically; never silently stale; ties into P0 |
| `flows.md` source | **Tuberosa's own knowledge graph, best-effort** | Rich execution-flow tracing is P2's Graph-RAG job; P1 emits a thin section + open-gap note when the graph is sparse |
| Semantic merge | **Always queue as a `semantic_duplicate` conflict for human review; nothing auto-merges** | Consistent with the existing conflict flow and the repo's human-in-loop safety rule |
| Dashboard scope (v1) | **Freshness + coverage gaps per area + open conflicts (byte+semantic) + decay**, atop shipped counts/tombstones | All computable from existing data; each answers a distinct "is my knowledge healthy?" question |

---

## 3. The shared primitive — the area model

A single deterministic module is the backbone for all three capabilities.

```
src/knowledge-areas/area-model.ts
  buildAreaModel(store, project): Promise<ProjectArea[]>
```

```ts
interface ProjectArea {
  key: string;                 // canonical area key, e.g. "src/retrieval"
  label: string;               // human label, e.g. "Retrieval"
  paths: string[];             // source_files paths under this area (from the P0 ledger)
  knowledgeIds: string[];      // knowledge whose metadata.sourcePath falls in this area
  atomIds: string[];           // atoms whose trigger/evidence paths fall in this area
  labels: { type: string; value: string }[]; // domain/business_area labels seen here (overlay)
  crossingRelations: number;   // graph edges crossing this area's boundary (overlay)
  counts: { files: number; knowledge: number; atoms: number; verifiedAtoms: number };
}
```

**Spine:** top-level repo directories drawn from the `source_files` ledger (configurable depth; default 1 segment
under `src/`, else top segment). **Overlays:** `domain`/`business_area` labels and atom-graph relations annotate each
area but never define it. Pure and deterministic — no model calls — so it is unit-testable and eval-gated. Items with
no resolvable path collect under a sentinel `_unassigned` area.

**Consumers:** `project-map.md` sections, `areas/<area>/` export folders, and dashboard "coverage gaps per area" rows
all read `buildAreaModel`. Build once, reuse three times.

---

## 4. Atlas (`src/atlas/`)

### 4.1 Hybrid synthesis

```
src/atlas/
  synthesize.ts   // one deterministic builder per file → string (the canonical artifact)
  gloss.ts        // optional narrative pass over a built file (OpenAiModelProvider only)
  service.ts      // AtlasService: orchestrates build → (optional gloss) → write → record run
```

The deterministic builder is the source of truth. When `TUBEROSA_MODEL_PROVIDER` resolves to a real LLM, `gloss.ts`
adds prose **around** the deterministic structure — it may rephrase headings and add summary paragraphs but must not
introduce facts, IDs, paths, or commands that are not already in the deterministic artifact (enforced by a post-gloss
assertion that every code-fence/path/command token in the output also appears in the deterministic input). With
`HashModelProvider`, gloss is skipped entirely and the deterministic artifact is the final output.

### 4.2 The five files

| File | Deterministic source | Degradation |
|---|---|---|
| `project-map.md` | The area model: each area with its files, key symbols (from atom triggers), knowledge/atom counts, and cross-links to other areas. | Always populated (ledger is authoritative). |
| `flows.md` | Tuberosa's atom relations (`depends_on`, `calls`, `co_changes_with`) + cross-file references between areas. **Best-effort.** | Sparse graph → a short section that names the gap and links to `open-gaps.md`. Rich flows are P2. |
| `commands.md` | `package.json` scripts + a "Commands" section parsed from README, if present. | Fully deterministic; empty scripts → empty section with a note. |
| `risks.md` | `gotcha`-type atoms and their `pitfalls`, knowledge tied to changed/missing ledger files (stale risk), open conflicts, high-churn areas. | Always derivable from existing fields. |
| `open-gaps.md` | Coverage gaps (thin areas from the area model) + the `knowledge_gaps` table (migration 002) + atoms missing verification commands. | Always derivable. |

Each file carries a header block recording the generating `atlas_run` id, input hash, and generated-at, so a reader
(human or agent) can tell how fresh it is.

### 4.3 Lifecycle

`AtlasService.regenerate(project)` runs:

1. **On every apply** — invoked as the final step of `SourceSyncService.apply` (`src/source-sync/service.ts:140`,
   after `applyPlan`). All three sync wrappers (CLI, MCP, git hook) refresh the atlas automatically. Failure to
   regenerate is logged but never fails the sync (atlas is derived, not authoritative).
2. **On demand** — `tuberosa atlas` CLI and `tuberosa_get_atlas` MCP tool.

Output writes to `.tuberosa/atlas/*.md` (new config key `atlasDir`, default `.tuberosa/atlas`, mirroring
`physicalMirrorDir` at `src/config.ts:111`). Files are exposed as MCP resources alongside the existing physical-mirror
resources. Every run records an `atlas_runs` row (input content-hash over the area model + relevant tables) so the
dashboard can flag staleness when the current inputs no longer match the last run's hash.

---

## 5. Export/import delta (`src/export/`)

### 5.1 Categorized layout

`exporter.ts` reorganizes the flat layout into area folders using the area model:

```
.tuberosa-pack/
  manifest.json            ← gains an `areas` index: { key, label, atomCount, knowledgeCount }[]
  areas/
    src-retrieval/
      atoms/<slug>-<id>.md
      knowledge/<slug>-<id>.md
    src-storage/
      ...
    _unassigned/
      ...
  edges.jsonl              ← unchanged (single file, area-agnostic)
  chunks/                  ← unchanged
  README.md
```

`manifest.json` gains `layout: "categorized"` (vs. legacy implicit `"flat"`) and an `areas` index. Area folder names
are filesystem-safe slugs of the area key.

### 5.2 Backward-compatible import

`importer.ts` reads `manifest.layout`: `"flat"` (or absent) → walk `atoms/` + `knowledge/` as today; `"categorized"`
→ walk `areas/*/atoms` + `areas/*/knowledge`. The atom/knowledge file format is unchanged, so a categorized pack and a
flat pack import to identical store state. **Old flat packs continue to import unchanged** (a verification case, §8).

### 5.3 Semantic-duplicate review

During import, before inserting an incoming atom as a new draft, the importer embeds its claim
(`ModelProvider.embed`) and compares against local atoms **in the same area** via pgvector. Above a configurable
similarity threshold (`TUBEROSA_IMPORT_SEMANTIC_DUP_THRESHOLD`, default `0.92`), instead of inserting, it creates an
`atom_import_conflicts` row with `conflict_type='semantic_duplicate'` and a `similarity` score, carrying both atoms'
snapshots and a suggested merged claim. Nothing auto-merges. Resolution reuses the existing review tab and
`tuberosa_resolve_atom_import_conflict`, with a new `keep_both` action (inserts the import as a fresh draft,
acknowledging the two are genuinely distinct).

With `HashModelProvider` the embedding is deterministic, so the same near-duplicate pair always produces the same
conflict — making this eval-able (§8).

---

## 6. Health dashboard

A new **Knowledge Health** view in `workbench-v2`, backed by read-only aggregation in
`src/operations/workbench-summary.ts` (extending the shipped Source Health summary; surfaced via existing HTTP
operations routes and a `tuberosa_get_workbench_summary` field). Sections:

| Section | Source | Status |
|---|---|---|
| File counts + tombstones | `source_files` ledger | shipped (P0) |
| **Freshness** | knowledge/atoms whose `sourcePath` maps to a `changed`/`missing` ledger row | new |
| **Coverage gaps per area** | area model: areas with zero/thin knowledge, no verified atom, or no wiki | new |
| **Open conflicts** | `atom_import_conflicts` where `status='open'`, split by `conflict_type` (byte vs `semantic_duplicate`), linking into the Import Conflicts tab | new |
| **Decay** | atoms with low reuse, stale verification, or `superseded` chains | new |
| **Atlas staleness** | `atlas_runs`: current input-hash vs. last run's | new |

All sections are read-only counts + drill-down lists. No new write paths. "Coverage gaps per area" pairs directly with
`open-gaps.md` — the same area-model computation rendered interactively.

---

## 7. Data model & surfaces

### Migration `012_atlas_and_semantic_conflicts.sql`

```sql
CREATE TABLE atlas_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  input_hash  text NOT NULL,                 -- content-hash over area model + source tables
  files       jsonb NOT NULL DEFAULT '[]',   -- [{ name, bytes, glossed }]
  glossed     boolean NOT NULL DEFAULT false,
  generated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_atlas_runs_project ON atlas_runs(project_id, generated_at DESC);

-- extend the shipped import-conflict table (migration 009)
ALTER TABLE atom_import_conflicts ADD COLUMN conflict_type text NOT NULL DEFAULT 'byte';
ALTER TABLE atom_import_conflicts ADD COLUMN similarity real;
ALTER TABLE atom_import_conflicts DROP CONSTRAINT atom_import_conflicts_status_check;
ALTER TABLE atom_import_conflicts ADD CONSTRAINT atom_import_conflicts_status_check
  CHECK (status IN ('open','resolved_keep_local','resolved_take_imported',
                    'resolved_merged','resolved_keep_both','dismissed'));
```

`MemoryKnowledgeStore` gains matching in-process implementations so unit tests run without Postgres.

### Surfaces (all additive — no existing signatures change)

- **CLI:** `tuberosa atlas [--project p] [--write] [--json]` (regenerate on demand; `--write` persists, default prints).
  Atlas also auto-runs inside `tuberosa sync --apply`.
- **MCP:** `tuberosa_get_atlas({ project, file? })` returns one or all atlas files; atlas files registered as MCP
  resources. Existing `tuberosa_*` tool signatures are untouched.
- **Config:** `TUBEROSA_ATLAS_DIR` (default `.tuberosa/atlas`), `TUBEROSA_ATLAS_GLOSS` (default `auto` — on iff a real
  model provider is configured), `TUBEROSA_IMPORT_SEMANTIC_DUP_THRESHOLD` (default `0.92`).

---

## 8. Verification plan

Nothing merges red.

- **Unit** (`MemoryKnowledgeStore`, `HashModelProvider`): `buildAreaModel` partitions a fixture corpus correctly
  (spine from paths, label/graph overlays, `_unassigned` fallback); each atlas builder over a fixture corpus
  (golden-snapshot per file); gloss assertion rejects an output that introduces an unknown path/command; semantic-dup
  detection produces exactly one `semantic_duplicate` conflict for a near-duplicate pair and **no auto-merge**.
- **Golden snapshots:** the five deterministic atlas files over a fixed corpus are byte-stable across runs (gloss off),
  so regressions are caught by diff.
- **Integration** (`pnpm run test:integration`, Docker Postgres): `atlas_runs` records input-hash and staleness flips
  when inputs change; categorized export round-trips through import to identical store state; **an old flat pack still
  imports unchanged**; dashboard aggregation queries return the expected freshness/coverage/conflict/decay counts.
- **Retrieval eval gate:** `pnpm run eval:retrieval` stays green. **No new retrieval fixture is required** — P1 adds
  synthesis and read-side surfaces only; it does not touch the classifier, fusion, reranking, context-pack assembly, or
  context-fit logic. This is called out explicitly to satisfy the repo rule (a retrieval *fixture* is required only for
  retrieval *ranking* changes, of which there are none here).
- **Atlas-after-sync:** end-to-end — `sync --apply` regenerates `.tuberosa/atlas/*.md`; a failing atlas build logs but
  does not fail the sync.

---

## 9. Implementation sequencing (non-binding)

Although this is one spec, the work decomposes into independently shippable plans, in dependency order:

1. **Area model** (`src/knowledge-areas/`) + its unit tests — the shared backbone everything else imports.
2. **Atlas** (`src/atlas/`, migration `012` `atlas_runs`, CLI/MCP, sync hook, golden snapshots).
3. **Export/import delta** (categorized layout, back-compat import, `semantic_duplicate` conflict + migration `012`
   column adds).
4. **Health dashboard** (workbench-summary extension + workbench-v2 view).

---

## 10. Safety rules (invariants)

1. **Atlas is derived, never authoritative.** A failed atlas build never fails a sync; the store is the source of truth.
2. **Gloss adds no facts.** The optional LLM pass cannot introduce paths, IDs, commands, or claims absent from the
   deterministic artifact; enforced by a post-gloss token assertion.
3. **No silent merges.** Semantic duplicates always queue for human/agent review; nothing auto-merges.
4. **No silent exclusion.** Items with no resolvable area appear under `_unassigned` in both the map and the bundle.
5. **Backward compatibility.** Old flat export bundles import unchanged.
6. **Deterministic core.** Every P1 feature has a deterministic, eval-gated path that works with `HashModelProvider`.

---

## 11. Out of scope for P1 (roadmap → P2)

- **Graph-RAG retrieval** with path explanations across files/symbols/errors/decisions/sessions/commits.
- **Contributor lineage / timeline** in export bundles.
- **Rich execution-flow tracing** in `flows.md` (P1 ships the best-effort, graph-derived version only).
- **Cross-project area linking** and bundle-to-bundle differential sync.
