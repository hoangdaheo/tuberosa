# Complete Workbench Audit, Then Prepare Automation Loop

## Summary
- Immediate implementation is Phase 1: close the handoff’s skipped workbench audit, harden the summary/API surface, and resolve newly found live health issues.
- Phase 2 is not implemented in this change. It becomes a follow-up product plan using `tuberosa-concern-answer.md` as input for automatic research trace learning and stale/duplicate memory maintenance.
- Keep strict auto-learning defaults unchanged. Any risky review mutation remains explicit.

## Phase 1 Key Changes
- Add browser verification with `playwright-core` using `/usr/bin/google-chrome`, no frontend build system.
  - Add `test:workbench-browser`.
  - Test `/workbench` at desktop and mobile widths.
  - Start sessions through the UI in a disposable project, verify policy/context fit/task brief/direct evidence/adjacent context/missing signals/verification commands, record `selected`, `selected_but_noisy`, `rejected`, and `missing_context`, then finish one session and confirm summary metrics update.
- Add API-key coverage.
  - `/workbench` remains public.
  - `/operations/workbench/summary` returns `401` without/wrong key when `TUBEROSA_API_KEY` is configured.
  - Valid `x-tuberosa-api-key` succeeds.
- Compact `WorkbenchSummary` queue records.
  - Keep existing top-level fields and counts.
  - Replace embedded full draft/knowledge/session records with summary records containing IDs, titles, statuses, short summaries, timestamps, links/reasons, and counts for labels/references/duplicates.
  - Exclude full `content`, large metadata, and raw agent-output bodies from summary responses.
  - Add a safety regression proving summary output does not leak a seeded secret string.
- Make count/window behavior honest.
  - Keep bounded scans for local performance.
  - Add summary metadata indicating the count scan limit and whether counts may be capped.
  - Update CLI/UI formatting to display capped values clearly.
- Surface backup health as a workbench action.
  - Add a recommended action when backup status has `lastError` or unhealthy scheduler state.
  - For the current Docker stack, repair `.tuberosa/backups` ownership outside tracked files, then verify backup status no longer reports `EACCES`.
- Disposition the skipped doc.
  - Treat `tuberosa-concern-answer.md` as inspected and intentional product context.
  - Note in `handoff.md` that it informs Phase 2; do not fold its broader automation scope into Phase 1.

## Phase 2 Follow-Up Plan
- Research trace learning: add a reviewed “research trace summary” path that stores agent investigation outputs as structured summaries and learning signals, not raw transcripts.
- Auto-maintenance loop: detect duplicate/stale/superseded memories, generate exact proposed actions, and auto-apply only low-risk label/reference cleanup while requiring approval for archive/supersede/approve actions.
- Workbench choosing panel: add `proceed`, `confirm`, and `clarify` states from context fit, with user approval prompts for unsafe or irreversible actions.
- Automation APIs should be preview-first, then approve/apply; no hidden mutation from retrieval alone.

## Test Plan
- `pnpm install` after adding `playwright-core`.
- `pnpm run build`
- `pnpm test`
- `pnpm run test:workbench-browser`
- `pnpm run test:integration`
- `pnpm run eval:retrieval`
- `pnpm run eval:knowledge-completeness`
- `pnpm run eval:agent-context`
- `docker compose up --build -d`
- Smoke:
  - `curl -s http://localhost:3027/health`
  - `curl -s -o /dev/null -w '%{size_download}\n' 'http://localhost:3027/operations/workbench/summary?project=tuberosa&limit=1'`
  - `curl -s http://localhost:3027/workbench`
- Finish with `git diff --check`.

## Assumptions
- Phase 1 may change the new `WorkbenchSummary` item shapes because the API is fresh and current live output is already too verbose.
- No database migration is needed.
- No React/Vite/frontend service is added.
- Browser automation uses installed Chrome, not downloaded Playwright browsers.
