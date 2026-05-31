# 03 — Knowledge Model

Tuberosa stores three kinds of things:

1. **Knowledge items** — coarse documents (files, runbooks, specs).
2. **Knowledge atoms** — fine-grained claims with evidence and triggers.
3. **Relations** — typed edges between items and atoms.

This guide covers items. For atoms and user-style, see [07-atoms-and-user-style.md](07-atoms-and-user-style.md).

## Knowledge item

The atomic stored unit at the document level.

### Required fields

| Field | Type | Example |
|---|---|---|
| `project` | string | `"newsletter-app"` |
| `sourceType` | string | `"manual"`, `"github"`, `"web"`, `"agent"` |
| `sourceUri` | string | `"docs/paywall.md"` |
| `itemType` | enum | see table below |
| `title` | string | `"Newsletter paywall workflow"` |
| `content` | string | the body text or code |

### Optional fields

| Field | Type | Use |
|---|---|---|
| `summary` | string | Short blurb shown in shortlist |
| `trustLevel` | int 0-100 | Hand-set confidence; influences ranking |
| `labels` | `Label[]` | Typed signals (see below) |
| `references` | `Reference[]` | Cross-pointers (see below) |
| `metadata` | object | Free-form; survives round-trips |
| `status` | enum | `approved` (default) / `draft` / `archived` / `blocked` |

### `itemType` table

| `itemType`     | When to use |
|----------------|-------------|
| `code_ref`     | A source code file or snippet to surface |
| `wiki`         | Free-form documentation, runbooks |
| `spec`         | Specs, requirements docs |
| `workflow`     | Procedural how-to (e.g. release checklist) |
| `rule`         | Hard project rule (e.g. "MCP stdout is JSON-RPC only") |
| `bugfix`       | Specific bug + fix pairing |
| `memory`       | Reflection memory (usually written via reflection drafts, not directly) |
| `conversation` | Captured chat / decision thread |

### Inference (when `itemType` is omitted on ingestion)

`POST /ingest/files` infers from path:

- `*.md`, `docs/**` → `wiki`
- `specs/**`, `*-spec.*` → `spec`
- everything else → `code_ref`

## Label

A typed signal that boosts metadata matching. Fixed `type` axes:

```jsonc
{ "type": "file",          "value": "src/retrieval/fusion.ts", "weight": 1.0 }
{ "type": "symbol",        "value": "fuseCandidates",          "weight": 0.9 }
{ "type": "error",         "value": "ECONNREFUSED",            "weight": 0.8 }
{ "type": "technology",    "value": "postgres",                "weight": 0.7 }
{ "type": "business_area", "value": "paywall",                 "weight": 1.0 }
{ "type": "domain",        "value": "retrieval",               "weight": 1.0 }
{ "type": "task_type",     "value": "debugging",               "weight": 0.8 }
{ "type": "project",       "value": "tuberosa",                "weight": 1.0 }
```

Labels carry an optional `weight` (default 1.0) and `provenance` object so the source of a label survives joins.

Effects:

- **Metadata search** matches labels first (highest weight wins).
- **Classifier** extracts the same axes from the prompt; matches drive fusion seeds.
- **Aboutness boosts** in `ranking.ts` add small score bumps for project/domain/business-area matches.

## Reference

Where an item points in your world:

```jsonc
{ "type": "file",         "uri": "src/retrieval/service.ts", "lineStart": 142, "lineEnd": 178 }
{ "type": "url",          "uri": "https://docs.../pgvector" }
{ "type": "commit",       "uri": "abc1234", "metadata": { "repo": "tuberosa" } }
{ "type": "tool",         "uri": "tuberosa_search_context" }
{ "type": "conversation", "uri": "session:91b70c51-…" }
```

References are non-authoritative — they tell the agent where to look next. Line numbers, when set, scope deep-context expansion to that slice of the file.

## Chunks and embeddings

On ingestion, content is chunked (token-aware split) and each chunk gets an embedding. The store table is `knowledge_chunks`. Vector search runs against the chunk embeddings; the parent knowledge item is what gets returned.

`EMBEDDING_DIMENSIONS` must match the `vector(N)` column in `migrations/001_init.sql`. Default 1536 (matches `text-embedding-3-small`). Changing it requires a new migration.

## Relations (knowledge graph)

Stored in `knowledge_relations`. Typed edges between items:

| Kind | Direction | Meaning |
|---|---|---|
| `supersedes` | `from` replaces `to` | `to` is hidden from retrieval (with reason) |
| `refines` | `from` adds detail to `to` | Both surface; graph expansion may pull `to` when `from` matches |
| `depends_on` | `from` requires `to` | Pull `to` as supporting context |
| `co_changes_with` | bidirectional | When you touch one, surface the other |
| `related_to` | bidirectional | Weak link; surfaces only when expansion budget allows |

Relations are inferred by `src/relations/inference.ts` and persisted at ingest time. They can also be added by hand via `POST /operations/relations`.

## Status lifecycle

Default is `approved`. Other values:

- `draft` — present in the store but not in retrieval results.
- `archived` — hidden from retrieval but kept for export/restore.
- `blocked` — flagged by safety; never injected.

`PATCH /knowledge/{id}` can change status. Bulk archival typically runs through the maintenance service.

## Ingestion modes

`POST /ingest/files` accepts `mode: "document" | "atomic"`:

- **document** (default) — file is chunked but stays one logical knowledge item. Best for code.
- **atomic** — Markdown is split into headed sections, each becoming its own knowledge item. Best for long docs.

```bash
curl -sX POST http://localhost:3027/ingest/files -H 'Content-Type: application/json' -d '{
  "project": "newsletter-app",
  "mode":    "document",
  "files": [
    { "path": "src/components/paywall-selection-modal.tsx",
      "content": "export function PaywallSelectionModal() { return null; }" }
  ]
}'
```

## Deduplication

`DuplicateDetector` (`src/ingest/duplicate-detector.ts`) rejects exact-text and high-semantic-similarity duplicates at ingest time, throwing `DuplicateIngestionError`. Treat that error as a successful skip, not a failure.

## What's NOT stored as a knowledge item

- **Reflection drafts** — separate table, not searchable until approved (then they become `itemType: "memory"`).
- **Atoms** — separate table (`knowledge_atoms`), graph (`atom_links`). See [07-atoms-and-user-style.md](07-atoms-and-user-style.md).
- **Error logs** — filesystem-backed under `.tuberosa/error-logs/`.
- **Backups** — under `.tuberosa/backups/`.
- **Physical mirror** — under `.tuberosa/current/`.

## Read next

- [04-retrieval-pipeline.md](04-retrieval-pipeline.md) — how items get ranked.
- [07-atoms-and-user-style.md](07-atoms-and-user-style.md) — atoms and user-style.
- [10-http-api-reference.md](10-http-api-reference.md#knowledge) — full knowledge API.
