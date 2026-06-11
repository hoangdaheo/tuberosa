# Installing & Publishing Tuberosa

Tuberosa ships as an npm package with a `tuberosa` binary, so consumers run it through `npx`
exactly like other MCP-aware CLIs (`npx gitnexus analyze`, `npx <pkg> <command>`). This guide
has three parts:

- **Part A — Maintainer: publish to npm/pnpm** (build → pack → version → publish → verify).
- **Part B — End user: install & wire it up** (quick start, skill injection, MCP registration, Docker).
- **Part C — Script triage: who runs what** (end user vs operator vs contributor script classification).

Everything here is **local-first**: the default runtime uses the deterministic `hash` model
provider and the in-memory store, so it works offline with **zero external API calls**. An
`OPENAI_API_KEY` is optional and unused unless you explicitly switch providers.

---

## Part A — Publish to npm / pnpm

Run from the repo root on Node ≥22.13 with pnpm ≥11.1.2 (`npx tuberosa doctor` checks both).

### A1. Build & package sanity

```bash
pnpm run build                 # tsc → dist/ (this is what `bin.tuberosa` points at)
npm pack --dry-run             # list the tarball contents WITHOUT writing a file
```

Confirm the dry-run output includes — and nothing secret leaks in:

| Must be present | Why |
| --- | --- |
| `dist/bin/tuberosa.js` | the real built CLI entrypoint (`bin.tuberosa`) |
| `dist/src/**` | the server + MCP code the CLI spawns |
| `bin/**` | the `tsx` fallback entry used in a fresh checkout |
| `migrations/**` | Postgres schema (`pnpm run migrate`) |
| `.env.example` | the env template `init` copies to `.env` |
| `.claude/skills/tuberosa-onboard-project/SKILL.md` | the skill `init` installs by default |
| `LICENSE`, `README.md`, `package.json` | npm always includes these |

> **Bundled skills are gated.** `.claude/skills/bundled-skills.json` is the single
> source of truth for which skills ship and which `init` copies by default. The
> `prepack` hook runs `verify:bundled-skills`, which fails the pack/publish if the
> manifest, the on-disk skill files, and the `package.json` `files` allowlist
> disagree. To add a skill to the package: (1) add its folder under
> `.claude/skills/`, (2) add one entry to `bundled-skills.json`, (3) run
> `pnpm run verify:bundled-skills` — it names exactly which directory to add to `files`.

❌ Must **not** appear: `.env`, `.tuberosa/`, `.git/`, `node_modules/`, test fixtures with
secrets. The `files` allowlist in `package.json` already restricts the set — the dry-run is your
last check. (`.npmignore` is not used; the `files` allowlist wins.)

### A2. Versioning & metadata

`package.json` already declares `repository`, `homepage`, `bugs`, `license: MIT`, `keywords`,
`publishConfig.access: public`, and `engines` (`node >=22.13`, `pnpm >=11.1.2`). Bump the version
with npm so it also tags the commit:

```bash
npm version patch   # or: minor / major  → updates package.json + creates a git tag
```

### A3. Publish (dry-run first)

```bash
npm publish --dry-run          # final contents + registry checks, no upload
npm publish                    # real publish (scoped/public per publishConfig.access)
```

- **2FA / CI:** interactive publish prompts for an OTP. In CI, set `NODE_AUTH_TOKEN` (or
  `NPM_TOKEN` wired into `.npmrc` as `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`) and publish
  with `npm publish --provenance` from a trusted workflow.
- pnpm equivalent: `pnpm publish --dry-run` then `pnpm publish` (respects the same `files`/`publishConfig`).

### A4. Verify the published artifact locally (before trusting it)

Install the packed tarball into a throwaway directory and smoke-test the binary:

```bash
pnpm run build && npm pack                 # writes tuberosa-<version>.tgz
mkdir /tmp/tuberosa-verify && cd /tmp/tuberosa-verify
npm init -y >/dev/null
npm i /path/to/tuberosa/tuberosa-<version>.tgz
npx tuberosa doctor                        # exits 0 when the install is sound
npx tuberosa --help                        # confirms the command surface
```

✅ `doctor` printing a checklist and exiting `0` means `dist/bin/tuberosa.js` resolves and runs
from a real install.

---

## Part B — End-user install

### B1. Quick start

```bash
npx tuberosa init        # requires Docker (Postgres+Redis+migrate+model warm-up); --embedded for volatile trial mode
npx tuberosa doctor      # verify Node, pnpm, port 3027, Postgres reachability, MCP stdout sanity
npx tuberosa mcp         # run the MCP stdio server (full stack: Postgres + Redis + local embeddings)
```

`init` requires Docker and hard-fails without it. Use `--embedded` (or `TUBEROSA_EMBEDDED=1`) for volatile trial mode — everything in memory, no Docker needed, data lost on restart.

### B2. Skill injection (canonical mechanism)

`npx tuberosa init` copies all bundled agent skills into `./.claude/skills/` by default. Pass `--no-skills` to skip.

- Skills are written to a **flat** path (`.claude/skills/tuberosa-onboard-project/SKILL.md`) —
  required, because Claude Code only auto-discovers skills exactly one level under a skills root.
- Existing files are **never overwritten** (your edits are safe); delete a file to let `init`
  re-copy it.
- Restart Claude Code afterward so the Skill tool discovers the new skill.
- Manual alternative (any agent runtime): copy
  `node_modules/tuberosa/.claude/skills/tuberosa-onboard-project/SKILL.md` into your project's
  `.claude/skills/tuberosa-onboard-project/SKILL.md` yourself.
- Override the source root with `TUBEROSA_SKILLS_SRC=/path/to/skills` if you vendor your own.

Once installed, the skill drives onboarding: `init → doctor → bootstrap --deep → review drafts`,
and keeping knowledge fresh via `sync` + `hook install`.

### B3. Register as an MCP server (local-first, zero external services)

> **Zero-touch:** `npx tuberosa init` writes the agent MCP config files for you (`.mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml`). Run `npx tuberosa mcp install` to re-write them on demand — merge-only, it never clobbers other servers in an existing config. Pass `--no-mcp-config` to `init` to skip writing them. The snippets below are the manual fallback.

Claude Code / Codex / Cursor read a TOML/JSON MCP block. The full-stack defaults (Postgres + Redis + local embeddings) need no API key — just run `npx tuberosa init` first. For volatile trial mode, add `TUBEROSA_EMBEDDED = "1"`:

**TOML (Claude Code / Codex):**

```toml
[mcp_servers.tuberosa]
command = "npx"
args = ["tuberosa", "mcp"]
# No env needed for full stack (after `npx tuberosa init`).
# For volatile trial mode (no Docker): env = { TUBEROSA_EMBEDDED = "1" }
```

**JSON (`claude_desktop_config.json` / clients using JSON):**

```json
{
  "mcpServers": {
    "tuberosa": {
      "command": "npx",
      "args": ["tuberosa", "mcp"]
    }
  }
}
```

`tuberosa mcp` defaults to the full stack (Postgres + Redis + local embeddings) and keeps **stdout JSON-RPC-clean** (diagnostics go to stderr). `npx tuberosa init` prints a copy of this snippet tailored to your setup.

### B4. Volatile trial mode (no Docker required)

For a quick try without Postgres or Redis, use `--embedded` or `TUBEROSA_EMBEDDED=1`:

```bash
npx tuberosa init --embedded   # memory store, hash embeddings — data lost on exit
npx tuberosa mcp --embedded    # same for the MCP server
# or via env: TUBEROSA_EMBEDDED=1 npx tuberosa mcp
```

Switching the model provider to `ollama` or `openai` (to turn on automatic atom extraction / the LEARN pillar) is a separate, opt-in choice — see `docs/SETUP.md` and `.claude/skills/tuberosa-operating/SKILL.md` §6.

---

## Part C — Script triage: who runs what

`package.json` has ~40 scripts with no audience signal. They fall into three buckets — and end users
need **none** of them, because the `npx tuberosa` CLI covers the whole consumer surface. The scripts
themselves are deliberately untouched: renaming or regrouping them would churn CI and contributor
muscle memory for zero end-user gain.

| Audience | Scripts | Notes |
| --- | --- | --- |
| **End user (consumer project)** | _none_ | Use the CLI instead: `npx tuberosa init`, `doctor`, `mcp`, `mcp install`, `bootstrap`, `sync`, `hook install`. |
| **Operator (requires this repo checked out)** | `backup`, `restore`, `error-logs`, `context-quality`, `organization`, `export-pack`, `import-pack` | Maintenance tasks with no CLI subcommand yet (promotion to `tuberosa <cmd>` is future work). Run as `pnpm run <script>` from the repo root. Several have MCP tool equivalents (`tuberosa_export_pack`, `tuberosa_import_pack`, `tuberosa_list_error_logs`, `tuberosa_collect_context_quality_feedback`). |
| **Contributor (Tuberosa development only)** | Everything else: `eval:*`, `sandbox`, `sandbox:ablate`, `calibrate-fusion`, `benchmark`, `reembed`, `seed:self`, `backfill:domains`, `archival-sweep`, `infer-co-change`, `prune-stale-edges`, `cluster-user-corrections`, `migrate-knowledge-to-atoms`, `import:docs`, `build`, `test`, `test:integration`, `verify:bundled-skills`, `migrate`, `dev`, `start`, `worker`, `mcp`, `prepack` | These gate development of Tuberosa itself. If you are not changing Tuberosa's code, you never run them. The list is illustrative — any script not in the operator row above is contributor-only. |

The same classification ships to end users as the `tuberosa-using` bundled skill
(`.claude/skills/tuberosa-using/SKILL.md`), installed by `npx tuberosa init` alongside the other skills.

---

## See also

- `.claude/skills/tuberosa-onboard-project/SKILL.md` — onboard/comprehend a project into Tuberosa.
- `docs/SETUP.md` — environment + provider matrix.
- `README.md` — architecture and surfaces.
