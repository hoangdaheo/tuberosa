# Examples — Tuberosa End-to-End Scenarios

Verified 2026-06-09 against a memory store (`TUBEROSA_STORE=memory`, `hash` provider). Outputs are elided — shapes, not full payloads.

This file shows 4 real scenarios. Each one has:

- **Goal** — what you want.
- **Tool call(s)** — the exact MCP tool name and a small JSON args block.
- **Output (elided)** — the top-level keys you get back, not the full data.
- **What to notice** — the one or two fields you should read.

> Note on honesty. The examples below were run against an **empty** memory store. With an empty store, `contextFit.fitStatus` is `insufficient` and `policy.action` is `clarify`. ✅ This is a real, correct result — it tells the agent "I do not have enough to be sure, ask first." After you ingest project knowledge and finish a few sessions, the same calls return richer packs and fit moves toward `ready` / `proceed`.

Valid `taskType` values: `debugging`, `implementation`, `refactor`, `review`, `planning`, `exploration`, `testing`, `unknown`.

Valid `feedbackType` values (for `tuberosa_record_context_decision`): `selected`, `selected_but_noisy`, `rejected`, `irrelevant`, `stale`, `missing_context`, `too_much_adjacent_context`, `missing_orientation`, `missing_current_handoff`, `missing_verification_commands`.

---

## Scenario 1 — Continue yesterday's work

**Goal.** You start a new day. You want to pick up the login refactor you left yesterday.

**Step 1 — open a session.** Tool: `tuberosa_start_session`

```json
{
  "project": "demo",
  "prompt": "continue the login refactor from yesterday",
  "contextMode": "layered",
  "taskType": "planning"
}
```

**Output (elided) — top-level keys:**

```jsonc
{
  session:  { id, project, prompt, status, initialContextPackId, … },
  context:  {
    contextPackId,
    confidence,
    contextFit:  { fitStatus: "insufficient", fitScore, fitReasons, missingSignals, … },
    orientation: { inferredTask, workflowStage, recommendedFiles: [ { path, reason } ], verificationCommands, … },
    taskBrief:   { mode, goal, actionItems, … },
    sections:    { /* essential / supporting / optional, each a list of items */ },
    deepContext: { budget, tokenEstimate, sections }
  },
  policy:   { action: "clarify", instruction },
  handbook: { exists, conventionCount, suggestion }
}
```

**What to notice.**

1. Read `context.contextFit.fitStatus` first.
   - `ready` → ✅ trust the pack, start working.
   - `insufficient` → ❌ do not trust it yet. Open the files it points to, or ask a question.
2. Read `context.orientation.recommendedFiles` — these are the files to open first.
3. Then tell Tuberosa what you did with the pack.

**Step 2 — record your decision.** Tool: `tuberosa_record_context_decision`

```json
{
  "sessionId": "<session.id from step 1>",
  "feedbackType": "selected",
  "reason": "Opened the recommended files and used the prior login-refactor notes."
}
```

> Note the field is named **`feedbackType`**, not `decision`.

**Output (elided) — top-level keys:**

```jsonc
{
  session:  { id, project, status, updatedAt, … },
  decision: { id, sessionId, decision: "selected", reason, rejectedKnowledgeIds, createdAt }
}
```

---

## Scenario 2 — Debug an error with prior lessons

**Goal.** Something throws an error. You want Tuberosa to surface past fixes for the same kind of bug.

**Tool:** `tuberosa_start_session`

```json
{
  "project": "demo",
  "prompt": "fix the session token check",
  "errors": ["TypeError: cannot read property token of undefined"],
  "taskType": "debugging",
  "contextMode": "layered"
}
```

**Output (elided) — top-level keys:**

```jsonc
{
  session:  { id, … },
  context:  {
    contextPackId,
    contextFit: { fitStatus: "insufficient", … },   // empty store → insufficient
    classified: { taskType: "debugging", errors: ["TypeError: cannot read property token of undefined"], … },
    sections:   { essential, supporting, optional },
    …
  },
  policy:   { action: "clarify", instruction },
  handbook: { … }
}
```

**What to notice.**

- The error string lands in `context.classified.errors`. Tuberosa uses it to search for past sessions that hit the same error.
- When the store has learned from past sessions, **prior-lesson items appear inside `context.sections`** (items with `itemType: "memory"` or `"workflow"`). On an empty store there are none yet, so the lists are empty and fit is `insufficient`. ✅ That is expected on a fresh store.

---

## Scenario 3 — Implement a feature using conventions

**Goal.** You want to add a logout endpoint and follow the project's existing patterns. First get a quick list, then pull the full detail only when you need it.

**Step 1 — quick search.** Tool: `tuberosa_search_context`

```json
{
  "project": "demo",
  "prompt": "add a logout endpoint following project conventions"
}
```

**Output (elided) — top-level keys (this is the slim pack):**

```jsonc
{
  contextPackId,
  confidence,
  contextFit:  { fitStatus, … },
  orientation: { recommendedFiles, verificationCommands, … },
  taskBrief:   { … },
  classified:  { … },
  sections:    { essential, supporting, optional },   // titles + scores, not full text
  deepContext: { budget, tokenEstimate, sections },    // summary only, no chunks
  deepContextAvailable, deepContextReturned, deepContextTruncated
}
```

**Step 2 — pull the full pack.** Take `contextPackId` from step 1 and pass it. Tool: `tuberosa_get_context_pack`

```json
{
  "contextPackId": "<contextPackId from step 1>"
}
```

**Output (elided) — top-level keys (this is the full pack):**

```jsonc
{
  id,                       // the pack id (note: here the field is `id`, not `contextPackId`)
  queryId,
  project,
  prompt,
  confidence,
  status,
  classified,
  contextFit,
  orientation,
  taskBrief,
  startupBrief,
  actionableMissingSignals,
  sections,                 // full items
  rejectedKnowledgeIds,
  createdAt,
  deepContext: { mode, budget, tokenEstimate, sections }   // full chunks live here when the store has content
}
```

**What to notice.**

- The first response (`search_context`) is **slim** — titles, scores, and a deepContext summary. Cheap and fast.
- `get_context_pack` gives the **full** pack. Its `deepContext.sections` carry the full text chunks (when the store actually has matching knowledge).
- Field name changes between the two: search returns `contextPackId`; the fetched pack exposes the same id under `id`. ⚠️ Use `id` from the fetched pack.

---

## Scenario 4 — Human: review and approve a reflection draft

**Goal.** You are the reviewer. When agents finish sessions, Tuberosa writes "reflection drafts" (lessons it wants to remember). A human checks them before they become searchable memory.

**Step 1 — list drafts.** Tool: `tuberosa_list_reflection_drafts`

```json
{
  "project": "demo"
}
```

You can also list over HTTP:

```bash
curl -s "http://127.0.0.1:3027/reflection-drafts?project=demo"
```

**Output (elided) — on a fresh store:**

```jsonc
[]   // empty list — no drafts yet. ✅ This is fine; it just means no sessions have produced lessons.
```

After agents finish sessions, the list fills with draft objects (each has an `id`, a `title`, and a `status` such as `pending` or `needs_changes`).

**Step 2 — approve one.** Tool: `tuberosa_review_reflection_draft`

```json
{
  "reflectionDraftId": "<id of a draft from the list>",
  "decision": "approve",
  "reviewer": "you@example.com",
  "reviewerNote": "Accurate and reusable lesson."
}
```

> `decision` must be one of `approve`, `reject`, `needs_changes`. The draft id field is `reflectionDraftId` (or `id`).

**What to notice.**

- On a fresh store the list is empty `[]`. ❌ Nothing to approve yet.
- After sessions finish, drafts appear here for review. Approving one promotes it to memory, so future agents can find it (this is the lesson you saw appear in Scenario 2's `sections`).

---

## How to run these yourself (safe, throwaway data)

Use the memory store so nothing touches your real database:

```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run dev
```

The MCP stdio server is what coding agents talk to. The same tools are available over HTTP on `127.0.0.1:3027` for quick `curl` checks.
