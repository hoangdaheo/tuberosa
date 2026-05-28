# 14 — Development & Extension

How to add features to Tuberosa without breaking the existing flow.

## Project layout reminder

See [02-architecture.md](02-architecture.md#source-layout) for the full tree. The shortest map you need:

- **HTTP route** → add to `src/http/server.ts`.
- **MCP tool** → add to `src/mcp/server.ts` (`callTool` switch + `tools()` schema list).
- **Store method** → add to `KnowledgeStore` interface (`src/storage/store.ts`) and both implementations (`postgres-store.ts`, `memory-store.ts`).
- **Retrieval stage tweak** → `src/retrieval/service.ts` + a fixture in `eval/retrieval-fixtures.json`.
- **Atom rule** → `src/atoms/` (critic, archival, triviality-rules) + tests in `test/atoms-*.test.ts`.
- **Security check** → `src/security/{knowledge-safety,safe-paths}.ts` + tests in `test/safe-paths.test.ts`.

## Test conventions

Tests run with `node:test` + `tsx`. One file per concern. Run a single file:

```bash
node --test --import tsx test/<name>.test.ts
```

Or the whole suite:

```bash
pnpm test
```

Test file boilerplate (matches the rest of the codebase):

```ts
import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { createAppServices } from '../src/app.js';

test('does the thing', async () => {
  process.env.TUBEROSA_STORE = 'memory';
  process.env.TUBEROSA_CACHE = 'memory';
  process.env.TUBEROSA_MODEL_PROVIDER = 'hash';
  process.env.TUBEROSA_AUTO_MIGRATE = 'false';
  const services = await createAppServices();
  try {
    // … your test …
  } finally {
    await services.close();
  }
});
```

Integration tests (Postgres-gated) live under `test/integration/`. They skip when Postgres/Redis are unreachable.

## Adding a new HTTP route

1. Identify the concern (knowledge / context / atom / operations / …).
2. Append to the `createRoutes()` array in `src/http/server.ts`:

   ```ts
   {
     method: 'POST',
     match: exactPath('/my-thing'),
     handle: async ({ services, request }) => {
       const body = (await readJsonBody(request, services.config.maxRequestBytes)) as { foo?: unknown };
       if (typeof body.foo !== 'string') throw new ValidationError('foo is required');
       return services.operations.doThing(body.foo);
     },
   },
   ```

3. If the route takes a filesystem path from the caller, run it through `assertSafeBundlePath` (see `src/http/server.ts` `/operations/export-pack` for the pattern, including the narrow try/catch that re-throws the framework's `ValidationError` for 400 mapping).
4. Add a test in `test/<concern>.test.ts`. Use the test boilerplate above; spin up `createHttpServer(services)` on port 0 and `fetch` against it.

## Adding a new MCP tool

1. Append a `case` to `callTool(...)` in `src/mcp/server.ts`. Pattern (mirror an existing tool):

   ```ts
   case 'tuberosa_my_tool': {
     const project = readRequiredMcpString(args.project, 'tuberosa_my_tool arguments.project');
     // … work …
     return toolJson(result);
   }
   ```

2. Add the tool's schema to the `tools()` array:

   ```ts
   {
     name: 'tuberosa_my_tool',
     description: 'One-line description.',
     inputSchema: {
       type: 'object',
       properties: { project: { type: 'string' } },
       required: ['project']
     }
   }
   ```

3. Errors throw normally — the MCP envelope at `handleMcpRequest` catches them and turns them into JSON-RPC errors.
4. Test through `handleMcpRequest({method:'tools/call', params:{name:'tuberosa_my_tool', arguments:{...}}})`. See `test/export-import-security.test.ts` for the pattern.

## Adding a store method

1. Add to the `KnowledgeStore` interface in `src/storage/store.ts`.
2. Implement in `src/storage/postgres-store.ts` (use `pool.connect()` + `client.release()` in a `finally` block for any transaction).
3. Implement in `src/storage/memory-store.ts` — and make sure both implementations agree on edge cases. The memory store is the test fixture; if it diverges from Postgres, tests silently lie.
4. If the method takes IDs, gate them through `isPersistedKnowledgeId(id)` before any `::uuid` cast (avoids the worktree-UUID 22P02 class).

## Adding a retrieval signal

1. Write a failing fixture case in `eval/retrieval-fixtures.json` that exercises the signal you want.
2. Run `pnpm run eval:retrieval` — confirm it fails for the *right* reason (not a typo).
3. Update the classifier / fusion / context-fit code.
4. Re-run the eval — must hit the green metrics in the fixture header (`hitRate=1`, `staleRejectionRate=1`, all classification rates `1`).
5. Run the full suite (`pnpm test`) to catch regressions elsewhere.

## Adding a security check

1. New patterns go into `src/security/knowledge-safety.ts` (`SECRET_PATTERNS`, `BLOCK_PATTERNS`, `SUSPICIOUS_PATTERNS`).
2. New path/name validators go into `src/security/safe-paths.ts`.
3. Add tests in `test/safety.test.ts` (existing patterns) or `test/safe-paths.test.ts`.
4. If the check rejects user input, add an integration test in `test/export-import-security.test.ts` showing the malicious input returning HTTP 400 / MCP error.

## Hooks (Claude Code / agent harness)

This repo ships several hook patterns under `.claude/`:

- `PreToolUse` hooks gate destructive bash commands.
- `PostToolUse` hooks log telemetry (e.g. the GitNexus stale-index notice).
- `SessionStart` hooks load the superpowers skill set.

Hooks are matched by tool name + regex. See your harness docs for the configuration format; the project's `.claude/settings.json` (or `~/.claude/settings.json`) is the source of truth. Use the `hookify:writing-rules` skill to generate new hooks from a transcript.

## Subagent-driven development

For multi-task work, prefer:

1. `superpowers:brainstorming` to align on requirements.
2. `superpowers:writing-plans` to produce a TDD-shaped plan with per-task tests + code blocks.
3. `superpowers:subagent-driven-development` to execute task-by-task with two-stage review.

Recent example: `docs/superpowers/plans/2026-05-28-security-audit-remediation.md` (the Phase 1 security fixes used this workflow end-to-end).

## Calibration workflow

When fusion feels off:

1. `pnpm run sandbox` — generate the synthetic corpus and run golden prompts.
2. `pnpm run sandbox:ablate` — find load-bearing sources.
3. `pnpm run calibrate-fusion` — emit a `config/retrieval-policy.json` patch.
4. Apply the patch by hand (review the diff first).
5. Run `pnpm run eval:retrieval` to confirm no regressions in the fixture.

## Adding an itemType or AtomType

Both are closed unions in `src/types/*`. Adding a value means:

1. Extend the union type.
2. Update the SQL `CHECK` constraint in `migrations/*` (and add a new migration that loosens it).
3. Update inference rules in `src/ingest/service.ts` (for `itemType`) or `src/atoms/critic.ts` (for `AtomType`).
4. Extend the classifier so the new value can surface from prompts.
5. Add fixture cases.
6. Run the full eval suite.

## Logging policy

- **HTTP**: log via the operations logger (not `console.*`). Errors flow through `appErrorToHttpBody`.
- **MCP**: stderr only. Stdout is JSON-RPC. `console.error` is acceptable for diagnostics but should not echo attacker-shaped strings verbatim (audit L2).
- **Tests**: silent on success. Any `console.log` will pollute test output and is treated as a code-review nit.

## Coding conventions (light)

- ESM imports with `.js` extensions even from `.ts` files.
- Prefer `node:test` + `node:assert/strict` (no chai / vitest / jest).
- Async route handlers; no `void`-fire-and-forget unless you genuinely don't care about errors (and document it).
- Errors thrown as `ValidationError` / `NotFoundError` / `AuthorizationError` / etc., not raw `Error` — the HTTP error mapper relies on the class.

## Read next

- [04-retrieval-pipeline.md](04-retrieval-pipeline.md) — pipeline internals.
- [13-operations-runbook.md](13-operations-runbook.md) — eval / sandbox / integration tests.
- [docs/superpowers/plans/](../docs/superpowers/plans/) — recent and historical implementation plans.
