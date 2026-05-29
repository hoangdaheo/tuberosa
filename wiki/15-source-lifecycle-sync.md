# 15 — Source Lifecycle Sync

Tuberosa keeps a project's knowledge in step with its files. When you add, change, rename, or delete a file, **sync** detects it and produces a reviewable plan: ingest new files, re-ingest changed ones, re-point renames, and **archive** (never hard-delete) the knowledge behind a vanished file.

One engine, three ways to call it:

| Trigger | Command / tool | Deletions |
|---|---|---|
| CLI | `tuberosa sync` | Need `--apply --yes` |
| MCP | `tuberosa_sync_sources` | Always surfaced for the agent to confirm |
| Git hook | `tuberosa hook install` | Never auto-archived — queued for review |

The engine is `SourceSyncService` (`src/source-sync/service.ts`); the three triggers are thin wrappers over it.

## The core safety rule

**Additive changes can flow automatically. Destructive ones never do.**

Archiving the knowledge for a deleted file always needs a human or agent in the loop. There is no code path that silently drops knowledge.

## What a plan looks like

`sync` first runs **dry** and prints a `SyncPlan`:

```
$ tuberosa sync --project tuberosa
Sync plan for tuberosa (git @ a1b2c3d4):
  added:   3
  changed: 1
  renamed: 1
  deleted: 1
  - DELETE → archive: src/old-helper.ts (4 knowledge, 2 atoms)

Dry-run. Re-run with --apply to execute (archives also need --yes).
```

The five buckets:

| Bucket | Action on apply |
|---|---|
| `added` | Ingest the file (item type inferred from path). |
| `changed` | Re-ingest; at most one live version per path. |
| `renamed` | **Re-point**, don't re-ingest — knowledge IDs, labels, edges, embeddings are preserved. |
| `deleted` | **Archive** the knowledge (tombstone). Nothing is hard-deleted; resurrect is lossless. |
| `ignored` | Skipped — but always listed (lockfiles, `dist/`, binaries, oversized files, `.env*`). Silent exclusion never happens. |

## CLI examples

```bash
# 1. See the plan (safe, writes nothing)
tuberosa sync --project tuberosa

# 2. Apply additive ops only (add / change / rename). Deletions are deferred.
tuberosa sync --project tuberosa --apply

# 3. Apply everything, including archiving deleted-file knowledge
tuberosa sync --project tuberosa --apply --yes

# 4. Machine-readable plan for scripting / hooks
tuberosa sync --project tuberosa --json
```

`--apply` without `--yes` on a plan that contains deletions still applies the additions and **queues the deletions** to `.tuberosa/pending-sync.json` (no silent drop):

```
Deferred 1 deletion(s) to .tuberosa/pending-sync.json — re-run with --apply --yes to archive:
  - src/old-helper.ts (4 knowledge)
```

| Flag | Effect |
|---|---|
| `--project <name>` | Required. |
| `--path <repo>` | Repo root (defaults to cwd). |
| `--apply` | Execute the plan (additive ops; archives also need `--yes`). |
| `--yes` | Confirm destructive archiving. |
| `--json` | Emit the plan/result as JSON. |

## MCP example

`tuberosa_sync_sources` returns the plan and a `planId`. Apply with a second call:

```jsonc
// 1. Get the plan
{ "name": "tuberosa_sync_sources", "arguments": { "project": "tuberosa" } }
// → { "planId": "...", "plan": { ... }, "instruction": "..." }

// 2. Apply it (after the user confirms any deletions)
{ "name": "tuberosa_sync_sources",
  "arguments": { "project": "tuberosa", "apply": true, "planId": "<planId>" } }
```

When the plan is destructive, the `instruction` field tells the agent to surface the deletions to the user before re-calling with `apply: true`.

## Git hook example

```bash
tuberosa hook install --project tuberosa
```

This writes `post-commit` and `post-merge` hooks that run an **additive-only** sync after every commit/merge:

```sh
npx --no-install tuberosa sync --project tuberosa --apply --json > .tuberosa/last-sync.json || true
```

The hook never archives. Any deletions land in `.tuberosa/pending-sync.json` and show up as a "pending cleanup" badge in the workbench, waiting for someone to run `tuberosa sync --apply --yes`.

## How detection works

- **Git mode (default):** `git ls-files` for the inventory, `git diff -M <last_synced_sha>..HEAD` for classification. `-M` gives exact rename detection for free. A rename *with* edits above the similarity threshold is split into a `renamed` + a `changed` entry.
- **FS fallback:** walks the repo (honoring `.gitignore`), hashes each file, diffs against the ledger, and infers renames by matching the content hash of a vanished path to a new path. Used for non-git or dirty trees.

## The ledger — `source_files`

Migration `011_source_files.sql` adds one durable row per file path (`UNIQUE (project_id, path)`):

| Column | Meaning |
|---|---|
| `path` | Repo-relative canonical path. |
| `content_hash` | Latest synced hash; `null` when archived. |
| `status` | `tracked` \| `changed` \| `missing` \| `archived` \| `ignored`. |
| `last_synced_sha` | Git SHA at last sync (`null` in FS mode). |
| `prior_paths[]` | Rename history. |

A second table, `sync_runs`, audits every plan + apply outcome. A plan reviewed at time T applies exactly what was reviewed; apply **re-validates each file's hash** and skips (not aborts) any entry whose on-disk content drifted.

## Archive ↔ resurrect

Deleting a file doesn't erase its knowledge — it **tombstones** it:

- `knowledge_items.status` → `archived` with `metadata.archive = { reason: 'source_deleted', sourcePath, syncRunId }`.
- Atoms → `archived`.
- Retrieval already filters `status='approved'`, so archived items drop out of agent results automatically — but stay visible in the workbench.

Resurrect is lossless — flip the status back:

```jsonc
{ "name": "tuberosa_resurrect_atom", "arguments": { "atomId": "<id>" } }
```

This is why a future agent asking about a deleted path can be told *"this path no longer exists"* instead of getting silence.

## First sync = first ingest

On an empty ledger, **everything** is `added`, so the first `tuberosa sync --apply` ingests the whole repo. That makes sync double as first-time project ingestion — which is exactly what [`tuberosa bootstrap`](17-bootstrap-and-export-v2.md) wraps for a one-command first run.

## Read next

- [16-project-atlas.md](16-project-atlas.md) — turn the ingested corpus into a readable map (auto-regenerates after `sync --apply`).
- [17-bootstrap-and-export-v2.md](17-bootstrap-and-export-v2.md) — one command: sync + atlas + health + export.
- [07-atoms-and-user-style.md](07-atoms-and-user-style.md#archival) — atom archival and resurrect.
