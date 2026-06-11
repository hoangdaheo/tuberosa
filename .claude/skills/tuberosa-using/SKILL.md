---
name: tuberosa-using
description: "Use when working in a project that has Tuberosa installed and you need to know which command or tool does what: the daily session loop, the install lifecycle, operator maintenance tasks, or which repo scripts to ignore. Examples: \"How do I use Tuberosa day to day?\", \"When do I run calibrate-fusion?\""
---

# Using Tuberosa

This skill is the map of Tuberosa for an end user. It answers one question: **"I want to X — what do I run?"** Four sections: the daily tool loop, the lifecycle commands, the maintenance tasks that still need a Tuberosa source checkout, and the contributor scripts you never run.

## 1. The daily loop — "I want to X" → tool

These are MCP tools. Your agent calls them while working; you never type them in a shell.

| I want to… | Call this |
| --- | --- |
| Start a non-trivial coding task | `tuberosa_start_session` — pass `project`, `cwd`, the user's prompt, `contextMode: "layered"`, `noiseTolerance: "strict"`, `includeDeepContext: true` |
| Search project knowledge without opening a session | `tuberosa_search_context` |
| Read the full chunks behind a slim session reply | `tuberosa_get_context_pack` with the `contextPackId` |
| Tell Tuberosa whether the pack helped — **before** substantive work | `tuberosa_record_context_decision` (`selected`, `selected_but_noisy`, `rejected`, `stale`, `missing_context`, … — full list in [`tuberosa-agent-loop`](../tuberosa-agent-loop/SKILL.md)) |
| End the task so Tuberosa can learn from it | `tuberosa_finish_session` with `outcome` + `summary` |

Always read `contextFit.fitStatus` before trusting a pack:

| Status | Meaning | What you do |
| --- | --- | --- |
| `ready` ✅ | strong match | proceed |
| `needs_confirmation` ⚠️ | partial match | confirm against real files first |
| `insufficient` ❌ | weak or no match | work from repo evidence, not the pack |

For the full step-by-step loop, read [`tuberosa-agent-loop`](../tuberosa-agent-loop/SKILL.md).

## 2. Lifecycle — CLI commands in the order you meet them

| When | Run | What it does |
| --- | --- | --- |
| Once per project | `npx tuberosa init` | Brings up the full local stack: Docker Postgres + Redis, migrations, embedding-model warm-up. **Docker is required** — `--embedded` opts into volatile trial mode instead (everything in memory, data lost on exit). Also writes agent MCP configs (`.mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml`; skip with `--no-mcp-config`) and copies all bundled skills into `./.claude/skills/` (skip with `--no-skills`). |
| Once per editor / agent | `npx tuberosa mcp install` | Re-writes the agent MCP config files on demand. Merge-only: it never clobbers other servers already in a config. |
| First onboard of a project | `npx tuberosa bootstrap` | First-run project knowledge: additive sync + atlas + health summary (`--deep` for a deeper pass). |
| Keeping knowledge fresh | `npx tuberosa sync`, then `npx tuberosa sync --apply` | Two-step on purpose: the first call shows the plan, `--apply` executes it (destructive archiving also needs `--yes`). `npx tuberosa hook install` adds a git hook for additive-only auto-sync. |
| When something breaks | `npx tuberosa doctor` | Checks Node, pnpm, Docker, port 3027, Postgres reachability, and MCP stdout sanity. |

One expectation to set: the LEARN pillar (turning finished sessions into reusable memory) needs an LLM provider — `openai` or `ollama`. It stays **off** under the default `local` provider and under `hash`. FIND (retrieval) works on all providers.

## 3. Operator tasks that are script-only today

These seven maintenance tasks have **no CLI subcommand yet** (promoting them to `tuberosa <cmd>` is explicitly future work). Each runs **from a Tuberosa source checkout** with the repo's script runner — they do not exist inside your consumer project.

| Script | What it does (one line) |
| --- | --- |
| `backup` | Snapshot the knowledge store to a backup directory and report backup health. |
| `restore` | Restore the knowledge store from a chosen backup. |
| `error-logs` | List and inspect error logs recorded by agents. |
| `context-quality` | Report on context-quality feedback collected from agent sessions. |
| `organization` | Export read-only organization views of the store: project map, knowledge graph (JSONL), readable summary. |
| `export-pack` | Export one project's knowledge as a portable pack file. |
| `import-pack` | Import a previously exported pack file. |

Some have MCP tool equivalents your agent can call without a checkout: `tuberosa_export_pack`, `tuberosa_import_pack`, `tuberosa_list_error_logs`, `tuberosa_collect_context_quality_feedback`.

## 4. Everything else is contributor tooling — you never run these

Every other script in the Tuberosa repo gates development **of Tuberosa itself**. If you are using Tuberosa (not building it), you never run them:

| Group | Examples | Why you can ignore them |
| --- | --- | --- |
| Quality evals | `eval:retrieval`, `eval:agent-context`, `eval:safety`, `eval:knowledge-completeness` | Regression gates for Tuberosa's own retrieval quality. |
| Tuning & benchmarks | `sandbox`, `sandbox:ablate`, `calibrate-fusion`, `benchmark` | Re-tune fusion weights from synthetic corpora. The answer to "when do I run `calibrate-fusion`?" is **never**. |
| Data & graph maintenance | `reembed`, `seed:self`, `backfill:domains`, `archival-sweep`, `infer-co-change`, `prune-stale-edges`, `cluster-user-corrections`, `migrate-knowledge-to-atoms`, `import:docs` | One-off migrations and graph upkeep for Tuberosa's own store. |
| Build & CI | `build`, `test`, `test:integration`, `verify:bundled-skills` | CI for the Tuberosa codebase. |

## See also

- [`tuberosa-agent-loop`](../tuberosa-agent-loop/SKILL.md) — the session loop, step by step.
- [`tuberosa-guide`](../tuberosa-guide/SKILL.md) — what Tuberosa is; FIND vs LEARN; the full tool map.
- [`tuberosa-onboard-project`](../tuberosa-onboard-project/SKILL.md) — onboard a repo into Tuberosa.
- [`tuberosa-operating`](../tuberosa-operating/SKILL.md) — operate Tuberosa as a human (ingest, review, curate).
