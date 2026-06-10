# Full-Featured End-User Experience — Design Spec

- **Date:** 2026-06-10
- **Status:** Draft for review
- **Scope:** Three sub-specs (A, B, C), built and shipped in that order. Each gets its own implementation plan and PR.
- **Audit basis:** All file/line claims verified against the working tree on 2026-06-10 (post bundled-skills single-source work, commits `f7402d3..b17cc72`).

---

## 0. Goals and non-goals

**Goal in one sentence:** a user who runs `npm install -g tuberosa && tuberosa init` gets the *real* product — real vector search, persistent storage, agent configs written for them, and skills that teach their agent how to use it — without creating any file by hand and without any API key.

**Non-goals (explicitly out of scope):**

- No embedded/SQLite vector store. Docker is a hard requirement for the default path.
- No automatic Docker installation. We fail with guidance instead.
- No new CLI commands for the operator scripts (backup/restore/etc.) — Spec C documents them; promoting them to CLI commands is future work.
- No change to the test/eval toolchain: evals stay pinned to the deterministic hash provider.

## 1. Decisions of record

These were decided with the user during brainstorming (2026-06-09) and survive the 2026-06-10 audit:

| # | Decision | Choice |
|---|----------|--------|
| D1 | Default stack | **Local embeddings + Docker Postgres + Redis.** No API keys. Fully offline after first model download. |
| D2 | No Docker at `init` | **Hard-fail with install guidance.** Explicit `--embedded` flag opts into the volatile trial mode (memory store, hash provider). |
| D3 | Where config generation lives | **New `tuberosa mcp install` subcommand.** Bare `tuberosa mcp` stays "run the MCP stdio server". `init` calls the installer automatically. |
| D4 | Delegating embeddings to the host agent (Claude/Codex) | **Not possible, closed.** MCP has no server→client callback channel for embedding requests, and Anthropic exposes no embeddings endpoint at all. The alternatives are local model (chosen), Ollama, or OpenAI. |
| D5 | Standard embedding dimension | **384** for every provider. The local model (`bge-small-en-v1.5`) is natively 384-dim; the OpenAI path already sends `dimensions` (`src/model/provider.ts:432`) and `text-embedding-3-small` supports shortened output, so OpenAI users also run at 384. One schema for everyone. |

---

## Spec A — Full-featured default runtime

### A.1 Problem

Today the package defaults to a fake brain and a forgetful memory:

- `TUBEROSA_MODEL_PROVIDER` defaults to `hash` (`src/config.ts:128`) — vector search returns deterministic noise, not semantics.
- The `local` provider only reranks locally; its **embeddings silently fall back to hash** (`src/model/local-provider.ts:22-24`, `src/model/factory.ts:10-13`). Real local embeddings do not exist yet.
- `tuberosa mcp` defaults to `memory` store + `memory` cache + `hash` provider (`bin/commands/mcp.ts:50-58`) — all data is lost when the agent session ends.
- `tuberosa init` silently degrades to embedded mode when Docker is missing (`bin/commands/init.ts:43-46`).

### A.2 Design

#### A.2.1 Real local embeddings (`src/model/local-provider.ts`)

Add an embedding pipeline to the existing `local` provider, reusing the exact lazy-import pattern the local reranker already uses:

- Lazy-import `@xenova/transformers`, build a `feature-extraction` pipeline with model `Xenova/bge-small-en-v1.5` (384-dim, ~34 MB ONNX), mean-pooled + normalized.
- New env: `TUBEROSA_EMBEDDING_MODEL` (default `Xenova/bge-small-en-v1.5`). Model cache honors the existing `TUBEROSA_MODEL_CACHE_DIR` (default `~/.cache/tuberosa/models/`).
- **Fallback contract:** if the import or model load fails (offline CI, missing cache), `embed()` falls back to `HashModelProvider` **and logs one loud stderr warning** — same shape as the reranker's `hasLoggedLoadFailure` pattern. Tests keep working offline; users are never silently degraded without a message.
- **Test seam:** constructor accepts an injected `embedder` (mirror of the existing injected `scorer` seam at `local-provider.ts:38`) so unit tests stay deterministic and offline.
- `@xenova/transformers` moves from "intentionally not a dependency" to a **regular dependency**. Rationale: D1 makes local the default; an optional dependency that's missing would mean the default install is broken. It is pure JS/WASM — no native build step, no platform matrix.

#### A.2.2 Schema migration to 384 dimensions

**Audit correction folded in:** there are TWO embedding columns, not one.

- New migration `006_embedding_dim_384.sql`:
  - `knowledge_chunks.embedding` (`migrations/001_init.sql:116`): drop any vector index, `SET embedding = NULL`, `ALTER ... TYPE vector(384)`, recreate index.
  - `knowledge_atoms.embedding` (`migrations/005_knowledge_atoms.sql:27`): same treatment.
- `EMBEDDING_DIMENSIONS` default changes 1536 → 384 (`src/config.ts:129`); `.env.example` updated to match.
- **Startup validation:** on Postgres store startup, read the column's `atttypmod` and compare with `config.model.embeddingDimensions`. Mismatch → fail fast with a message naming both numbers and pointing at `tuberosa init` (which migrates). This enforces the existing "dimensions must be consistent" constraint mechanically instead of by documentation.
- **Breaking change, stated plainly:** existing installs lose stored embeddings (1536-d vectors cannot be cast to 384-d; they are nulled). Recovery is the re-embed backfill below. Release notes must say this.

#### A.2.3 Re-embed backfill (new — nothing like it exists today)

- New `scripts/reembed.ts` + `pnpm run reembed`: stream all rows in `knowledge_chunks` / `knowledge_atoms` where `embedding IS NULL`, embed with the configured provider, update in batches. Idempotent; safe to interrupt and re-run.
- `tuberosa init` runs it automatically after migrations whenever null-embedding rows exist, so upgrading users get healed without learning a new command.

#### A.2.4 Default flips

| Surface | Today | After |
|---|---|---|
| `src/config.ts:128` provider default | `hash` (or `openai` if key present) | `local` (or `openai` if key present) |
| `bin/commands/mcp.ts` `buildEnv()` | `memory` / `memory` / `hash` | `postgres` / `redis` / `local`, `TUBEROSA_AUTO_MIGRATE=false` (unchanged) |
| `.env.example` | `TUBEROSA_MODEL_PROVIDER=hash`, dims 1536 | `local`, dims 384 |

- `buildEnv()` keeps its "user-exported values win" behavior — only the defaults change.
- New escape hatch: `tuberosa mcp --embedded` (and env `TUBEROSA_EMBEDDED=1`, for MCP configs that can't pass CLI flags) → `memory`/`memory`/`hash`, exactly today's behavior.
- **Failure mode:** if the MCP server starts with `postgres` defaults and Postgres is unreachable, it must fail fast with a one-line stderr message: `Tuberosa store unreachable — run 'npx tuberosa init' first, or set TUBEROSA_EMBEDDED=1 for volatile trial mode.` (stdout stays JSON-RPC clean, per the existing MCP constraint).

#### A.2.5 `tuberosa init` becomes Docker-required

- Docker missing or `docker compose up` fails → **exit 1** with: link to Docker install docs, and the `tuberosa init --embedded` escape hatch. The current silent `printEmbeddedMode` fallback is removed from the default path; it runs only under `--embedded`.
- `--no-docker` is kept as a deprecated alias for `--embedded` (prints a deprecation note).
- After the stack is healthy and migrations applied, init additionally:
  1. **Pre-downloads the embedding model** by running one warm-up `embed("warmup")` through the local provider, so the agent's first real call isn't a multi-second stall. Failure here is a hard error (the default install must not silently degrade to hash) with `--embedded` named as the escape hatch.
  2. Runs the re-embed backfill if needed (A.2.3).
  3. Writes agent configs and copies skills (Spec B).
- `doctor` gains one check: embedding model present in cache / loadable (`ok` / `warn` with the warm-up command as remediation).

#### A.2.6 Text that must change with the defaults (audit correction)

- `bin/commands/parser.ts:76` — mcp help line currently says "embedded-mode defaults (memory store + cache + hash provider)". Reword to the new default + `--embedded` flag.
- `bin/commands/parser.ts:74` and the `--with-skills`/`--no-docker` option lines — updated per Spec B flag changes.
- `printEmbeddedMode` (`init.ts:261-277`) — survives only as the `--embedded` path; reworded so it never claims to be the default.
- `README.md`, `docs/INSTALL.md`, `docs/SETUP.md`, `docs/MINIMAL_ENV.md` — same story everywhere.

### A.3 What does NOT change

- Evals and unit tests stay pinned to `hash` (verified: `scripts/eval-retrieval.ts:41` hard-codes `provider: 'hash'`). `pnpm run eval:retrieval` must stay green with zero fixture edits.
- `HashModelProvider` itself is untouched — it remains the deterministic test/CI provider and the embedded-mode provider.
- Ollama and OpenAI provider paths are untouched (OpenAI now simply runs at 384 via its existing `dimensions` parameter).

### A.4 Testing

- Unit: local embed pipeline with injected embedder (dims, normalization, fallback-to-hash on load failure, the single-warning behavior).
- Unit: startup dimension validation (matching, mismatched, column missing).
- CLI tests (`test/cli.test.ts` pattern): init hard-fail without Docker; `--embedded` path; warm-up failure is fatal; `mcp --embedded` env; `buildEnv` new defaults + user-override precedence.
- Migration test (Docker-gated integration suite): 006 applies on top of 001..005, both columns at 384, reembed backfill fills nulls.
- Full gates before merge: `pnpm test`, `pnpm run eval:retrieval`, `pnpm run eval:agent-context`, `pnpm run verify:bundled-skills`, `pnpm run build`.

---

## Spec B — Zero-touch agent config + skills by default

### B.1 Problem

- No config writer exists anywhere (verified by clean grep — only a help-text mention in `doctor.ts:146` and a printed TOML snippet in `init.ts:284`). Users hand-edit `.mcp.json` / `.cursor/mcp.json` / `~/.codex/config.toml` from a printed snippet.
- Skills are opt-in (`init --with-skills`) and the manifest ships only **one** skill (`tuberosa-onboard-project`). The other three (`tuberosa-guide`, `tuberosa-agent-loop`, `tuberosa-operating`) are blocked by repo-internal cross-references that would dangle in a consumer install (documented in the bundled-skills plan self-review).

### B.2 Design

#### B.2.1 `tuberosa mcp install` (new file `bin/commands/mcp-install.ts`)

- Routing: `parseArgs` already yields `command='mcp'`, `positional=['install']` (`parser.ts:48-63`); `mcpCommand` branches on `positional[0] === 'install'`. No parser changes needed.
- **Targets and files:**

| Target | File | Format | Default? |
|---|---|---|---|
| `claude` | `<root>/.mcp.json` | JSON, `mcpServers.tuberosa` | always |
| `cursor` | `<root>/.cursor/mcp.json` | JSON, `mcpServers.tuberosa` | always |
| `codex` | `~/.codex/config.toml` | TOML, `[mcp_servers.tuberosa]` | only when `~/.codex/` exists |

- `--target claude,cursor,codex` overrides the default set. `--root <path>` reuses the existing flag.
- **Written entry** (identical semantics across formats): `command: "npx"`, `args: ["tuberosa", "mcp"]`, plus an explicit full-feature env block (`TUBEROSA_STORE=postgres`, `TUBEROSA_CACHE=redis`, `TUBEROSA_MODEL_PROVIDER=local`, `DATABASE_URL`, `REDIS_URL` with the init ports). The env duplicates the new `buildEnv()` defaults *on purpose* — the config file is self-documenting and survives future default changes.
- **Merge, never clobber:**
  - JSON: parse existing file, preserve every other key and server; if `mcpServers.tuberosa` already exists, leave it and print "already configured (use --force to overwrite)"; `--force` replaces only the `tuberosa` entry. Unparseable JSON → refuse to touch the file, print the snippet instead, exit non-zero.
  - TOML: no TOML dependency. If the file contains a `[mcp_servers.tuberosa]` line, skip (or `--force`: print manual-edit instructions — we do not rewrite TOML we didn't author). Otherwise append our section with a `# added by tuberosa mcp install` marker. Limitation stated in help text.
- **`init` integration:** after the stack is up (A.2.5 step 3), init invokes the same writer with default targets and reports each file written/skipped. `init --no-mcp-config` opts out.

#### B.2.2 Skills: consumer-safe and shipped by default

1. **Rewrite for consumers (prerequisite, audit-confirmed):** `tuberosa-guide`, `tuberosa-agent-loop`, `tuberosa-operating` get consumer-safe edits — remove/replace references to repo-internal paths (`docs/SETUP.md`, `pnpm run …` dev scripts, checkout-only file paths) with installed-package equivalents (`npx tuberosa …`, MCP tool names). Acceptance check: no relative repo path in a shipped SKILL.md that doesn't exist in a consumer project.
2. **Manifest expansion:** add all four existing skills + the new `tuberosa-using` (Spec C) to `.claude/skills/bundled-skills.json`. The existing prepack gate (`scripts/verify-bundled-skills.ts`) mechanically forces the matching `package.json` `files` entries — this is the single edit point the previous work built for us.
3. **Copy by default:** `init` copies all bundled skills (current `copyBundledSkills`, unchanged never-overwrite semantics). `--with-skills` is removed; `--no-skills` opts out. Help text updated.

### B.3 Testing

- CLI tests with the fake `FsAdapter`: fresh write per target; merge preserving foreign servers; existing-entry skip; `--force`; unparseable JSON refusal; TOML append + duplicate detection; codex default only when `~/.codex` exists; `init` auto-invocation and `--no-mcp-config`.
- `pnpm run verify:bundled-skills` green with the expanded manifest.
- Consumer-safety check for skills: grep gate in `verify-bundled-skills.ts` (no `docs/`, `pnpm run`, `eval/` references in shipped SKILL.md files).

---

## Spec C — End-user usage skill + script triage

### C.1 Problem

`package.json` has ~40 scripts with no signal about who they're for. End users wonder "when do I run `calibrate-fusion`?" The answer is **never** — but nothing says so.

### C.2 Design

#### C.2.1 New bundled skill: `tuberosa-using`

Flat path `.claude/skills/tuberosa-using/SKILL.md`, superpowers conventions (frontmatter `name` + "Use when…" `description`). Audience: the end user's agent in a consumer project. Contents:

1. **"I want to X" → command/tool map** — the daily loop: when the agent should call `tuberosa_start_session` / `tuberosa_search_context` / `tuberosa_record_context_decision` / `tuberosa_finish_session`, and what `contextFit` statuses mean.
2. **Lifecycle table:** `init` (once per project) → `mcp install` (once per editor) → `bootstrap` (first onboard) → `sync` / `hook install` (keeping knowledge fresh) → `doctor` (when broken).
3. **Operator tasks that are script-only today** (audit-corrected list — 4 of the old list already have CLI commands): `backup`, `restore`, `error-logs`, `context-quality`, `organization`, `export-pack`, `import-pack`. The skill documents each in one line and notes they require a Tuberosa checkout. Promoting them to CLI subcommands is explicitly future work.
4. **Everything else in `package.json` is contributor tooling** (evals, sandbox, calibrate-fusion, benchmark, seed, graph maintenance) — one table that says "you never run these; they gate development of Tuberosa itself."

#### C.2.2 Script triage (documentation only, no script changes)

The same dev-vs-operator classification lands in `docs/INSTALL.md` so it's visible outside the skill. `package.json` scripts themselves are untouched — renaming/regrouping them would churn CI and the muscle memory of contributors for zero end-user gain (end users never see them).

### C.3 Testing

- `verify:bundled-skills` parity (manifest + files + on-disk).
- Consumer-safety grep gate from B.3 applies to the new skill.

---

## Rollout

1. **Spec A** first — it defines the env/defaults that B's config writer bakes into files.
2. **Spec B** second — configs + skills shipping.
3. **Spec C** last — pure docs/skill content, no code risk.
4. One implementation plan + PR per spec. Every PR runs the full gate set (A.4). Version bump: A is breaking (schema + defaults) → minor bump pre-1.0 with release notes naming the re-embed step.

## Risks

| Risk | Mitigation |
|---|---|
| WASM embedding latency (~50–150 ms/text) slows bulk ingestion | Batch embeds in `reembed.ts` and ingestion; latency is per-chunk, acceptable for interactive retrieval |
| First-run model download fails (proxy/offline) | init warm-up makes it fail loudly at setup time, not silently at query time; `--embedded` escape |
| Existing installs lose embeddings at 006 | Auto re-embed in init; release notes; backfill is idempotent |
| npm package weight (+`@xenova/transformers`) | Pure-JS dep, no native builds; model itself is downloaded to cache, not shipped |
| TOML merge corrupting `~/.codex/config.toml` | Append-only with marker; never rewrite existing sections; refuse on detection |
