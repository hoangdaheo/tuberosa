# Tuberosa

**Tuberosa is a memory + librarian for your AI coding assistant.**

When you use a coding agent (Claude Code, Codex, Copilot, Cursor…), it starts every task knowing *nothing* about your specific project. Tuberosa fixes that. It sits between the agent and your project's knowledge, and does two jobs:

1. **FIND** — when the agent starts a task, Tuberosa hands it the *right* notes for that task (the files, rules, and past lessons that matter), not the whole codebase.
2. **LEARN** — after the agent finishes, Tuberosa can save what it learned (reviewed by a human first) so the *next* agent doesn't repeat the same mistake.

> **Analogy:** Think of a new contractor showing up at a job site every single morning with total amnesia. Tuberosa is the site foreman who, each morning, hands them exactly the right blueprints for today's job — and writes down what went wrong yesterday so tomorrow's crew doesn't trip over it again.

It's **local-first**: by default it runs entirely on your machine with zero external API calls and no API key.

---

## Table of contents

- [The problem, in one picture](#the-problem-in-one-picture)
- [The two jobs: FIND and LEARN](#the-two-jobs-find-and-learn)
- [Quick start](#quick-start)
- [Core concepts (the vocabulary)](#core-concepts-the-vocabulary)
- [How FIND works (the retrieval pipeline)](#how-find-works-the-retrieval-pipeline)
- [A full end-to-end example](#a-full-end-to-end-example)
- [How LEARN works (sessions → reviewed memory)](#how-learn-works-sessions--reviewed-memory)
- [The `tuberosa` CLI](#the-tuberosa-cli)
- [Connecting an agent (MCP)](#connecting-an-agent-mcp)
- [Configuration](#configuration)
- [HTTP API (summary)](#http-api-summary)
- [Everyday commands](#everyday-commands)
- [Quality gates (evals)](#quality-gates-evals)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Where to read next](#where-to-read-next)

---

## The problem, in one picture

Without Tuberosa, the agent either knows too little or you paste too much:

```
  ❌ Without a context broker

  You: "Fix the paywall bug"
   │
   ▼
  Agent: greps the whole repo, guesses, re-asks questions you already answered,
         re-introduces a bug a teammate fixed last week.
```

With Tuberosa, the agent asks one question first — *"what do I need to know for this?"* — and gets a short, ranked answer:

```
  ✅ With Tuberosa

  You: "Fix the paywall bug"
   │
   ▼
  Agent ──ask──▶ Tuberosa ──ranked context pack──▶ Agent
                    │
                    ├─ "PaywallSelectionModal lives in src/components/paywall-selection-modal.tsx"
                    ├─ "It must preserve selected product ids across edits" (a saved lesson)
                    └─ "Run pnpm run eval:retrieval before touching fusion weights"
```

Here is the whole system at a glance:

```
 ┌──────────┐   "what do I need to know?"   ┌──────────────────────────────┐
 │  Agent   │ ────────────────────────────▶ │  Tuberosa                    │
 │ (Claude, │                               │   ├─ MCP stdio  (for agents) │
 │  Codex,  │ ◀──── ranked context pack ─── │   └─ HTTP API   :3027        │
 │  Cursor) │                               └───────────────┬──────────────┘
 └──────────┘                                               │
                                       ┌───────────────────┼───────────────────┐
                                       ▼                    ▼                   ▼
                              Postgres + pgvector         Redis        .tuberosa/current/
                              (the real memory)          (cache)       (human-readable mirror)
```

- **Postgres + pgvector** is the source of truth (the actual knowledge, embeddings, and links between facts).
- **Redis** is a short-lived cache so repeated questions are fast.
- **`.tuberosa/current/`** is an *optional*, one-way Markdown export so a human can read what Tuberosa knows. (It is never read back into the database.)

---

## The two jobs: FIND and LEARN

Tuberosa has exactly two pillars. Everything else supports one of them.

| Pillar | What it does | Analogy | Main entry point |
|---|---|---|---|
| **FIND** | Retrieve the right knowledge for the task right now | The librarian who hands you the 3 books you need | `tuberosa_search_context` |
| **LEARN** | Turn a finished task into a reviewed lesson for next time | The notebook of "things we learned the hard way" | `tuberosa_start_session` → `tuberosa_finish_session` |

> **Important nuance:** LEARN only *automatically extracts* new lessons when a generation-capable model provider (`ollama` or `openai`) is turned on. With the default `local` provider (real embeddings, no API key) and with `hash`, FIND works fully and you can still record lessons manually — but automatic lesson extraction is off. (See [Configuration](#configuration).)

---

## Quick start

You need **Node 22+** and **pnpm 11+**. Three commands get you running:

```bash
npx tuberosa init          # set up the local stack (Docker required; --embedded for a volatile trial)
npx tuberosa setup-models  # download + verify the local embedding model and cross-encoder (real search, no API key)
npx tuberosa doctor        # health check: Node / pnpm / Docker / port / Postgres / MCP / local models
npx tuberosa mcp           # run the MCP server an agent talks to (full stack by default)
```

What each one does, in plain words:

- **`init`** — gets you ready. **Docker is required.** It writes `.tuberosa/compose.yml`, starts Postgres + Redis, waits for them to be healthy, runs the database migrations, warms up the local embedding model, and copies `.env.example → .env`. It also:
  - writes agent MCP configs — `.mcp.json`, `.cursor/mcp.json`, and `~/.codex/config.toml` (Codex only when `~/.codex/` exists). Skip with `--no-mcp-config`.
  - copies the 5 bundled agent skills into `.claude/skills/`. Skip with `--no-skills`.

  No Docker? init **fails with install guidance**. For a quick look without Docker, `npx tuberosa init --embedded` runs the volatile trial mode (memory store, hash embeddings, data lost on exit). Safe to run again — it never overwrites what's already there.
- **`setup-models`** — downloads the local embedding model (`Xenova/bge-small-en-v1.5`) and the cross-encoder reranker (`onnx-community/bge-reranker-v2-m3-ONNX`) to `~/.cache/tuberosa/models`, then loads each one to prove it works. This is what makes search *real* instead of fake. Skip it only for the `hash` trial mode.
- **`doctor`** — tells you *why* something is broken before you waste time guessing. It now also checks that the local models exist (`--deep` actually loads them).
- **`mcp`** — starts the server your agent connects to. It defaults to the **full stack** (Postgres + Redis + local embeddings), matching what `init` provisioned. Add `--embedded` for the zero-dependency volatile trial stack.

> **🔒 No silent fake search (new).** Tuberosa uses a deterministic `hash` provider for tests — fast, but its "search" is meaningless. As of the local-first backbone, the real-world server **refuses to start** rather than silently serve hash results: under the default `local` provider it fails loud if the embedding model or cross-encoder won't load (fix: `npx tuberosa setup-models`), and the `ollama` provider (real rerank, *fake* embeddings) also refuses to start. To deliberately accept degraded hash mode, set `TUBEROSA_ALLOW_HASH_FALLBACK=true`.

### Want to try it with literally zero setup?

No Docker, no database, nothing to install beyond the repo deps:

```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run dev
curl http://localhost:3027/health
```

This runs Tuberosa entirely in memory. ✅ Great for poking at the API. ❌ Loses all data when you stop it.

### Want the durable, full stack?

```bash
corepack enable
pnpm install
cp .env.example .env       # compose reads it; sets TUBEROSA_MODEL_PROVIDER=local
docker compose up --build -d
curl http://localhost:3027/health
```

A healthy stack replies:

```json
{
  "ok": true,
  "service": "tuberosa",
  "store": "postgres",
  "durability": "persistent",
  "backupDir": ".tuberosa/backups",
  "cache": "redis",
  "modelProvider": "local"
}
```

(`modelProvider` echoes `TUBEROSA_MODEL_PROVIDER`. Without a `.env`, `docker compose` falls back to `hash` — see `docker-compose.yml`.)

Stop it with `docker compose down` (add `-v` to also wipe the Postgres data).

> Full install + publish walkthrough lives in [`docs/INSTALL.md`](docs/INSTALL.md). Environment/provider matrix is in [`docs/SETUP.md`](docs/SETUP.md).

---

## Core concepts (the vocabulary)

Tuberosa has a small vocabulary. Learn these six words and the rest of the docs make sense.

| Term | ELI5 | One-line definition |
|---|---|---|
| **Knowledge item** | A whole note / document | A stored chunk of project knowledge: a code reference, a runbook, a spec, a bug fix, a memory. |
| **Atom** | A single sticky-note fact | A small, claim-shaped fact with evidence and a trigger (e.g. "MCP stdout is JSON-RPC only"). |
| **Label** | A tag on a note | A typed signal (`file`, `symbol`, `error`, `technology`…) that helps Tuberosa match by metadata. |
| **Reference** | A pin on a map | Where a note *points to* in your world: a file + line range, a URL, a commit, a tool. |
| **Context pack** | The short stack handed back | The ranked shortlist Tuberosa returns for one task, split into essential/supporting/optional. |
| **Context-fit** | The confidence light | A traffic light — `ready` / `needs_confirmation` / `insufficient` — telling the agent how sure Tuberosa is. |

### Knowledge item (the document-sized unit)

The original unit of knowledge — a row of type `code_ref` / `wiki` / `spec` / `workflow` / `rule` / `bugfix` / `memory` / `conversation`. Best for stable things: files, runbooks, specs.

Required fields when you create one: `project`, `sourceType`, `sourceUri`, `itemType`, `title`, `content`.

### Atom (the sticky-note-sized unit)

A finer, claim-shaped fact. Where a knowledge item is a *page*, an atom is a single *sentence you'd defend*:

```jsonc
{
  "id": "<uuid>",
  "project": "tuberosa",
  "claim": "MCP stdout is reserved for JSON-RPC; diagnostics go to stderr",
  "type": "convention",                 // fact | procedure | decision | gotcha | convention
  "tier": "verified",                   // draft | verified | canonical
  "status": "active",                   // active | legacy_archived | superseded | archived
  "scope": "project",                   // project | user
  "evidence":     [ { "kind": "file", "path": "src/mcp-stdio.ts" } ],
  "trigger":      { "files": ["src/mcp/server.ts"], "symbols": ["console.log"] },
  "verification": { "command": "pnpm test" },
  "pitfalls":     ["A stray console.log breaks every MCP client."],
  "links":        [ { "toAtomId": "<other>", "kind": "refines", "confidence": 0.8 } ]
}
```

Atoms graduate `draft → verified → canonical` through a quality gate (dedup, decay, a critic). They link to each other with typed edges (`supersedes`, `refines`, `depends_on`, `co_changes_with`, `related_to`) that retrieval can follow — so changing one fact can surface the facts it impacts.

**User-style atoms** are a special subset with `scope: "user"` that follow *you* across projects:
- `personal_workflow` — wins over project conventions ("I always use `pnpm`").
- `coding_preference` — yields to project conventions when they conflict.

### Label, reference, context pack

A **label** boosts metadata matching:

```jsonc
{ "type": "file",          "value": "src/retrieval/fusion.ts", "weight": 1.0 }
{ "type": "symbol",        "value": "fuseCandidates",          "weight": 0.9 }
{ "type": "error",         "value": "ECONNREFUSED",            "weight": 0.8 }
{ "type": "business_area", "value": "paywall",                 "weight": 1.0 }
```

A **reference** says where a note lives:

```jsonc
{ "type": "file",   "uri": "src/retrieval/service.ts", "lineStart": 142, "lineEnd": 178 }
{ "type": "commit", "uri": "abc1234", "metadata": { "repo": "tuberosa" } }
```

A **context pack** is the answer Tuberosa hands back:

```jsonc
{
  "id":         "<context-pack-id>",
  "confidence": 0.92,
  "contextFit": { "status": "ready", "score": 0.98, "missingSignals": [] },
  "sections": {
    "essential":  [ /* read these first */ ],
    "supporting": [ /* helpful but secondary */ ],
    "optional":   [ /* nice-to-have */ ]
  },
  "deepContext": { /* full chunks, present in layered mode */ }
}
```

Every item carries `matchReasons` (`vector match`, `symbol:fuseCandidates`, `feedback:selected:3`…), so retrieval is **never an opaque blob** — you can always see *why* something was returned.

### Context-fit (the traffic light)

`contextFit.status` tells the agent how to behave:

- 🟢 **`ready`** — confident. Proceed.
- 🟡 **`needs_confirmation`** — show the shortlist to the human first.
- 🔴 **`insufficient`** — ask the human for the listed `missingSignals` before doing anything.

---

## How FIND works (the retrieval pipeline)

When an agent asks for context, the request walks a short assembly line. Each station has one job:

```
   prompt
     │
 ┌───▼────────┐   ┌──────────┐   ┌──────────────┐   ┌───────┐   ┌────────┐
 │ 1 Classify │──▶│ 2 Rewrite│──▶│ 3 Search ×5  │──▶│ 4 Fuse│──▶│ 5 Rerank│
 │ pull signals│   │ if needed│   │ in parallel  │   │ merge │   │ reorder │
 └────────────┘   └──────────┘   └──────────────┘   └───────┘   └────┬────┘
                                                                     │
        ┌──────────┐   ┌────────────┐   ┌──────────────┐   ┌─────────▼──────┐
        │ 9 Assemble│◀─│ 8 Check fit│◀─│ 7 Adjust     │◀─│ 6 (top slice)  │
        │ pack      │   │ traffic    │   │ feedback &   │   │                │
        │ sections  │   │ light      │   │ penalties    │   │                │
        └─────┬─────┘   └────────────┘   └──────────────┘   └────────────────┘
              │
              ▼  (layered mode only)
        ┌──────────────┐
        │ 10 Deep ctx  │  expand chosen items into full chunks
        └──────────────┘
```

| # | Step | What it does |
|---|---|---|
| 1 | **Classify** | Pull task signals from the prompt: project, task type, files, symbols, error codes, technologies, business areas, exact terms. |
| 2 | **Rewrite (only if needed)** | Probe first. If the top results already look strong, skip rewriting. Otherwise ask the model for a better-angled query, reusing the probe's embedding. |
| 3 | **Search in parallel** | Five sources at once: labels & references, full-text search, vector similarity, approved memories — then expand through the knowledge/atom graph from the best hits. |
| 4 | **Fuse** | Weighted reciprocal-rank fusion across all five lists. |
| 5 | **Rerank** | Re-order the top slice (local cross-encoder by default, with `hash` as fallback; or `openai` / `ollama`). |
| 6–7 | **Adjust** | Boost items with positive feedback; penalize stale, superseded, or evidence-mismatched items. |
| 8 | **Check fit** | Emit `ready` / `needs_confirmation` / `insufficient` and list missing signals. `noiseTolerance="strict"` drops weak items here. |
| 9 | **Assemble** | Split survivors into `essential` / `supporting` / `optional` within the token budget. |
| 10 | **Deep context** (layered mode) | Expand chosen items into full chunks, up to `deepContextBudget`. |

**Why five search sources instead of just "AI similarity"?** In code work, an exact symbol name, file path, or error code is *just as strong a signal* as semantic meaning. A pure-vector search would miss `ECONNREFUSED` matching a note that literally contains `ECONNREFUSED`. Tuberosa weights both — this is called **hybrid retrieval**.

Two request flags change the path:
- `"bypassCache": true` — skip the Redis cache and re-run the pipeline fresh.
- `"debug": true` — also skip the cache, *and* return per-stage candidates and timings.

---

## A full end-to-end example

Store one fact, search for it, then tell Tuberosa whether it helped. (Uses the HTTP API so you can paste it into any terminal.)

```bash
# 1. Ingest one knowledge item
curl -sX POST http://localhost:3027/knowledge -H 'Content-Type: application/json' -d '{
  "project": "newsletter-app",
  "sourceType": "manual",
  "sourceUri": "docs/paywall.md",
  "itemType": "wiki",
  "title": "Newsletter paywall workflow",
  "content": "PaywallSelectionModal must preserve selected product ids across edits.",
  "labels": [
    { "type": "business_area", "value": "paywall", "weight": 1 },
    { "type": "symbol",        "value": "PaywallSelectionModal", "weight": 1 }
  ],
  "references": [{ "type": "file", "uri": "src/components/paywall-selection-modal.tsx" }]
}'

# 2. Search for it
curl -sX POST http://localhost:3027/context/search -H 'Content-Type: application/json' -d '{
  "project": "newsletter-app",
  "prompt": "Update PaywallSelectionModal for newsletter paywall flow",
  "files":   ["src/components/paywall-selection-modal.tsx"],
  "symbols": ["PaywallSelectionModal"],
  "taskType": "implementation"
}'

# 3. After working, tell Tuberosa it helped (or: stale / irrelevant / missing_context)
curl -sX POST http://localhost:3027/context/feedback -H 'Content-Type: application/json' -d '{
  "contextPackId": "<id-from-step-2>",
  "project": "newsletter-app",
  "feedbackType": "selected"
}'
```

Step 3 is the magic loop: feedback nudges this item up or down for future searches. **Good feedback makes future retrieval better.**

---

## How LEARN works (sessions → reviewed memory)

A *session* is one auditable unit of agent work. The lifecycle:

```
 tuberosa_start_session
         │   (Tuberosa hands back initial context + a traffic light)
         ▼
 tuberosa_record_context_decision   ← "this note was: selected / stale / irrelevant /
         │                             missing_context / selected_but_noisy / ..."
         ▼
 tuberosa_capture_learning_signal   ← (optional) mid-session signals
         │
         ▼
 tuberosa_append_session_note       ← (optional) notes after finishing
         │
         ▼
 tuberosa_finish_session            ← outcome = completed | failed | blocked | cancelled
                                       → may auto-extract a *reflection draft*
```

A finished session can produce a **reflection draft** — a *proposed* lesson. But a draft is **never** injected into anyone's context until a human reviews it. That review gate is the safety boundary that keeps low-quality "lessons" out of retrieval:

```
 finish_session ──▶ reflection draft (pending)
                          │
                          ├─ approve       ──▶ stored as a searchable memory  ✅
                          ├─ reject        ──▶ archived, never injected        ❌
                          └─ needs_changes ──▶ author edits, re-submits        ✍️
```

> Drive a full coding task through this loop: read `.claude/skills/tuberosa-agent-loop/SKILL.md`. Review drafts and run the human side: `.claude/skills/tuberosa-operating/SKILL.md`.

---

## The `tuberosa` CLI

Run from anywhere with `npx tuberosa <command>` (or `pnpm run <command>` inside the checkout).

| Command | What it's for |
|---|---|
| `tuberosa init` | Bootstrap the local stack — **Docker required** (hard-fails with install guidance if missing). Copies the 5 bundled agent skills into `.claude/skills/` and writes agent MCP configs by default (`--no-skills` / `--no-mcp-config` to skip; never overwrites existing files). `--embedded` opts into the volatile trial stack instead (`--no-docker` is a deprecated alias). |
| `tuberosa doctor` | Diagnose Node, pnpm, Docker, port 3027, Postgres reachability, MCP stdout sanity, and the local models (embedding model + reranker). Add `--deep` to actually load the models and prove they run, not just that the files exist. |
| `tuberosa setup-models` | Download **and verify** the local embedding model and cross-encoder so real (non-hash) search works with no API key. Run it once per machine, or whenever `doctor` reports a missing model. |
| `tuberosa mcp` | Run the MCP stdio server — full stack by default (postgres + redis + local embeddings); `--embedded` for the volatile trial stack. |
| `tuberosa mcp install` | (Re)write agent MCP configs on demand: `.mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml` (Codex only when `~/.codex/` exists). Merge-only — never clobbers other servers in an existing config; the TOML is append-only with a marker. |
| `tuberosa bootstrap` | **First-run project knowledge**: additive sync + atlas + a health summary. Add `--deep` for a deeper pass, `--export` to also write a bundle. |
| `tuberosa sync` | Detect added / changed / renamed / deleted files and review or apply a cleanup plan. `--apply` applies additive ops; archiving deleted files also needs `--yes`. |
| `tuberosa hook` | Manage git hooks — `tuberosa hook install` wires **additive-only auto-sync** so knowledge stays fresh on every commit. |
| `tuberosa atlas` | Emit the project "atlas" (project-map, flows, commands) — the one-look overview. |

**Onboarding a brand-new project?** The recommended flow is `init → doctor → bootstrap --deep → review drafts`, then `hook install` to keep it fresh. The skill `.claude/skills/tuberosa-onboard-project/SKILL.md` walks an agent through it step by step.

---

## Connecting an agent (MCP)

Start the server:

```bash
pnpm run mcp        # inside the checkout
# or
npx tuberosa mcp    # from anywhere
```

> ⚠️ The MCP process writes **only JSON-RPC** to stdout. All diagnostics go to stderr. (A stray `console.log` would break every MCP client.)

### Client setup snippets

> **Zero-touch:** `npx tuberosa init` writes the Claude Code, Cursor, and Codex configs
> (`.mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml`) for you, and `npx tuberosa mcp install`
> re-writes them on demand — merge-only, it never clobbers other servers in an existing config;
> Codex only when `~/.codex/` exists. `--embedded` trial installs skip config writing.
> For other clients (e.g. GitHub Copilot's `.vscode/mcp.json`), use the snippets below as the manual fallback.

**Claude Code** — project-scoped:

```bash
claude mcp add --transport stdio --scope project tuberosa -- \
  pnpm --silent --dir <repo-path> run mcp
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.tuberosa]
command = "npx"
args    = ["tuberosa", "mcp"]
# No env block needed: defaults to full stack (Postgres + Redis + local embeddings).
# For volatile trial mode (no Docker required): add env = { TUBEROSA_EMBEDDED = "1" }
```

**GitHub Copilot** (VS Code Agent mode) — `.vscode/mcp.json`:

```json
{ "servers": { "tuberosa": { "type": "stdio", "command": "pnpm",
                             "args": ["--dir", "<repo-path>", "run", "mcp"] } } }
```

**Debug with the MCP Inspector** (verify tools/prompts/resources list correctly before wiring a real client):

```bash
npx @modelcontextprotocol/inspector pnpm --silent --dir <repo-path> run mcp
```

### The 36 MCP tools, grouped

| Group | Tools |
|---|---|
| **Retrieval (FIND)** | `tuberosa_search_context`, `tuberosa_get_context_pack` |
| **Session lifecycle (LEARN)** | `tuberosa_start_session`, `tuberosa_record_context_decision`, `tuberosa_capture_learning_signal`, `tuberosa_append_session_note`, `tuberosa_finish_session` |
| **Reflection review** | `tuberosa_reflect`, `tuberosa_list_reflection_drafts`, `tuberosa_get_reflection_draft`, `tuberosa_review_reflection_draft` |
| **Feedback & quality** | `tuberosa_feedback_context`, `tuberosa_collect_context_quality_feedback` |
| **Onboarding & overview** | `tuberosa_sync_sources`, `tuberosa_bootstrap_handbook`, `tuberosa_get_atlas` |
| **Atoms & graph** | `tuberosa_atom_gate_stats`, `tuberosa_atom_graph_density`, `tuberosa_predict_impact`, `tuberosa_resurrect_atom` |
| **Curation & maintenance** | `tuberosa_propose_curation`, `tuberosa_propose_maintenance`, `tuberosa_apply_maintenance` |
| **Project bundles** | `tuberosa_export_pack`, `tuberosa_import_pack`, `tuberosa_list_atom_import_conflicts`, `tuberosa_resolve_atom_import_conflict` |
| **User style** | `tuberosa_record_user_style`, `tuberosa_list_user_style` |
| **Error logs** | `tuberosa_record_error_log`, `tuberosa_list_error_logs`, `tuberosa_get_error_log`, `tuberosa_collect_error_logs`, `tuberosa_update_error_log`, `tuberosa_resolve_error_log`, `tuberosa_create_error_log_reflection_draft` |

### Resource templates & prompts

```
# Resources (read by URI)
tuberosa://packs/{id}
tuberosa://knowledge/{id}
tuberosa://error-logs/{id}
tuberosa://error-logs/{id}/markdown

# Prompts (canned MCP prompts)
tuberosa_bootstrap_session
tuberosa_reflect_after_task
tuberosa_review_pending_reflections
tuberosa_capture_error_for_later
tuberosa_review_error_logs
tuberosa_fix_error_log
```

### Recommended agent workflow

```
1. tuberosa_start_session  (or just tuberosa_search_context for a one-off)
2. Look at contextFit + missing signals:
     ready              → proceed
     needs_confirmation → confirm the shortlist with the human
     insufficient       → ask the human for the missing signals
3. tuberosa_get_context_pack  (if you only got a shortlist)
4. Do the work.
5. tuberosa_record_context_decision  (selected / stale / ...)
6. tuberosa_finish_session  → a reflection draft is queued for human review
```

---

## Configuration

Copy `.env.example → .env`. The variables that matter most:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3027` | HTTP port. |
| `DATABASE_URL` | `postgres://tuberosa:tuberosa@localhost:5432/tuberosa` | |
| `POSTGRES_PASSWORD` | `tuberosa` | Change outside local dev. |
| `REDIS_URL` | `redis://localhost:6379` | |
| `TUBEROSA_STORE` | `postgres` | `postgres` or `memory`. |
| `TUBEROSA_CACHE` | `redis` | `redis`, `memory`, or `none`. MCP stdio defaults to `memory`. |
| `TUBEROSA_AUTO_MIGRATE` | `true` | Run migrations on app start. |
| `TUBEROSA_MODEL_PROVIDER` | `local` | `local` (real embeddings via `Xenova/bge-small-en-v1.5` + cross-encoder rerank, offline after the one-time `setup-models` download), `hash` (deterministic, zero downloads — **tests only**, not real search), `openai`, or `ollama`. Auto-selection: `openai` when `OPENAI_API_KEY` is set; `hash` when `TUBEROSA_EMBEDDED=1`. |
| `TUBEROSA_ALLOW_HASH_FALLBACK` | `false` | The escape hatch for the no-silent-fake-search guard. When `false` (default) the server fails loud if real models can't load. Set `true` to opt into degraded `hash` search instead of failing. |
| `TUBEROSA_CONTEXT_MODE` | `layered` | `layered` adds deep-context expansion; `compact` is shortlist only. |
| `TUBEROSA_DEEP_CONTEXT_BUDGET` | `60000` | Tokens. Clamped 30k–100k. |
| `CONTEXT_CACHE_TTL_SECONDS` | `300` | Context-pack cache lifetime. |
| `TUBEROSA_PHYSICAL_MIRROR_ENABLED` | `true` | Sync DB to the human-readable `.tuberosa/current/` mirror. |
| `TUBEROSA_API_KEY` | _empty_ | If set, every route except `/health` requires `Authorization: Bearer <key>`. |
| `TUBEROSA_REQUIRE_API_KEY_FOR_NON_LOOPBACK` | `false` | When `true` and no key is set, non-loopback requests are refused. |
| `TUBEROSA_EXPORT_BASE_DIR` | `.tuberosa/exports` | Confines export-pack outputs. |
| `TUBEROSA_IMPORT_BASE_DIR` | `.tuberosa/imports` | Confines import-pack inputs. |
| `OPENAI_API_KEY` | _empty_ | Needed only when `TUBEROSA_MODEL_PROVIDER=openai`. |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Must match `EMBEDDING_DIMENSIONS`. |
| `EMBEDDING_DIMENSIONS` | `384` | Must equal the `vector(N)` column. Default matches `Xenova/bge-small-en-v1.5` and `migrations/014_embedding_dim_384.sql`. |

> ⚠️ **Changing `EMBEDDING_DIMENSIONS` requires a new migration.** The pgvector column dimension and the embedding length must agree, or you'll hit `vector dimension mismatch`.

For backup tuning, error-log capture, request-size limits, and the minimal env set, see `.env.example`, [`docs/SETUP.md`](docs/SETUP.md), and [`docs/MINIMAL_ENV.md`](docs/MINIMAL_ENV.md).

---

## HTTP API (summary)

All endpoints return JSON. `/health` is unauthenticated; everything else requires `Authorization: Bearer $TUBEROSA_API_KEY` *if* you set the key.

| Concern | Sample routes |
|---|---|
| Knowledge | `POST /knowledge`, `GET /knowledge`, `GET /knowledge/{id}`, `PATCH /knowledge/{id}`, `POST /ingest/files`, `GET /labels` |
| Context | `POST /context/search`, `GET /context/packs[/{id}]`, `POST /context/feedback`, `GET /feedback-events` |
| Atoms | `POST /atoms/{id}/resurrect` |
| User style | `POST /user-style-atoms`, `GET /user-style-atoms[/{id}]` |
| Sessions | `POST /agent-sessions`, `GET /agent-sessions[/{id}]`, `…/context-decisions`, `…/learning-signals`, `…/finish`, `…/notes` |
| Reflection | `POST /reflection-drafts`, `GET /reflection-drafts[/{id}]`, `…/review`, `…/approve`, `…/recommendation` |
| Relations | `GET/POST /operations/relations`, `GET/PATCH/DELETE /operations/relations/{id}` |
| Conflicts | `GET /operations/conflicts`, `POST /operations/conflicts/detect`, `POST /operations/conflicts/{id}` |
| Atom graph | `GET /operations/atom-gate/stats`, `GET /operations/atom-graph/density`, `POST /operations/atom-graph/impact` |
| Export/import | `POST /operations/export-pack`, `POST /operations/import-pack`, `GET /operations/atom-import-conflicts[/{id}]`, `POST /operations/atom-import-conflicts/{id}/resolve` |
| Organization | `GET /operations/organization/{project-map,knowledge-graph.jsonl,readable-summary}` |
| Quality / sessions | `GET /operations/context-quality`, `GET /operations/session/{id}/replay`, `GET /operations/catchup` |
| Maintenance | `GET /operations/learning-proposals`, `POST /operations/maintenance/{preview,apply}`, `POST /operations/cleanup`, `GET/PATCH /operations/knowledge-gaps[/{id}]` |
| Error logs | `POST /operations/error-logs`, `GET /operations/error-logs[/{id}]`, `POST /operations/error-logs/{id}/resolve` |
| Backups | `POST /operations/import-files`, `GET/POST /operations/backups`, `GET /operations/backups/status`, `POST /operations/backups/prune` |

### Feed Tuberosa its own source code

```bash
pnpm run seed:self
# or, for full coverage (all of src/ + docs/ recursively):
node --import tsx scripts/seed-tuberosa-knowledge.ts
```

The extended seed wraps each file in its own try/catch — `IngestionService.ingestFiles` is sequential and would otherwise abort the whole batch on one rejected file. The security module's pattern strings trip its own guard, so the seed skips `src/security/knowledge-safety.ts`.

---

## Everyday commands

```bash
pnpm run build           # TypeScript compile to dist/
pnpm test                # full unit suite (all test/*.test.ts)
pnpm run dev             # HTTP server in watch mode (port 3027)
pnpm run mcp             # MCP stdio server
pnpm run migrate         # apply SQL migrations
pnpm run worker          # background worker process

pnpm run eval:retrieval              # deterministic retrieval-quality eval (gate, hash provider)
pnpm run eval:local-model            # opt-in LIVE cross-encoder smoke eval — proves the real reranker scores pairs (self-skips if models aren't downloaded)
pnpm run eval:agent-context          # agent-session compliance eval
pnpm run eval:knowledge-completeness # LEARN-loop / atoms eval
pnpm run eval:context-mapping
pnpm run eval:safety

pnpm run sandbox                # synthetic corpus + golden prompts → eval/sandbox/report.md
pnpm run sandbox:ablate         # disable each retrieval source in turn to measure its value
pnpm run calibrate-fusion       # emit a calibrated config/retrieval-policy.json patch

pnpm run test:integration       # Docker-gated Postgres+Redis tests (skips if the stack is down)
pnpm run verify:bundled-skills  # prepack gate: skills manifest ↔ package.json files ↔ disk parity + consumer-safety grep
```

Older Node in your shell? Either `nvm use` or prefix the command:

```bash
PATH=/home/<you>/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```

---

## Quality gates (evals)

**The retrieval eval must stay green** before any change to the classifier, fusion weights, reranker, or context-pack assembly:

```bash
pnpm run eval:retrieval
pnpm run eval:retrieval -- --top-k 3
pnpm run eval:retrieval -- --json
pnpm run eval:retrieval -- --fixture eval/retrieval-fixtures.json --fail-under-hit-rate 0.95
```

The fixture seeds an in-memory store, runs each prompt through the real ingestion + retrieval services, and reports hit rate, MRR, precision@k, stale rejection, unexpected-result avoidance, and exact file/symbol/error classification.

> **Rule:** never tweak a weight or add a heuristic without first adding a fixture case that would fail *without* the change. Matching improves through measured retrieval quality, not hand-tuned weights.

The deterministic evals run on the `hash` provider, so they can't see the *real* cross-encoder. `pnpm run eval:local-model` closes that gap: it drives the live `LocalCrossEncoderProvider` and asserts the real reranker actually scores query↔passage pairs (it self-skips when the models aren't downloaded). Run it after any change to the reranker.

Two recent classifier-quality fixes that the fixtures now lock in: the cross-encoder reranker was fixed to tokenize pairs directly (it had been silently degrading to fused order), and the symbol/label extractor was tightened so ALL-CAPS prose (`NEVER`, `TDD`), words that merely precede a `(`, and back-ticked English words no longer leak in as `symbol:` labels — while real identifiers (`TransformersScorer`, `bge-reranker-v2-m3-ONNX`, `dotted.path`) still classify.

---

## Security

- **Secrets** are redacted from content before storage *and* from search prompts before embedding (`src/security/knowledge-safety.ts`).
- **Prompt-injection** patterns are blocked at ingestion.
- **Retrieved candidates** are re-sanitized before being returned.
- **Path confinement:** every export/import path on both HTTP and MCP is canonicalized against `TUBEROSA_EXPORT_BASE_DIR` / `TUBEROSA_IMPORT_BASE_DIR`. Absolute paths, `..` segments, NUL bytes, and symlink escapes are rejected.
- **Self-ingestion gotcha:** the security module's own pattern strings trip its own guard — skip `src/security/knowledge-safety.ts` in self-seed scripts.
- Set `TUBEROSA_API_KEY` to require `Authorization: Bearer <key>` on every HTTP route except `/health`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node:sqlite` or pnpm fails on Node 20 | `nvm use` then `corepack enable && pnpm install`. `.nvmrc` pins 22.21.1. |
| pnpm tries to use a global store | `pnpm config set store-dir .pnpm-store --location project && pnpm install`. |
| Docker app exits during migration | `docker compose logs --no-color app worker`, then `docker compose up --build -d`. |
| "Refusing to start: TUBEROSA_HTTP_HOST=0.0.0.0 …" | Set `TUBEROSA_API_KEY` (recommended) or set `TUBEROSA_HTTP_HOST=127.0.0.1`. |
| `/operations/export-pack` returns 400 "absolute path is not allowed" | Use a path *relative* to `TUBEROSA_EXPORT_BASE_DIR` (default `.tuberosa/exports`). |
| `vector dimension mismatch` | `EMBEDDING_DIMENSIONS` must equal the `vector(N)` in `migrations/001_init.sql`. |
| "Local embedding model / cross-encoder is unavailable — refusing to start with fake search" | The no-silent-fake-search guard fired. Run `npx tuberosa setup-models` to download the models, or set `TUBEROSA_ALLOW_HASH_FALLBACK=true` to accept degraded hash mode. |
| MCP client sees no tools | Use the absolute repo path, check the command's `PATH` for Node/pnpm, verify with MCP Inspector, ensure stdout is JSON-RPC only. |
| `tuberosa doctor` says `DATABASE_URL not set` even though it's in `.mcp.json` | `.mcp.json` `env` is only seen by the MCP server your agent spawns, **not** your interactive shell. Export it in the shell to check a real DB: `DATABASE_URL=… tuberosa doctor`. |
| `npx tuberosa mcp` / `migrate` fails with `Missing script` or `Could not find MCP entrypoint` | Update Tuberosa — older versions resolved bundled assets from your cwd instead of the installed package. The CLI now finds `migrations/` and the MCP entry inside the package automatically. |
| `DuplicateIngestionError` on re-ingest | Expected — the `DuplicateDetector` auto-rejects textual + semantic duplicates. Treat it as "skipped". |

---

## Where to read next

Everything below is a file that **actually exists** in this repo (the old `wiki/` folder has been removed and its content folded into these docs and skills).

| Doc / skill | Use it for |
|---|---|
| **README.md** (this file) | The one-page overview. |
| [`docs/SETUP.md`](docs/SETUP.md) | Environment setup + the full model-provider matrix. |
| [`docs/MINIMAL_ENV.md`](docs/MINIMAL_ENV.md) | The smallest set of env vars to get running. |
| [`docs/INSTALL.md`](docs/INSTALL.md) | Publish to npm/pnpm, the end-user install + MCP wiring guide, and the script triage (which `package.json` scripts are for end users / operators / contributors). |
| [`docs/EXAMPLES.md`](docs/EXAMPLES.md) | Verified, copy-pasteable scenarios. |
| [`docs/tuberosa-project.md`](docs/tuberosa-project.md) | Project intent and original design notes. |
| `.claude/skills/tuberosa-guide/SKILL.md` | What Tuberosa is, the full tool list, FIND vs LEARN. |
| `.claude/skills/tuberosa-agent-loop/SKILL.md` | Drive one coding task through the session loop. |
| `.claude/skills/tuberosa-onboard-project/SKILL.md` | Onboard / comprehend a whole project into Tuberosa, and keep it fresh. |
| `.claude/skills/tuberosa-operating/SKILL.md` | Operate Tuberosa as a human: ingest, review drafts, run evals, turn on learning. |
| `.claude/skills/tuberosa-using/SKILL.md` | End-user usage map: the daily tool loop, the install lifecycle, operator maintenance tasks, and which repo scripts to ignore. |

External references:

- Model Context Protocol — https://modelcontextprotocol.io/docs/sdk
- MCP Inspector — https://modelcontextprotocol.io/docs/tools/inspector
- Claude Code MCP — https://code.claude.com/docs/en/mcp
- GitHub Copilot MCP — https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/extend-cloud-agent-with-mcp
- pgvector HNSW — https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes
