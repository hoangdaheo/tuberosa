# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Detailed guidance is split into focused rule files under `.claude/rules/` and imported below. Edit a rule in its own file; keep this index short.

## User Rules
- **MUST** generate the output to be similar to `Explain Like I'm 5 or intern`
- Ensure the AI user will know and understand well, even if for non-native English developer
- Make sure the Human deeply understand when working with you, like the incredible, effectively teacher

## What Tuberosa is (30-second version)

Tuberosa is a **local-first MCP context broker** — a memory + librarian for coding agents. It has exactly two pillars:

- **FIND** — hand the agent the *right* ranked notes for the task now (`tuberosa_search_context`). Pipeline: classify → rewrite → 5-source hybrid search → fuse → rerank → adjust → context-fit → assemble → deep-context.
- **LEARN** — turn a finished session into a *human-reviewed* lesson for next time (`tuberosa_start_session` → `tuberosa_finish_session` → reflection draft → human gate → searchable memory).

Storage: Postgres + pgvector (source of truth), Redis (cache), `.tuberosa/current/` (one-way human-readable mirror). For the full mechanism read [`README.md`](README.md), the plain-language [`nash-readme.md`](nash-readme.md), and [`AGENTS.md`](AGENTS.md) (source map + API surface). Product intent lives in [`docs/tuberosa-project.md`](docs/tuberosa-project.md); the **live working state** (what's in flight or uncommitted) lives in [`handoff.md`](handoff.md) — check it at the start of a session.

## Rules (always loaded)

Short, high-value operational rules — imported into every session:

@.claude/rules/tuberosa-startup.md
@.claude/rules/commands.md
@.claude/rules/key-constraints.md
@.claude/rules/workflow.md

## Deep reference (read on demand)

These are not auto-loaded — open the one you need:

| Doc | Read it for |
|-----|-------------|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System structure, components, data flow, data model, deploy topology |
| [`docs/FEATURES.md`](docs/FEATURES.md) | Feature inventory, domain model, business rules, glossary, invariants |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | Code style, naming, testing, error handling, and the add-endpoint / add-MCP-tool cookbook |
| [`docs/SETUP.md`](docs/SETUP.md) | Environment setup + the full model-provider matrix |

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **tuberosa** (10121 symbols, 22129 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/tuberosa/context` | Codebase overview, check index freshness |
| `gitnexus://repo/tuberosa/clusters` | All functional areas |
| `gitnexus://repo/tuberosa/processes` | All execution flows |
| `gitnexus://repo/tuberosa/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
