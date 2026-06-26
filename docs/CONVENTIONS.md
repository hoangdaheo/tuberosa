# Conventions & patterns

> How this team writes code. Follow these so your changes look like they were written by the
> team, not bolted on. Derive every rule from existing code — match what the repo already does.
> Companion: [`ARCHITECTURE.md`](ARCHITECTURE.md), [`FEATURES.md`](FEATURES.md), [`SETUP.md`](SETUP.md).

## 1. Formatting & linting

- **Formatter / linter:** none configured (no ESLint/Prettier/Biome/EditorConfig). Match the
  surrounding style by hand.
- **Type checking is the gate:** `tsconfig.json` is strict — `strict: true`,
  `noUncheckedIndexedAccess: true`, `forceConsistentCasingInFileNames: true`, NodeNext ESM, ES2022.
- Run before finishing: `pnpm run build` (== `tsc -p tsconfig.json`) and `pnpm test`.

## 2. Naming conventions

- **Files:** `kebab-case.ts` (`memory-store.ts`, `mcp-stdio.ts`, `write-gate.ts`). Domain folders are
  kebab-case (`src/agent-session/`, `src/error-log/`).
- **One service per domain folder, named `service.ts`** (`src/ingest/service.ts`,
  `src/retrieval/service.ts`); the class is `XxxxService` (`IngestionService`, `RetrievalService`).
- **Types/classes:** PascalCase; interfaces often `XxxxInput` / `XxxxOptions` / `XxxxRecord`.
- **Errors:** `XxxxError` extending `AppError` (`src/errors.ts`).
- **Migrations:** sequential, zero-padded, descriptive — `NNN_snake_case.sql` (`014_embedding_dim_384.sql`).
- **Tests:** `test/*.test.ts` (flat under `test/`, not colocated).

## 3. Project structure conventions

- **Domain-first folders under `src/`** — each subsystem (`retrieval/`, `ingest/`, `atoms/`,
  `reflection/`, `agent-session/`, `storage/`, `model/`, `operations/`, …) owns its `service.ts`,
  types, and helpers.
- **Shared primitives at the top level:** `src/app.ts` (composition), `src/config.ts`,
  `src/errors.ts`, `src/validation.ts`, `src/cache.ts`, `src/types.ts`. Domain types live in `src/types/`,
  Zod schemas in `src/schemas/`.
- **Two entry points share the service layer:** `src/index.ts` (HTTP) and `src/mcp-stdio.ts` (MCP)
  both build services through `createAppServices()` — never duplicate wiring.

## 4. Patterns to follow / anti-patterns to avoid

**Follow**
- Go through the **`KnowledgeStore` interface** (`src/storage/store.ts`) for all persistence — never
  hit `pg` directly outside `postgres-store.ts`.
- Pick implementations via **factories** (`src/storage/factory.ts`, `src/model/factory.ts`,
  `createCache` in `src/cache.ts`) keyed off config — don't `new` a concrete store/provider elsewhere.
- **Validate at the boundary** with Zod (`src/schemas/` + `parseOrThrow` in `src/schemas/primitives.ts`);
  throw `ValidationError` on bad input.
- **Inject dependencies via constructors**; build everything once in `createAppServices()`.
- Throw a typed `AppError` subclass (`src/errors.ts`); let the HTTP/MCP layer map it to a status/code.

**Avoid**
- **No `console.log`/`process.stdout.write` on the MCP path** — stdout is JSON-RPC only; diagnostics go
  to `stderr`. A stray write breaks every MCP client.
- **No new global singletons** — pass services through.
- **Don't create a table named `references`** (reserved) — the table is `knowledge_references`.
- **Don't tune retrieval weights/heuristics without a failing fixture first** (see §5).

## 5. Testing strategy

- **Framework:** Node's built-in `node:test` + `tsx` (no Jest/Vitest). `assert` from `node:assert/strict`.
- **Where:** `test/*.test.ts` (165 files). Run all: `pnpm test` (sets
  `TUBEROSA_DISABLE_LOCAL_MODELS=true`). Single file: `node --test --import tsx test/<name>.test.ts`.
- **Test doubles** (no external deps in unit tests): `MemoryKnowledgeStore` (`src/storage/memory-store.ts`),
  `MemoryCache` (`src/cache.ts`), `HashModelProvider` (`src/model/provider.ts`).
- **Integration tests are Docker-gated** — `pnpm run test:integration` probes Postgres/Redis and
  `t.skip()`s cleanly when they're down.
- **Retrieval is eval-gated:** `pnpm run eval:retrieval` must stay green (`hitRate=1`,
  `staleRejectionRate=1`, all classification rates `=1`) before any change to classifier/fusion/
  rerank/context-pack/context-fit. **Add a fixture that fails without your change first** — never
  relax thresholds to pass. Hash-only evals can't see the real reranker; use `pnpm run eval:local-model`
  after reranker changes.

## 6. Error handling, logging, config

- **Errors:** `AppError` base in `src/errors.ts` (`ValidationError` 400, `NotFoundError` 404,
  `DuplicateIngestionError` 409, `ModelProviderError` 502, `StoreError`/`CacheError` 503, …).
  `toAppError()` normalizes unknown/pg/redis errors; HTTP returns `{ error, code, details? }`, MCP maps
  to JSON-RPC error shape.
- **Logging:** stderr only for diagnostics; never log to stdout on the MCP path; don't log secrets.
- **Config/secrets:** read once via `loadConfig()` (`src/config.ts`); never hardcode. See
  [`SETUP.md`](SETUP.md) and `.env.example`.

## 7. Git, branches & PRs

- **Commit only when the user asks.** Don't commit/push as a side effect of finishing.
- **The owner pushes the default branch** — agents may commit but do **not** push to `main` (the
  auto-mode classifier blocks agent pushes; commits are fine). Branch for non-trivial work.
- **No AI co-author trailer** (`Co-Authored-By: Claude …` / "Generated with …").
- **Node 22** (`.nvmrc` 22.21.1) — prefix with `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH`
  if the shell is older. **Don't run multiple `pnpm` commands concurrently** (transient workspace JSON
  parse failures). Run `git diff --check` before handing off.
- **CI:** `.github/workflows/ci.yml`. `prepack` runs `build` + `verify:bundled-skills`.

## 8. Cookbook

**Add a new HTTP endpoint** (`src/http/server.ts`):
1. Add an `HttpRoute` to the route list — `{ method, match, handle, public? }`. Use the `exactPath()`
   or `pathPattern(/regex/, ['id'])` matcher helpers.
2. In `handle({ services, request, url, params })`, validate the body with a `src/validation.ts`
   validator, call the service method, return a plain object (auto-serialized to JSON).
3. Throw `ValidationError`/`NotFoundError` for bad input/missing resources. Copy the
   `/atoms/:id/resurrect` route as a template.

**Add a new MCP tool** (`src/mcp/`):
1. Add a `ToolEntry` (name, title, description, JSON `inputSchema`, category) to
   `src/mcp/tool-definitions.ts`.
2. Add a `case 'tuberosa_my_tool':` in `callTool()` (`src/mcp/server.ts`): validate args via a
   `src/validation.ts` function, call the service, wrap the result in `toolJson(...)`. Copy the
   `tuberosa_search_context` case as a template.
3. Keep packs compact; put verbose diagnostics behind a debug flag. Never write to stdout.
4. Run `pnpm run build` + `pnpm test`. If the tool ships to consumers, update
   `.claude/skills/bundled-skills.json` + `package.json` `files` and run `pnpm run verify:bundled-skills`.

(Helper names verified against source: `HttpRoute`/`exactPath`/`pathPattern` in `src/http/server.ts`,
`ToolEntry` in `src/mcp/tool-definitions.ts`, `toolJson` in `src/mcp/server.ts`, `parseOrThrow` in
`src/schemas/primitives.ts`.)
