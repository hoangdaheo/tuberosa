# Spec C — End-User Usage Skill + Script Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fifth bundled skill `tuberosa-using` (the end-user agent's "I want to X" → command/tool map) and add a dev-vs-operator script classification to `docs/INSTALL.md`. Docs-only — `package.json` scripts are untouched.

**Architecture:** The bundled-skills manifest (`.claude/skills/bundled-skills.json`) is the single source of truth; `scripts/verify-bundled-skills.ts` is the prepack gate that forces manifest ↔ `package.json` `files` ↔ on-disk parity AND greps every shipped SKILL.md for consumer-unsafe literals. We drive the work gate-first: add the manifest entry, watch the gate fail with named errors, then create the skill + `files` entry to turn it green.

**Tech Stack:** Markdown skill files (superpowers frontmatter conventions), the existing `verify:bundled-skills` tsx gate, conventional commits. No production code changes.

**Source spec:** `docs/superpowers/specs/2026-06-10-full-featured-enduser-design.md` § Spec C (lines 160–185).

---

## Locked-in decisions (do not re-litigate mid-task)

### D1. Consumer-safety wording strategy

The gate (`scripts/verify-bundled-skills.ts:54-58`) FAILS any shipped SKILL.md containing these literal patterns:

| Forbidden pattern | Gate label | Replacement wording used in this plan |
| --- | --- | --- |
| `docs/` | repo-internal docs/ path | "the install guide in the Tuberosa repository" / omit entirely |
| `pnpm run` | contributor-only pnpm script | name scripts bare in backticks ("the `backup` script") + one sentence saying they run "from a Tuberosa source checkout with the repo's script runner" |
| `eval/` (lookbehind-guarded) | repo-internal eval/ path | script names like `eval:retrieval` are SAFE (colon, no slash); never write the directory path |

Do NOT dodge the gate with `pnpm backup` (no `run`) — it would pass the grep but violate the gate's intent. The bare-backtick-script-name strategy is the decided wording.

`docs/INSTALL.md` is NOT gated (the grep only runs on manifest-listed SKILL.md files), so the INSTALL.md section may use `pnpm run` freely.

### D2. Facts the skill must state correctly (review of Specs A/B fixed 6 factual errors in the other skills — do not reintroduce them)

1. `init` is **Docker-required**; `--embedded` is the volatile trial-mode opt-in (memory only, data lost on exit).
2. `init` writes `.mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml` by default (`--no-mcp-config` opts out) and copies all bundled skills by default (`--no-skills` opts out).
3. LEARN / atom extraction is **OFF** under both `hash` and the default `local` provider — it needs `openai` or `ollama`. FIND works on all providers.
4. Sync is two-step plan→apply (CLI: `sync` then `sync --apply`; archiving additionally needs `--yes`).
5. `contextFit.fitStatus` values are exactly `ready` / `needs_confirmation` / `insufficient`.
6. The seven script-only operator tasks are: `backup`, `restore`, `error-logs`, `context-quality`, `organization`, `export-pack`, `import-pack`. Four tasks from older lists already have CLI commands — do not list them here.

### D3. File structure

| File | Action | Responsibility |
| --- | --- | --- |
| `.claude/skills/tuberosa-using/SKILL.md` | Create | The end-user usage skill (full content in Task 1, Step 3) |
| `.claude/skills/bundled-skills.json` | Modify | Add the `tuberosa-using` manifest entry |
| `package.json` | Modify | Add `.claude/skills/tuberosa-using/` to `files` (line 45 area). **Scripts untouched.** |
| `docs/INSTALL.md` | Modify | New "Script triage" section before "See also" |

### D4. Environment

Prefix every node/pnpm command: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH`. Work on branch `feat/spec-c-using-skill`. Conventional commits, **never** add `Co-Authored-By` trailers.

---

### Task 1: Register and create the `tuberosa-using` skill (gate-first)

**Files:**
- Modify: `.claude/skills/bundled-skills.json`
- Create: `.claude/skills/tuberosa-using/SKILL.md`
- Modify: `package.json` (the `files` array only)
- Gate: `scripts/verify-bundled-skills.ts` (read-only — this is the test)

- [ ] **Step 1: Add the manifest entry (the "failing test")**

Replace the full contents of `.claude/skills/bundled-skills.json` with:

```json
{
  "skills": [
    { "name": "tuberosa-onboard-project", "files": ["SKILL.md"] },
    { "name": "tuberosa-guide", "files": ["SKILL.md"] },
    { "name": "tuberosa-agent-loop", "files": ["SKILL.md"] },
    { "name": "tuberosa-operating", "files": ["SKILL.md"] },
    { "name": "tuberosa-using", "files": ["SKILL.md"] }
  ]
}
```

- [ ] **Step 2: Run the gate to verify it fails for the right reasons**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run verify:bundled-skills
```
Expected: exit 1 with BOTH errors:
```
Bundled-skills verification FAILED:
  - manifest lists ".claude/skills/tuberosa-using/" but package.json "files" does not ship it
  - manifest references a missing file: .claude/skills/tuberosa-using/SKILL.md
```
(Order may differ. If it passes or fails differently, STOP — the gate or manifest edit is wrong.)

- [ ] **Step 3: Create the skill file**

Create `.claude/skills/tuberosa-using/SKILL.md` with exactly this content:

````markdown
---
name: tuberosa-using
description: "Use when working in a project that has Tuberosa installed and you need to know which command or tool does what: the daily session loop, the install lifecycle, operator maintenance tasks, or which repo scripts to ignore. Examples: \"How do I use Tuberosa day to day?\", \"When do I run calibrate-fusion?\""
---

# Using Tuberosa

This skill is the map of Tuberosa for an end user. It answers one question: **"I want to X — what do I run?"** Four sections: the daily tool loop, the lifecycle commands, the maintenance tasks that still need a Tuberosa source checkout, and the contributor scripts you never run.

## 1. The daily loop — "I want to X" → tool

These are MCP tools. Your agent calls them while working; you never type them in a shell.

| I want to… | Call this |
| --- | --- |
| Start a non-trivial coding task | `tuberosa_start_session` — pass `project`, `cwd`, the user's prompt, `contextMode: "layered"`, `noiseTolerance: "strict"`, `includeDeepContext: true` |
| Search project knowledge without opening a session | `tuberosa_search_context` |
| Read the full chunks behind a slim session reply | `tuberosa_get_context_pack` with the `contextPackId` |
| Tell Tuberosa whether the pack helped — **before** substantive work | `tuberosa_record_context_decision` (`selected`, `selected_but_noisy`, `rejected`, `stale`, `missing_context`, …) |
| End the task so Tuberosa can learn from it | `tuberosa_finish_session` with `outcome` + `summary` |

Always read `contextFit.fitStatus` before trusting a pack:

| Status | Meaning | What you do |
| --- | --- | --- |
| `ready` ✅ | strong match | proceed |
| `needs_confirmation` ⚠️ | partial match | confirm against real files first |
| `insufficient` ❌ | weak or no match | work from repo evidence, not the pack |

For the full step-by-step loop, read [`tuberosa-agent-loop`](../tuberosa-agent-loop/SKILL.md).

## 2. Lifecycle — CLI commands in the order you meet them

| When | Run | What it does |
| --- | --- | --- |
| Once per project | `npx tuberosa init` | Brings up the full local stack: Docker Postgres + Redis, migrations, embedding-model warm-up. **Docker is required** — `--embedded` opts into volatile trial mode instead (everything in memory, data lost on exit). Also writes agent MCP configs (`.mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml`; skip with `--no-mcp-config`) and copies all bundled skills into `./.claude/skills/` (skip with `--no-skills`). |
| Once per editor / agent | `npx tuberosa mcp install` | Re-writes the agent MCP config files on demand. Merge-only: it never clobbers other servers already in a config. |
| First onboard of a project | `npx tuberosa bootstrap` | First-run project knowledge: additive sync + atlas + health summary (`--deep` for a deeper pass). |
| Keeping knowledge fresh | `npx tuberosa sync`, then `npx tuberosa sync --apply` | Two-step on purpose: the first call shows the plan, `--apply` executes it (destructive archiving also needs `--yes`). `npx tuberosa hook install` adds a git hook for additive-only auto-sync. |
| When something breaks | `npx tuberosa doctor` | Checks Node, pnpm, Docker, port 3027, Postgres reachability, and MCP stdout sanity. |

One expectation to set: the LEARN pillar (turning finished sessions into reusable memory) needs an LLM provider — `openai` or `ollama`. It stays **off** under the default `local` provider and under `hash`. FIND (retrieval) works on all providers.

## 3. Operator tasks that are script-only today

These seven maintenance tasks have **no CLI subcommand yet** (promoting them to `tuberosa <cmd>` is explicitly future work). Each runs **from a Tuberosa source checkout** with the repo's script runner — they do not exist inside your consumer project.

| Script | What it does (one line) |
| --- | --- |
| `backup` | Snapshot the knowledge store to a backup directory and report backup health. |
| `restore` | Restore the knowledge store from a chosen backup. |
| `error-logs` | List and inspect error logs recorded by agents. |
| `context-quality` | Report on context-quality feedback collected from agent sessions. |
| `organization` | Review and apply knowledge organization (curation) proposals. |
| `export-pack` | Export one project's knowledge as a portable pack file. |
| `import-pack` | Import a previously exported pack file. |

Some have MCP tool equivalents your agent can call without a checkout: `tuberosa_export_pack`, `tuberosa_import_pack`, `tuberosa_list_error_logs`, `tuberosa_collect_context_quality_feedback`.

## 4. Everything else is contributor tooling — you never run these

Every other script in the Tuberosa repo gates development **of Tuberosa itself**. If you are using Tuberosa (not building it), you never run them:

| Group | Examples | Why you can ignore them |
| --- | --- | --- |
| Quality evals | `eval:retrieval`, `eval:agent-context`, `eval:safety`, `eval:knowledge-completeness` | Regression gates for Tuberosa's own retrieval quality. |
| Tuning & benchmarks | `sandbox`, `sandbox:ablate`, `calibrate-fusion`, `benchmark` | Re-tune fusion weights from synthetic corpora. The answer to "when do I run `calibrate-fusion`?" is **never**. |
| Data & graph maintenance | `reembed`, `seed:self`, `backfill:domains`, `archival-sweep`, `infer-co-change`, `prune-stale-edges`, `cluster-user-corrections`, `migrate-knowledge-to-atoms`, `import:docs` | One-off migrations and graph upkeep for Tuberosa's own store. |
| Build & CI | `build`, `test`, `test:integration`, `verify:bundled-skills` | CI for the Tuberosa codebase. |

## See also

- [`tuberosa-agent-loop`](../tuberosa-agent-loop/SKILL.md) — the session loop, step by step.
- [`tuberosa-guide`](../tuberosa-guide/SKILL.md) — what Tuberosa is; FIND vs LEARN; the full tool map.
- [`tuberosa-onboard-project`](../tuberosa-onboard-project/SKILL.md) — onboard a repo into Tuberosa.
- [`tuberosa-operating`](../tuberosa-operating/SKILL.md) — operate Tuberosa as a human (ingest, review, curate).
````

- [ ] **Step 4: Add the package.json `files` entry**

In `package.json`, change the `files` array (no other changes — scripts stay untouched):

```json
  "files": [
    "dist/",
    "bin/",
    ".env.example",
    "migrations/",
    ".claude/skills/bundled-skills.json",
    ".claude/skills/tuberosa-onboard-project/",
    ".claude/skills/tuberosa-guide/",
    ".claude/skills/tuberosa-agent-loop/",
    ".claude/skills/tuberosa-operating/",
    ".claude/skills/tuberosa-using/"
  ],
```

- [ ] **Step 5: Run the gate to verify it passes**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run verify:bundled-skills
```
Expected: exit 0 with:
```
Bundled-skills OK: 5 skill(s), 5 file(s) shipped.
```

- [ ] **Step 6: Belt-and-braces forbidden-literal scan on the new file**

Run:
```bash
grep -nE 'docs/|pnpm run|(^|[^a-zA-Z])eval/' .claude/skills/tuberosa-using/SKILL.md; echo "exit=$?"
```
Expected: no match lines, `exit=1` (grep found nothing). If anything matches, fix the wording per decision D1 and re-run Steps 5–6.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/tuberosa-using/SKILL.md .claude/skills/bundled-skills.json package.json
git commit -m "docs(skills): add tuberosa-using end-user usage skill (Spec C)"
```

---

### Task 2: Script triage section in docs/INSTALL.md

**Files:**
- Modify: `docs/INSTALL.md` (insert a new section between "### B4. Volatile trial mode" and "## See also", i.e. after line 161)

- [ ] **Step 1: Insert the new section**

Immediately after the B4 paragraph ending "…see `docs/SETUP.md` and `.claude/skills/tuberosa-operating/SKILL.md` §6." and before `## See also`, insert:

```markdown
---

## Part C — Script triage: who runs what

`package.json` has ~40 scripts with no audience signal. They fall into three buckets — and end users
need **none** of them, because the `npx tuberosa` CLI covers the whole consumer surface. The scripts
themselves are deliberately untouched: renaming or regrouping them would churn CI and contributor
muscle memory for zero end-user gain.

| Audience | Scripts | Notes |
| --- | --- | --- |
| **End user (consumer project)** | _none_ | Use the CLI instead: `npx tuberosa init / doctor / mcp / mcp install / bootstrap / sync / hook install`. |
| **Operator (requires this repo checked out)** | `backup`, `restore`, `error-logs`, `context-quality`, `organization`, `export-pack`, `import-pack` | Maintenance tasks with no CLI subcommand yet (promotion to `tuberosa <cmd>` is future work). Run as `pnpm run <script>` from the repo root. Several have MCP tool equivalents (`tuberosa_export_pack`, `tuberosa_import_pack`, `tuberosa_list_error_logs`, `tuberosa_collect_context_quality_feedback`). |
| **Contributor (Tuberosa development only)** | Everything else: `eval:*`, `sandbox`, `sandbox:ablate`, `calibrate-fusion`, `benchmark`, `reembed`, `seed:self`, `backfill:domains`, `archival-sweep`, `infer-co-change`, `prune-stale-edges`, `cluster-user-corrections`, `migrate-knowledge-to-atoms`, `import:docs`, `build`, `test`, `test:integration`, `verify:bundled-skills`, `migrate`, `dev`, `start`, `worker`, `mcp` | These gate development of Tuberosa itself. If you are not changing Tuberosa's code, you never run them. |

The same classification ships to end users as the `tuberosa-using` bundled skill
(`.claude/skills/tuberosa-using/SKILL.md`), installed by `npx tuberosa init` alongside the other skills.
```

- [ ] **Step 2: Update the stale "4 skills" implications in INSTALL.md prose (verification read)**

Read `docs/INSTALL.md` end to end once. The B2 section speaks generically ("copies all bundled agent skills") — confirm no sentence hard-codes a skill count of 4. If one does, update it to name the manifest as the source of truth rather than a number.

- [ ] **Step 3: Run the gate (must still pass — INSTALL.md is not gated, this catches accidental SKILL.md edits)**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run verify:bundled-skills
```
Expected: `Bundled-skills OK: 5 skill(s), 5 file(s) shipped.`

- [ ] **Step 4: Commit**

```bash
git add docs/INSTALL.md
git commit -m "docs(install): classify package scripts by audience (Spec C script triage)"
```

---

### Task 3: Full gate set + live init smoke

**Files:** none modified — verification only.

- [ ] **Step 1: Build + unit tests**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```
Expected: build exits 0; all unit tests pass (879 at last green main; any new count is fine as long as fail=0). Known flake: `test/invariants.test.ts` "mcp-stdio writes only JSON-RPC frames" once flaked under parallel load — if it fails, re-run once before investigating; if it flakes again, widen its deadline the same way commit 61d447f did (do NOT weaken the assertion).

- [ ] **Step 2: Retrieval + agent-context evals (NEVER edit fixtures/thresholds to pass)**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
```
Expected: eval:retrieval 26/26 green; eval:agent-context pass. These should be untouched by a docs-only change — any regression means something else broke; STOP and investigate.

- [ ] **Step 3: Bundled-skills gate + pack dry-run**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run verify:bundled-skills
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH npm pack --dry-run 2>&1 | grep tuberosa-using
```
Expected: `Bundled-skills OK: 5 skill(s), 5 file(s) shipped.` and the dry-run tarball listing contains `.claude/skills/tuberosa-using/SKILL.md`.

- [ ] **Step 4: Integration tests (Docker-gated)**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
```
Expected: 5/5 pass (or explicit skip message if the Docker stack is down — bring it up with `docker compose up -d` first if needed).

- [ ] **Step 5: Live foreign-directory init smoke — the new skill must copy**

`init` copies skills before the embedded-mode branch (`bin/commands/init.ts:44-52`), so `--embedded` avoids the Docker requirement without changing what we're testing:

```bash
rm -rf /tmp/spec-c-smoke && mkdir -p /tmp/spec-c-smoke && cd /tmp/spec-c-smoke
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH npx tsx /home/nash/tuberosa/bin/tuberosa.ts init --embedded --no-mcp-config
ls /tmp/spec-c-smoke/.claude/skills/
test -f /tmp/spec-c-smoke/.claude/skills/tuberosa-using/SKILL.md && echo "SMOKE OK"
```
Expected: init reports `Installed 5 skill(s)`; `ls` shows all 5 skill dirs including `tuberosa-using`; final line prints `SMOKE OK`. Clean up with `rm -rf /tmp/spec-c-smoke` afterward.

- [ ] **Step 6: Working tree clean check**

```bash
git -C /home/nash/tuberosa status --porcelain
```
Expected: empty (only the plan file itself may appear if not yet committed — commit it as `docs(plans): add Spec C implementation plan` if so).

---

## Self-review (done at plan-writing time)

- **Spec coverage:** C.2.1 items 1–4 → SKILL.md sections 1–4 (Task 1 Step 3). C.2.2 → Task 2. C.3 (`verify:bundled-skills` parity + consumer-safety grep) → Task 1 Steps 2/5/6 and Task 3 Step 3. ✅
- **Placeholder scan:** all file contents are written out in full; all commands have expected outputs. ✅
- **Forbidden-literal audit of the SKILL.md content in Task 1 Step 3:** no `docs/`, no `pnpm run`, `eval:` names carry colons not slashes, links use `../<skill>/SKILL.md` relative form like the existing skills. ✅
- **Fact audit vs D2:** Docker-required init ✅, MCP-config + skills defaults with opt-out flags ✅, LEARN off under local+hash ✅, two-step sync ✅, three contextFit statuses ✅, exactly 7 operator scripts ✅.
