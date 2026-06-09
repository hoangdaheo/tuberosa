---
name: tuberosa-guide
description: "Use when the user or agent asks what Tuberosa is, which Tuberosa MCP tools exist, or how the FIND and LEARN pillars work. Examples: \"What Tuberosa tools are available?\", \"How does Tuberosa learning work?\""
---

# Tuberosa Guide

Tuberosa is a local-first MCP context broker for coding agents. It does two jobs. This file explains the system and points you to the next skill to read.

## Two Pillars

Tuberosa has two pillars. Think of them as two halves of one loop.

| Pillar | What it does | Works on which model? |
| --- | --- | --- |
| **FIND** | Gives an agent the right project knowledge for its task. | ✅ All providers (`hash`, `openai`, `ollama`). |
| **LEARN** | Turns a finished session into atoms → conventions → reusable memory, so the next agent does not repeat mistakes. | ⚠️ Needs a real model (`openai` or `ollama`). ❌ OFF under `hash`. |

In short: FIND reads knowledge in. LEARN writes new knowledge back. Under the `hash` provider you still get FIND, but LEARN is off.

## Tool Map

The tools are grouped into three categories. The counts below are verified against `src/mcp/tool-definitions.ts`.

| Group | Count | What it is for | Examples |
| --- | --- | --- | --- |
| core | 17 | Agent-facing retrieval / session / learning | `tuberosa_search_context`, `tuberosa_start_session`, `tuberosa_record_context_decision`, `tuberosa_finish_session`, `tuberosa_get_context_pack` |
| admin-ops | 17 | Human / maintenance / review / import-export | `tuberosa_sync_sources`, `tuberosa_list_reflection_drafts`, `tuberosa_review_reflection_draft`, `tuberosa_export_pack`, `tuberosa_import_pack` |
| diagnostics | 2 | Health / introspection | `tuberosa_atom_gate_stats`, `tuberosa_atom_graph_density` |

- **core** = what a coding agent calls while doing a task.
- **admin-ops** = what a human runs to ingest, review, and curate.
- **diagnostics** = health and introspection checks.

## Which Skill Next?

Pick the row that matches what you want, then read that file.

| I want to… | Read |
| --- | --- |
| Drive a coding task through Tuberosa (the session loop) | `.claude/skills/tuberosa/tuberosa-agent-loop/SKILL.md` |
| Operate Tuberosa as a human (ingest, review, evals) | `.claude/skills/tuberosa/tuberosa-operating/SKILL.md` |
| Set up the environment | `docs/SETUP.md` |

## One Note

The **mandatory startup rule** lives in `CLAUDE.md` (the "Tuberosa MCP startup rule"). This skill explains the system; it does not replace that rule.
