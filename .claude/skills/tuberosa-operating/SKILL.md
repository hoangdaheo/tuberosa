---
name: tuberosa-operating
description: "Use when a human operator wants to drive Tuberosa: ingest sources, review reflection drafts, approve conventions, run evals, read the atlas, or turn on learning. Examples: \"How do I review Tuberosa drafts?\", \"Run the Tuberosa evals\""
---

# Tuberosa Operating Runbook

A runbook for a **human operator** driving Tuberosa. Tuberosa is a local-first MCP context broker: it feeds ranked project knowledge to coding agents and stores reviewed lessons so future agents do not repeat mistakes.

This file is grouped by **what you want to do** (a human action), not by tool category. Each action shows **When**, **How**, and **What to expect**.

> Want the tool category map (core vs admin-ops) or a full tool list? Read `.claude/skills/tuberosa-guide/SKILL.md`.

## Actions At A Glance

| # | I want to...                  | How (tool or command)                                  |
| - | ----------------------------- | ------------------------------------------------------ |
| 1 | Add my docs/code to Tuberosa  | `tuberosa_sync_sources` (or HTTP `POST /ingest/files`) |
| 2 | Review the lessons it learned | `tuberosa_list_reflection_drafts` → `tuberosa_review_reflection_draft` |
| 3 | Clean up the knowledge base   | `tuberosa_propose_curation`                            |
| 4 | See the big picture           | `tuberosa_get_atlas`                                   |
| 5 | Check quality                 | `pnpm run eval:*` (one at a time)                      |
| 6 | Turn on learning (atoms)      | Set an extract model env var, then restart MCP server  |

---

## 1. Ingest sources

- **When:** You added or changed docs, specs, or code and want Tuberosa to know about them.
- **How:** Call `tuberosa_sync_sources`. (HTTP equivalent: `POST /ingest/files`.)
- **What to expect:** An upsert summary — a `results` array, one entry per stored item. ✅ Items appear in the array. ❌ An empty array means nothing was ingested — check the paths you passed.

## 2. Review reflection drafts

Tuberosa proposes **draft lessons** from agent sessions. A human approves the good ones so they become trusted memory.

- **When:** After agents have worked, on a regular cadence (for example, weekly).
- **How (two steps):**
  1. `tuberosa_list_reflection_drafts` — see the pending drafts.
  2. `tuberosa_review_reflection_draft` — approve or reject one draft.
- **What to expect:** Step 1 returns a list of drafts. Step 2 returns the **updated status** of the draft you acted on (approved or rejected). ✅ Approved drafts become searchable memory. ❌ Rejected drafts stop being suggested.

## 3. Propose curation

- **When:** The knowledge base feels noisy, duplicated, or out of date.
- **How:** Call `tuberosa_propose_curation`.
- **What to expect:** A curation suggestion — **merge**, **split**, or **retire** candidates. These are suggestions only; you decide what to act on. ✅ Use it to keep the base small and sharp.

## 4. Read the atlas

- **When:** You want a one-look overview of the project as Tuberosa understands it.
- **How:** Call `tuberosa_get_atlas`.
- **What to expect:** Sections such as **project-map**, **flows**, and **commands**. ✅ A good way to sanity-check what Tuberosa knows before trusting its answers.

## 5. Run evals

Run **one** `pnpm` command at a time, so if one fails you know which one. These are your quality gates.

| Command                              | Checks                          | Must hold                                  |
| ------------------------------------ | ------------------------------- | ------------------------------------------ |
| `pnpm run eval:retrieval`            | Retrieval quality               | Stays green: `hitRate=1`, `staleRejectionRate=1` |
| `pnpm run eval:agent-context`        | Agent session lifecycle         | Sessions start → decide → finish cleanly   |
| `pnpm run eval:knowledge-completeness` | LEARN loop / atoms            | Atoms extracted and complete               |

- **When:** Before trusting a change, and before merging anything that touches retrieval, sessions, or learning.
- **What to expect:** A pass/fail report per eval. ✅ All green. ❌ If `eval:retrieval` is red, **do not** tweak thresholds — fix the logic.

> If your shell uses an old Node, prefix the command:
> `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval`

## 6. Turn on learning (atom extraction)

The LEARN loop pulls small reusable facts ("atoms") out of content. It is **OFF** under the `hash` provider. It works on **both** `ollama` and `openai`.

- **When:** You want Tuberosa to start extracting atoms automatically.
- **How (pick one, then restart the MCP server):**
  - **Ollama:** set `TUBEROSA_OLLAMA_EXTRACT_MODEL=qwen2.5:3b-instruct`
  - **OpenAI:** set `OPENAI_RERANK_MODEL=<an OpenAI model id>` (exact choice lives in `docs/SETUP.md` / `docs/MINIMAL_ENV.md`)
  - Then **restart the MCP server** so the provider re-registers. The env var alone does nothing until restart.
- **What to expect:** After restart, ingestion and sessions begin producing atoms. ✅ `pnpm run eval:knowledge-completeness` exercises this path. ❌ Still no atoms under `hash` — that provider has extraction off by design.

> For the full provider/env matrix (which keys each provider needs), read `docs/SETUP.md` and `docs/MINIMAL_ENV.md`. Do not memorize it from here.

---

## See Also

- `.claude/skills/tuberosa-guide/SKILL.md` — Tuberosa overview, tool list, and tool category map.
- `docs/SETUP.md` — environment setup and provider matrix.
