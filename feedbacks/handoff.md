# Tuberosa Handoff

## Goal

Complete Tuberosa V1 as a developer-first local context broker and local control plane, while keeping strict auto-learning review behavior intact.

The current V1 workbench now supports:

- Starting an agent session from `/workbench`.
- Inspecting policy, context fit, task brief, direct evidence, adjacent context, missing signals, and verification commands.
- Recording context decisions before work proceeds.
- Finishing sessions with visible compliance and learning behavior.
- Reviewing context-quality feedback, pending drafts, open gaps/proposals/conflicts, risky auto memories, open error logs, backup health, and recommended actions without adding React/Vite or a new storage migration.

## Current State

Phase 1 from `plan-for-handoff.md` is implemented and verified.

Key changes:

- Added `playwright-core` and `pnpm run test:workbench-browser`.
- Added `test/browser/workbench-browser.test.ts`, using `/usr/bin/google-chrome` and the existing HTTP server with memory services.
- Moved browser coverage outside `test/*.test.ts`, so normal `pnpm test` stays dependency-light and does not bind a browser port.
- Added API-key coverage proving `/workbench` is public while `/operations/workbench/summary` returns 401 without or with the wrong key when `TUBEROSA_API_KEY` is configured.
- Compacted `WorkbenchSummary` queue payloads:
  - Sessions no longer include metadata or raw output bodies.
  - Drafts no longer include full `content`, metadata, labels, references, or full duplicate candidates.
  - Risky auto memories no longer include full `content`, metadata, labels, or references.
  - Gaps, proposals, conflicts, context-quality records, error logs, and backup status are summarized with IDs, status, reason/summary previews, counts, and small array previews.
  - `openErrorLogs.agentBrief` is omitted from the workbench summary.
  - Backup status now exposes compact backup and verification summaries instead of full manifest table checksums.
- Added `countMetadata.scanLimit` and `countMetadata.capped`; CLI and UI render capped count values with `+`.
- Added backup-health recommended actions when backup status has `lastError` or degraded/unhealthy health.
- Updated `BackupService.createBackup()` to clear stale scheduler `lastError` and set `lastSuccessAt` / `lastBackupId` after any successful backup.
- Added a safety regression proving a seeded secret in draft content, knowledge content/metadata, and session metadata does not appear in the summary API or static workbench HTML.
- Inspected `tuberosa-concern-answer.md`; it is intentional product context for Phase 2, not Phase 1 scope.

Strict auto-learning defaults were not relaxed.

## Files Actively Edited

Core product files:

- `package.json`
- `pnpm-lock.yaml`
- `src/types.ts`
- `src/operations/workbench-summary.ts`
- `src/operations/workbench-cli.ts`
- `src/http/workbench.ts`
- `src/operations/backup-service.ts`

Tests:

- `test/browser/workbench-browser.test.ts`
- `test/operations.test.ts`
- `test/api-boundary.test.ts`
- `test/workbench-cli.test.ts`

Docs/context:

- `handoff.md`
- `plan-for-handoff.md`
- `tuberosa-concern-answer.md`

## Verification Completed

All checks passed:

- `pnpm run build`
- `pnpm test`
- `pnpm run test:integration`
- `pnpm run test:workbench-browser`
- `pnpm run eval:retrieval`
- `pnpm run eval:knowledge-completeness`
- `pnpm run eval:agent-context`
- `TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_PHYSICAL_MIRROR_ENABLED=false pnpm run workbench -- --project tuberosa --limit 2`
- `docker compose up --build -d`
- `curl -s http://localhost:3027/health`
- `curl -s -o /tmp/tuberosa-workbench-summary.json -w '%{size_download}\n' 'http://localhost:3027/operations/workbench/summary?project=tuberosa&limit=1'`
- `curl -s -o /tmp/tuberosa-workbench.html -w '%{size_download}\n' http://localhost:3027/workbench`
- `curl -s http://localhost:3027/operations/backups/status`
- `docker compose ps`
- `git diff --check`

Browser smoke note:

- Initial sandbox run failed with `listen EPERM` for binding `127.0.0.1`.
- Rerunning `pnpm run test:workbench-browser` outside the sandbox passed.

Workbench CLI note:

- Initial sandbox run failed with `listen EPERM` for `/tmp/tsx-1000/14.pipe`.
- Rerunning memory-mode `pnpm run workbench` outside the sandbox passed.

Backup ownership note:

- `.tuberosa/backups` was owned by `nobody:nogroup`.
- `docker compose exec -T app chown -R 1000:1000 /data/backups` failed because the app container runs as UID 1000.
- Repaired with a one-off root container:
  - `docker compose run --rm --user root --entrypoint chown app -R 1000:1000 /data/backups`
- Verified host ownership is now `nash:nash`.
- Triggered a manual backup; backup status is now `healthy` and no longer reports `EACCES`.

Live endpoint smoke:

- `/health` returns Postgres/Redis-backed healthy service metadata.
- `/workbench` returns the static workbench HTML.
- `/operations/workbench/summary?project=tuberosa&limit=1` returns compact queue records, `countMetadata`, compact backup status, and no `tables`, `content`, `metadata`, `agentBrief`, `lastError`, or `EACCES` strings.

## Things Corrected During This Pass

1. `playwright-core` install failed in the sandbox with npm registry `EAI_AGAIN`.
   - Reran `pnpm add -D playwright-core` with network escalation; install succeeded.

2. The first browser test location was under `test/*.test.ts`.
   - Moved it to `test/browser/` and kept it on the dedicated script so normal tests do not require Chrome or port binding.

3. Browser test initially seeded knowledge directly into the store, which produced no retrieval candidates.
   - Switched browser-test seed setup to `services.ingestion.ingestKnowledge()` so chunks and inferred relations are created.

4. The browser locator for `selected_but_noisy` was too broad.
   - Narrowed it to the context-quality item title.

5. Workbench backup-health action initially treated `scheduler.enabled && !running` as a problem.
   - Removed that condition because startup delay can make it noisy. Recommended action now appears for `lastError` or degraded/unhealthy backup health.

6. Live backup status retained stale `lastError` after a later successful manual backup.
   - `BackupService.createBackup()` now clears stale error state on success.

7. `git diff --check` initially found trailing whitespace in `tuberosa-concern-answer.md`.
   - Removed the trailing whitespace.

## Phase 2 Follow-Up

Do not fold this into Phase 1.

Use `tuberosa-concern-answer.md` as product context for the next iteration:

- Research trace learning: store structured investigation summaries and learning signals, not raw transcripts.
- Auto-maintenance loop: detect duplicate/stale/superseded memories, propose exact safe actions, auto-apply only low-risk label/reference cleanup, and require approval for archive/supersede/approve actions.
- Workbench choosing panel: show `proceed`, `confirm`, and `clarify` states from context fit, with user approval prompts for unsafe or irreversible actions.
- Automation APIs should be preview-first, then approve/apply; no hidden mutation from retrieval alone.

## Remaining Notes

- `plan-for-handoff.md` remains as the source plan for this pass.
- The Docker stack is currently running.
- The latest backup status is healthy, and `.tuberosa/backups` ownership has been repaired outside tracked files.
- There are active historical sessions in the live Tuberosa store; the workbench summary correctly recommends finishing active sessions.
