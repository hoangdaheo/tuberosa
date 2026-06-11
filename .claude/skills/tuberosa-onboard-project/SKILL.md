---
name: tuberosa-onboard-project
description: "Use when an agent approaches an unfamiliar repo, before a non-trivial task in a project Tuberosa does not know yet, or after a large merge — to scan, understand, and persist a project's knowledge into Tuberosa and keep it fresh. This is the Tuberosa analog of 'gitnexus analyze'. Examples: \"Onboard this repo into Tuberosa\", \"Comprehend this codebase\", \"Tuberosa doesn't know this project yet\", \"Re-sync Tuberosa after the merge\"."
---

# Tuberosa: Onboard & Comprehend a Project

This skill teaches you to load a project's knowledge **into** Tuberosa so future agents (and you) get a useful context pack instead of a cold start. It **reuses the existing engine** — `tuberosa` CLI commands and `tuberosa_*` MCP tools. You never re-implement ingestion, atlas, or sync.

> Related: [`tuberosa-guide`](../tuberosa-guide/SKILL.md) (what Tuberosa is, FIND vs LEARN), [`tuberosa-agent-loop`](../tuberosa-agent-loop/SKILL.md) (consuming knowledge during a task), [`tuberosa-operating`](../tuberosa-operating/SKILL.md) (human review of drafts).

## Local-first — no external APIs

This whole flow runs **offline** with the deterministic `hash` provider. No OpenAI key, no network.

| Pin this | Value |
| --- | --- |
| `TUBEROSA_MODEL_PROVIDER` | `hash` |
| `TUBEROSA_STORE` | `postgres` (full) or `memory` (embedded/try-out) |
| `TUBEROSA_CACHE` | `redis` (full) or `memory` (embedded) |

⚠️ **One honest limit:** under `hash`, the **LEARN** pillar's *automatic* atom extraction is OFF (see [`tuberosa-guide`](../tuberosa-guide/SKILL.md)). Everything in this skill still works under `hash`, because comprehension here is **FIND-side ingestion + atlas + human-reviewed drafts**, not auto-extraction. Turning on auto-extraction needs a real model (`ollama`/`openai`) — that is a separate choice documented in [`tuberosa-operating`](../tuberosa-operating/SKILL.md) §6.

## C. When to run this skill — and which path

Decide A vs B first:

| Situation | Path |
| --- | --- |
| Tuberosa has **no** knowledge for this project (cold start, first approach to an unfamiliar repo) | **A. Onboard** |
| You're about to start a non-trivial task and a Tuberosa session returned `fitStatus: insufficient` / `handbook.exists: false` | **A. Onboard** (then proceed) |
| Project is already onboarded but **code changed** (you finished a feature, or just pulled a large merge) | **B. Update** |
| Same project, every commit, hands-off | **B. Update** → install the git hook once |

Quick signal: run a throwaway `tuberosa_start_session`. If `context.handbook.exists` is `false` and `contextFit.fitStatus` is `insufficient`, the project is cold → **Path A**.

---

## A. Onboard a new project (first approach)

### A1. Make sure the local stack is up

```bash
npx tuberosa init      # Requires Docker → Postgres+Redis+migrate. No Docker → fails with install guidance.
npx tuberosa doctor    # Verify Node ≥22.13, pnpm, port, Postgres reachability, MCP stdout sanity.
```

- `init` is idempotent and **requires Docker** — without it, init exits non-zero with install guidance. Volatile **embedded trial mode** (memory store) is an explicit opt-in via `npx tuberosa init --embedded` — fine for trying Tuberosa, not for durable onboarding. (`--no-docker` is deprecated; use `--embedded`.)
- ✅ Proceed when `doctor` shows no `✗ fail` lines.

### A2. Seed knowledge deterministically

```bash
npx tuberosa bootstrap --project <name> --deep
```

This single command does, in order:

1. **Sync (additive only)** — discovers/ingests source + docs. Bootstrap **never archives** anything (deletions are deferred, not applied).
2. **Deep graph enrichment** (`--deep`) — co-change edge inference + atom graph-density snapshot.
3. **Atlas** — writes `project-map.md`, `flows.md`, `commands.md`, `risks.md`, `open-gaps.md`, `conventions.md` to `.tuberosa/atlas/`.
4. **Convention signals** — counts candidate signals (detected tech + recurring hints). It only *prepares*; distillation is an agent step (A4).
5. **Health summary** + a **Next actions** list. Read that list — it tells you exactly what to do next.

Useful flags (all real): `--path <repo>` (root, defaults to cwd), `--export` (emit a portable bundle), `--no-conventions` (skip signal prep), `--out <dir>`, `--json`.

### A3. Comprehension pass — go BEYOND file ingestion

`bootstrap` ingested the raw files. Your job now is to add the **understanding** the files don't state outright: the project's **goal, core logic, and per-feature behavior**. Read the atlas first so you don't repeat it:

```
tuberosa_get_atlas  project=<name>          # returns the six atlas docs in-memory
```

Then write back **summaries, not code**. Use `tuberosa_reflect` to create review-gated knowledge drafts:

| Write this | itemType | What goes in it |
| --- | --- | --- |
| **Project goal / positioning** — 1 atom | `wiki` | What the project is for, who uses it, the one-sentence purpose. |
| **Architecture map** — 1 atom | `wiki` | The major subsystems and how they connect. Reference real files by path; do **not** paste code bodies. |
| **Per-feature summary** — 1 atom per significant feature | `wiki` | What the feature does, its entry points (file paths), and its key invariant. One atom per feature. |
| **A gotcha / decision worth keeping** | `memory` or `bugfix` | Only if you genuinely discovered one while reading. |

Rules that keep the base sharp:

- ❌ **Never paste raw code** that `sync` already ingested — link to it via `references: [{ type: "file", uri: "src/…" }]` instead. Duplicated code is noise.
- ✅ One atom = one idea. A feature summary is a paragraph + file pointers, not a file dump.
- ✅ Set `triggerType: "manual"` and `project: <name>` on each `tuberosa_reflect` call.
- These drafts are **review-gated** — they land pending, not active. That is by design (A4).

For project **conventions** specifically, use the deterministic helper instead of guessing:

```
tuberosa_bootstrap_handbook  project=<name>
```

It returns repo evidence (detected tech, scripts, recurring hints, README/CONTRIBUTING excerpts) **plus an instruction** telling you to propose one convention per recurring hint via `tuberosa_reflect` with `metadata: { convention: true, curationSource: "bootstrap", scope: "project"|"team", … }`. Follow that instruction verbatim. (Expected: bootstrap convention drafts trip the "needs ≥2 source atoms" gate — that blocker is normal here; a human approves them on review.)

### A4. Review drafts before they become trusted

Everything you proposed is a **draft**. A human (or you, acting as reviewer) confirms it:

```
tuberosa_list_reflection_drafts            # see pending drafts
tuberosa_get_reflection_draft   id=<id>    # inspect accuracy / scope / privacy
tuberosa_review_reflection_draft id=<id> decision=approve|reject|needs_changes
```

✅ Approved drafts become searchable knowledge for the next agent. ❌ Rejected drafts stop being suggested. (Full human runbook: [`tuberosa-operating`](../tuberosa-operating/SKILL.md) §2.)

### A5. Verify the onboarding took

Start a real session and confirm the cold start is gone:

```
tuberosa_start_session  project=<name>  contextMode=layered  …
```

✅ `contextFit.fitStatus` should improve toward `ready` and `handbook.exists` should be `true` once conventions are approved.

---

## B. Update an already-onboarded project (code changed)

### B1. Plan the sync (dry-run first)

```bash
npx tuberosa sync --project <name>         # dry-run: prints added/changed/renamed/deleted counts
```

Or via MCP: `tuberosa_sync_sources project=<name>` returns a `planId` + `plan`.

### B2. Apply additively; surface deletions for human confirm

```bash
npx tuberosa sync --project <name> --apply         # applies ADDITIVE ops; archives are deferred
npx tuberosa sync --project <name> --apply --yes   # also archives knowledge for DELETED files
```

- Additive changes (new/changed/renamed files) apply immediately.
- **Destructive archiving (deleted files) requires `--yes`.** Without it, deletions are queued to `.tuberosa/pending-sync.json` — never silently dropped. ⚠️ Always show a human the deletion list before passing `--yes`.
- After a meaningful update, re-run A3 for any **new** feature (one new `wiki` atom), and `tuberosa_get_atlas` to refresh your mental model. Don't re-summarize unchanged features.

### B3. Make updates automatic

```bash
npx tuberosa hook install --project <name>
```

Writes `post-commit` + `post-merge` git hooks that run an **additive-only** sync on every commit/merge (deletions stay deferred to `.tuberosa/pending-sync.json` for review). This is the "keep it fresh" step — install it once per onboarded repo.

---

## The loop, at a glance

```
cold? ── A ── init → doctor → bootstrap --deep → (read atlas) → reflect summaries + handbook conventions → review drafts → verify
                                                                                                                         │
changed? ─ B ── sync (dry-run) → sync --apply [--yes for deletes] → refresh atlas / new-feature atoms → hook install ───┘
```

## Reuse, don't reinvent

| Need | Use (already exists) |
| --- | --- |
| Stand up stack | `npx tuberosa init` / `doctor` |
| Seed knowledge | `npx tuberosa bootstrap --deep` |
| Ingest changes | `npx tuberosa sync` / `tuberosa_sync_sources` |
| Auto-refresh | `npx tuberosa hook install` |
| Read overview | `tuberosa_get_atlas` |
| Convention evidence | `tuberosa_bootstrap_handbook` |
| Write understanding | `tuberosa_reflect` (drafts) |
| Approve knowledge | `tuberosa_list/get/review_reflection_draft` |

If you think a genuinely new command is missing (e.g. a one-shot `tuberosa comprehend`), do **not** bolt it on. Propose it to the Tuberosa maintainers instead — workarounds layered on top of the CLI tend to rot.
