# Installing & Publishing Tuberosa

Tuberosa is published **privately** to **GitHub Packages** as the scoped package
**`@hoangdaheo/tuberosa`** (tied to the private `hoangdaheo/tuberosa` repo). The package exposes a
`tuberosa` binary, so once installed it runs as `tuberosa <command>` (or `npx @hoangdaheo/tuberosa
<command>` for a one-shot). This guide has two halves:

- **Part A — Maintainer: publish to GitHub Packages** (build → pack → publish → verify).
- **Part B — End user: install & wire it up** (quick start, skill injection, MCP registration, Docker).

> Because the package is private, **both publishing and installing require a GitHub token** with the
> right `packages` scope (publishers need `write:packages`, installers need `read:packages`). There
> are no npmjs.com credentials involved.

Everything here is **local-first**: the default runtime uses the deterministic `hash` model
provider and the in-memory store, so it works offline with **zero external API calls**. An
`OPENAI_API_KEY` is optional and unused unless you explicitly switch providers.

---

## Part A — Publish to npm / pnpm

Run from the repo root on Node ≥22.13 with pnpm ≥11.1.2 (after `pnpm run build`, `node dist/bin/tuberosa.js doctor` checks both).

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

`package.json` is already wired for GitHub Packages:

- `name: "@hoangdaheo/tuberosa"` — the scope **must** equal the GitHub repo owner.
- `publishConfig: { registry: "https://npm.pkg.github.com", access: "restricted" }` — routes publish
  to GitHub Packages; private repo ⇒ private package.
- `repository` points at `github.com/hoangdaheo/tuberosa` (GitHub Packages requires this to link the package).
- `engines` (`node >=22.13`, `pnpm >=11.1.2`). The repo `.npmrc` maps the `@hoangdaheo` scope to the registry.

Bump the version with npm so it also tags the commit:

```bash
npm version patch   # or: minor / major  → updates package.json + creates a git tag
```

### A3. Authenticate, then publish

GitHub Packages auth uses a **GitHub Personal Access Token (classic)** with the `write:packages`
scope (create it at GitHub → Settings → Developer settings → Personal access tokens). Put the token
in your **user-level** `~/.npmrc` (never the repo):

```bash
# one time — replace TOKEN with your PAT
printf '//npm.pkg.github.com/:_authToken=%s\n' "TOKEN" >> ~/.npmrc
```

Then dry-run and publish from the repo root:

```bash
npm publish --dry-run          # final contents + routing check, no upload
npm publish                    # real publish to https://npm.pkg.github.com (private)
```

- The `prepack` hook runs `pnpm run build && pnpm run verify:bundled-skills` automatically before the
  tarball is built, so a stale `dist/` or a drifted bundled-skills manifest blocks the publish.
- **CI:** set `NODE_AUTH_TOKEN` and reference it from `.npmrc`
  (`//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}`); GitHub Actions' `GITHUB_TOKEN` already has
  `packages:write` when the workflow declares that permission.

### A4. Verify the published artifact locally (before trusting it)

Install the packed tarball into a throwaway directory and smoke-test the binary:

```bash
pnpm run build && npm pack                 # writes hoangdaheo-tuberosa-<version>.tgz (scoped name)
mkdir /tmp/tuberosa-verify && cd /tmp/tuberosa-verify
npm init -y >/dev/null
npm i /path/to/tuberosa/hoangdaheo-tuberosa-<version>.tgz
npx tuberosa doctor                        # exits 0 when the install is sound (bin name stays `tuberosa`)
npx tuberosa --help                        # confirms the command surface
```

✅ `doctor` printing a checklist and exiting `0` means `dist/bin/tuberosa.js` resolves and runs
from a real install.

---

## Part B — End-user install

**First, authenticate to install the private package.** In your user-level `~/.npmrc` (one time),
map the scope to GitHub Packages and add a token with `read:packages`:

```bash
printf '@hoangdaheo:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "READ_TOKEN" >> ~/.npmrc
```

Then either install it once (recommended) and use the `tuberosa` binary, or run it via scoped `npx`:

```bash
npm i -g @hoangdaheo/tuberosa   # installs the `tuberosa` binary on PATH
tuberosa init                   # Docker present → Postgres+Redis+migrate; otherwise embedded (memory) mode
tuberosa doctor                 # verify Node, pnpm, port 3027, Postgres reachability, MCP stdout sanity
tuberosa mcp                    # run the MCP stdio server (embedded defaults: memory store + hash provider)

# …or without a global install (one-shot):
npx @hoangdaheo/tuberosa init
```

`init` is idempotent and auto-falls-back to embedded mode when Docker is absent (or pass
`--no-docker`). Embedded mode keeps everything in memory — great for trying Tuberosa, volatile
across restarts.

### B2. Skill injection (canonical mechanism)

Tuberosa bundles the **project-comprehension** skill and installs it for you:

```bash
tuberosa init --with-skills          # copies bundled skills → ./.claude/skills/<name>/SKILL.md
# (or: npx @hoangdaheo/tuberosa init --with-skills)
```

- Skills are written to a **flat** path (`.claude/skills/tuberosa-onboard-project/SKILL.md`) —
  required, because Claude Code only auto-discovers skills exactly one level under a skills root.
- Existing files are **never overwritten** (your edits are safe); delete a file to let `init`
  re-copy it.
- Restart Claude Code afterward so the Skill tool discovers the new skill.
- Manual alternative (any agent runtime): copy
  `node_modules/@hoangdaheo/tuberosa/.claude/skills/tuberosa-onboard-project/SKILL.md` into your
  project's `.claude/skills/tuberosa-onboard-project/SKILL.md` yourself.
- Override the source root with `TUBEROSA_SKILLS_SRC=/path/to/skills` if you vendor your own.

Once installed, the skill drives onboarding: `init → doctor → bootstrap --deep → review drafts`,
and keeping knowledge fresh via `sync` + `hook install`.

### B3. Register as an MCP server (local-first, zero external services)

Claude Code / Codex / Cursor read a TOML/JSON MCP block. The embedded defaults (`memory` store +
`memory` cache + `hash` provider) need no Postgres, Redis, or API key:

**TOML (Claude Code / Codex):**

```toml
[mcp_servers.tuberosa]
command = "tuberosa"            # after `npm i -g @hoangdaheo/tuberosa` (see B1)
args = ["mcp"]
env = { TUBEROSA_STORE = "memory", TUBEROSA_CACHE = "memory", TUBEROSA_MODEL_PROVIDER = "hash" }
# No global install? Use:  command = "npx", args = ["@hoangdaheo/tuberosa", "mcp"]
```

**JSON (`claude_desktop_config.json` / clients using JSON):**

```json
{
  "mcpServers": {
    "tuberosa": {
      "command": "tuberosa",
      "args": ["mcp"],
      "env": {
        "TUBEROSA_STORE": "memory",
        "TUBEROSA_CACHE": "memory",
        "TUBEROSA_MODEL_PROVIDER": "hash"
      }
    }
  }
}
```

No global install? Set `"command": "npx"` and `"args": ["@hoangdaheo/tuberosa", "mcp"]` instead
(the consumer's `~/.npmrc` must be authenticated to GitHub Packages for the `@hoangdaheo` scope).
`tuberosa mcp` already applies these defaults itself and keeps **stdout JSON-RPC-clean** (diagnostics
go to stderr), so the block above is belt-and-suspenders. `tuberosa init` prints a copy of this
snippet tailored to your setup.

### B4. Optional — full Postgres-backed stack (durable)

For persistent knowledge across restarts, run the Docker stack and point the env at it:

```bash
tuberosa init                           # writes .tuberosa/compose.yml, brings up Postgres+Redis, migrates
# then set the durable env for the MCP block:
#   TUBEROSA_STORE=postgres
#   TUBEROSA_CACHE=redis
#   DATABASE_URL=postgres://tuberosa:tuberosa@127.0.0.1:5432/tuberosa
#   REDIS_URL=redis://127.0.0.1:6379
#   TUBEROSA_MODEL_PROVIDER=hash      # still local-first; no external API
```

Stay on `hash` to remain fully offline. Switching the model provider to `ollama` or `openai`
(to turn on automatic atom extraction / the LEARN pillar) is a separate, opt-in choice — see
`docs/SETUP.md` and `.claude/skills/tuberosa-operating/SKILL.md` §6.

---

## See also

- `.claude/skills/tuberosa-onboard-project/SKILL.md` — onboard/comprehend a project into Tuberosa.
- `docs/SETUP.md` — environment + provider matrix.
- `README.md` — architecture and surfaces.
