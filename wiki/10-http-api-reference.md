# 10 — HTTP API Reference

All endpoints return JSON. `/health` is public. Everything else requires `Authorization: Bearer $TUBEROSA_API_KEY` when the key is set.

Server: `src/http/server.ts`. Error mapping: `src/errors.ts` (`{error: string, code: string, ...details}`).

---

## Health

### `GET /health`

Returns service status. Public.

```jsonc
{
  "ok": true,
  "service": "tuberosa",
  "store": "postgres",
  "durability": "persistent",
  "backupDir": ".tuberosa/backups",
  "cache": "redis",
  "modelProvider": "hash"
}
```

> Note: this returns more than a typical liveness probe needs. If your deploy exposes `/health` beyond loopback, consider trimming this to `{ok:true}` — see audit finding M1 in `docs/audit-specs/SECURITY_AUDIT_2026-05-28.md`.

---

## Knowledge

| Method | Path | Use |
|---|---|---|
| `POST` | `/knowledge` | Add one item. Body: see [03-knowledge-model.md](03-knowledge-model.md#required-fields). |
| `GET`  | `/knowledge?project=<p>&q=<query>&status=<s>&review=<bool>&limit=<n>` | List. `limit` capped at 100. |
| `GET`  | `/knowledge/{id}` | Fetch one. |
| `PATCH`| `/knowledge/{id}` | Update fields. |
| `POST` | `/ingest/files` | Bulk file ingestion (chunks + atomizes). Body: `{project, mode, files:[{path, content}]}`. |
| `GET`  | `/labels?project=<p>&type=<t>` | List labels. |

`POST /ingest/files` accepts `mode: "document" | "atomic"`. See [03-knowledge-model.md](03-knowledge-model.md#ingestion-modes).

---

## Context

| Method | Path | Use |
|---|---|---|
| `POST` | `/context/search` | Run retrieval. Pass `"debug": true` for per-stage candidates and timings, or `"bypassCache": true` to skip the pack cache. |
| `GET`  | `/context/packs?project=<p>&limit=<n>` | List stored packs (admin). |
| `GET`  | `/context/packs/{id}` | Fetch a stored pack. |
| `POST` | `/context/feedback` | Body: `{contextPackId, project, feedbackType, reason?, rejectedKnowledgeIds?}`. Rejected/stale/irrelevant triggers a one-shot retry excluding `rejectedKnowledgeIds`. |
| `GET`  | `/feedback-events?project=<p>` | List recorded feedback events. |

`feedbackType` values: see [05-agent-session-lifecycle.md](05-agent-session-lifecycle.md#record-context-decision).

---

## Atoms

| Method | Path | Use |
|---|---|---|
| `POST` | `/atoms/{id}/resurrect` | Move an archived atom back to `active`. Sets `lastReusedAt` to now. |

Atom search / list is driven through `/context/search` (atoms are a candidate source) and through the bundle/graph routes below.

---

## User style

| Method | Path | Use |
|---|---|---|
| `POST` | `/user-style-atoms` | Create a user-style atom. Body: `{userId, claim, type, priority, trigger, evidence?, pitfalls?, sessionId?}`. |
| `GET`  | `/user-style-atoms?userId=<u>&project=<p>&limit=<n>` | List user-style atoms. |
| `GET`  | `/user-style-atoms/{id}` | Fetch one. |

`priority`: `personal_workflow` | `coding_preference`. See [07-atoms-and-user-style.md](07-atoms-and-user-style.md#user-style-atoms).

---

## Agent sessions

| Method | Path | Use |
|---|---|---|
| `POST` | `/agent-sessions` | Start a session. |
| `GET`  | `/agent-sessions?project=<p>&status=<s>` | List. |
| `GET`  | `/agent-sessions/{id}` | Read one. |
| `GET`  | `/agent-sessions/{id}/context-decisions` | List decisions for a session. |
| `POST` | `/agent-sessions/{id}/context-decision` | Record one decision. |
| `POST` | `/agent-sessions/{id}/learning-signals` | Capture a learning signal. |
| `POST` | `/agent-sessions/{id}/finish` | Finish a session. |
| `POST` | `/agent-sessions/{id}/notes` | Append a note. |

Full lifecycle: [05-agent-session-lifecycle.md](05-agent-session-lifecycle.md).

---

## Reflection drafts

| Method | Path | Use |
|---|---|---|
| `POST`  | `/reflection-drafts` | Create. |
| `GET`   | `/reflection-drafts?project=<p>&status=<s>&triggerType=<t>` | List. |
| `GET`   | `/reflection-drafts/{id}` | Read one. |
| `PATCH` | `/reflection-drafts/{id}` | Edit title / summary / content / labels. |
| `POST`  | `/reflection-drafts/{id}/review` | `{decision, reviewer, note?}`. |
| `POST`  | `/reflection-drafts/{id}/approve` | Shortcut for `decision=approve`. |
| `GET`   | `/reflection-drafts/{id}/recommendation` | Write-gate recommendation (ADD / UPDATE / SKIP). |

`triggerType`: `complex_task_success` | `error_recovery` | `user_correction` | `non_trivial_workflow` | `manual`.

---

## Operations — relations

| Method | Path | Use |
|---|---|---|
| `GET`    | `/operations/relations?project=<p>&kind=<k>` | List knowledge graph relations. |
| `POST`   | `/operations/relations` | Add a relation. |
| `GET`    | `/operations/relations/{id}` | Read one. |
| `PATCH`  | `/operations/relations/{id}` | Edit. |
| `DELETE` | `/operations/relations/{id}` | Remove. |

Kinds: `supersedes` | `refines` | `depends_on` | `co_changes_with` | `related_to`.

---

## Operations — conflicts

| Method | Path | Use |
|---|---|---|
| `GET`  | `/operations/conflicts?project=<p>` | List detected knowledge conflicts. |
| `POST` | `/operations/conflicts/detect` | Run conflict detection now. |
| `POST` | `/operations/conflicts/{id}` | Resolve one. Body: `{decision, reviewer, note?}`. |

---

## Operations — atom graph

| Method | Path | Use |
|---|---|---|
| `GET`  | `/operations/atom-gate/stats?project=<p>` | Per-tier counts + accept/reject rates. |
| `GET`  | `/operations/atom-graph/density?project=<p>` | Edge count, average degree, orphans. |
| `GET`  | `/operations/organization/atom-graph.jsonl?project=<p>` | One edge per line. |
| `POST` | `/operations/atom-graph/impact` | Impact prediction. Body: `{project, files, symbols, depth}`. |

---

## Operations — export / import

| Method | Path | Use |
|---|---|---|
| `POST` | `/operations/export-pack` | Export a project bundle. Body: `{project, out, includeChunks?, includeArchived?}`. |
| `POST` | `/operations/import-pack` | Import a bundle. Body: `{from, project?, dryRun?, onConflict?}`. |
| `GET`  | `/operations/atom-import-conflicts?project=<p>&status=<s>` | List import conflicts. |
| `GET`  | `/operations/atom-import-conflicts/{id}` | Read one. |
| `POST` | `/operations/atom-import-conflicts/{id}/resolve` | Resolve. Body: `{resolution, mergedSnapshot?}`. |

`out` is relative to `TUBEROSA_EXPORT_BASE_DIR`; `from` is relative to `TUBEROSA_IMPORT_BASE_DIR`. Absolute paths and `..` segments are rejected with HTTP 400 (`"absolute path is not allowed; use a relative path under the configured base"`).

Full guide: [08-export-import-bundle.md](08-export-import-bundle.md).

---

## Operations — organization & quality

| Method | Path | Use |
|---|---|---|
| `GET`  | `/operations/organization/project-map?project=<p>` | High-level project map. |
| `GET`  | `/operations/organization/knowledge-graph.jsonl?project=<p>` | One knowledge edge per line. |
| `GET`  | `/operations/organization/readable-summary?project=<p>` | Human-readable summary. |
| `GET`  | `/operations/context-quality?project=<p>` | Quality scorecard. |
| `GET`  | `/operations/session/{id}/replay` | Replay a session step-by-step. |
| `GET`  | `/operations/catchup?project=<p>&since=<ts>` | Catch-up brief for an agent returning to a project. |

---

## Operations — knowledge gaps & maintenance

| Method | Path | Use |
|---|---|---|
| `GET`  | `/operations/knowledge-gaps?project=<p>` | Missing-coverage items. |
| `PATCH`| `/operations/knowledge-gaps/{id}` | Update a gap (status, notes). |
| `GET`  | `/operations/learning-proposals?project=<p>` | List proposed learnings. |
| `POST` | `/operations/learning-proposals/{id}` | Accept / reject a proposal. |
| `POST` | `/operations/maintenance/preview` | Preview a maintenance plan. |
| `POST` | `/operations/maintenance/apply` | Apply a previously previewed plan. |
| `POST` | `/operations/cleanup` | Run a cleanup pass (archival, decay). |
| `POST` | `/operations/import-files` | Bulk-import files into knowledge. |

---

## Operations — error logs

| Method | Path | Use |
|---|---|---|
| `POST`  | `/operations/error-logs` | Record an incident. |
| `GET`   | `/operations/error-logs?project=<p>&status=<s>` | List. |
| `POST`  | `/operations/error-logs/collection` | Aggregate a set of logs for review. |
| `POST`  | `/operations/error-logs/reflection-drafts` | Turn collection into reflection drafts. |
| `POST`  | `/operations/error-logs/{id}/resolve` | Close an incident. |
| `GET`   | `/operations/error-logs/{id}` | Read one. |
| `PATCH` | `/operations/error-logs/{id}` | Update fields. |

Storage: filesystem-backed under `TUBEROSA_ERROR_LOG_DIR` (default `.tuberosa/error-logs/`).

---

## Operations — backups

| Method | Path | Use |
|---|---|---|
| `GET`  | `/operations/backups` | List backups. |
| `POST` | `/operations/backups` | Create a backup now. |
| `GET`  | `/operations/backups/status` | Schedule + last-run info. |
| `POST` | `/operations/backups/prune` | Prune older than retention policy. |

Backups land in `TUBEROSA_BACKUP_DIR` (default `.tuberosa/backups/`).

---

## Authentication

When `TUBEROSA_API_KEY` is set, every route except `/health` requires:

```
Authorization: Bearer <api-key>
```

Or the alternate header form:

```
X-Tuberosa-Api-Key: <api-key>
```

Both compared in constant time (`secureEqual` in `src/http/server.ts`).

When the key is **not** set and `TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK=true`, non-loopback requests are refused. When neither condition holds, requests are accepted from any origin — only safe behind a trusted network boundary. See [12-security-model.md](12-security-model.md#auth).

---

## Error responses

```jsonc
{
  "error": "absolute path is not allowed; use a relative path under the configured base",
  "code":  "validation_error",
  "details": { /* optional */ }
}
```

| `code` | HTTP status |
|---|---|
| `validation_error` | 400 |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict` | 409 |
| `payload_too_large` | 413 |
| `internal_error` | 500 |

---

## Read next

- [09-mcp-reference.md](09-mcp-reference.md) — MCP equivalents.
- [11-configuration.md](11-configuration.md) — all env vars.
- [12-security-model.md](12-security-model.md) — auth, redaction, path confinement.
