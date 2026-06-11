---
name: tuberosa-agent-loop
description: "Use when an agent is about to start a non-trivial coding task in your project and needs the Tuberosa session loop: start a session, read the fit, record a decision, finish, and let it learn. Examples: \"How do I use Tuberosa for this task?\", \"Start a Tuberosa session\""
---

# Tuberosa Agent Loop

This skill teaches you **how** to run a Tuberosa session for a coding task.

> **Standing rule:** for any non-trivial task, call `tuberosa_start_session` before reading or editing code, record a context decision, and finish the session when done. This skill shows you how to follow that rule. For an overview of all Tuberosa tools, read [`tuberosa-guide`](../tuberosa-guide/SKILL.md).

The loop has 6 steps, always in this order:

```
start → read fit/orientation/brief → (verify if weak) → record decision → work → finish → learn
```

## Step 1 — Start the session

Call `tuberosa_start_session`. Always pass these:

| Field | Value |
| --------------- | -------------------------------------------------- |
| `project` | `"<your project name>"` |
| `cwd` | `"<absolute path to your project root>"` |
| `prompt` | the user's request, word for word |
| `contextMode` | `"layered"` |
| `noiseTolerance`| `"strict"` |
| `includeDeepContext` | `true` |
| `taskType` | e.g. `"debugging"`, `"implementation"`, `"review"`, `"planning"` |

`taskType` is a **closed set** — it must be one of: `debugging`, `implementation`, `refactor`, `review`, `planning`, `exploration`, `testing`, `unknown`. Do not invent other values.

Also pass any signals you already know: `files`, `symbols`, `errors`. More signals → better fit.

The reply has 4 top-level keys: `session`, `context`, `policy`, `handbook`.

## Step 2 — Read these BEFORE you act

Look inside `context` first. Do not touch code yet.

1. **`contextFit.fitStatus`** — how much to trust the pack. One of:
   - `ready` ✅ — strong match, you can proceed.
   - `needs_confirmation` ⚠️ — partial match, confirm first.
   - `insufficient` ❌ — weak/no match, verify from the repo.
2. **`orientation`** — recommended files to open + verification commands to run.
3. **`taskBrief`** — the concrete action items for this task.
4. **`policy.action`** — what to do next. On a fresh or sparse store it may say `clarify` — a hint the fit is weak, so confirm before trusting the pack (see Step 4). When fit is strong it says `proceed`.

## Step 3 — The pack is slim on purpose

The session reply is intentionally small (deep-context chunks may be truncated or left out). This keeps the response cheap.

When you need the **full** deep context, call:

```
tuberosa_get_context_pack  with  contextPackId  (the id from context.contextPackId)
```

✅ Use `tuberosa_get_context_pack` to expand. ❌ Do not assume the slim reply is everything.

## Step 4 — Verify from source if the fit is weak (CRITICAL)

If `fitStatus` is `needs_confirmation` or `insufficient`, **or** `policy.action` is `clarify`:

- ❌ Do NOT trust the pack blindly.
- ✅ Confirm against real repo evidence — Read / Grep the actual files before you act.

The pack is a starting point, not the truth. Real files are the truth.

## Step 5 — Record a decision (BEFORE substantive work)

Call `tuberosa_record_context_decision` with the `sessionId`, the `contextPackId`, and one `feedbackType`. Do this before you start editing.

The 5 most common values:

| `feedbackType` | Use it when... |
| -------------------- | ------------------------------------------------------ |
| `selected` | The pack was right and you used it. |
| `selected_but_noisy` | Useful, but mixed with irrelevant items. |
| `rejected` | The pack was wrong for this task; you did not use it. |
| `stale` | The pack pointed at old / out-of-date knowledge. |
| `missing_context` | A key piece you needed was not in the pack. |

Other valid values you may use: `irrelevant`, `too_much_adjacent_context`, `missing_orientation`, `missing_current_handoff`, `missing_verification_commands`. Use only values from this list.

## Step 6 — Finish (then it learns)

When the task is done, call `tuberosa_finish_session` with:

- `outcome` — how it ended.
- `summary` — a short plain-language recap.

On finish, a learning gate runs. It either **auto-approves** a small memory atom or leaves a **reviewable draft** for later. Learning needs an LLM provider — `openai` or `ollama` (the default `local` and the `hash` providers do not extract atoms) — see [`tuberosa-guide`](../tuberosa-guide/SKILL.md).

## The loop, at a glance

```
start → read fit/orientation/brief → (verify if weak) → record decision → work → finish → learn
```

## See also

- [`tuberosa-guide`](../tuberosa-guide/SKILL.md) — overview of all Tuberosa tools and resources.
