# P1 Plan 2 — Project Atlas (deterministic synthesis)

**Date:** 2026-05-29
**Status:** Design approved, pending spec review
**Parent spec:** [P1 — Atlas, Health, Export Delta](2026-05-29-project-knowledge-lifecycle-p1-atlas-health-export-design.md) §4. This document is the focused design for the **atlas** capability (Plan 2 of four).
**Depends on:** the area-model backbone (`src/knowledge-areas/area-model.ts`, shipped — PR #14), P0 source sync (shipped).

---

## 1. Background & goal

P0 made a project's knowledge *ingestible and retrievable*; it did not make it *understandable at a glance*. There is no
artifact a human or agent can read to grasp what a project is, how its areas relate, how to operate it, and where it is
thin. The atlas is that artifact: five deterministic Markdown files synthesized from already-ingested knowledge.

This is the synthesis half of the vision's "first-time project understanding." The ingestion half ships in P0 (first
`tuberosa sync` ingests the whole repo); the atlas turns that corpus into a readable map.

**Goal:** a `tuberosa atlas` trigger (CLI + MCP + auto-after-sync) that writes `project-map.md`, `flows.md`,
`commands.md`, `risks.md`, and `open-gaps.md` to `.tuberosa/atlas/`, fully deterministically.

## 2. Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Synthesis | **Deterministic-only; LLM gloss deferred entirely** | `ModelProvider` has no text-generation seam (only `embed`/`rewriteQuery`/`rerank`); the deterministic atlas already delivers the understanding payoff and is 100% eval-gated. Gloss is a later increment. |
| Categorization | **Reuse the shipped `buildAreaModel`** | The shared area-model spine (directory + label/graph overlays) is already merged. |
| `project-map.md` density | **Standard** | Purpose line + labels + key files + key symbols + counts + dependency links — orients without a wall of text. |
| Purpose line | **Fallback chain** | Top wiki/spec summary → dominant labels → `(no description — see open-gaps.md)`; never fabricates, feeds `open-gaps.md`. |
| `flows.md` | **Area dependency map + co-change coupling, best-effort** | Tuberosa relations are `supersedes/refines/depends_on/co_changes_with/related_to` — there is **no `calls` edge**. Architecture-flow view, not a call trace. |
| Lifecycle | **On-demand + auto (non-fatal) after `sync --apply`**; output to `.tuberosa/atlas/` | Tracks the ledger; a failed build never fails a sync. |
| Migration | **`012_atlas_runs.sql` (atlas only)** | Renumbered from the parent spec's combined migration; the export plan's `semantic_duplicate` columns ship in their own later migration since they are a separate plan. |

## 3. Architecture — pure builders behind one service

```
src/atlas/
  inputs.ts     // gather one immutable AtlasInputs snapshot from the store + repo
  builders.ts   // 5 pure functions: AtlasInputs → markdown string (one per file)
  service.ts    // AtlasService.regenerate(): inputs → builders → hash → write → record run
```

All builders are pure `(AtlasInputs) => string`, making each golden-snapshot testable with `HashModelProvider`.
`AtlasInputs` is computed once and includes a **shared area-dependency graph** that both `project-map.md` and
`flows.md` consume.

```ts
interface AreaDepEdge { from: string; to: string; weight: number } // area key → area key

interface AtlasInputs {
  project: string;
  repoPath: string;
  areas: ProjectArea[];                 // from buildAreaModel
  atoms: KnowledgeAtom[];               // listAtoms({ project })
  knowledge: StoredKnowledge[];         // listKnowledge({ project })
  relations: AtomRelationRow[];         // listAtomRelations({ project })
  ledger: SourceFileRecord[];           // listSourceFiles({ project })
  knowledgeGaps: KnowledgeGap[];        // listKnowledgeGaps({ project })
  openConflictCount: number;            // atom_import_conflicts status='open'
  scripts: Record<string, string>;     // package.json scripts (repoPath)
  readmeCommands?: string;             // optional README "Commands" section
  areaDeps: AreaDepEdge[];             // shared dependency graph
  generatedAt: string;                 // passed in (determinism); never Date.now() inside builders
}
```

`areaDeps` is built by mapping each `depends_on`/`refines` atom relation to its endpoints' area keys (via the same
trigger/evidence path logic the area model uses), dropping intra-area edges, and summing weights per `(from,to)`.
Cross-area `references` on knowledge items contribute additional weight.

## 4. The five files

Every file begins with a header block: `<!-- atlas_run <id> · input <hash8> · generated <iso> -->` plus a one-line
nav linking the other four files.

### `project-map.md` (entry point, Standard density)

Per area, sorted by area key:

```
## src/retrieval — Retrieval
Search pipeline area. labels: domain/retrieval, business_area/search
key files:   service.ts, fusion.ts, context-fit.ts
key symbols: searchContext, assembleContextPack, classifyQuery
files 12 · knowledge 9 · atoms 4 (2 verified) · crossing edges 6
→ depends on: src/storage, src/model
```

- **Purpose line:** fallback chain (§2). Wiki/spec chosen as the area's highest `trustLevel` item of `itemType ∈
  {wiki, spec}`; its `summary` (else first sentence of `content`) is used.
- **key files:** top-N (default 5) paths in the area ranked by referencing knowledge+atom count, then path.
- **key symbols:** top-N (default 8) from atom `trigger.symbols` + `symbol`-type labels, ranked by frequency then name.
- **depends on:** area keys from `areaDeps` where `from` = this area, ranked by weight then key.

### `flows.md` (best-effort)

- **§1 Area dependency map** — `areaDeps` rendered as a sorted adjacency list (`area → area (weight)`). Empty → a note:
  "No cross-area dependencies inferred yet."
- **§2 Co-change coupling** — `co_changes_with` relations aggregated to file/area pairs. Empty → "No co-change data —
  run `pnpm run infer-co-change` to populate temporal coupling." 
- File header notes it is best-effort and links `open-gaps.md`.

### `commands.md`

`package.json` scripts grouped deterministically by name prefix:

| Group | Match |
|---|---|
| Build & Dev | `build*`, `dev*`, `start`, `workbench*` |
| Test & Eval | `test*`, `eval:*`, `sandbox*`, `benchmark`, `calibrate-fusion` |
| Data & Maintenance | `backfill*`, `archival-sweep`, `infer-co-change`, `prune-stale-edges`, `cluster-*`, `migrate*`, `seed*`, `import:docs`, `backup`, `restore` |
| Packs | `export-pack`, `import-pack` |
| Ops | `mcp`, `worker`, `error-logs`, `organization`, `context-quality` |
| Other | anything unmatched |

Each entry: `` `pnpm run <name>` `` + the raw script. A README "Commands" section, if present, is appended verbatim
under a "From README" subsection.

### `risks.md`

- `gotcha`-type atoms with their `pitfalls`/claim (sorted by tier then claim).
- Knowledge whose `metadata.sourcePath` maps to a `changed` or `missing` ledger row (stale risk), grouped by area.
- A one-line count of open `atom_import_conflicts`.

### `open-gaps.md`

- Areas whose purpose line fell through to `(no description)` — undocumented areas.
- Areas with no verified/canonical atom or no wiki — thin coverage.
- The `knowledge_gaps` table entries.
- Atoms with no `verification.command` — unverifiable claims.

## 5. `AtlasService` & lifecycle

`AtlasService.regenerate({ project, repoPath, write })`:

1. Build `AtlasInputs` (one pass over the store + `package.json`/README).
2. Run the five builders → `{ name, content }[]`.
3. Compute `inputHash = sha256OfBuffer(canonicalInputsJson)` (reuse `src/export/manifest.ts`); the hash covers inputs,
   **not** `generatedAt`, so an unchanged project yields a stable hash.
4. If `write`: `mkdir -p` `atlasDir` and write the five files; insert one `atlas_runs` row.
5. Return `{ atlasRunId, inputHash, files: [{ name, bytes }] }`.

**Sync hook:** the final step of `SourceSyncService.apply` (`src/source-sync/service.ts:140`) calls
`regenerate({ write: true })` inside a try/catch — on error it logs to stderr and returns; **the sync result is
unaffected**. Gated by config `atlasAutoRegen` (default `true`).

## 6. Surfaces (all additive)

- **CLI:** `tuberosa atlas [--project p] [--path repo] [--write] [--json]` — new `bin/commands/atlas.ts`, a `case
  'atlas'` in `bin/tuberosa.ts`. Default prints a summary (file names + bytes + staleness); `--write` persists;
  `--json` emits the `regenerate` result.
- **MCP tool:** `tuberosa_get_atlas({ project, file? })` — returns one named file or all five (regenerating in-memory if
  none on disk). Registered in `src/mcp/server.ts`.
- **MCP resources:** the five atlas files added to `resources/list` and `resources/read` (`src/mcp/server.ts:82`), URIs
  like `tuberosa://atlas/project-map.md`.

## 7. Data model

**Migration `012_atlas_runs.sql`:**

```sql
CREATE TABLE atlas_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  input_hash   text NOT NULL,
  files        jsonb NOT NULL DEFAULT '[]',   -- [{ name, bytes }]
  generated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_atlas_runs_project ON atlas_runs(project_id, generated_at DESC);
```

`KnowledgeStore` gains `createAtlasRun(input)` and `getLatestAtlasRun(project)`; implemented in both
`PostgresKnowledgeStore` and `MemoryKnowledgeStore`. Staleness = current `inputHash` ≠ latest run's `input_hash`
(consumed by the dashboard plan later).

**Config:** `TUBEROSA_ATLAS_DIR` (default `.tuberosa/atlas`), `TUBEROSA_ATLAS_AUTO_REGEN` (default `true`).

## 8. Verification plan

Nothing merges red.

- **Unit (golden snapshots, Memory store + Hash provider):** each of the five builders over a fixed fixture corpus is
  byte-stable across runs; the purpose-line fallback chain hits all three branches; `areaDeps` drops intra-area edges
  and sums cross-area weight; `commands.md` grouping assigns every fixture script to the right group; `flows.md` emits
  the correct empty-state notes when relations are absent.
- **`AtlasService`:** same inputs → same `inputHash`; `regenerate({ write:true })` writes exactly five files and inserts
  one `atlas_runs` row; `getLatestAtlasRun` returns it.
- **Sync hook:** `apply` regenerates the atlas; an injected builder error logs but `apply` still returns its normal
  `ApplyResult`.
- **CLI/MCP:** `tuberosa atlas --json` returns the result shape; `tuberosa_get_atlas` returns content; the five files
  appear in `resources/list`.
- **Integration (Docker Postgres):** `atlas_runs` round-trips; staleness flips after inputs change.
- **Retrieval eval gate:** `pnpm run eval:retrieval` stays green — no retrieval-pipeline change, **no new retrieval
  fixture required** (parent spec §8).

## 9. Safety rules (invariants)

1. **Atlas is derived, never authoritative** — a failed build never fails a sync; the store is the source of truth.
2. **No fabrication** — every line traces to stored data; absent data becomes an explicit gap note, never invented prose.
3. **Deterministic** — identical inputs produce byte-identical files (modulo the `generatedAt` header line).
4. **No silent exclusion** — `_unassigned`/`_root` areas and empty sections are rendered with honest notes.

## 10. Out of scope (later increments / plans)

- **LLM gloss** (narrative prose; needs a `ModelProvider` generation seam) — deferred.
- **Categorized export + semantic-merge** (Plan 3), **health dashboard incl. atlas-staleness UI** (Plan 4).
- **Rich execution-flow / call-trace tracing** — P2 Graph-RAG.
