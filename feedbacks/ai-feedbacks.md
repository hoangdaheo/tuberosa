Yes. My feedback is that Tuberosa was useful, but it did not fully carry the task by itself.

**Did it feed appropriate knowledge?**

Partially. It surfaced relevant adjacent context: roadmap phases, MCP/server surfaces, and backup-related memory. But the most important sources for this ticket were local working files: `handoff.md`, `plan-for-handoff.md`, `src/operations/workbench-summary.ts`, `src/http/workbench.ts`, and `tuberosa-concern-answer.md`. Tuberosa explicitly marked several of those as missing signals, so the fit was correctly `needs_confirmation`.

That is good behavior: it did not overclaim. But for handoff continuation work, missing the current handoff/plan files is a major gap.

**What I want Tuberosa to do when approaching a new task**

I want it to produce a startup brief like:

- `proceed / confirm / clarify`
- exact files to read first
- current handoff and plan status
- direct evidence vs adjacent context
- missing signals that block confidence
- likely verification commands
- risky areas, especially API contracts and persistence boundaries
- required context-decision action before finishing

For this ticket, it should have said: “Read `handoff.md` and `plan-for-handoff.md` first; the stored context is noisy and incomplete.”

**Improvements suggested by this task**

Tuberosa should treat continuation prompts and handoff-style prompts as a special workflow. It should prioritize current local files and untracked plan files more aggressively, especially when the user names them directly.

It should also distinguish “stored memory says this exists” from “current worktree file exists and changed.” A lot of implementation truth lived in the git diff, not in approved memory.

**Things I wanted that Tuberosa does not fully support yet**

- A real worktree-aware context bridge: current git diff, untracked files, and recently edited files.
- A browser/workbench verification mode that can record UI audit evidence.
- A preview-first maintenance loop for stale/duplicate memories.
- A stronger “handoff continuation” mode that reads the current handoff, plan, and active session state together.
- Automatic compact research trace summaries after investigation, without storing raw transcript noise.

**Things Tuberosa should remember to avoid repeated mistakes**

- Browser tests should stay outside `test/*.test.ts`; use a dedicated script so normal tests do not require Chrome or port binding.
- Browser-test knowledge must be seeded through `IngestionService.ingestKnowledge()`, not direct store writes, or retrieval has no chunks/relations.
- `WorkbenchSummary` must stay compact: no raw draft content, knowledge content, metadata blobs, `agentBrief`, or backup manifest table checksums.
- `/workbench` can be public, but `/operations/workbench/summary` must follow API-key protection.
- Backup health should not flag `scheduler.enabled && !running` during startup delay as a problem.
- Successful backups should clear stale scheduler `lastError`, otherwise the workbench keeps showing repaired issues.