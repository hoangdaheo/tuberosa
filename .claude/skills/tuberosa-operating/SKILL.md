---
name: tuberosa-operating
description: "Use when a human operator wants to drive Tuberosa: ingest sources, review reflection drafts, approve conventions, read the atlas, or turn on learning. Examples: \"How do I review Tuberosa drafts?\", \"Ingest my docs into Tuberosa\""
---

# Tuberosa Operating Runbook

A runbook for a **human operator** driving Tuberosa. Tuberosa is a local-first MCP context broker: it feeds ranked project knowledge to coding agents and stores reviewed lessons so future agents do not repeat mistakes.

This file is grouped by **what you want to do** (a human action), not by tool category. Each action shows **When**, **How**, and **What to expect**.

> Want the tool category map (core vs admin-ops) or a full tool list? Read `.claude/skills/tuberosa-guide/SKILL.md`.

## Actions At A Glance

| # | I want to...                  | How (tool or command)                                  |
| - | ----------------------------- | ------------------------------------------------------ |
| 1 | Add my sources to Tuberosa    | `tuberosa_sync_sources` (or HTTP `POST /ingest/files`) |
| 2 | Review the lessons it learned | `tuberosa_list_reflection_drafts` → `tuberosa_review_reflection_draft` |
| 3 | Clean up the knowledge base   | `tuberosa_propose_curation`                            |
| 4 | See the big picture           | `tuberosa_get_atlas`                                   |
| 5 | Check quality                 | contributor-only: quality evals run in the Tuberosa repo, not in your project |
| 6 | Turn on learning (atoms)      | Set an extract model env var, then restart MCP server  |

---

## 1. Ingest sources

- **When:** You added or changed docs, specs, or code and want Tuberosa to know about them.
- **How (two steps):**
  1. Call `tuberosa_sync_sources` — this is a **dry-run**. It returns a `planId`, a `plan` (added / changed / renamed / deleted files), and an `instruction`. Nothing is ingested yet.
  2. Call it again with `apply: true` and the `planId` to apply the plan.
- **What to expect:** Ingestion happens only on the second call. ⚠️ If the plan is **destructive** (deleted files), show the deletion list to a human before re-calling with `apply: true`. ❌ An empty plan means nothing changed — check the paths you passed.

## 2. Review reflection drafts

Tuberosa proposes **draft lessons** from agent sessions. A human approves the good ones so they become trusted memory.

- **When:** After agents have worked, on a regular cadence (for example, weekly).
- **How (two steps):**
  1. `tuberosa_list_reflection_drafts` — see the pending drafts.
  2. `tuberosa_review_reflection_draft` — approve or reject one draft.
- **What to expect:** Step 1 returns a list of drafts. Step 2 returns the **updated status** of the draft you acted on (approved or rejected). ✅ Approved drafts become searchable memory. ❌ Rejected drafts stop being suggested.

## 3. Propose curation

- **When:** Un-curated atoms have piled up and you want to distill them into reusable conventions.
- **How:** Call `tuberosa_propose_curation`.
- **What to expect:** Deterministic **clusters** of un-curated atoms. The tool does no reasoning — you (the agent or human) distill each cluster into one convention via `tuberosa_reflect`. For merge / stale / superseded cleanup, use `tuberosa_propose_maintenance` instead (reviewer-gated, never auto-applied). ✅ Use both to keep the base small and sharp.

## 4. Read the atlas

- **When:** You want a one-look overview of the project as Tuberosa understands it.
- **How:** Call `tuberosa_get_atlas`.
- **What to expect:** Sections such as **project-map**, **flows**, and **commands**. ✅ A good way to sanity-check what Tuberosa knows before trusting its answers.

## 5. Check quality

Quality evals (`retrieval`, `agent-context`, `knowledge-completeness`) are contributor tooling that runs inside the Tuberosa checkout — as an operator of an installed Tuberosa you never run them. If retrieval quality looks wrong, use `npx tuberosa doctor` and the feedback tools (`tuberosa_feedback_context`) instead.

## 6. Turn on learning (atom extraction)

The LEARN loop pulls small reusable facts ("atoms") out of content. It is **OFF** under both the default `local` provider and `hash` — extraction needs an LLM. It works on **both** `ollama` and `openai`.

- **When:** You want Tuberosa to start extracting atoms automatically.
- **How (pick one, then restart the MCP server):**
  - **Ollama:** set `TUBEROSA_OLLAMA_EXTRACT_MODEL=qwen2.5:3b-instruct`
  - **OpenAI:** set `OPENAI_RERANK_MODEL=<an OpenAI model id>` (any current OpenAI model id works; pick a small one for cost)
  - Then **restart the MCP server** so the provider re-registers. The env var alone does nothing until restart.
- **What to expect:** After restart, ingestion and sessions begin producing atoms. ✅ New sessions produce atoms (check with `tuberosa_atom_gate_stats`). ❌ Still no atoms under the default `local` or under `hash` — those providers have extraction off by design.

> For the full provider/env matrix (which keys each provider needs), see the Configuration section of the Tuberosa README (shipped with the package). Do not memorize it from here.

---

## See Also

- `.claude/skills/tuberosa-guide/SKILL.md` — Tuberosa overview, tool list, and tool category map.
