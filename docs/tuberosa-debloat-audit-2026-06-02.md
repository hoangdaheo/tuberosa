# Tuberosa De-Bloat Audit — 2026-06-02

Status: Phase 0 (Understand + Audit) of the simplification engagement.
Method: 6 parallel read-only exploration passes over all 24 `src/` areas + direct
verification greps of the highest-impact claims + a live test of Tuberosa on this task.

This document is **findings + recommendations**. Code changes happen in a later phase,
gated by the eval suites. Decisions still open are listed at the end.

---

## 1. Executive summary

Tuberosa is a local-first MCP **context broker**: it finds project knowledge for a
coding agent, records whether it was useful, and is *meant* to turn lessons into reviewed
memory so future agents repeat fewer mistakes.

The codebase is **~41,700 LOC across 146 files in 24 areas** (plus ~22,000 LOC of tests).
It works as a retrieval engine, but it has grown three kinds of weight:

1. **A dead pillar.** The "learn from experience" half (atoms → conventions → auto-improving
   memory, ~2,000 LOC) is wired to a model capability (`extractAtoms`) that **no shipping
   provider implements**. In real use it produces nothing.
2. **Enterprise machinery for a single-user local tool.** Scheduled backups, write-through
   mirror, session replay, atom diagnostics, org-CLI, context-quality CLI — ~2,000–3,000 LOC
   that a one-person local install does not need.
3. **Surface + boilerplate sprawl.** 36 MCP tools, 59 env vars, ~75 HTTP routes (mirroring the
   tools), and a hand-rolled `validation.ts` (1,434 LOC) that a schema library would cut ~70%.

And critically for the owner's complaint — **there is no guidance layer**: 0 skills for users
or agents, no minimal env recipe, no usage examples.

### The live demonstration

Running `tuberosa_start_session` on the prompt for this very task reproduced every complaint:

- ❌ Output was **56,186 characters and exceeded the MCP token limit** — the "compact pack"
  is too big to consume.
- ❌ The classifier extracted the capitalized plain words `Simplify`, `Build`, `Provide`,
  `Create` as **code symbols**, then reported them as "missing symbols."
- ❌ Top candidate was an unrelated old session (`P4-2 withTransaction`); fit =
  `needs_confirmation` (0.499); policy = `confirm`. The broker told itself not to trust the pack.
- ❌ 0 atoms, 0 conventions, empty handbook.

---

## 2. The numbers

| Thing | Count | Note |
|---|---|---|
| Source | 41,663 LOC, 146 files, 24 areas | retrieval 7,960 + storage 6,945 ≈ ⅓ |
| Tests | 22,094 LOC, 150 files | |
| MCP tools | 36 | flat list, no core/admin split |
| Env vars | 59 `TUBEROSA_*` | no grouping, no minimal recipe |
| HTTP routes | ~75 | largely mirror the MCP tools |
| Migrations | 13 | ~24 tables |
| Eval suites | 7 | retrieval + knowledge-completeness gate merges |
| Biggest files | postgres-store 3,143 · retrieval/service 2,589 · memory-store 2,163 · validation 1,434 · http/server 1,363 · context-pack 1,244 | |

---

## 3. Keystone finding (VERIFIED) — the "learn" pillar is unwired

Evidence (direct):

- `src/model/provider.ts:27` — `extractAtoms?(...)` is **optional**.
- `src/model/provider.ts:86` — only `HashModelProvider.extractAtoms` exists; returns `fixtureAtoms`.
- `src/model/provider.ts:136` — `OpenAiModelProvider` does **not** implement `extractAtoms`.
- `src/model/local-provider.ts`, `src/model/ollama-provider.ts` — neither implements it.
- `src/atoms/extractor.ts:41` — `if (!this.models.extractAtoms) return { stored: [], ... }`.
- `.env` — `TUBEROSA_MODEL_PROVIDER=ollama`.

Consequence chain: ollama/openai have no `extractAtoms` → extractor early-returns → **no atoms
ever created** → `curation` clusters an empty set → conventions never distilled → handbook
always empty → the convention retrieval lane is always blank.

Code that is therefore **dormant in any real deployment**:

- `src/atoms/` (1,094 LOC): critic (4-stage gate), extractor, inference (semantic-neighbor,
  co-change, sync, prune), migration, gate-telemetry, tier, archival.
- `src/curation/` (472 LOC): cluster + bootstrap-extract (proposes from atoms that don't exist).
- Convention auto-distillation path in `src/reflection/service.ts`.
- Atom-graph expansion + impact-prediction in `src/retrieval/` (atom-graph walk over an empty graph).
- The `knowledge_atoms`, `knowledge_atom_relations`, `atom_gate_events`, `atom_import_conflicts`
  tables and their store methods.

Note: **manual** reflection memory (reflect → review → approve → `itemType:"memory"`) and
**manually** flagged conventions (`metadata.convention=true`) still work — they don't depend on
`extractAtoms`. User-style atoms are routed from explicit `user_preference` learning signals
through the critic's embed/dedup (not `extractAtoms`), so they *can* be created if signals are passed.

**This is the central decision of the engagement** — see §8.

---

## 4. Per-cluster findings

### 4.1 Retrieval (`src/retrieval/`, 7,960 LOC) — core, keep but slim

- **Classifier symbol bug** (`classifier.ts:500`): regex `/\b[A-Z][A-Za-z0-9_]{2,}\b/` matches any
  capitalized word; sentence-start verbs (`Simplify`, `Provide`, `Ensure`…) become "symbols".
  Fix: extend stop-words / narrow the regex. **Quick, high-value.**
- **Pack size** (`context-pack.ts:119`, `types/retrieval.ts:188`): every candidate serializes
  content (2,800) + contextualContent (3,600) + matchReasons + fitReasons + actionableMissingSignals
  + references + labels + metadata. ~4 KB × ~15 = the 56 KB blow-up. Fix: strip scoring/diagnostic
  fields from the returned pack (keep in debug only); truncate labels/refs.
- **Policy indirection** (`policy.ts`, 657 LOC): `getRetrievalPolicy()` read 23× per search. Pre-compute once.
- **Review-queue over-fetch** (`service.ts:986`): 6 queries × 24 = 144 items fetched, top 12 used.
- **`context-fit`**: downgrades `ready`→`needs_confirmation` whenever reranker unavailable, even at high score.
- KEEP: 8-lane search, fusion, fit, pack assembly — the engine is sound.

### 4.2 Storage (`src/storage/`, 6,945 LOC) — keep, de-duplicate

- ~27% (~1,450 LOC) is mechanical duplication / asymmetry between postgres-store and memory-store.
- **Parity bug**: `memory-store.updateKnowledge` (~418) skips `mergeLabelProvenanceIntoMetadata`
  that postgres calls (~437). Behavior drift.
- Extract shared search-ranking and relation-validity logic.
- `context_queries` is **used** (correction to agent claim) — keep. `learning_proposals`, `atlas_runs`
  are low-use; evaluate later. KEEP the postgres sub-store pattern.

### 4.3 Learning subsystems (`agent-session`, `reflection`, `atoms`, `user-style`, `curation`) — see §3

- Reflection has a **13-gate** recommendation framework (`recommendation.ts`, 611 LOC) — measure how
  many drafts pass hard gates before keeping all soft gates.
- **Dual persistence**: approved learning becomes *either* a convention atom *or* a legacy memory —
  two layers for "approved learning."
- KEEP: write-gate (Mem0-style, no LLM) and manual reflection path are sound.

### 4.4 Surfaces + config (`http`, `mcp`, `model`, `validation`, `config`) — simplify

- **36 MCP tools**, flat. ~17 core agent tools; ~12 admin/ops; ~7 diagnostic/overlap. No hierarchy
  shown to the agent. Merge overlaps (error-log list+collect; atom stats+density; session start/record/finish).
- **59 env vars**, no grouping, no minimal recipe. Backup alone = 8 vars; user-style cluster = 4;
  worktree = 3. Minimal local set is ~4 vars.
- **`validation.ts` 1,434 LOC**: hand-rolled repetitive readers; a schema lib (zod) cuts ~70%.
- **Model providers**: hash + openai + local + ollama. ollama is the owner's actual provider; keep
  hash+openai+ollama, treat `local` as experimental. None except hash implement extractAtoms (see §3).
- **HTTP mirrors MCP**: ~75 routes ≈ the 36 tools. 2× maintenance. (Keep both only if HTTP has a real consumer.)

### 4.5 Knowledge plumbing (`ingest`, `source-sync`, `atlas`, `bootstrap`, `export`) — trim

- **`BootstrapService` (`bootstrap/service.ts`, ~203 LOC) is DEAD** (never instantiated). Remove.
- Atlas: only project-map / flows / commands are high-signal; conventions.md is empty (see §3),
  risks.md lists unverified atoms. Make builder selection lazy; mark conventions intentionally empty.
- Only `ingest/` is on the core agent path; source-sync / atlas / export / import are manual/occasional.
- `document-atomizer`, `label-enricher` (LLM enricher is no-op by default), `item-type-inference`
  are conditional/optional — document and gate.

### 4.6 Operations / eval / security / maintenance / error-log (~8,600 LOC) — biggest local-overkill

- **BackupService (809 LOC) IS wired** (correction): `index.ts:21` scheduled start + HTTP routes.
  But scheduled/write-through/retention is enterprise-heavy for a single-user local tool. Decide:
  keep on-demand only vs strip in favor of `pg_dump`.
- **Physical mirror**: 15 call sites; useful for inspection but coupled through BackupService — extract.
- **Session replay (153 LOC)**: `persistReplay=false` by default — dormant.
- **Atom diagnostics** (gate-stats, graph-density, graph-export): HTTP-only telemetry over an empty graph.
- **`organization-cli.ts` (140 LOC)**: incomplete multi-user feature — remove for single-user scope.
- **`context-quality-cli.ts` (552 LOC)**: workbench/dev concern (workbench was already removed).
- **Eval (3,224 LOC)**: test-only, valuable, KEEP — but 3 fixture loaders (714 LOC) can merge to ~150.
- **Security**: secret redaction is sound (KEEP); prompt-injection is a stub; safe-paths is necessary.

---

## 5. Consolidated recommendation tables

### Safe removals (low risk, verified)

> **CORRECTION (SP3 execution, 2026-06-03):** the three "safe removal" code items below were re-verified by grep across `bin/`, `scripts/`, and `test/` (not just `src/`) and are **all LIVE — none were removed**:
> - `BootstrapService` is instantiated at `bin/commands/bootstrap-factory.ts:28`, wired into the `tuberosa bootstrap` CLI, and covered by 3 tests. (The original `grep "new BootstrapService" src` missed `bin/`.)
> - `organization-cli.ts` is used by `scripts/organization.ts` (the `pnpm run organization` ops command) and `test/organization-cli.test.ts` — it is live ops machinery the owner chose to keep.
> - `error-log/auto-capture.ts` is imported by `src/http/server.ts` and `src/mcp/server.ts` (`shouldAutoCapture`).
>
> Net code removed by SP3 item 5: **zero**. Only the eval-fixture-loader merge below is a real consolidation. Lesson: verify `bin/` + `scripts/` + `test/` before declaring code dead.

| Item | LOC | Evidence | SP3 outcome |
|---|---|---|---|
| `BootstrapService` | ~203 | ~~never instantiated~~ | KEPT — live (bin CLI + 3 tests) |
| `organization-cli.ts` | ~140 | ~~incomplete multi-user~~ | KEPT — live (`pnpm run organization` + test) |
| `error-log/auto-capture.ts` | ~11 | ~~stub~~ | KEPT — imported by http + mcp servers |
| Merge 3 eval fixture loaders → 1 | ~560 saved | duplicated parsing | planned (SP3 item 6) |

### Simplify (medium)

| Item | Action |
|---|---|
| `classifier.ts` symbol regex | extend stop-words / narrow regex (fixes capitalized-word bug) |
| context-pack output | strip diagnostic fields from returned candidates (fixes 56 KB blow-up) |
| `validation.ts` | replace hand-rolled readers with zod schemas (~70% cut) |
| `config.ts` / env | group into nested objects; publish a minimal local recipe |
| MCP tools | split core vs admin; merge overlapping tools |
| retrieval policy | pre-compute once per search instead of 23 reads |

### Strategic (needs owner decision — §8)

| Item | LOC | Options |
|---|---|---|
| Atom/curation/convention auto-learning pillar | ~2,000 | remove / wire-up `extractAtoms` / keep dormant |
| Enterprise ops (scheduled backup, replay, diagnostics) | ~2,000–3,000 | strip-to-local / keep / on-demand only |
| Dual HTTP+MCP surface | — | keep both / MCP-first |

---

## 6. What is genuinely good (keep)

- The 8-lane retrieval → fusion → fit → pack core.
- Postgres + memory store parity design and sub-store split.
- Secret redaction + safe-paths.
- The 7 eval suites (test-only, regression value).
- Manual reflection-memory path (works without `extractAtoms`).

---

## 7. The missing layer: guidance

- 0 skills for users or agents (only 4 internal trial-harness agents).
- No minimal local env recipe (59 vars, `.env.example` exists but unscoped).
- No real use-case examples / onboarding.

This is Phase 2 of the engagement (env guide + user skill + agent skill + examples), written
against the *simplified* system.

---

## 8. Open decisions (owner)

1. **Learn pillar**: remove the dead auto-extraction machinery, *or* wire `extractAtoms` into a
   real provider so the loop works, *or* keep it dormant + documented?
2. **Enterprise ops for local**: strip scheduled backup/replay/diagnostics, keep on-demand backup,
   or keep all?
3. **Surfaces**: keep HTTP + MCP both, or make MCP-first and trim HTTP to what has a real consumer?

Sequencing after decisions: Phase 1 = de-bloat refactor (eval-gated, per-area, reversible),
Phase 2 = usability layer (env recipe + skills + examples).
