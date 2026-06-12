# README + CLAUDE.md (+ AGENTS.md) Specs A–C Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make README.md, CLAUDE.md, and AGENTS.md state only facts that match the shipped Specs A/B/C code (full-featured runtime, zero-touch MCP config, 5 bundled skills) — docs only, zero code changes.

**Architecture:** Three surgical doc-edit tasks (one file per task, one commit per task) followed by a verification task that runs the full gate suite, a link-check over every referenced path, and `npx gitnexus analyze` so the refreshed index blocks ride along in the final commit. Every claim below was verified against code on 2026-06-12; spec reviewers must re-verify against the files listed per claim, not against memory.

**Tech Stack:** Markdown only. Verification: `pnpm run build`, `pnpm test`, `pnpm run eval:retrieval`, `pnpm run verify:bundled-skills`, bash link-check.

---

## Verified ground truth (the canonical facts — every edit below traces to one of these)

Each fact lists the code that proves it. Reviewers: open the file, don't trust this table.

| # | Fact | Proof |
|---|---|---|
| 1 | Default model provider is `local`; `openai` if `OPENAI_API_KEY` set; `hash` if `TUBEROSA_EMBEDDED=1` | `src/config.ts:135` — `readEnum(..., embedded ? 'hash' : (process.env.OPENAI_API_KEY ? 'openai' : 'local'))` |
| 2 | LEARN/atom extraction is OFF under both `local` and `hash`; needs `openai` or `ollama` (ollama also needs `TUBEROSA_OLLAMA_EXTRACT_MODEL`) | `src/model/registry.ts:107-128` — `buildProviderRegistry` (local) registers no extraction provider; `registry.ts:158-165` — ollama extraction gated on `ollamaExtractModel` |
| 3 | `init` is Docker-required and hard-fails (exit 1) with install guidance; no silent fallback | `bin/commands/init.ts:55-62` |
| 4 | `--embedded` = explicit volatile trial (memory store, memory cache, hash embeddings, data lost on exit); `--no-docker` is a deprecated alias that prints a deprecation warning | `bin/commands/init.ts:48-52,148`; `bin/commands/init.ts:371-388` (`printEmbeddedMode`) |
| 5 | `init` by default writes agent MCP configs (`.mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml` — codex only when `~/.codex/` exists), best-effort, `--no-mcp-config` opts out | `bin/commands/init.ts:103-133`; codex gating in `bin/commands/mcp-install.ts` |
| 6 | `init` by default copies **5** bundled skills into `.claude/skills/`, `--no-skills` opts out, never overwrites existing files | `bin/commands/init.ts:44-46,178-216`; `.claude/skills/bundled-skills.json` lists exactly 5: tuberosa-onboard-project, tuberosa-guide, tuberosa-agent-loop, tuberosa-operating, tuberosa-using |
| 7 | `tuberosa mcp` defaults to the FULL stack: `TUBEROSA_STORE=postgres`, `TUBEROSA_CACHE=redis`, `TUBEROSA_MODEL_PROVIDER=local`; `--embedded` (or `TUBEROSA_EMBEDDED=1`) switches to memory/memory/hash and overrides exported env | `bin/commands/mcp.ts:57-80` (`buildEnv`) |
| 8 | `tuberosa mcp install` = merge-only config (re)writer; JSON never clobbers other servers; TOML is append-only with a marker; refuses unparseable JSON | `bin/commands/mcp.ts:30-32` dispatch; `bin/commands/mcp-install.ts` |
| 9 | Exactly **36** MCP tools | `grep -c "name: 'tuberosa_" src/mcp/tool-definitions.ts` → 36; README's grouped table sums 2+5+4+2+3+4+3+4+2+7 = 36. **Keep the number.** |
| 10 | **159** test files (not 157) | `ls test/*.test.ts \| wc -l` → 159. Drop the hard count (it drifts). |
| 11 | Health sample: `modelProvider` echoes `TUBEROSA_MODEL_PROVIDER`. `docker-compose.yml:40,66` uses `${TUBEROSA_MODEL_PROVIDER:-hash}`; compose auto-loads `.env`; `.env.example:10` sets `local`. So WITH `.env` (copied from `.env.example`) → `"local"`; bare `docker compose up` with no `.env` → `"hash"` | `docker-compose.yml`, `.env.example`, `src/http/server.ts:159-169` |
| 12 | `sync` is two-step plan→apply: `--apply` applies additive ops; archiving deleted files also needs `--yes` | `bin/commands/sync.ts` (README line 378 already states this — verify, don't change) |
| 13 | The 7 script-only operator tasks: `backup`, `restore`, `error-logs`, `context-quality`, `organization`, `export-pack`, `import-pack`. `organization` is a READ-ONLY export (project-map / knowledge-graph / readable-summary) — never describe it as curation review/apply | `docs/INSTALL.md` Part C table; `package.json` scripts |
| 14 | `verify:bundled-skills` script exists; gates manifest ↔ package.json `files` ↔ on-disk parity + consumer-safety grep (no literal `docs/`, `pnpm run`, `eval/` in shipped SKILL.md files) | `package.json` scripts; `scripts/verify-bundled-skills.ts` |
| 15 | contextFit statuses: `ready` / `needs_confirmation` / `insufficient` | `src/retrieval/context-fit.ts` (README already correct — verify, don't change) |
| 16 | `handoff.md` does NOT exist; project-intent doc lives at `docs/tuberosa-project.md` | `ls` at repo root |

**Do NOT touch:** anything between `<!-- gitnexus:start -->` and `<!-- gitnexus:end -->` (regenerated by `npx gitnexus analyze`); any SKILL.md file; any code file; eval fixtures/thresholds. `bin/commands/doctor.ts:118-119` has a stale message — that is a CODE fix for a separate PR; mention it in the PR body only.

**Standing rules:** prefix node/pnpm commands with `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH`; conventional commits; NEVER add Co-Authored-By trailers; never commit to main.

---

### Task 1: README.md — fix every stale Spec-A/B/C fact

**Files:**
- Modify: `README.md`

All edits are exact-string replacements. Line numbers are from main as of 2026-06-12; match on content, not line number.

- [ ] **Step 1: Fix the LEARN-nuance callout (~line 96) — default provider is `local`, not `hash`**

Replace:

```markdown
> **Important nuance:** LEARN only *automatically extracts* new lessons when a smart model provider (`ollama` or `openai`) is turned on. With the default `hash` provider, FIND works fully, and you can still record lessons manually — but automatic lesson extraction is off. (See [Configuration](#configuration).)
```

with:

```markdown
> **Important nuance:** LEARN only *automatically extracts* new lessons when a generation-capable model provider (`ollama` or `openai`) is turned on. Under the default `local` provider (real embeddings, no API key) — and under `hash` — FIND works fully and you can still record lessons manually, but automatic lesson extraction is off. (See [Configuration](#configuration).)
```

- [ ] **Step 2: Fix the Quick start commands + descriptions (~lines 104–114) — init is Docker-required, mcp is full-stack**

Replace:

```markdown
npx tuberosa init      # set up the local stack (Docker if present, embedded fallback otherwise)
npx tuberosa doctor    # health check: Node / pnpm / Docker / port / Postgres / MCP
npx tuberosa mcp       # run the MCP server an agent talks to (safe local defaults)
```

with:

```markdown
npx tuberosa init      # set up the local stack (Docker required; --embedded for a volatile trial)
npx tuberosa doctor    # health check: Node / pnpm / Docker / port / Postgres / MCP
npx tuberosa mcp       # run the MCP server an agent talks to (full stack by default)
```

Then replace the three explanation bullets:

```markdown
- **`init`** — gets you ready. If Docker is installed it writes `.tuberosa/compose.yml`, starts Postgres + Redis, waits for them to be healthy, runs the database migrations, and copies `.env.example → .env`. If Docker is missing, it falls back to *embedded mode* (everything in memory). Safe to run again — it won't clobber what's already there.
- **`doctor`** — tells you *why* something is broken before you waste time guessing.
- **`mcp`** — starts the server your agent connects to. It defaults to memory store + memory cache + `hash` provider, so it works with **zero external services**.
```

with:

```markdown
- **`init`** — gets you ready. **Docker is required**: it writes `.tuberosa/compose.yml`, starts Postgres + Redis, waits for them to be healthy, runs the database migrations, warms up the local embedding model, and copies `.env.example → .env`. It also writes agent MCP configs (`.mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml` — Codex only when `~/.codex/` exists; skip with `--no-mcp-config`) and copies the 5 bundled agent skills into `.claude/skills/` (skip with `--no-skills`). If Docker is missing, init **fails with install guidance** — `npx tuberosa init --embedded` is the explicit volatile trial mode (memory store, hash embeddings, data lost on exit). Safe to run again — it never overwrites what's already there.
- **`doctor`** — tells you *why* something is broken before you waste time guessing.
- **`mcp`** — starts the server your agent connects to. It defaults to the **full stack** (Postgres + Redis + local embeddings), matching what `init` provisioned. Add `--embedded` for the zero-dependency volatile trial stack.
```

- [ ] **Step 3: Fix the durable-stack snippet + health sample (~lines 129–148)**

Replace:

```bash
corepack enable
pnpm install
docker compose up --build -d
curl http://localhost:3027/health
```

with:

```bash
corepack enable
pnpm install
cp .env.example .env       # compose reads it; sets TUBEROSA_MODEL_PROVIDER=local
docker compose up --build -d
curl http://localhost:3027/health
```

Then in the JSON health sample, replace `"modelProvider": "hash"` with `"modelProvider": "local"`, and add this line directly under the closing ``` of the JSON block:

```markdown
(`modelProvider` echoes `TUBEROSA_MODEL_PROVIDER`. Without a `.env`, `docker compose` falls back to `hash` — see `docker-compose.yml`.)
```

- [ ] **Step 4: Fix the CLI table init row + add an `mcp install` row (~line 374)**

Replace the init row:

```markdown
| `tuberosa init` | Bootstrap the local stack. Copies bundled agent skills into `.claude/skills/` and writes agent MCP configs by default. `--no-skills` / `--no-mcp-config` to skip either. `--no-docker` forces embedded mode. |
```

with:

```markdown
| `tuberosa init` | Bootstrap the local stack — **Docker required** (hard-fails with install guidance if missing). Copies the 5 bundled agent skills into `.claude/skills/` and writes agent MCP configs by default (`--no-skills` / `--no-mcp-config` to skip; never overwrites existing files). `--embedded` opts into the volatile trial stack instead (`--no-docker` is a deprecated alias). |
```

Then add a new row directly after the `tuberosa mcp` row:

```markdown
| `tuberosa mcp install` | (Re)write agent MCP configs on demand: `.mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml` (Codex only when `~/.codex/` exists). Merge-only — never clobbers other servers in an existing config; the TOML is append-only with a marker. |
```

- [ ] **Step 5: Verify (no edit) the "36 MCP tools" heading (~line 436)**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH grep -c "name: 'tuberosa_" src/mcp/tool-definitions.ts`
Expected: `36`. The heading "The 36 MCP tools, grouped" and the grouped table (sums to 36) are correct — make NO edit. If the count is not 36, update the heading number to the actual count and reconcile the table.

- [ ] **Step 6: Fix the Configuration table `TUBEROSA_MODEL_PROVIDER` row (~line 498)**

Replace:

```markdown
| `TUBEROSA_MODEL_PROVIDER` | `hash` | `hash` (offline, deterministic), `openai`, or `ollama`. |
```

with:

```markdown
| `TUBEROSA_MODEL_PROVIDER` | `local` | `local` (real embeddings via `Xenova/bge-small-en-v1.5`, offline after the one-time model download), `hash` (deterministic, zero downloads), `openai`, or `ollama`. Auto-selection: `openai` when `OPENAI_API_KEY` is set; `hash` when `TUBEROSA_EMBEDDED=1`. |
```

- [ ] **Step 7: Fix the Everyday commands block (~line 555) — drop the stale test-file count, add verify:bundled-skills**

Replace:

```markdown
pnpm test                # full unit suite (157 test files)
```

with:

```markdown
pnpm test                # full unit suite (all test/*.test.ts)
```

Then add this line directly after the `pnpm run test:integration` line in the same block:

```markdown
pnpm run verify:bundled-skills  # prepack gate: skills manifest ↔ package.json files ↔ disk parity + consumer-safety grep
```

- [ ] **Step 8: Add the `tuberosa-using` skill to "Where to read next" + mention INSTALL.md Part C (~lines 636–642)**

Replace the INSTALL.md row:

```markdown
| [`docs/INSTALL.md`](docs/INSTALL.md) | Publish to npm/pnpm *and* the end-user install + MCP wiring guide. |
```

with:

```markdown
| [`docs/INSTALL.md`](docs/INSTALL.md) | Publish to npm/pnpm, the end-user install + MCP wiring guide, and the script triage (which `package.json` scripts are for end users / operators / contributors). |
```

Then add this row directly after the `.claude/skills/tuberosa-operating/SKILL.md` row:

```markdown
| `.claude/skills/tuberosa-using/SKILL.md` | End-user usage map: the daily tool loop, the install lifecycle, operator maintenance tasks, and which repo scripts to ignore. |
```

- [ ] **Step 9: Link-check every path README references**

Run:

```bash
for p in docs/SETUP.md docs/MINIMAL_ENV.md docs/INSTALL.md docs/EXAMPLES.md docs/tuberosa-project.md .claude/skills/tuberosa-guide/SKILL.md .claude/skills/tuberosa-agent-loop/SKILL.md .claude/skills/tuberosa-onboard-project/SKILL.md .claude/skills/tuberosa-operating/SKILL.md .claude/skills/tuberosa-using/SKILL.md; do [ -f "$p" ] || echo "MISSING: $p"; done
```

Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add README.md
git commit -m "docs(readme): sync quick start, CLI table, provider default, and skills list with shipped Specs A-C"
```

---

### Task 2: CLAUDE.md — add tuberosa-using row, verify:bundled-skills command, bundled-skills constraint

**Files:**
- Modify: `CLAUDE.md` (NOT the gitnexus block at the bottom)

- [ ] **Step 1: Add the `tuberosa-using` row to the skills table (~lines 38–44)**

In the "Tuberosa skills (teaching layer)" table, add directly after the `tuberosa-operating` row:

```markdown
| Which command/tool does what day to day (end-user usage map: tool loop, lifecycle, operator tasks) | `.claude/skills/tuberosa-using/SKILL.md` |
```

- [ ] **Step 2: Add `verify:bundled-skills` to the Commands block (~line 61)**

Add directly after the `pnpm run test:integration` line inside the commands code fence:

```bash
pnpm run verify:bundled-skills # Prepack gate: bundled-skills manifest ↔ package.json files ↔ on-disk parity + consumer-safety grep
```

- [ ] **Step 3: Add the bundled-skills rule to Key constraints (~after line 151)**

Add as a new paragraph after the "**Retrieval improvements require eval coverage first.**" paragraph (and before `<!-- gitnexus:start -->`):

```markdown
**Bundled skills must stay consumer-safe.** The skills listed in `.claude/skills/bundled-skills.json` ship into end-user projects via `npx tuberosa init`. Their SKILL.md files must contain no literal `docs/`, `pnpm run`, or `eval/` strings — those paths only exist in this checkout, not in a consumer repo. Adding a skill means three things in one change: a manifest entry, a `package.json` `files` entry, and the SKILL.md on disk. `pnpm run verify:bundled-skills` must pass (currently 5/5) before any commit that touches them.
```

- [ ] **Step 4: Verify the gitnexus block is untouched**

Run: `git diff CLAUDE.md | grep -c "gitnexus"`
Expected: `0` from this task's edits (a pre-existing symbol-count refresh from a prior `npx gitnexus analyze` run may already be in the working tree — that is fine and will be committed in Task 4 after the final analyze run; just confirm THIS task added no new lines inside the block).

- [ ] **Step 5: Commit (CLAUDE.md content edits only)**

```bash
git add CLAUDE.md
git commit -m "docs(claude): add tuberosa-using skill row, verify:bundled-skills command, bundled-skills constraint"
```

Note: this commit will carry the pre-existing gitnexus count refresh in CLAUDE.md — acceptable, since Task 4 re-runs `npx gitnexus analyze` and reconciles all index blocks before the PR.

---

### Task 3: AGENTS.md — fix the stale provider claim and dead doc references

**Files:**
- Modify: `AGENTS.md` (NOT the gitnexus block at the bottom)

- [ ] **Step 1: Fix the provider bullet (~line 77)**

Replace:

```markdown
- Provider-pluggable model adapter, with deterministic hash embeddings for local development and OpenAI embeddings when configured.
```

with:

```markdown
- Provider-pluggable model adapter: local embeddings by default (`Xenova/bge-small-en-v1.5`), deterministic hash embeddings for tests and embedded trial mode, OpenAI or Ollama when configured.
```

- [ ] **Step 2: Fix the dead doc references (~line 80)**

Replace:

```markdown
Before substantial work, read `tuberosa-project.md` for the product intent and `handoff.md` for current work state, recent verification, known failures, and next-step recommendations.
```

with:

```markdown
Before substantial work, read `docs/tuberosa-project.md` for the product intent.
```

(`handoff.md` no longer exists; `tuberosa-project.md` lives under `docs/`.)

- [ ] **Step 3: Link-check the referenced path**

Run: `[ -f docs/tuberosa-project.md ] && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): fix stale provider claim and dead handoff.md/tuberosa-project.md references"
```

---

### Task 4: Gates, gitnexus refresh, final reconcile

**Files:**
- Modify (machine-generated): `CLAUDE.md` / `AGENTS.md` gitnexus blocks, `.tuberosa/last-eval.json`

- [ ] **Step 1: Run the full gate suite**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run verify:bundled-skills
```

Expected: build clean; all tests pass; eval:retrieval green (26/26); verify:bundled-skills 5/5. Known flake: `test/invariants.test.ts` "mcp-stdio writes only JSON-RPC frames" can flake under parallel load — re-run once; if it recurs, report it (do NOT fix in this PR).

- [ ] **Step 2: Full link-check over every path the three docs reference**

Run the Task 1 Step 9 loop again, plus: `[ -f docs/tuberosa-project.md ] && [ -f .claude/skills/bundled-skills.json ] && echo OK`
Expected: no MISSING lines, `OK`.

- [ ] **Step 3: Refresh the gitnexus index BEFORE the final commit**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH npx gitnexus analyze
```

This rewrites the gitnexus blocks in CLAUDE.md/AGENTS.md with fresh symbol counts.

- [ ] **Step 4: Commit whatever the gates + analyze dirtied**

```bash
git add CLAUDE.md AGENTS.md .tuberosa/last-eval.json
git commit -m "chore: refresh gitnexus index blocks and eval snapshot"
```

(Skip the commit if `git status --short` shows nothing — analyze may be a no-op.)

- [ ] **Step 5: Verify clean tree and exact diff scope**

Run: `git status --short` (expect empty) and `git diff main --stat` (expect ONLY: README.md, CLAUDE.md, AGENTS.md, .tuberosa/last-eval.json, docs/superpowers/plans/2026-06-12-readme-claudemd-sync.md).

---

## Close-out

Use superpowers:finishing-a-development-branch. PR to `main`, titled exactly:

```
docs: sync README and CLAUDE.md with full-featured runtime + bundled skills (Specs A-C)
```

PR body must list the verified facts enforced (table above), the gate results, and the known follow-ups NOT done here: `bin/commands/doctor.ts:118-119` stale embedded-fallback message (code fix, separate PR), and the invariants-test flake if observed.
