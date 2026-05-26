# Project Export Bundle — Design (Concern E)

**Status:** Draft for review
**Date:** 2026-05-26
**Concern:** E in the six-concern decomposition (B → D → A → C → E → F)
**Depends on:** [B — Knowledge Atom Schema](2026-05-26-knowledge-atom-schema-design.md), [C2 — Graph Read-Side](2026-05-26-graph-relations-impact-propagation-design.md)
**Author:** Brainstorming session with user

---

## 1. Problem

Tuberosa accumulates per-project knowledge: atoms, edges, reviewed wikis, code references, chunks. None of that crosses machine boundaries today. A new teammate joining a project gets nothing from previous sessions; expertise lives in one developer's `.tuberosa/`. The user wants a portable artifact a teammate can install on their Tuberosa **and** edit, append to, and contribute back — not a one-way snapshot.

Three specific gaps:

1. **No export format** — `GET /operations/organization/atom-graph.jsonl` (from C2) streams atom data, but there's no packaging story for the rest (chunks, knowledge, manifest, integrity).
2. **No import path** — a receiving Tuberosa has no way to merge an incoming pack into its own DB.
3. **No collaborative editing story** — teammates can't open the bundle, edit a claim, drop a new atom, and contribute back without round-trip data loss.

## 2. Goal

A portable `.tuberosa-pack/` directory that is:

- **Human-readable and editable** — atoms and knowledge are individual markdown files with YAML frontmatter. Anyone with a text editor can read, edit, or append.
- **Importable** with a clear conflict-resolution flow — incoming atoms that collide with local ones never auto-overwrite; they queue for human review using the existing workbench review surface.
- **Versioned and integrity-checked** — a `manifest.json` records schema version, source commit, generated-at, and integrity hashes for the non-human files.
- **Stream-friendly** for receivers that want fast bulk import — one file per atom and per knowledge item, edges in a single JSONL, chunks in their own subdirectory.

## 3. Non-goals (deferred)

| Out of scope here | Belongs in |
|---|---|
| Cross-project graph linking (atoms from project A link to atoms in project B) | F or future |
| Differential / incremental sync between two Tuberosa instances | Future — for v1, full re-export is fine |
| Cryptographic signing of bundles | Future hardening; checksums only in v1 |
| Bundle search before import ("preview what's in this pack") | UI follow-up |
| Bundle hosting / discovery (a "Tuberosa pack registry") | Out of scope; bundles are just files |

## 4. Bundle layout

```
.tuberosa-pack/
  manifest.json
  atoms/
    <slug>-<short-id>.md         ← one atom per file
    ...
  knowledge/
    <slug>-<short-id>.md         ← wikis, specs, code_refs
    ...
  edges.jsonl                    ← all atom edges (one JSON per line)
  chunks/
    <knowledge-id>/
      <chunk-index>.txt          ← deep-context content (optional)
  README.md                      ← human guide: how to read, edit, import
```

Notes:

- Atoms and knowledge files have **YAML frontmatter** (structured) plus a Markdown body (the claim or the content). This is the editing surface for teammates.
- `edges.jsonl` is a single file because edges don't map naturally to one-per-file Markdown.
- `chunks/` is optional. Pack default includes chunks only for `tier ∈ (verified, canonical)` atoms and `wiki`/`spec` items, capped at `TUBEROSA_EXPORT_CHUNK_BUDGET_TOKENS` (default 200000). `--include-all-chunks` overrides.
- Archived atoms, `legacy_archived` knowledge, and `superseded` atoms are **excluded** by default. `--include-archived` overrides for audit-style snapshots.

## 5. Manifest format

```jsonc
{
  "schemaVersion": 2,
  "project":      "tuberosa",
  "generated":    "2026-05-26T15:00:00.000Z",
  "sourceCommit": "3eb6210",
  "tuberosaVersion": "0.x.y",
  "counts": {
    "atoms":      142,
    "knowledge":   38,
    "edges":      214,
    "chunks":     312
  },
  "integrity": {
    "edges.jsonl":  "sha256:abc...",
    "manifest_self": "sha256:..."
  },
  "tierPolicy": {
    "exportedTiers": ["draft","verified","canonical"],
    "excludedStatuses": ["archived","legacy_archived","superseded"]
  },
  "includesChunks": true,
  "notes": "Exported via `pnpm run export-pack`."
}
```

**Why integrity covers only `edges.jsonl` and itself:** atom and knowledge `.md` files are explicitly editable — checking their hashes would be hostile to the workflow. Edges are not human-edited (no good markdown shape), so a hash on them is meaningful. Manifest self-hash protects against truncated downloads.

## 6. Atom file format

`atoms/pgvector-column-dim-bf3a.md`:

```markdown
---
id:        bf3a-2b1f-4c2d-9a0e-...
revision:  3
project:   tuberosa
type:      gotcha
tier:      canonical
status:    active
trigger:
  errors:  ["vector dimension mismatch"]
  symbols: ["EMBEDDING_DIMENSIONS"]
  files:   ["migrations/001_init.sql"]
evidence:
  - kind:   file
    path:   migrations/001_init.sql
    lineStart: 14
verification:
  command: pnpm run eval:retrieval
pitfalls:
  - "Don't lower --fail-under-hit-rate to mask failures"
links:
  - to:    2a91-...
    kind:  refines
    confidence: 0.85
audit:
  producedBy: agent_session
  createdAt:  2026-05-12T...
  updatedAt:  2026-05-26T...
---

pgvector column dim must equal EMBEDDING_DIMENSIONS in config.
```

**Frontmatter is canonical.** The Markdown body is the human-readable claim. On import, the body is treated as the claim **unless** the frontmatter explicitly contains `claim:`. Editors can change either side.

`revision` is incremented automatically on every export. Teammates editing the file can also bump it manually; the importer uses `revision` only to detect "the source has moved on since I last imported." Actual conflict resolution is content-based (§9), not revision-based.

The filename pattern `<slug>-<short-id>.md` is derived from the claim and the first 4 hex chars of the id. Stable for the same atom across re-exports.

## 7. Knowledge file format

Same structure as atoms — frontmatter + body — for `itemType ∈ (wiki, spec, code_ref, workflow, rule, conversation)`. Memory-type items are now atoms after B, so they don't appear here.

```markdown
---
id:        e5d4-...
project:   tuberosa
itemType:  wiki
title:     "Pgvector tuning notes"
labels:
  - { type: domain,        value: retrieval }
  - { type: business_area, value: search }
references:
  - { type: file, uri: src/retrieval/policy.ts }
trustLevel: 70
audit:
  createdAt: 2026-04-12T...
  updatedAt: 2026-05-01T...
---

# Pgvector tuning notes

…long-form wiki content…
```

## 8. Edges file

`edges.jsonl` — one object per line:

```jsonc
{ "from": "bf3a-...", "to": "2a91-...", "kind": "refines", "confidence": 0.85, "inferenceSource": "semantic" }
{ "from": "bf3a-...", "to": "1c30-...", "kind": "co_changes_with", "confidence": 0.62, "inferenceSource": "co_change" }
```

Order: stable sort by `from`, then `to`, then `kind` so re-exports diff cleanly in git.

## 9. Import: conflict resolution

```
$ pnpm run import-pack -- --from /path/to/.tuberosa-pack
```

For each atom in the bundle:

| Local state | Bundle state | Action |
|---|---|---|
| Not present | Any | INSERT — local tier is forced to `draft` regardless of bundle tier. Bundle tier preserved in `metadata.import.sourceTier` so a reviewer can use it as a hint when promoting. |
| Present and identical | Any | NOOP — count as `unchanged`. |
| Present and differs from bundle | Any | Create an `atom_import_conflict` row; **do not change local state**. Surface in workbench review queue. |
| Marked deleted in bundle (future) | Any | Out of scope for v1. Deletion via re-export is intentionally not supported. |

For each edge in `edges.jsonl`:

| Local state | Bundle state | Action |
|---|---|---|
| Not present | Any | INSERT with `inference_source` set from bundle. |
| Present, same `(from, to, kind, source)`, same confidence | Any | NOOP. |
| Present, different confidence | Any | UPDATE to max(local, bundle) confidence. Edges are low-stakes; auto-merge is fine. |

**Why atoms get human review and edges don't:** atoms carry semantic claims a teammate could disagree with. Edges are mechanical inferences and their worst-case failure is a slightly wrong rank — recoverable through feedback.

### 9.a — Conflict review surface

A new table mirrors the pattern of `knowledge_gaps`:

```sql
-- migrations/009_atom_import_conflicts.sql
CREATE TABLE IF NOT EXISTS atom_import_conflicts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  atom_id         uuid REFERENCES knowledge_atoms(id) ON DELETE CASCADE,
  local_snapshot  jsonb NOT NULL,
  imported_snapshot jsonb NOT NULL,
  bundle_source   text NOT NULL,        -- e.g. file path or URL of the .tuberosa-pack
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','resolved_keep_local','resolved_take_imported','resolved_merged','dismissed')),
  resolution_notes text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_atom_import_conflicts_status
  ON atom_import_conflicts(project_id, status, created_at DESC);
```

HTTP routes:

```
GET   /operations/atom-import-conflicts            — list with filters
GET   /operations/atom-import-conflicts/:id        — diff view
POST  /operations/atom-import-conflicts/:id/resolve
       body: { action: 'keep_local' | 'take_imported' | 'merged', mergedSnapshot? }
```

Workbench gets a new tab "Import conflicts" rendering side-by-side diffs with the three buttons. Resolution writes the chosen state back to the atom and closes the row.

MCP tool:

```
tuberosa_list_atom_import_conflicts({ project, status? })
tuberosa_resolve_atom_import_conflict({ id, action, mergedSnapshot? })
```

## 10. Export command

```bash
pnpm run export-pack -- \
  --project tuberosa \
  --out .tuberosa-pack \
  --include-chunks         # default true; --no-include-chunks to skip
  --include-archived       # default false
  --max-chunk-tokens 200000
```

What it does:

1. Read atoms in `status='active'` and `tier ∈ {draft, verified, canonical}` (filter overridable).
2. Read non-memory knowledge in `status='approved'` and `legacy_status` is null.
3. Read edges via the existing `walkAtomGraph` / `listAtomRelations` path.
4. Write `.md` files with frontmatter + body. Filenames stable across re-exports.
5. Write `edges.jsonl` sorted.
6. Optionally write chunks.
7. Write `README.md` (a static template explaining how to read/edit/import).
8. Compute hashes, write `manifest.json`.
9. Print a one-line report: `Exported 142 atoms, 38 knowledge items, 214 edges, 312 chunks to .tuberosa-pack/`.

Idempotent: re-running on the same `--out` updates files in place. Removed-from-source items are removed from `--out` only when `--prune` is passed.

`--dry-run` writes nothing and prints what would be written.

## 11. Import command

```bash
pnpm run import-pack -- \
  --from /path/to/.tuberosa-pack \
  --project tuberosa            # default: derived from manifest.project
  --dry-run                     # report-only
  --on-conflict review|skip     # default 'review' (creates rows); 'skip' counts and ignores
```

Flow:

1. Read `manifest.json`; verify `schemaVersion` is supported.
2. Verify `edges.jsonl` checksum matches; warn if not.
3. For each atom `.md`: parse frontmatter; reconcile per §9.
4. For each knowledge `.md`: same.
5. For each edge: same.
6. For chunks: upsert into `knowledge_chunks` by `(knowledgeId, chunkIndex)`; skip when local chunk has a more recent `updatedAt`.
7. Emit a report: `inserted, unchanged, conflicts_queued, edges_inserted, edges_updated, chunks_inserted, chunks_skipped`.

HTTP endpoint mirrors the CLI:

```
POST /operations/import-pack
  multipart upload OR { remoteUrl }
  → { report, conflictIds[] }
```

MCP tool:

```
tuberosa_import_pack({ path? | remoteUrl?, project?, onConflict? })
```

## 12. Configuration

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_EXPORT_DEFAULT_OUT` | `.tuberosa-pack` | Default `--out` path. |
| `TUBEROSA_EXPORT_INCLUDE_CHUNKS` | `true` | Default for the chunks subdirectory. |
| `TUBEROSA_EXPORT_CHUNK_BUDGET_TOKENS` | `200000` | Cap on chunk content per export. |
| `TUBEROSA_EXPORT_INCLUDE_ARCHIVED` | `false` | Include `status='archived'` items. |
| `TUBEROSA_IMPORT_DEFAULT_CONFLICT_POLICY` | `review` | Or `skip`. |
| `TUBEROSA_EXPORT_FORMAT_VERSION` | `2` | Schema version baked into manifest; bump when frontmatter shape changes. |

## 13. Acceptance criteria

- ✅ `pnpm run export-pack -- --project tuberosa --out /tmp/pack` produces a `manifest.json`, `atoms/`, `knowledge/`, `edges.jsonl`, `chunks/`, and `README.md`. Counts in the manifest match file counts on disk.
- ✅ Every atom `.md` parses back to a valid `KnowledgeAtom` via the importer with no data loss.
- ✅ Editing one atom's `.md` body, then re-importing, surfaces an `atom_import_conflict` row (does not silently overwrite).
- ✅ Adding a new `.md` file with valid frontmatter to a pack, then importing, inserts the atom locally at `tier='draft'` with `metadata.import.sourceTier` set to the bundle's tier.
- ✅ Edge integrity: the SHA256 of `edges.jsonl` matches `manifest.integrity["edges.jsonl"]`.
- ✅ `--dry-run` on import emits a complete report without changing any local data.
- ✅ Workbench "Import conflicts" tab shows pending conflicts with a side-by-side diff and the three resolution buttons.
- ✅ Re-exporting the same project twice in a row produces byte-identical `edges.jsonl` and frontmatter (apart from `generated`).
- ✅ Importing a malformed pack (missing `manifest.json`, broken frontmatter) fails fast with a precise error.

## 14. Risks and open questions

| Risk | Mitigation |
|---|---|
| Teammate's local edit gets out of sync with source's re-export, conflict pile grows. | Conflict surface is first-class in workbench; can be batch-resolved. `--on-conflict=skip` lets a reviewer triage a backlog in chunks. |
| Markdown frontmatter is fragile to hand-editing (YAML indentation, quoting). | Importer error messages name the file and line. README.md template includes a copy-paste-ready skeleton. Future polish: a `pnpm run validate-pack` lint command. |
| Atoms imported as `draft` lose their earned tier from the source. | By design — tiers reflect *local* reuse evidence. `metadata.import.sourceTier` preserves the source's signal so reviewers can fast-track promotion. |
| Edges merged across two corpora reference atom ids that don't exist locally yet. | Importer processes atoms before edges in one pass. Edges whose endpoints are missing are queued for retry in a second pass after atom upserts complete. |
| Bundle path includes secrets accidentally (atoms with leaked credentials). | The existing `KnowledgeSafetyService` redacts at export time; explicitly run on every atom body and chunk before write. Manifest records `safetyRedactionVersion` so old packs can be re-scrubbed on import. |
| Two teammates export and merge cross-ways at the same time. | Out of scope for v1; treat as "last importer wins on edges, conflicts pile on atoms." Documented in README. |
| `edges.jsonl` grows large for big projects. | Acceptable for v1. Gzipped at rest is a follow-up. |

## 15. Next steps

1. User reviews this spec.
2. After approval, write the E implementation plan.
3. Continue to concern F — user-style preference layer.
