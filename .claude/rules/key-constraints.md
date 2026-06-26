# Rule: Key constraints

**Retrieval eval must be green.** Run `pnpm run eval:retrieval` before any change to classifier, fusion weights, reranking, context-pack assembly, or context-fit logic. The eval fixture (`eval/retrieval-fixtures.json`) asserts `hitRate=1`, `staleRejectionRate=1`, and all exact classification rates at 1. Do not adjust thresholds to make tests pass — fix the logic.

**Embedding dimensions must be consistent.** `EMBEDDING_DIMENSIONS` in config must match the `vector(N)` column dimension. The current default is 384 (matching `Xenova/bge-small-en-v1.5` and `migrations/014_embedding_dim_384.sql`; the original 001 and 005 migrations also track this). Changing dimensions requires a new migration.

**MCP stdout is protocol-only.** The MCP stdio process must write only JSON-RPC frames to stdout. Do not add any `console.log` or `process.stdout.write` calls in the MCP code path; use `stderr` for diagnostics.

**Retrieval improvements require eval coverage first.** Do not add heuristics or weight tweaks without a fixture case that would fail without the change.

**Bundled skills must stay consumer-safe.** The skills listed in `.claude/skills/bundled-skills.json` ship into end-user projects via `npx tuberosa init`. Their SKILL.md files must contain no literal `docs/`, `pnpm run`, or `eval/` strings — those paths only exist in this checkout, not in a consumer repo. Adding a skill means three things in one change: a manifest entry, a `package.json` `files` entry, and the SKILL.md on disk. `pnpm run verify:bundled-skills` must pass before any commit that touches them.
