# Phase 2: Worktree-Aware Startup Brief And Automation Preview

## Summary
- Implement the deferred Phase 2 work from `handoff.md`, `plan-for-handoff.md`, `tuberosa-concern-answer.md`, and `ai-feedbacks.md`.
- The next step is a thin vertical slice: Tuberosa should start a session with a clear `proceed / confirm / clarify` brief, prioritize current local handoff/worktree files, preserve compact research outcomes, and preview memory maintenance before mutation.
- Checked skipped work: Phase 1’s browser/workbench audit is done; the skipped item is the broader automation direction in `tuberosa-concern-answer.md`, now refined by `ai-feedbacks.md`.

## Key Changes
- Add a worktree evidence bridge used during context search/session start when `cwd` is provided.
  - Read bounded git status, staged/unstaged changed files, untracked files, and recently modified named files.
  - Prioritize `handoff.md`, `plan-for-handoff.md`, `tuberosa-project.md`, `ai-feedbacks.md`, and prompt-named files for continuation tasks.
  - Return compact evidence only: paths, statuses, short markdown section/status summaries, and skipped reasons. Do not store raw diffs or full file content.

- Add `startupBrief` to context packs and MCP/HTTP start-session responses.
  - Include: `action`, exact files to read first, current handoff/plan status, direct evidence, adjacent context, missing signals, risky areas, verification commands, and required context-decision action.
  - Distinguish `source: "worktree"` from `source: "memory"` so agents can see when current worktree truth differs from stored memory.
  - Keep existing `contextFit`, `orientation`, and `taskBrief`; the brief composes them rather than replacing them.

- Improve handoff continuation behavior.
  - Extend continuation classification and recommended files to include `plan-for-handoff.md` and prompt-named local markdown files.
  - If local handoff/plan files exist but stored memory is weak, return `confirm` with explicit read-first files instead of overclaiming.
  - If required handoff files are missing from both worktree and memory, return `clarify` and create/encourage `missing_current_handoff` feedback.

- Add compact research-trace learning.
  - Extend finish-session input with optional `researchTrace`.
  - Derive a compact trace from structured learning signals, session notes, context decisions, changed files, and verification commands when no explicit trace is supplied.
  - Store only the compact summary/signals in reflection drafts; never store raw transcript/tool-output noise automatically.

- Add preview-first memory maintenance.
  - Add `POST /operations/maintenance/preview` to detect duplicate, stale, superseded, weakly grounded, or risky auto memories without mutation.
  - Add `POST /operations/maintenance/apply` to re-check selected preview actions before applying.
  - Auto-apply only low-risk label/reference enrichment. Archive, supersede, approve, or status-changing actions must create or use reviewable learning proposals.

- Improve `/workbench`.
  - Show a startup brief panel with `proceed / confirm / clarify`, worktree badges, read-first files, direct vs adjacent evidence, missing signals, and verification commands.
  - Add finish fields for research trace and verification evidence.
  - Add maintenance preview controls in Memory Review with clear safe-vs-approval-required actions.
  - Keep browser coverage in `test/browser/` and keep normal `pnpm test` free of Chrome/port requirements.

## Public API And Types
- Add `includeWorktree?: boolean` to `ContextSearchInput`, defaulting to `true` only when `cwd` is present.
- Add `StartupBrief`, `WorktreeEvidenceSummary`, and optional `startupBrief` / `worktreeEvidence` fields on `ContextPack`.
- Add `ResearchTraceInput` / `ResearchTraceSummary` and `researchTrace?: ResearchTraceInput` to `FinishAgentSessionInput`.
- Add maintenance preview/apply result types and MCP tools for preview/apply memory maintenance.
- No database migration by default; new context-pack/session data fits existing JSON metadata fields.

## Test Plan
- Unit/API tests for classifier continuation anchors, worktree evidence parsing, startup brief action selection, MCP shortlist output, research-trace finish behavior, and maintenance preview/apply idempotency.
- Regression tests proving no raw diff, draft content, metadata blobs, secrets, or raw transcript text leak into workbench summary or static HTML.
- Browser test via `pnpm run test:workbench-browser` covering startup brief display, worktree/read-first files, decision recording, finish with research trace, and maintenance preview.
- Full verification: `pnpm run build`, `pnpm test`, `pnpm run test:integration`, `pnpm run test:workbench-browser`, `pnpm run eval:retrieval`, `pnpm run eval:knowledge-completeness`, `pnpm run eval:agent-context`, and `git diff --check`.

## Assumptions
- Existing staged Phase 1 changes are the base; do not revert or rework them except where Phase 2 requires small extensions.
- Strict auto-learning defaults stay unchanged.
- Worktree evidence is local-first, bounded, sanitized, and advisory; retrieval/startup may use it, but it does not become durable trusted memory unless reviewed through the reflection flow.
- Browser verification remains a dedicated script using installed Chrome, not Playwright browser downloads.
