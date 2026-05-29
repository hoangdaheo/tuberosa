# Project Knowledge Lifecycle — P0: Source Lifecycle Sync

**Date:** 2026-05-29
**Status:** Design approved, pending spec review
**Scope:** P0 slice of the larger "Project Knowledge Lifecycle" vision (4 capabilities). This document specs P0 only.

---

## 1. Background & current state

Tuberosa has pieces of a knowledge lifecycle but not a cohesive one. Verified against the code:

- **Deleted files:** only partial. `IngestionService.deleteStaleAtoms` (`src/ingest/service.ts:143`) →
  `PostgresKnowledgeStore.deleteStaleFileAtoms` (`src/storage/postgres-store.ts:189`) removes stale **atomic-mode**
  atoms for the **same** `sourcePath`, and only when that file is **re-ingested**. There is no repo-wide scan that
  detects deleted files and archives the knowledge that referenced them.
- **First-time understanding:** `tuberosa init` (`bin/commands/init.ts`) boots the stack and runs migrations but does
  **not** ingest or analyze the codebase.
- **Source identity:** `knowledge_sources` (`migrations/001_init.sql:17`) is keyed
  `UNIQUE (project_id, uri, content_hash)`. Re-ingesting a *changed* file creates a **new** source row and orphans the
  old one (`knowledge_items.source_id` is `ON DELETE SET NULL`). There is no durable "one row per file path" ledger.
- **Archival precedent:** atoms already support an `archived` status (`migrations/006_atom_archival.sql`) and a
  `tuberosa_resurrect_atom` tool. `knowledge_items.status` is plain text (default `approved`); retrieval filters
  `status='approved'`, so any non-approved status is already excluded from agent results.

### The larger vision (context, not P0 scope)

1. **Source lifecycle sync** — detect add/change/rename/delete; update/archive/remove knowledge; reviewable plans. **← P0**
2. **First-time project understanding** — initial project map/atlas on init.
3. **Human-readable export/import** — categorized bundles, provenance, semantic merge review.
4. **Graph-RAG-style retrieval** — path-explained retrieval across files/symbols/errors/decisions/sessions/commits.

P0 builds the engine and ledger that the other three depend on. Because the chosen action scope is **full
add/change/rename/delete**, the **first** `tuberosa sync` on an empty ledger ingests the whole repo — so P0 also
delivers the *ingestion half* of capability #2. The **synthesized atlas** (`project-map.md`, `flows.md`, `risks.md`)
is deferred to P1 (it is analysis over already-ingested knowledge, not file plumbing).

---

## 2. Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Trigger model | **All three**: CLI, MCP tool, git hook — as thin wrappers over one engine | User wants on-demand, agent-driven, and commit-aware entry points |
| Detection | **Git-first, FS fallback** | `git diff -M` gives exact rename detection for free; FS walk covers non-git/dirty trees |
| Ledger model | **New `source_files` table** (no FK backfill onto knowledge) | Clean per-path authority; smallest schema disturbance to the hot ingest path |
| Action scope | **Full add/change/rename/delete** | Most value; first sync doubles as first-time ingest |
| Destructive default | **Archive (tombstone), never hard-delete; always human/agent-reviewed** | Core safety rule: no silent destructive cleanup |
| Atlas synthesis | **Deferred to P1** | Synthesis layer, not file plumbing |

---

## 3. Architecture — one engine, three wrappers

A `SourceSyncService` (`src/source-sync/`) is the single authority. It produces a `SyncPlan` and, on confirmation,
applies it. The three triggers are thin adapters:

| Wrapper | Behavior | Destructive default |
|---|---|---|
| `tuberosa sync` (CLI) | Dry-run prints plan; `--apply` executes | Archives need `--apply` + interactive confirm (or `--yes`) |
| `tuberosa_sync_sources` (MCP) | Returns structured plan; apply via `planId` | Always returns archives for the agent to surface to the user |
| git post-commit / post-merge hook | Auto-applies **additive** ops (add/change/rename) from the commit diff | **Never auto-archives** — queues deletes to `.tuberosa/pending-sync.json` + workbench |

**Core safety rule made structural:** additive ops may flow automatically; destructive ops (archiving knowledge for a
vanished file) always require a human or agent in the loop.

**Detection:** git mode uses `git ls-files` for inventory and `git diff -M <last_synced_sha>..HEAD` for
add/change/rename/delete classification with exact rename detection. FS mode walks the repo (respecting `.gitignore`),
hashes each file, diffs against the ledger, and infers renames by matching the content-hash of a vanished path to a new
path.

---

## 4. Data model

### New migration `011_source_files.sql`

```sql
CREATE TABLE source_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path text NOT NULL,                          -- repo-relative, canonical
  content_hash text,                           -- latest synced hash; null when archived
  status text NOT NULL DEFAULT 'tracked',      -- tracked | changed | missing | archived | ignored
  last_synced_sha text,                        -- git SHA at last sync (null in FS mode)
  prior_paths text[] NOT NULL DEFAULT '{}',    -- rename history
  knowledge_count integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (project_id, path)
);

CREATE TABLE sync_runs (                        -- audit: every plan + apply outcome
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode text NOT NULL,                           -- git | fs
  from_sha text, to_sha text,
  plan jsonb NOT NULL,                          -- the SyncPlan snapshot
  applied boolean NOT NULL DEFAULT false,
  trigger text NOT NULL,                        -- cli | mcp | git_hook
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
```

### `knowledge_items` archival (same migration)

- Add `'archived'` to the accepted status vocabulary and stamp
  `metadata.archive = { reason: 'source_deleted', sourcePath, syncRunId }`.
- Retrieval already filters `status='approved'`, so archived items drop out of agent results automatically while
  remaining visible in workbench/health views. **This is the tombstone:** a future agent asking about a dead file can
  be told "this path no longer exists" instead of getting silence.
- Resurrect = flip status back to `approved` (lossless). Atoms reuse the existing `archived` status +
  `tuberosa_resurrect_atom`.

### Linkage (no FK backfill)

Dead-path → knowledge linkage is resolved at plan-build time from existing fields:
`knowledge_items.metadata->>'sourcePath'`, `knowledge_sources.uri`, and atom `sourcePath`. No new FK column in P0.

---

## 5. The SyncPlan & apply semantics

`SyncPlan` is the one object every wrapper produces and apply consumes. It is persisted to `sync_runs.plan` so a plan
reviewed at time T applies exactly what was reviewed. Apply re-validates content hashes per entry and **skips** any entry
whose on-disk hash no longer matches the plan (the rest of the run continues; skipped entries are reported). No TOCTOU
drift; no whole-run abort.

```ts
interface SyncPlan {
  project: string;
  repoPath: string;
  mode: 'git' | 'fs';
  fromSha?: string; toSha?: string;
  added:   { path: string; sizeBytes: number; willIngestAs: ItemType }[];
  changed: { path: string; oldHash: string; newHash: string; knowledgeIds: string[] }[];
  renamed: { from: string; to: string; similarity: number }[];
  deleted: { path: string; knowledgeIds: string[]; atomIds: string[]; chunkCount: number }[];
  ignored: { path: string; reason: 'gitignored' | 'excluded' | 'too_large' | 'binary' }[];
  summary: { added: number; changed: number; renamed: number; deleted: number; ignored: number };
  destructive: boolean; // true iff deleted.length > 0
}
```

### Apply order (transactional per item, idempotent overall)

1. **added** → `IngestionService.ingestFiles` (existing path; `itemType` inferred). Insert ledger row `status=tracked`.
2. **changed** → re-ingest via `ingestFiles`. Atomic files ride the existing `deleteStaleAtoms`; document-mode files
   delete the prior version's knowledge (old `source_id`) so at most one live source version exists per path (bounds the
   accumulating-source-rows problem). Update ledger `content_hash`/`last_synced_sha`.
3. **renamed** → **re-point, do not re-ingest.** Update `source_files.path` (push old onto `prior_paths`), update
   `knowledge_items.metadata.sourcePath` + `knowledge_sources.uri` + atom `sourcePath`. Knowledge, labels, references,
   embeddings preserved. A git rename *with* content change above the similarity threshold is split into rename + change.
4. **deleted** → **archive, never hard-delete.** Set `knowledge_items.status='archived'` + tombstone metadata; atoms →
   `archived`; ledger row → `missing`/`archived`. Chunks/labels/refs stay attached so resurrect is lossless.

Re-running a plan whose hashes already match is a no-op.

### File-selection policy (`config/source-sync-policy.json`, with defaults)

- Inventory from `git ls-files` (honors `.gitignore`) or FS walk respecting `.gitignore`.
- **Exclude defaults:** lockfiles, `dist/`, `build/`, `node_modules/`, binaries/images by extension, `.tuberosa/`, `.env*`.
- **Size cap:** reuse the existing `maxContentBytes` guard → over-cap files become `ignored: too_large`.
- **Include:** everything else; `itemType` via existing `inferItemTypeFromPath` (`.md`→wiki, spec-like→spec, else code_ref).
- Overridable per project. `ignored` entries always appear in the plan — silent exclusion must never read as "covered."

---

## 6. Surfaces

**MCP** (additive; no changes to existing tool signatures):
- `tuberosa_sync_sources` — `{ project, path?, apply?: false, planId? }`. Default returns the plan and writes a
  `sync_runs` row. `apply:true` + `planId` executes; archives are always echoed in the response.

**CLI:** `tuberosa sync [--project p] [--path repo] [--apply] [--yes] [--json]`. Dry-run by default; `--apply` runs
additive ops; archives additionally require interactive confirm or `--yes`. `--json` for scripting/hooks.

**git hook:** `tuberosa hook install` writes a post-commit/post-merge hook running `tuberosa sync --apply --json`,
auto-applying additive ops and writing any `deleted` set to `.tuberosa/pending-sync.json` (+ a workbench "pending
cleanup" badge) instead of archiving.

**Workbench:** a **Source Health** panel — counts of tracked/changed/missing files, pending cleanup plans with
approve/reject, and a tombstone list (archived knowledge + dead path + resurrect button). Seed of the later
"knowledge health dashboard."

---

## 7. Verification plan

Nothing merges red.

- **Unit** (`MemoryKnowledgeStore`, `HashModelProvider`): git-diff parser (renames; rename+edit split), FS-walk +
  content-hash differ, plan builder (each change class + every `ignored` reason), apply ordering, rename re-point
  preserves knowledge IDs, archive→resurrect round-trip is lossless.
- **Integration** (`pnpm run test:integration`, Docker Postgres): archiving sets `status='archived'` and the item
  disappears from `searchContext` but appears in workbench; resurrect restores retrievability; changed-file re-ingest
  leaves exactly one live source version.
- **End-to-end round-trip:** empty ledger → first `sync` ingests N files → delete a file → `sync` plans 1 deletion →
  apply archives it → `searchContext` no longer returns it → resurrect → returns again.
- **Retrieval eval gate:** `pnpm run eval:retrieval` stays green. New fixture: a deleted-then-archived item must be
  stale-rejected/absent — proving the freshness win and satisfying the repo rule that retrieval changes need a fixture
  that would fail without them.
- **Export/import** round-trip untouched in P0.

---

## 8. Safety rules (invariants)

1. **No silent destructive cleanup.** Archiving requires explicit human/agent confirmation in every wrapper; the git
   hook never archives.
2. **Archive, don't delete.** Deleted-file knowledge is tombstoned and fully resurrectable; nothing is hard-deleted in P0.
3. **Preserve provenance.** Renames keep knowledge IDs and history (`prior_paths`); tombstones record the dead path.
4. **No silent exclusion.** Every ignored/skipped file is reported in the plan.
5. **Plan/apply integrity.** Apply re-validates hashes against the persisted plan; mismatches are skipped, not forced.

---

## 9. Out of scope for P0 (roadmap)

- **P1:** synthesized project atlas (`project-map.md`, `flows.md`, `commands.md`, `risks.md`, `open-gaps.md`);
  human-readable categorized export + provenance/semantic-merge import review (capability #3); knowledge health dashboard.
- **P2:** Graph-RAG retrieval with path explanations (capability #4); contributor lineage/timeline in bundles.
