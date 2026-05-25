# Tuberosa Agent Guide

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward deliberate product judgment over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Intentional Scope

**Build the right thing for the current product stage. Do not let the old v1 scope cap useful ideas.**

- For ordinary fixes, keep changes narrow and avoid speculative abstractions.
- For Tuberosa product work, the v1 roadmap is no longer a ceiling. Agents may propose and build more creative, cohesive experiences when they directly advance Tuberosa's purpose as an agent context broker and learning layer.
- Prefer prototypes or thin vertical slices for broad ideas, with clear verification and rollback boundaries.
- Add flexibility only when it supports a real workflow, integration surface, or review loop.
- Avoid over-engineering, but do not reject useful product direction only because it is beyond the original v1 shape.

Ask yourself: "Is this complexity buying a real product capability or just hedging?" If it is only hedging, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Project Purpose

Tuberosa is a local-first context broker for agentic AI tools. It sits between coding agents and durable project or user knowledge, retrieves the right references for the current task, and saves reviewed reflection memories so future agents avoid repeated mistakes.

The v1 architecture is:

- MCP stdio server as the primary agent integration.
- HTTP API for CRUD, ingestion, retrieval, feedback, and reflection review.
- Postgres plus pgvector for durable knowledge, labels, references, chunks, vectors, context packs, feedback, and reflection memory.
- Redis for short-lived context-pack caching and coordination.
- Provider-pluggable model adapter, with deterministic hash embeddings for local development and OpenAI embeddings when configured.
- Docker Compose deployment for Postgres, Redis, app, and worker.

Before substantial work, read `tuberosa-project.md` for the product intent and `handoff.md` for current work state, recent verification, known failures, and next-step recommendations.

## Stack And Runtime

- Runtime: Node.js `>=22.13`; `.nvmrc` pins `22.21.1`.
- Package manager: pnpm `>=11.1.2`.
- Language: strict TypeScript with NodeNext ESM.
- Tests: Node's built-in test runner with `tsx`.
- Durable services: Postgres/pgvector and Redis through Docker Compose.

If the shell is on an older Node version, use `nvm use` or prefix commands with:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH
```

Do not run multiple `pnpm` commands concurrently; pnpm workspace state has previously produced transient JSON parse failures during concurrent runs.

## Common Commands

```bash
pnpm install
pnpm run build
pnpm test
pnpm run test:integration
pnpm run eval:retrieval
pnpm run dev
pnpm run mcp
pnpm run migrate
docker compose up --build -d
docker compose down
```

Use `pnpm run eval:retrieval` before and after changes to retrieval classification, fusion, reranking, or context-pack assembly.

`pnpm run test:integration` is Docker-gated. It probes Postgres and Redis and skips cleanly when services are unavailable.

## Source Map

- `src/app.ts`: service composition.
- `src/index.ts`: HTTP app entry point.
- `src/mcp-stdio.ts`: MCP stdio entry point.
- `src/http/server.ts`: HTTP routes.
- `src/mcp/server.ts`: MCP tools, resources, and prompts.
- `src/ingest/service.ts`: knowledge and file ingestion.
- `src/retrieval/classifier.ts`: prompt classification.
- `src/retrieval/service.ts`: retrieval pipeline.
- `src/retrieval/fusion.ts`: candidate fusion.
- `src/retrieval/context-pack.ts`: context pack assembly.
- `src/reflection/service.ts`: reflection draft and approval workflow.
- `src/storage/store.ts`: storage interface.
- `src/storage/postgres-store.ts`: Postgres implementation.
- `src/storage/memory-store.ts`: in-memory test and fallback implementation.
- `src/storage/migrations.ts`: reusable migration runner.
- `migrations/001_init.sql`: database schema.
- `eval/retrieval-fixtures.json`: deterministic retrieval evaluation fixture.
- `test/*.test.ts`: unit and integration tests.

## API Surface

HTTP endpoints currently include:

- `GET /health`
- `GET /knowledge`
- `POST /knowledge`
- `PATCH /knowledge/:id`
- `POST /ingest/files`
- `POST /context/search`
- `GET /context/packs`
- `GET /context/packs/:id`
- `POST /context/feedback`
- `POST /agent-sessions`
- `POST /agent-sessions/:id/context-decision`
- `POST /agent-sessions/:id/finish`
- `POST /agent-sessions/:id/notes`
- `POST /reflection-drafts`
- `PATCH /reflection-drafts/:id`
- `POST /reflection-drafts/:id/approve`
- operations endpoints for relations, conflicts, knowledge gaps, learning proposals, context quality, organization exports, imports, cleanup, backups, and error logs

MCP tools currently include:

- `tuberosa_search_context`
- `tuberosa_get_context_pack`
- `tuberosa_start_session`
- `tuberosa_record_context_decision`
- `tuberosa_finish_session`
- `tuberosa_append_session_note`
- `tuberosa_reflect`
- reflection review tools
- `tuberosa_feedback_context`
- `tuberosa_collect_context_quality_feedback`
- error-log tools for recording, listing, collecting, reading, updating, and resolving incidents

MCP resources and prompts are defined in `src/mcp/server.ts`.

## Development Notes

- Keep normal MCP context packs compact. Put verbose retrieval diagnostics behind a debug flag, endpoint, or explicit tool field.
- Retrieval should preserve provenance: labels, references, match reasons, scores, and feedback decisions.
- Reflection memories should be reviewable drafts first; approval makes them searchable.
- Avoid storing secrets, raw private conversation, or prompt-injection content as durable knowledge.
- The SQL schema uses `knowledge_references`; avoid creating a table named `references`, which is a reserved identifier.
- Prefer existing abstractions over new ones: `KnowledgeStore`, cache adapters, model providers, ingestion, retrieval, and reflection services.
- Keep Docker defaults aligned with `.env.example` and `docker-compose.yml`.

## Verification Expectations

For narrow code changes, run:

```bash
pnpm run build
pnpm test
```

For storage, migration, cache, or Docker behavior, also run:

```bash
pnpm run test:integration
```

For retrieval behavior, also run:

```bash
pnpm run eval:retrieval
```

Run `git diff --check` before handing off changes.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **tuberosa** (7326 symbols, 15903 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/tuberosa/context` | Codebase overview, check index freshness |
| `gitnexus://repo/tuberosa/clusters` | All functional areas |
| `gitnexus://repo/tuberosa/processes` | All execution flows |
| `gitnexus://repo/tuberosa/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
