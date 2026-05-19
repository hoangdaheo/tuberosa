# Tuberosa Handoff

Date: 2026-05-19

## Goal We Are Working Toward

Tuberosa is a local-first context broker and learning layer for coding agents. The current product goal is to make Tuberosa operationally useful after v1: agents should receive compact, explainable context; users should be able to inspect noisy or missing context; and learning should remain provenance-rich, reviewable, and safe.

The v1 roadmap through Phase 10 is baseline context, not a ceiling. This pass focused on the ops-first foundation for the next product increment:

- make context-quality feedback reviewable and actionable;
- add organization exports for project understanding;
- reconcile roadmap and flow docs with the current implementation;
- enrich item explanations without changing retrieval ranking;
- document a short post-v1 product plan and audit current flows against `tuberosa-project.md`.

## Current State Of The Code

Implemented in this pass:

- `GET /operations/context-quality` reports on context-quality feedback and links events to context packs, sessions, open knowledge gaps, open learning proposals, noisy adjacent items, missing signals, and suggested review actions.
- MCP tool `tuberosa_collect_context_quality_feedback` exposes the same operations report.
- `pnpm run organization` now supports `project-map`, `knowledge-graph`, and `readable-summary` with `--project`, `--limit`, and optional `--out`.
- `pnpm run context-quality` now provides a thin local review workbench over the context-quality report. It lists linked packs, sessions, noisy adjacent items, missing signals, open gaps, open proposals, and existing review endpoints without adding new mutation paths.
- `usefulnessReason` now includes richer explanation details from existing evidence: exact files/symbols/errors, graph relation paths, feedback contribution, freshness/stale risk, and supersession suppression. Ranking was not intentionally changed.
- Roadmap and flow docs now treat Phase 9/10 as completed baseline work and describe current operations, feedback, reflection review, graph search, organization exports, and cache fingerprint fields.
- Added `docs/POST_V1_PRODUCT_PLAN.md` and `docs/FLOW_INTENT_AUDIT.md`.

Verification already passed after implementation:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/operations.test.ts test/api-boundary.test.ts test/retrieval.test.ts test/organization-cli.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
git diff --check
```

Verification after the context-quality CLI continuation:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/context-quality-cli.test.ts
env TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_PHYSICAL_MIRROR_ENABLED=false PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run context-quality -- --project tuberosa --limit 1
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
git diff --check
```

Runtime note: restart/reload MCP and HTTP services before relying on the newly added endpoint or MCP tool in a long-running process.

## Files Actively Edited

Contracts and validation:

- `src/types.ts`
- `src/validation.ts`

Operations, HTTP, and MCP:

- `src/operations/service.ts`
- `src/http/server.ts`
- `src/mcp/server.ts`

Retrieval:

- `src/retrieval/context-pack.ts`

Organization CLI:

- `src/operations/context-quality-cli.ts`
- `src/operations/organization-cli.ts`
- `scripts/context-quality.ts`
- `scripts/organization.ts`
- `package.json`

Tests:

- `test/operations.test.ts`
- `test/api-boundary.test.ts`
- `test/retrieval.test.ts`
- `test/organization-cli.test.ts`
- `test/context-quality-cli.test.ts`

Docs:

- `docs/AGENT_CONTEXT_ROADMAP.md`
- `docs/FLOW_LOGIC.md`
- `docs/SETUP_AND_USAGE.md`
- `docs/POST_V1_PRODUCT_PLAN.md`
- `docs/FLOW_INTENT_AUDIT.md`
- `README.md`
- `AGENTS.md`
- `handoff.md`

## Everything Tried That Failed Or Needed Correction

- GitNexus was checked as part of the audit path, but the available GitNexus context did not provide an indexed `tuberosa` repo for this work. The flow audit used local code and docs instead.
- Initial `pnpm run build` failed because `OperationsService` used `uniqueStrings` without importing it. The fix was to import `uniqueStrings` from `src/util/text.ts`; build and focused tests passed afterward.
- The first context-quality CLI smoke run failed inside the sandbox with `tsx` `listen EPERM` on `/tmp/tsx-*`; rerunning outside the sandbox was needed for that smoke test.
- The first escalated smoke run exposed that `pnpm run context-quality -- --project ...` passes a literal `--` through to the script. The parser now ignores standalone `--`, and the focused parser test covers it.
- The Tuberosa session finish created pending reflection draft `8280254e-9728-437a-83f1-856da3d3cf02` with noisy suggested labels. It was left pending with `learningMode: "draft_only"` and should not be approved without review.
- No verification failures remain known after the import fix. Full build, unit tests, retrieval eval, agent-context eval, integration test, and `git diff --check` passed.

## Improve Plan And Next Step

The context-quality workbench now exists as a first CLI slice. The next step I would take is to run it against a real local Postgres dataset after restarting the long-running HTTP/MCP services, then decide whether the next layer should be an interactive CLI action flow or a small frontend review surface.

Follow-up improvements:

- Use reviewed stale/supersedes flows to clean old v1-ceiling memories if they resurface in retrieval.
- Revisit the auto-approved session-memory policy because `docs/FLOW_INTENT_AUDIT.md` flags it as the main tension with the reviewed-memory intent.
- Add optional action execution to the workbench only if it can keep mutations routed through existing review APIs and make review intent explicit.
- Restart MCP/HTTP services, then manually smoke-test the endpoint, MCP tool, and CLI against a small local dataset before building UI on top of it.

## Notes For The Next Agent

- Start by reading `tuberosa-project.md`, `docs/AGENT_CONTEXT_ROADMAP.md`, and this file.
- Use `tuberosa_start_session` and record the context decision for substantial work.
- Do not directly edit durable memories or storage rows to rewrite product policy; use review APIs, stale status, proposals, or `supersedes` relations.
- Keep changes surgical. The current diff already spans API, MCP, operations, retrieval, CLI, tests, and docs.
