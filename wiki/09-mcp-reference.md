# 09 — MCP Reference

Every Tuberosa MCP tool, with arguments and a minimal example. The MCP server lives at `src/mcp/server.ts`; the stdio entry is `src/mcp-stdio.ts`.

> **Important:** MCP stdout is reserved for JSON-RPC. All diagnostics go to stderr. If you ever see a stray log on stdout, file it as a bug — every client breaks.

Frame cap: 16 MiB (`src/mcp-stdio.ts:14`).

---

## Retrieval

### `tuberosa_search_context`

Classify a task and return a ranked context pack.

```jsonc
{
  "name": "tuberosa_search_context",
  "arguments": {
    "project":           "newsletter-app",       // optional
    "cwd":               "/home/me/proj",        // optional, drives worktree match
    "prompt":            "Update PaywallSelectionModal",
    "files":             ["src/components/paywall.tsx"],
    "symbols":           ["PaywallSelectionModal"],
    "errors":            [],
    "taskType":          "implementation",
    "contextMode":       "layered",              // "layered" | "compact"
    "noiseTolerance":    "strict",               // "balanced" | "strict"
    "includeDeepContext": true,
    "tokenBudget":       8000,
    "deepContextBudget": 60000,
    "bypassCache":       false,
    "debug":             false,
    "namespace":         { "project": "newsletter-app" }
  }
}
```

Returns a context pack — see [04-retrieval-pipeline.md](04-retrieval-pipeline.md#pack-shape-returned-to-the-agent).

### `tuberosa_get_context_pack`

Fetch a stored pack by id (use this after a shortlist response).

```jsonc
{ "name": "tuberosa_get_context_pack", "arguments": { "contextPackId": "<id>" } }
```

---

## Session lifecycle

### `tuberosa_start_session`

Begin an auditable agent session. Returns `{session, context, policy}`.

```jsonc
{
  "name": "tuberosa_start_session",
  "arguments": {
    "project":         "newsletter-app",
    "cwd":             "/home/me/proj",
    "prompt":          "Update PaywallSelectionModal",
    "files":           ["src/components/paywall.tsx"],
    "symbols":         ["PaywallSelectionModal"],
    "errors":          [],
    "taskType":        "implementation",
    "contextMode":     "layered",
    "noiseTolerance":  "strict",
    "includeDeepContext": true,
    "agentTool":       "Claude Code",
    "agentName":       "claude-sonnet-4-6"
  }
}
```

### `tuberosa_record_context_decision`

```jsonc
{
  "name": "tuberosa_record_context_decision",
  "arguments": {
    "sessionId":     "<id>",
    "contextPackId": "<id>",
    "feedbackType":  "selected",
    "reason":        "matched the paywall flow",
    "rejectedKnowledgeIds": []
  }
}
```

`feedbackType` values: `selected` | `rejected` | `stale` | `irrelevant` | `missing_context` | `selected_but_noisy` | `too_much_adjacent_context` | `missing_orientation` | `missing_current_handoff` | `missing_verification_commands`.

### `tuberosa_capture_learning_signal`

Mid-task durable learning. Kinds: `tip` | `decision` | `mistake` | `verification` | `file_change` | `user_preference` | `follow_up`. Sources: `user` | `agent` | `tool` | `system` | `reviewer`.

```jsonc
{
  "name": "tuberosa_capture_learning_signal",
  "arguments": {
    "sessionId": "<id>",
    "kind":      "tip",
    "source":    "agent",
    "text":      "Worker has its own DB pool",
    "files":     ["src/worker.ts"],
    "symbols":   [],
    "errors":    [],
    "confidence": 0.85,
    "references": [{ "type": "commit", "uri": "abc1234" }]
  }
}
```

### `tuberosa_append_session_note`

Post-hoc notes / context-quality feedback.

```jsonc
{ "name": "tuberosa_append_session_note", "arguments": {
  "sessionId": "<id>", "kind": "context_quality_feedback",
  "text": "Graph expansion was too aggressive.",
  "feedbackType": "too_much_adjacent_context" } }
```

### `tuberosa_finish_session`

Outcomes: `completed` | `failed` | `blocked` | `cancelled`. Learning modes: `auto` (default) | `draft_only` | `off`.

```jsonc
{
  "name": "tuberosa_finish_session",
  "arguments": {
    "sessionId":            "<id>",
    "outcome":              "completed",
    "summary":              "Updated PaywallSelectionModal to preserve product ids.",
    "changedFiles":         ["src/components/paywall-selection-modal.tsx"],
    "verificationCommands": ["pnpm test"],
    "agentOutputSummary":   "All tests pass; PR ready.",
    "learningMode":         "auto"
  }
}
```

Optionally include `learningSignals: [...]` or an explicit `reflectionDraft: {...}`.

---

## Reflection review

| Tool | Purpose |
|---|---|
| `tuberosa_reflect` | Create a reviewable draft directly. |
| `tuberosa_list_reflection_drafts` | List drafts (filter by status / project / triggerType). |
| `tuberosa_get_reflection_draft` | Read one. |
| `tuberosa_review_reflection_draft` | `approve` / `reject` / `needs_changes`. |

```jsonc
{
  "name": "tuberosa_reflect",
  "arguments": {
    "project":     "newsletter-app",
    "title":       "Worker has its own DB pool",
    "summary":     "Refactors touching auth must also update src/worker.ts.",
    "content":     "<markdown body>",
    "triggerType": "user_correction"
  }
}
```

`triggerType`: `complex_task_success` | `error_recovery` | `user_correction` | `non_trivial_workflow` | `manual`.

---

## Feedback & quality

| Tool | Purpose |
|---|---|
| `tuberosa_feedback_context` | Record feedback on a context pack (same as `record_context_decision` but standalone). |
| `tuberosa_collect_context_quality_feedback` | Aggregate noisy/missing-context feedback with linked review actions. |
| `tuberosa_get_workbench_summary` | Workbench v2 summary: review queues, health, recent sessions, risky memories. |

---

## Atoms & graph

| Tool | Purpose |
|---|---|
| `tuberosa_atom_gate_stats` | Per-tier counts, accept/reject rates, recent reject reasons. |
| `tuberosa_atom_graph_density` | Edge count, average degree, orphan atoms. |
| `tuberosa_predict_impact` | Atoms within N hops of given files/symbols; ranked by risk. |
| `tuberosa_resurrect_atom` | Move an `archived` atom back to `active`. |

```jsonc
{
  "name": "tuberosa_predict_impact",
  "arguments": {
    "project": "tuberosa",
    "files":   ["src/retrieval/fusion.ts"],
    "symbols": ["fuseCandidates"],
    "depth":   2
  }
}
```

---

## Project bundles

### `tuberosa_export_pack`

```jsonc
{
  "name": "tuberosa_export_pack",
  "arguments": {
    "project":         "tuberosa",
    "out":             "snapshot-2026-05-28",
    "includeChunks":   true,
    "includeArchived": false
  }
}
```

`out` is relative to `TUBEROSA_EXPORT_BASE_DIR`. Absolute paths and `..` segments are rejected.

### `tuberosa_import_pack`

```jsonc
{
  "name": "tuberosa_import_pack",
  "arguments": {
    "from":           "snapshot-2026-05-28",
    "project":        "tuberosa",
    "dryRun":         true,
    "onConflict":     "review",                      // "review" | "skip"
    "targetUserId":   "nguyen",                       // optional
    "preserveUserId": false,
    "preservePriority": false
  }
}
```

`from` is relative to `TUBEROSA_IMPORT_BASE_DIR`.

### Conflict resolution

`tuberosa_list_atom_import_conflicts` — list open / resolved conflicts.

`tuberosa_resolve_atom_import_conflict`:

```jsonc
{
  "name": "tuberosa_resolve_atom_import_conflict",
  "arguments": {
    "conflictId":     "<id>",
    "resolution":     "merged",                       // "keep_local" | "take_imported" | "merged" | "dismiss"
    "mergedSnapshot": { /* required when merged */ }
  }
}
```

`take_imported` and `merged` update the atom's content fields (claim, type, evidence, trigger, verification, pitfalls, links), not just tier/status. Categorized Export V2 packs (`manifest.layout: "categorized-v2"`) import through the same `tuberosa_import_pack` tool — point `from` at the pack's `pack/` subdirectory. See [17-bootstrap-and-export-v2.md](17-bootstrap-and-export-v2.md).

---

## Project lifecycle

### `tuberosa_sync_sources`

Detect added/changed/renamed/deleted files and return a reviewable plan. Two-call apply: first get a `planId`, then re-call with `apply: true`. Archives for deleted files are always surfaced for the user to confirm.

```jsonc
// 1. Plan (writes nothing)
{ "name": "tuberosa_sync_sources", "arguments": { "project": "tuberosa", "path": "/repo" } }
// → { "planId": "...", "plan": { added, changed, renamed, deleted, ignored, summary, destructive }, "instruction": "..." }

// 2. Apply (after confirming any deletions)
{ "name": "tuberosa_sync_sources",
  "arguments": { "project": "tuberosa", "apply": true, "planId": "<planId>" } }
```

Full details: [15-source-lifecycle-sync.md](15-source-lifecycle-sync.md).

### `tuberosa_get_atlas`

Return the synthesized project atlas (five files), regenerated in-memory from current knowledge.

```jsonc
{ "name": "tuberosa_get_atlas", "arguments": { "project": "tuberosa" } }            // all five
{ "name": "tuberosa_get_atlas", "arguments": { "project": "tuberosa", "file": "project-map.md" } }
// → { "inputHash": "...", "files": [{ "name": "project-map.md", "content": "..." }, ...] }
```

The files are also registered as MCP resources (`tuberosa://atlas/project-map.md`, …). Full details: [16-project-atlas.md](16-project-atlas.md).

---

## User style

### `tuberosa_record_user_style`

```jsonc
{
  "name": "tuberosa_record_user_style",
  "arguments": {
    "userId":  "nguyen",
    "claim":   "I prefer pnpm over npm for all Node projects",
    "type":    "convention",
    "priority":"personal_workflow",                  // "personal_workflow" | "coding_preference"
    "trigger": { "files": ["package.json"] },
    "evidence":[{ "kind": "url", "uri": "https://pnpm.io", "fetchedAt": "2026-04-01T00:00:00Z" }],
    "pitfalls":["npm-shrinkwrap.json is an old form; ignore it."]
  }
}
```

### `tuberosa_list_user_style`

```jsonc
{ "name": "tuberosa_list_user_style", "arguments": {
  "userId": "nguyen", "project": "tuberosa", "limit": 50 } }
```

---

## Maintenance

| Tool | Purpose |
|---|---|
| `tuberosa_propose_maintenance` | Propose a dedup / re-link / re-classify plan. |
| `tuberosa_apply_maintenance` | Apply a previously proposed plan. |

```jsonc
{ "name": "tuberosa_propose_maintenance", "arguments": {
  "project": "tuberosa", "kinds": ["dedup", "decay"] } }
```

The response includes a `planId`; pass it to `tuberosa_apply_maintenance`.

---

## Error logs

| Tool | Purpose |
|---|---|
| `tuberosa_record_error_log` | Capture an incident (filesystem-backed). |
| `tuberosa_list_error_logs` | Browse. |
| `tuberosa_get_error_log` | Fetch one. |
| `tuberosa_collect_error_logs` | Aggregate a set for review. |
| `tuberosa_update_error_log` | Update fields on an open log. |
| `tuberosa_resolve_error_log` | Close an incident. |
| `tuberosa_create_error_log_reflection_draft` | Turn a resolved log into a reflection draft. |

Error logs live under `TUBEROSA_ERROR_LOG_DIR` (default `.tuberosa/error-logs/`). Auto-capture is on by default for HTTP/MCP server errors; toggle via `TUBEROSA_ERROR_LOG_AUTO_CAPTURE`.

---

## Resources

| URI template | Returns |
|---|---|
| `tuberosa://packs/{id}` | Context pack JSON |
| `tuberosa://knowledge/{id}` | Knowledge item JSON |
| `tuberosa://error-logs/{id}` | Error log JSON |
| `tuberosa://error-logs/{id}/markdown` | Error log Markdown |

`resources/list` returns no static resources (Tuberosa is template-only).

---

## Prompts

Six pre-baked agent prompts available via `prompts/list`:

| Prompt | Use |
|---|---|
| `tuberosa_bootstrap_session` | Standard "start a session, inspect fit, proceed" wrapper. |
| `tuberosa_reflect_after_task` | Coaches the agent through writing a draft after a task. |
| `tuberosa_review_pending_reflections` | Walks a human reviewer through the draft queue. |
| `tuberosa_capture_error_for_later` | Records an error log when the agent can't fix it now. |
| `tuberosa_review_error_logs` | Walks a reviewer through open error logs. |
| `tuberosa_fix_error_log` | Converts a resolved log into a draft. |

Fetch with `prompts/get`:

```jsonc
{ "name": "tuberosa_bootstrap_session",
  "arguments": { "project": "tuberosa", "prompt": "Refactor fusion" } }
```

---

## Error shape

MCP tool failures throw an error whose `message` contains a human-readable explanation. Categories you'll see:

- `ValidationError` — bad input (status code 400 in HTTP terms).
- `NotFoundError` — id doesn't exist.
- `AuthorizationError` — should not happen on stdio; surfaces if you wrap MCP over a network transport.

Errors are auto-captured to `TUBEROSA_ERROR_LOG_DIR` if `TUBEROSA_ERROR_LOG_AUTO_CAPTURE=true`.

---

## Read next

- [05-agent-session-lifecycle.md](05-agent-session-lifecycle.md) — the recommended flow.
- [08-export-import-bundle.md](08-export-import-bundle.md) — bundle internals.
- [10-http-api-reference.md](10-http-api-reference.md) — HTTP equivalents.
