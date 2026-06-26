---
description: Explore this codebase and (re)generate the CLAUDE.md doc set so any new session starts as a senior engineer already familiar with the project.
---

<!--
  INSTALL: copy this file to `.claude/commands/analyze-project.md` in your repo.
  Then run it from a session with `/analyze-project` (optionally `/analyze-project <focus area>`).
  It also works as a plain prompt — just paste the body below into a fresh session.
-->

# Analyze & document this project

You are a **staff-level engineer onboarding yourself to this codebase.** Explore it thoroughly,
then produce (or refresh) a set of memory docs so that any *future* session can act as a senior
engineer who already knows this project — without re-exploring from scratch.

Optional focus from the caller: **$ARGUMENTS**
(If provided, go deeper there — but still produce the complete doc set below.)

## Operating principles

- **Ground every claim in the code.** Cite real paths (e.g. `src/server/router.ts`) and real
  commands found in config files. Never invent structure, scripts, env vars, or behavior.
- **Mark uncertainty.** If something can't be determined from the repo, write
  `> TODO: unverified — {what to check}` instead of guessing.
- **Keep CLAUDE.md lean** (aim < ~150 lines). It loads into *every* session, so depth goes in
  `docs/` and is linked, not pasted. Don't bloat it.
- **Be idempotent.** If these docs already exist, update them in place, preserve hand-written
  notes, and don't duplicate sections. Note what changed.
- **Prefer breadth.** Read many files briefly over a few files deeply.

## Phase 1 — Survey (read, do not write yet)

Work outward from the entry points and take notes:

1. **Manifests & config** — read `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` /
   `pom.xml`, lockfiles, `Makefile`, `Dockerfile`, `docker-compose*`, CI in `.github/`,
   `.env.example`, and tsconfig/eslint/prettier/ruff configs. Capture the **real**
   install / dev / test / lint / build commands.
2. **Directory tree** — map the top 2–3 levels. Identify entry points (server bootstrap,
   app shell, CLI root, `main`/`index`).
3. **Stack** — languages, frameworks, runtime versions, datastores, queues, external services.
4. **Trace 1–2 end-to-end flows** — e.g. an HTTP request from route → middleware → handler →
   service → data layer → response; or a CLI command from parse → execute.
5. **Tests** — skim them to learn intended behavior and conventions.
6. **Existing docs** — README(s), `docs/`, ADRs, comments that explain "why".

## Phase 2 — Write the doc set

Create/update these files (create `docs/` and `.claude/commands/` if missing). Use the section
structures already present in each template file; omit a section only if it genuinely doesn't
apply, and say why.

- **`CLAUDE.md`** (lean, always-loaded): role line ("senior engineer on {project}, already
  familiar with it"), 2–4 sentence description, stack one-liners, short repo map, daily
  commands, project-specific **golden rules** (the non-obvious things that prevent mistakes),
  and links to the `docs/` files with a note to read them on demand (do **not** `@import` them
  all — that defeats the lean-context goal).
- **`docs/ARCHITECTURE.md`**: system overview; component/module breakdown with paths &
  responsibilities; **data flow** (include a Mermaid diagram); data model & storage; external
  integrations; key abstractions; cross-cutting concerns (auth, config, caching, jobs,
  observability); runtime & deployment topology.
- **`docs/FEATURES.md`**: feature inventory; core user flows step-by-step with the code paths
  that implement them; domain model & business rules; a **glossary** of domain terms; important
  invariants and edge cases.
- **`docs/CONVENTIONS.md`**: formatting/linting; naming; structural conventions; patterns to
  follow and anti-patterns to avoid (with real examples from the repo); testing strategy;
  error handling, logging, config; git/PR conventions; and a **"How to add a new
  {endpoint/component/feature}"** cookbook derived from how existing ones are built.
- **`docs/SETUP.md`**: prerequisites & versions; install steps; env vars & secrets (described
  from `.env.example` — never copy real secret values); how to run locally; backing services
  (db/queue/cache) and how to start them; seeding; build; deploy/CI; and a **Gotchas /
  footguns** section.

## Phase 3 — Verify (do this before finishing)

- Re-read each file you wrote. Confirm **every command and path actually exists** in the repo.
- Confirm the `CLAUDE.md` links resolve and the file stayed lean.
- In your final reply, report: what you created/updated, anything left as `TODO: unverified`,
  and the top few things you'd confirm with the team.

## Phase 4 — Suggest keeping it fresh

Remind the user (once) that these docs drift. Offer to:
- update the relevant doc whenever a change makes it stale, and/or
- re-run `/analyze-project` after large refactors.
