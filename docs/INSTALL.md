# Installing & Publishing Tuberosa

Tuberosa ships as an npm package with a `tuberosa` binary, so consumers run it through `npx`
exactly like other MCP-aware CLIs (`npx gitnexus analyze`, `npx <pkg> <command>`). This guide
has two halves:

- **Part A — Maintainer: publish to npm/pnpm** (build → pack → version → publish → verify).
- **Part B — End user: install & wire it up** (quick start, skill injection, MCP registration, Docker).

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
| `.claude/skills/tuberosa-onboard-project/SKILL.md` | the skill `init --with-skills` installs |
| `LICENSE`, `README.md`, `package.json` | npm always includes these |

> **Bundled skills are gated.** `.claude/skills/bundled-skills.json` is the single
> source of truth for which skills ship and which `init --with-skills` copies. The
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
npx tuberosa init        # Docker present → Postgres+Redis+migrate; otherwise embedded (memory) mode
npx tuberosa doctor      # verify Node, pnpm, port 3027, Postgres reachability, MCP stdout sanity
npx tuberosa mcp         # run the MCP stdio server (full stack: Postgres + Redis + local embeddings)
```

`init` requires Docker and hard-fails without it. Use `--embedded` (or `TUBEROSA_EMBEDDED=1`) for volatile trial mode — everything in memory, no Docker needed, data lost on restart.

### B2. Skill injection (canonical mechanism)

Tuberosa bundles the **project-comprehension** skill and installs it for you:

```bash
npx tuberosa init --with-skills      # copies bundled skills → ./.claude/skills/<name>/SKILL.md
```

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

## See also

- `.claude/skills/tuberosa-onboard-project/SKILL.md` — onboard/comprehend a project into Tuberosa.
- `docs/SETUP.md` — environment + provider matrix.
- `README.md` — architecture and surfaces.
