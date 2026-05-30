# 06 — Reflection Memory

A **reflection memory** is a lesson learned from one agent session that survives into future sessions. Memories are *reviewed* — agents cannot inject raw lessons into context. This is the safety boundary that keeps shallow, wrong, or contradictory lessons out of retrieval.

## Lifecycle

```
finish_session ──▶ reflection draft (status: pending or needs_changes)
                              │
                              ├─ approve  ──▶ stored as itemType="memory" (searchable)
                              ├─ reject   ──▶ archived, never injected
                              └─ needs_changes ──▶ author edits, re-submits
```

## Draft shape

```jsonc
{
  "id":           "<uuid>",
  "project":      "newsletter-app",
  "title":        "Worker has its own DB pool; refactors must update both",
  "summary":      "When refactoring auth, also update src/worker.ts",
  "content":      "<longer markdown body>",
  "itemType":     "memory",                     // becomes a knowledge item on approve
  "triggerType":  "complex_task_success",       // complex_task_success | error_recovery |
                                                // user_correction | non_trivial_workflow | manual
  "labels":       [...],
  "references":   [...],
  "metadata":     { "safety": {...}, "writeGate": {...}, "contextFit": {...} },
  "provenance":   { "agentSessionId": "...", "contextPackId": "..." },
  "status":       "pending"                     // pending | approved | rejected | needs_changes
}
```

## Creating drafts

Three paths:

1. **Automatic on `finish_session`** — see [05-agent-session-lifecycle.md](05-agent-session-lifecycle.md#finish-tuberosa_finish_session). The default `learningMode: "auto"` invokes the learning gate, which scores the session and either drafts or auto-approves.

2. **Explicit via `tuberosa_reflect` / `POST /reflection-drafts`** — when an agent or human wants to write a lesson by hand:

   ```jsonc
   {
     "project": "newsletter-app",
     "title":   "Worker has its own DB pool",
     "summary": "...",
     "content": "...",
     "triggerType": "user_correction"
   }
   ```

3. **From an error log** — `tuberosa_create_error_log_reflection_draft` converts a resolved error-log incident into a draft (see [13-operations-runbook.md](13-operations-runbook.md#error-logs)).

## Reviewing drafts

| Tool | HTTP | Purpose |
|---|---|---|
| `tuberosa_list_reflection_drafts` | `GET /reflection-drafts` | List pending or filtered drafts |
| `tuberosa_get_reflection_draft` | `GET /reflection-drafts/{id}` | Read one |
| `tuberosa_review_reflection_draft` | `POST /reflection-drafts/{id}/review` | `approve` / `reject` / `needs_changes` |
| – | `POST /reflection-drafts/{id}/approve` | Shortcut for approve |
| – | `PATCH /reflection-drafts/{id}` | Edit title / summary / content / labels |
| – | `GET /reflection-drafts/{id}/recommendation` | Write-gate recommendation (without committing) |

Approval body:

```jsonc
{
  "decision": "approve",
  "reviewer": "nguyen",
  "note":     "Good catch; widening to all background processes."
}
```

On approve, the draft is converted to a knowledge item with `itemType: "memory"` and `status: "approved"`. The original draft row stays for audit; its `status` becomes `approved`.

## Write gate (dedup + decay)

The **write gate** runs at draft-creation time AND at approval time. It decides whether a new memory should:

| Decision | What happens |
|---|---|
| `ADD` | New memory created. |
| `UPDATE` | Existing similar memory is enriched (labels/references merged, body appended). |
| `SKIP` | Draft rejected — duplicate of an existing high-confidence memory. |

Scoring inputs (`src/maintenance/write-gate.ts`):

- `cosine` — semantic similarity to existing memories on same project.
- `labelOverlap` — Jaccard over labels.
- `referenceOverlap` — Jaccard over references (files/symbols).
- `recencyDays` — age of the matched memory.

Thresholds live in `config/retrieval-policy.json` → `writeGate`. The draft metadata captures the decision so reviewers can see why a draft was queued vs auto-approved.

## Decay

Memories aren't permanent. The maintenance service runs a periodic pass that:

- Boosts memories that were recently `selected`.
- Decays memories that have gone unread for a long time.
- Archives memories whose evidence has rotted (file deleted, symbol renamed, etc.).

Decay is opt-in per project via the maintenance config. Trigger manually:

```bash
curl -sX POST http://localhost:3027/operations/maintenance/preview -d '{"project":"newsletter-app"}'
curl -sX POST http://localhost:3027/operations/maintenance/apply  -d '{"planId":"<from-preview>"}'
```

## Where in the source

- `src/reflection/service.ts` — draft CRUD, review.
- `src/reflection/write-gate.ts` (alias to maintenance) — scoring.
- `src/reflection/safety.ts` — runs redaction + injection guard before persisting.
- `src/reflection/taxonomy.ts` — classifies the draft into `project_fact` / `agent_lesson` / `bug_fix` / `convention`.
- `src/agent-session/learning-gate.ts` — decides auto vs draft on finish.

## Eval coverage

`pnpm run eval:knowledge-completeness` includes reflection-memory cases. Adding a new trigger type or write-gate input requires extending the fixture first; the rule is the same as retrieval (no heuristics without a failing fixture).

## Read next

- [05-agent-session-lifecycle.md](05-agent-session-lifecycle.md) — where drafts come from.
- [07-atoms-and-user-style.md](07-atoms-and-user-style.md) — atoms are a parallel mechanism for finer-grained claims.
- [13-operations-runbook.md](13-operations-runbook.md) — reviewing drafts via the reflection-review tools and HTTP routes.
