# 08 — Export / Import Bundles

A `.tuberosa-pack` is a portable, human-readable snapshot of a project's atoms, knowledge, edges, and user-style. It's directory-shaped, self-hashing, and round-trippable.

## Use cases

- **Backups** that are diffable in git, not opaque blobs.
- **Hand-off** between machines or environments (dev → staging).
- **Sharing** a project's lessons with another team or repo.
- **Migration** between Tuberosa installs.

## Bundle layout

```
<bundle-dir>/
├─ manifest.json                 # self-hashed; bundle integrity check
├─ atoms/
│   └─ <slug>.md                 # one atom per Markdown file (YAML front-matter + body)
├─ knowledge/
│   └─ <slug>.md                 # one knowledge item per file
├─ edges.jsonl                   # one edge per line (sorted, deterministic)
└─ user-style/
    └─ <userId>/
        └─ <slug>.md             # user-style atoms grouped by userId
```

Slug rule: alphanumeric + `.`, `_`, `-` only. Path-traversal characters are stripped during export and rejected on import.

## Atom Markdown shape

```markdown
---
id: 12345678-1234-1234-1234-123456789abc
project: tuberosa
type: convention
tier: verified
status: active
scope: project
evidence:
  - kind: file
    path: src/mcp-stdio.ts
trigger:
  files:
    - src/mcp/**
  symbols:
    - console.log
verification:
  command: pnpm test
pitfalls:
  - A stray console.log breaks every MCP client.
links:
  - toAtomId: 87654321-...
    kind: refines
    confidence: 0.8
audit:
  producedBy: agent_session
  createdAt: 2026-04-12T08:11:00Z
  updatedAt: 2026-05-20T10:00:00Z
---

MCP stdout is reserved for JSON-RPC; diagnostics go to stderr.
```

## Manifest

`manifest.json` records counts, a per-file hash table, and a top-level `selfHash` over the rest of the file. On import the manifest is parsed, every file in the bundle is re-hashed, and any mismatch aborts the import.

```jsonc
{
  "version": 1,
  "project": "tuberosa",
  "exportedAt": "2026-05-28T10:00:00Z",
  "counts": { "atoms": 142, "knowledge": 88, "edges": 271, "userStyleAtoms": 12 },
  "files": {
    "atoms/mcp-stdout-rule.md":     { "sha256": "..." },
    "knowledge/retrieval-flow.md":  { "sha256": "..." },
    "edges.jsonl":                  { "sha256": "..." }
  },
  "selfHash": "..."
}
```

## Export

### HTTP

```bash
curl -sX POST http://localhost:3027/operations/export-pack -H 'Content-Type: application/json' -d '{
  "project":         "tuberosa",
  "out":             "snapshot-2026-05-28",        # relative to TUBEROSA_EXPORT_BASE_DIR
  "includeChunks":   true,
  "includeArchived": false
}'
```

### MCP

```jsonc
{
  "name": "tuberosa_export_pack",
  "arguments": {
    "project": "tuberosa",
    "out":     "snapshot-2026-05-28",
    "includeChunks":   true,
    "includeArchived": false
  }
}
```

### CLI

```bash
node --import tsx scripts/export-pack.ts --project tuberosa --out snapshot-2026-05-28
```

`out` is **always relative** to `TUBEROSA_EXPORT_BASE_DIR` (default `.tuberosa/exports`). Absolute paths, `..` segments, NUL bytes, and symlinks that escape the base are rejected with HTTP 400 / MCP error. See [12-security-model.md](12-security-model.md#path-confinement).

Options:

| Option | Default | Effect |
|---|---|---|
| `includeChunks` | `true` | Include full chunk text for knowledge items (bigger bundle but searchable on re-import). |
| `includeArchived` | `false` | Include `status='archived'` atoms/knowledge. |

## Import

### HTTP

```bash
curl -sX POST http://localhost:3027/operations/import-pack -d '{
  "from":      "snapshot-2026-05-28",              # relative to TUBEROSA_IMPORT_BASE_DIR
  "project":   "tuberosa",                          # override target project; default uses manifest
  "dryRun":    true,                                # safe first pass
  "onConflict":"review"                             # review | skip
}'
```

### MCP

```jsonc
{
  "name": "tuberosa_import_pack",
  "arguments": {
    "from":       "snapshot-2026-05-28",
    "project":    "tuberosa",
    "dryRun":     true,
    "onConflict": "review",
    "targetUserId":   "nguyen",      # rewrite imported user-style atoms to this user
    "preserveUserId": false,         # set true to keep original user ids
    "preservePriority": false        # set true to keep personal_workflow priority
  }
}
```

### Report shape

```jsonc
{
  "atomsInserted":         42,
  "atomsUpdated":          0,
  "atomsSkipped":          3,
  "edgesInserted":         88,
  "edgesUpdated":          2,
  "knowledgeInserted":     22,
  "userStyleInserted":     7,
  "userStyleSkipped":      2,
  "conflictsQueued":       4,
  "dryRun":                true,
  "manifestVerified":      true
}
```

When `dryRun: true`, the importer reports what *would* happen without writing anything. Use this every time you import an unfamiliar bundle.

## Conflict resolution

When `onConflict: "review"` (default) and an imported atom/knowledge collides with an existing local one:

1. Importer creates an `atom_import_conflict` row with both snapshots.
2. The conflict appears in `tuberosa_list_atom_import_conflicts` / `GET /operations/atom-import-conflicts`.
3. A reviewer resolves it via `tuberosa_resolve_atom_import_conflict` / `POST /operations/atom-import-conflicts/{id}/resolve`:

   ```jsonc
   {
     "conflictId":      "<id>",
     "resolution":      "keep_local" | "keep_imported" | "keep_merged",
     "mergedSnapshot":  { /* only when resolution=keep_merged */ }
   }
   ```

When `onConflict: "skip"`, the import just bumps `atomsSkipped` and moves on. No conflict row is created.

## Workflow example

```bash
# Dry-run first
curl -sX POST http://localhost:3027/operations/import-pack -d \
  '{"from":"new-bundle","dryRun":true,"onConflict":"review"}'
# Inspect the report. If conflictsQueued > 0, list them:
curl -s http://localhost:3027/operations/atom-import-conflicts
# Resolve each, then commit the import:
curl -sX POST http://localhost:3027/operations/import-pack -d \
  '{"from":"new-bundle","dryRun":false,"onConflict":"review"}'
```

## Path confinement (Phase 1 security)

Every export/import path on both HTTP and MCP runs through `assertSafeBundlePath(base, candidate)` from `src/security/safe-paths.ts`:

- Rejects absolute paths.
- Rejects any segment equal to `..`.
- Rejects NUL bytes.
- Resolves the path via `fs.realpath` and refuses anything outside the configured base.
- `lstat`s every existing component to reject symlink escapes.

Two env vars set the bases (defaults are `.tuberosa/exports` and `.tuberosa/imports`):

```
TUBEROSA_EXPORT_BASE_DIR=.tuberosa/exports
TUBEROSA_IMPORT_BASE_DIR=.tuberosa/imports
```

Plus the importer enforces `assertSafeChildName` on every `user-style/<entry>` directory and every `*.md` filename — so a malicious pack containing `user-style/../etc` directory entries or `..` file entries is rejected.

Full threat model: [12-security-model.md](12-security-model.md#path-confinement).

## Round-trip guarantee

`test/export-roundtrip-retrieval.test.ts` exports a project, imports it into a fresh store, and asserts that:

- All atoms reappear with their original ids preserved.
- Edges round-trip exactly.
- A retrieval call against the imported store returns the same top-N as the original (within a small tolerance).

If you touch the codec or importer, this test is the one to keep green.

## Read next

- [09-mcp-reference.md](09-mcp-reference.md#bundles) — full MCP tool args.
- [10-http-api-reference.md](10-http-api-reference.md#export-import) — HTTP routes.
- [12-security-model.md](12-security-model.md#path-confinement) — confinement details.
