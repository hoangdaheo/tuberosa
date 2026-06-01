# Next-Session Prompt — Knowledge-Book Phases 3 / 4a / 4b

Paste the block below into a fresh Claude Code session to resume. It assumes zero memory of the prior conversation.

```
Resume the Tuberosa "Project Knowledge-Book" feature. Work in /home/nash/tuberosa.

CONTEXT (already shipped, do not redo):
- Phase 1 (foundation) = PR #28 on branch feat/project-knowledge-book: team atom scope + teamId
  (migration 013), config.teamId, resolveLayeredConflicts.
- Phase 2 (recall) = PR #29 on branch feat/knowledge-book-phase2: convention retrieval lane,
  pinning, layered-conflict swap, start_session handbook status, eval fixtures.
- The approved design is docs/superpowers/specs/2026-05-31-project-knowledge-book-design.md.
- Project memory: the "project-knowledge-book" entry has the full thread + the convention-metadata contract.

YOUR JOB — execute the remaining phases, each via superpowers:subagent-driven-development
(fresh implementer + spec-compliance review + code-quality review per task; final holistic
review per phase), in THIS order, each as its own stacked branch + PR:
  1. docs/superpowers/plans/2026-05-31-project-knowledge-book-phase3-handbook-view.md
  2. docs/superpowers/plans/2026-05-31-project-knowledge-book-phase4a-capture-curation.md  (before 4b)
  3. docs/superpowers/plans/2026-05-31-project-knowledge-book-phase4b-bootstrap.md
Each plan is self-contained (exact file:line anchors + concrete TDD code). Start with Phase 3 only;
pause after each phase to open its PR and let me review before starting the next.

SETUP:
- Branch off feat/knowledge-book-phase2 (or main if PRs #28/#29 are already merged — check `gh pr view 28 29`).
- Run `npx gitnexus analyze` once before editing code (index is stale).

HARD RULES (from CLAUDE.md + project conventions):
- Follow this repo's CLAUDE.md "Tuberosa MCP startup rule" before substantive work.
- After ANY change under src/retrieval/, src/reflection/, or src/storage/, run `pnpm run eval:retrieval`
  and confirm hitRate=1 / staleRejectionRate=1. NEVER lower a threshold to pass — fix the logic.
- Gate every task on `pnpm run build && pnpm test` green. Verify with fresh command output before
  claiming done (superpowers:verification-before-completion).
- Commits: NEVER add a "Co-Authored-By: Claude" or any AI-attribution trailer. Stage only the files
  you changed — do NOT `git add -A` (it sweeps in AGENTS.md / CLAUDE.md / .tuberosa/last-eval.json,
  which are external/generated churn to leave untouched).
- Architecture constraint: ModelProvider has NO text-generation seam, so the CALLING AGENT does all
  distillation reasoning; atlas builders and clustering stay deterministic (that's the eval contract).

Begin with Phase 3: read the plan, then execute it task-by-task.
```
