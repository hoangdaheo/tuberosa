# Tuberosa Agent Trial Harness

A multi-agent test harness for Tuberosa. Where `eval/retrieval-fixtures.json` measures the retrieval pipeline in isolation, this harness measures **end-to-end usefulness**: does Tuberosa's context actually help a real coding agent succeed, and where does it fail when it does?

## Goal

Existing evals answer *"did Tuberosa rank the right items?"* This harness answers four downstream questions:

1. **Sufficiency** — could a worker agent complete the task using only the pack?
2. **Hallucination resistance** — did the worker invent facts that aren't in the pack OR the codebase?
3. **Noise** — how many pack items were on-topic but contributed nothing?
4. **Contradiction handling** — when pack items disagree, does Tuberosa flag it before the agent picks the wrong one?

## Three roles

| Agent | Lives at | What it does |
|---|---|---|
| **Child worker** | `.claude/agents/tuberosa-child-worker.md` | Solves the task using ONLY a frozen Tuberosa pack. Reports per-item utility honestly. |
| **Debater** | `.claude/agents/tuberosa-debater.md` | Adversarial fact-check. Verifies every pack claim against the actual code; finds inter-pack contradictions; proposes counter-context. |
| **Mother judge** | `.claude/agents/tuberosa-mother-judge.md` | Smartest. Grades each Tuberosa pipeline stage, assigns root-cause blame, proposes concrete code+fixture changes. |
| **Orchestrator** | `.claude/agents/tuberosa-trial-orchestrator.md` | Wires one case through pack → child → debater → mother and writes the report. |

## Running a trial

From the repo root, ask Claude Code to run the orchestrator:

```text
Run the tuberosa-trial-orchestrator agent on eval/agent-trials/cases/01-classifier-edge-case.md
```

Or invoke it programmatically from the Agent SDK / Claude API by spawning the orchestrator subagent with the case path.

## Case file format

See `cases/01-classifier-edge-case.md` for the canonical example. Each case declares:
- `id`, `task_type`, `task`, optional `files/symbols/errors`
- `ground_truth` (changed files, required facts, forbidden outcomes)
- `expectations` (fit status, must-include / must-not-include knowledge ids)
- `constraints` (noise tolerance, context mode, token budget)
- `notes` (free-form context for the mother)

## Output layout

```
eval/agent-trials/
  cases/
    01-classifier-edge-case.md
    02-noisy-context-retrieval.md
  reports/
    <case-id>/<YYYY-MM-DDTHH-MM-SS>/
      pack.json          # full Tuberosa response (or pack.error.txt if the call failed)
      child.json
      debater.json
      mother.json
      report.md          # human summary aggregating all four
```

## Known blockers

- **Worktree UUID leak**: in some checkouts (including this one as of 2026-05-23) `tuberosa_search_context` returns
  `MCP error -32603: invalid input syntax for type uuid: "worktree:<sha>"`.
  The synthetic worktree ids generated at `src/retrieval/worktree.ts:168` are filtered before some `::uuid` casts (`src/storage/postgres-store.ts:386,1139`) but at least one path still leaks. Until fixed, trials that depend on a live pack will run the orchestrator's `pack.error.txt` path — the framework still works, it just flags this as the P0 root cause.

## How findings feed back into Tuberosa

- The mother emits `tuberosa_feedback_to_record[]` entries; the orchestrator records each via `tuberosa_feedback_context`. Those signals flow into `feedback_events` and influence future ranking.
- Inter-pack contradictions go into `knowledge_conflicts` (review-only — Tuberosa does not auto-supersede).
- Repeated noise findings on the same knowledge id should escalate to a `learning_proposal` of type `auto_memory_cleanup`.

## What this harness intentionally does NOT do

- It does not retrain or auto-tune Tuberosa weights. All improvement proposals are reviewable code changes + new fixture cases.
- It does not replace `eval:retrieval`. Both are needed: `eval:retrieval` is fast and deterministic; this harness is slower but tests downstream usefulness.
