# Synthesized Implementation Plan

## Inputs

- `feedbacks/plan-for-handoff.md`
- `feedbacks/plan-for-ai-feedbacks.md`
- `feedbacks/plan-for-architecture.md`

## Summary

The three plans converge on one product direction: make Tuberosa a worktree-aware agent companion that starts each task with a decisive brief, preserves compact research outcomes, and previews memory maintenance before mutation.

The work should remain local-first and review-gated. Current worktree evidence can guide retrieval and startup decisions, but it should not become trusted durable memory unless it flows through the existing reflection and review process.

## Baseline And Assumptions

- The Phase 1 workbench audit and hardening plan is the prerequisite baseline: browser-tested `/workbench`, API-key coverage for `/operations/workbench/summary`, compact `WorkbenchSummary` records, capped count metadata, and backup-health visibility.
- Strict auto-learning defaults stay unchanged.
- No database migration is required for the next slice; new data should fit existing JSON metadata fields unless implementation proves otherwise.
- Browser verification remains a dedicated script using installed Chrome, not downloaded Playwright browsers and not normal `pnpm test`.
- Automation APIs are preview-first. Retrieval alone must not perform hidden mutations.

## Goals

- Add a bounded worktree evidence bridge for current git status, recent edits, untracked plans, prompt-named files, and handoff-family Markdown files.
- Add `startupBrief` to context packs and session-start responses with `proceed / confirm / clarify`, read-first files, direct evidence, adjacent evidence, missing signals, risky areas, verification commands, and the required context decision.
- Improve handoff and continuation behavior so current local plan files beat stale stored memory.
- Add compact research-trace learning on session finish without storing raw transcripts or raw tool output.
- Add preview-first memory maintenance for duplicates, stale memories, supersession candidates, weak grounding, and low-risk label/reference enrichment.
- Surface startup brief, research trace, and maintenance preview in `/workbench`.

## Phase A: Worktree Provider And Brief Skeleton

Add `src/retrieval/worktree.ts` with `collectWorktreeEvidence`.

The provider should collect a sanitized, bounded view of:

- `git status --porcelain=v1`
- recently touched files
- prompt-named local files
- handoff-family Markdown files such as `handoff*.md`, `plan-*.md`, `*concern-answer*.md`, and `tuberosa-*.md`

Return compact evidence only: path, status, first heading or short summary, byte count, skipped reason, and truncation status. Never return raw diffs or full file bodies. Respect obvious secret and credential paths.

Wire the provider into retrieval when `cwd` is supplied and `includeWorktree` is not false. Mark candidates and read-first entries with `source: "worktree"` or `source: "memory"`.

Add a v0 `StartupBrief` compositor that repackages existing `policy`, `contextFit`, `orientation`, and `taskBrief`, plus worktree read-first files.

## Phase B: Handoff And Continuation Verdict Logic

Harden continuation classification:

- Require explicit continuation verbs or explicit handoff/plan file references.
- Extend file extraction to prompt-named Markdown files and handoff-family files.
- Prefer local handoff and plan files when available.

Add verdict rules:

- `proceed` when continuation evidence is strong and worktree files agree with stored memory.
- `confirm` when useful evidence exists but stored memory and worktree evidence are incomplete, noisy, or mismatched.
- `clarify` when required handoff or plan signals are missing from both worktree and memory.

Mismatch detection should compare titles/headings or compact summaries, not full body text.

## Phase C: Preview-First Memory Maintenance

Add `src/operations/maintenance.ts` with preview and apply methods.

Preview detectors should find:

- duplicate or near-duplicate memories
- stale memories
- supersession candidates
- weakly grounded auto memories
- missing labels
- missing references
- relation repairs

Add `POST /operations/maintenance/preview` and `POST /operations/maintenance/apply`. Add matching MCP tools if the MCP surface is part of the slice.

Preview actions should include deterministic IDs, risk, target IDs, rationale, evidence, and a bounded before snapshot. Apply must re-run the detector and return expired without mutation if preconditions changed.

Only low-risk additive enrichment may be auto-applied behind an explicit opt-in flag. Archive, supersede, approve, status-changing cleanup, and destructive changes must remain review-gated through proposals or explicit approval.

## Phase D: Compact Research Trace And Verification Mode

Add `ResearchTraceInput` to finish-session input. Keep it narrow:

- up to 12 steps
- each step length-bounded
- step kinds such as thought, action, observation, and decision
- references to files, symbols, commands, or knowledge IDs
- one compact outcome summary

If no explicit trace is supplied, derive one from structured learning signals, session notes, context decisions, changed files, and verification commands. Do not read or store raw transcript text.

Store the trace in session metadata and reflection draft provenance. Surface it in the workbench so reviewers can see the investigation path without raw conversation noise.

Optionally add a verification session mode for UI/browser work. Finish-session can accept bounded DOM, route, selector, and network summaries that become trace observations.

## Workbench Changes

- Add a `StartupBriefPanel` in the Session view.
- Show `proceed / confirm / clarify`, read-first files, worktree badges, direct evidence, adjacent evidence, missing signals, risky areas, and verification commands.
- Add finish fields for compact research trace and verification evidence.
- Add a Memory maintenance tab or sub-tab with preview, apply, reject, and open controls.
- Group maintenance actions by kind and risk.
- Add glossary entries for worktree evidence, startup brief, maintenance preview, research trace, and verification mode.

## Public API And Types

Add or extend these types:

- `ContextSearchInput.includeWorktree?: boolean`
- `WorktreeFileEvidence`
- `WorktreeEvidenceSummary`
- `StartupBrief`
- `ContextPack.worktreeEvidence?: WorktreeEvidenceSummary`
- `ContextPack.startupBrief?: StartupBrief`
- `ResearchTraceInput`
- `ResearchTraceSummary`
- `FinishAgentSessionInput.researchTrace?: ResearchTraceInput`
- `MaintenanceAction`
- `MaintenancePreview`

Keep old clients compatible by making new fields optional.

## Critical Files

Likely existing files to touch:

- `src/retrieval/classifier.ts`
- `src/retrieval/service.ts`
- `src/retrieval/context-fit.ts`
- `src/agent-session/service.ts`
- `src/operations/service.ts`
- `src/http/server.ts`
- `src/mcp/server.ts`
- `src/types.ts`
- `src/security/knowledge-safety.ts`
- `src/workbench/views/SessionView.tsx`
- `src/workbench/views/MemoryView.tsx`
- `src/workbench/glossary/terms.ts`

Likely new files:

- `src/retrieval/worktree.ts`
- `src/retrieval/startup-brief.ts`
- `src/operations/maintenance.ts`
- `src/agent-session/research-trace.ts`
- `eval/maintenance-fixtures.json`
- `test/worktree.test.ts`
- `test/startup-brief.test.ts`
- `test/maintenance.test.ts`
- `test/research-trace.test.ts`
- `test/secrets-regression.test.ts`

## Safety Rules

- Worktree evidence is advisory and transient.
- Do not store raw diffs, raw transcripts, full file bodies, secrets, large metadata blobs, or prompt-injection content as trusted knowledge.
- Sanitize worktree evidence, research traces, maintenance snapshots, and workbench responses.
- Treat self-edit work as higher risk: prefer worktree truth, downweight old memory, and avoid auto-approval.
- Re-check every maintenance action before apply.
- Keep summary APIs compact and free of raw content.

## Verification Plan

For each implementation phase:

- `pnpm run build`
- `pnpm test`
- `pnpm run eval:retrieval`
- `pnpm run eval:agent-context`
- `pnpm run eval:knowledge-completeness`
- `pnpm run test:workbench-browser`
- `pnpm run test:integration` when storage, cache, Docker, or persistence behavior changes
- `git diff --check`

Add targeted tests for:

- worktree-only handoff evidence
- worktree and memory agreement
- memory-only continuation context
- missing handoff and plan context
- startup brief verdicts
- no raw diff or secret leakage
- research trace auto-derivation
- maintenance preview idempotency
- apply returning expired after state changes
- workbench rendering for startup brief and maintenance preview

## Rollback Boundaries

- Phase A can be disabled by `includeWorktree: false` or by leaving `cwd` unset.
- Phase B changes should be limited to classifier and startup brief logic.
- Phase C mutations are isolated behind preview/apply endpoints and should default to no auto-apply.
- Phase D trace storage is optional metadata and can be ignored by old clients.
