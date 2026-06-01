# 05 — Agent Session Lifecycle

An **agent session** is an audit record that bundles one agent task end-to-end: the initial context fetch, every context decision the agent made, mid-task learning signals, and a final outcome. Sessions exist for two reasons:

1. **Audit** — show what context the agent used and what it decided to do.
2. **Learning** — the `finish_session` step extracts a reviewable reflection draft so future agents learn from what worked.

## State machine

```
                start_session
                     │
                     ▼
              ┌─────────────┐
              │   active    │
              └─────┬───────┘
                    │
       record_context_decision  (any number)
       capture_learning_signal  (any number)
       append_session_note      (any number)
                    │
                    ▼
              ┌─────────────┐
              │  finished   │  outcome: completed | failed | blocked | cancelled
              └─────────────┘
                    │
                    ▼
        reflection draft queued for review
```

## API

| Step | MCP tool | HTTP route |
|---|---|---|
| Start | `tuberosa_start_session` | `POST /agent-sessions` |
| Record context decision | `tuberosa_record_context_decision` | `POST /agent-sessions/{id}/context-decision` |
| Capture learning signal | `tuberosa_capture_learning_signal` | `POST /agent-sessions/{id}/learning-signals` |
| Append note | `tuberosa_append_session_note` | `POST /agent-sessions/{id}/notes` |
| Finish | `tuberosa_finish_session` | `POST /agent-sessions/{id}/finish` |
| Read | – | `GET /agent-sessions/{id}` |
| List | – | `GET /agent-sessions` |

## Start: `tuberosa_start_session`

```jsonc
{
  "project":          "newsletter-app",
  "cwd":              "/home/me/projects/newsletter",
  "prompt":           "Update PaywallSelectionModal for the new flow",
  "files":            ["src/components/paywall-selection-modal.tsx"],
  "symbols":          ["PaywallSelectionModal"],
  "errors":           [],
  "taskType":         "implementation",
  "contextMode":      "layered",
  "noiseTolerance":   "strict",
  "includeDeepContext": true,
  "agentTool":        "Claude Code",
  "agentName":        "claude-sonnet-4-6"
}
```

Returns `{session, context, policy}`:

- `session.id` — the session UUID to use for every later call.
- `session.initialContextPackId` — the pack id of the first retrieval.
- `context` — the full context pack (same shape as `tuberosa_search_context`).
- `policy.action` — one of `proceed`, `confirm_shortlist`, `request_missing_signals`. The agent should branch on this.

## Record context decision

```jsonc
{
  "sessionId": "<session-id>",
  "contextPackId": "<pack-id>",
  "feedbackType": "selected",          // see table
  "reason":       "matched the paywall flow",
  "rejectedKnowledgeIds": []
}
```

Valid `feedbackType` values:

| Value | Meaning |
|---|---|
| `selected` | Used the pack as delivered. |
| `rejected` | The pack was wrong; agent picked something else. |
| `stale` | An item in the pack pointed to old code/info. |
| `irrelevant` | The pack didn't help. |
| `missing_context` | The pack was missing a critical signal. |
| `selected_but_noisy` | Used it, but it had too much filler. |
| `too_much_adjacent_context` | Layered mode over-pulled. |
| `missing_orientation` | Pack lacked task brief / verification commands. |
| `missing_current_handoff` | Continuation notes were absent. |
| `missing_verification_commands` | Couldn't tell how to verify the work. |

These map directly to feedback events on the underlying pack.

## Capture learning signal (mid-task)

Use when the agent learns something **during** the task that should outlive the session:

```jsonc
{
  "sessionId": "<id>",
  "kind":       "tip",                  // tip | decision | mistake | verification | file_change | user_preference | follow_up
  "source":     "agent",                // user | agent | tool | system | reviewer
  "text":       "When refactoring auth, the worker has its own DB pool too.",
  "files":      ["src/worker.ts"],
  "symbols":    ["WorkerDbPool"],
  "errors":     [],
  "confidence": 0.85,
  "references": [{ "type": "commit", "uri": "abc1234" }]
}
```

These accumulate on the session and become candidate evidence for the reflection draft on finish.

## Append session note

Free-form post-hoc note. Optional; useful when a context-quality issue is discovered after the fact:

```jsonc
{
  "sessionId": "<id>",
  "kind":      "context_quality_feedback",
  "text":      "The graph expansion pulled in too many adjacent atoms.",
  "feedbackType": "too_much_adjacent_context"
}
```

## Finish: `tuberosa_finish_session`

```jsonc
{
  "sessionId":      "<id>",
  "outcome":        "completed",        // completed | failed | blocked | cancelled
  "summary":        "Updated PaywallSelectionModal to preserve product ids.",
  "changedFiles":   ["src/components/paywall-selection-modal.tsx"],
  "verificationCommands": ["pnpm test --filter paywall"],
  "agentOutputSummary":   "All tests pass; PR ready.",
  "learningSignals":      [ /* same shape as capture_learning_signal */ ],
  "researchTrace":        { "steps": [...], "outcome": "..." },
  "learningMode":         "auto"        // auto | draft_only | off
}
```

What `finish` does:

1. Closes the session (status = `finished`, sets `finishedAt`).
2. Computes a **research trace** if not supplied (derived from decisions + notes + changed files).
3. Runs the **learning gate** — the `learningGate` function in `src/agent-session/service.ts` (which calls `evaluateGates` from `src/reflection/recommendation.ts`) that scores whether the session produced a durable lesson.
4. Depending on `learningMode`:
   - `auto` (default) — gate decides: auto-approve as memory, or queue a draft for review.
   - `draft_only` — always queue a draft, never auto-approve.
   - `off` — no draft created.
5. Optionally accepts an explicit `reflectionDraft` payload (overrides auto-extraction).

Returns the session record plus, if applicable, `reflectionDraft` (with `id` and gate decision).

## Recommended agent workflow

```
1. tuberosa_start_session
       │
       ▼
2. Inspect context.contextFit + policy.action:
       ─ proceed              → step 3
       ─ confirm_shortlist    → show pack to user, wait for OK
       ─ request_missing_signals → ask user for files/symbols/errors/intent
       │
       ▼
3. (If only a shortlist was returned)
   tuberosa_get_context_pack(id=initialContextPackId)
       │
       ▼
4. Do the work.
       │
       ▼
5. tuberosa_record_context_decision (any time during the task)
   tuberosa_capture_learning_signal (mid-task durable lessons)
       │
       ▼
6. tuberosa_finish_session(outcome, summary, changedFiles, verificationCommands)
       │
       ▼
7. Reflection draft queued for review.
```

## Eval gate: `pnpm run eval:agent-context`

There is a deterministic eval that asserts agents follow this lifecycle. It checks:

- Did the agent call `start_session` before `record_context_decision`?
- Did it inspect `contextFit` before acting?
- Did it record at least one decision before `finish_session`?
- Did it run the verification commands suggested?

If you add or rewire any session tool, run this eval — it's part of the merge gate.

## Read next

- [06-reflection-memory.md](06-reflection-memory.md) — what happens to the draft after `finish`.
- [09-mcp-reference.md](09-mcp-reference.md#session-lifecycle) — full tool argument reference.
- [10-http-api-reference.md](10-http-api-reference.md#agent-sessions) — HTTP equivalents.
