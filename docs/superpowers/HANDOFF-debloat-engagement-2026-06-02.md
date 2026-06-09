# Tuberosa De-Bloat / Simplify / Skills — Engagement Handoff

Created 2026-06-02. **Read this first** in any new session that continues this engagement.
Each sub-project (SP1–SP4) is designed to be run in its **own clean context**: read this file +
the linked doc for that SP, then follow the brainstorm → spec → plan → implement flow.

---

## 0. How to use this handoff

- This engagement was decomposed into **4 sub-projects**. Do them in order: **SP1 → SP3 → SP2 → SP4**
  (rationale below). Each SP has a copy-paste **kickoff prompt** in its section.
- The full evidence-based audit is `docs/tuberosa-debloat-audit-2026-06-02.md`. Read it once.
- SP1 already has a **spec + plan written** (see §3). SP2/SP3/SP4 still need their own spec+plan
  (brainstorm them in their own session).
- Honor the **global constraints** in §2 in every session.

---

## 1. What Tuberosa is + why this engagement exists

Tuberosa is a **local-first MCP context broker** for coding agents. Two pillars:
1. **FIND** — retrieve the right project knowledge for an agent's task. ✅ Works; it's the good core.
2. **LEARN** — turn finished sessions into atoms → conventions → auto-improving memory. ❌ **Dead in
   real use** (see SP2). Built but never wired to a working model capability.

Size: ~41,700 LOC src across 146 files / 24 areas + ~22,000 LOC tests. 36 MCP tools, 59 env vars,
~75 HTTP routes, 13 migrations (~24 tables), 7 eval suites. Biggest files: `postgres-store.ts`
3,143 · `retrieval/service.ts` 2,589 · `memory-store.ts` 2,163 · `validation.ts` 1,434 ·
`http/server.ts` 1,363 · `context-pack.ts` 1,244.

The owner found it bloated, vague, and undocumented. A live `tuberosa_start_session` reproduced
the pain: 56 KB output (over the token limit), classifier extracted English words (`Simplify`,
`Build`, `Provide`, `Create`) as code symbols, off-target results, 0 atoms / 0 conventions / empty
handbook, and **0 skills** for users or agents.

### Owner's standing decisions (do not re-litigate without asking)

1. **LEARN pillar → WIRE IT UP** (implement the missing model capability so it works). It is an
   *add*, not a deletion. → **SP2**.
2. **Local ops machinery → KEEP EVERYTHING** (scheduled backup, mirror, replay, diagnostics,
   org-cli, quality-cli). Only remove *provably dead* code (e.g. `BootstrapService`, stubs).
3. **HTTP + MCP surfaces → KEEP BOTH.** MCP is primary (the agent path); HTTP is secondary
   (documented + dockerized, no in-repo client). Don't delete HTTP; reduce the shared
   `validation.ts` burden instead. → **SP3**.
4. Engagement mode: "everything including code changes", eval-gated, decomposed into sub-projects.

### Roadmap order + rationale

`SP1 (fix the engine) → SP3 (de-boilerplate) → SP2 (wire LEARN) → SP4 (docs/skills last, against
the final shape so they don't need rework).`

---

## 2. Global constraints (every session must honor)

- **Tuberosa startup rule** (from `CLAUDE.md`): for non-trivial work, call `tuberosa_start_session`
  (project `tuberosa`, cwd `/home/nash/tuberosa`, `contextMode: layered`, `noiseTolerance: strict`,
  `includeDeepContext: true`, taskType per task) and record a context decision before substantive
  work. **Caveat:** the broker currently returns oversized packs and a noisy classifier — treat the
  pack with skepticism and verify from direct repo evidence (this is exactly what SP1/SP2 fix).
- **Eval-first / no threshold-lowering:** any change to classifier, fusion, rerank, context-fit,
  context-pack, or retrieval policy must keep `pnpm run eval:retrieval` green (`hitRate=1`,
  `staleRejectionRate=1`, all exact classification rates = 1). Add a **failing fixture before** a
  heuristic change. Session-lifecycle changes → `pnpm run eval:agent-context`. Learning/atoms →
  `pnpm run eval:knowledge-completeness`. Safety → `pnpm run eval:safety`.
- **MCP stdout is protocol-only:** never add `console.log`/`process.stdout.write` in the MCP path;
  diagnostics go to stderr.
- **Store parity:** every `KnowledgeStore` method must behave identically in
  `postgres-store.ts` and `memory-store.ts`.
- **Run one `pnpm` command at a time.** Node pin: `.nvmrc` = 22.21.1; if shell Node is older,
  prefix: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH`.
- **Git:** the owner commits only when asked. Branch off `main` before committing
  (`git switch -c <branch>`). **Never add a `Co-Authored-By: Claude …` trailer.**
- **Communication:** the owner is a non-native English speaker — explain with short sentences,
  tables, ✅/❌, analogies, concrete steps; keep facts exact.
- **Always brainstorm before implementing** (superpowers): spec (get approval) → plan → implement.

---

## 3. SP1 — Retrieval Correctness — STATUS: SPEC + PLAN WRITTEN, NOT EXECUTED

- Spec: `docs/superpowers/specs/2026-06-02-sp1-retrieval-correctness-design.md`
- Plan: `docs/superpowers/plans/2026-06-02-sp1-retrieval-correctness.md`
- Scope (3 fixes; 2 deferred): **Fix 1** classifier stops treating lone capitalized words as
  symbols (`src/retrieval/classifier.ts:497-505` + new `hasSymbolStructure`). **Fix 2** slim the
  MCP response at `contextPackShortlist` (`src/mcp/server.ts:578`): bound inlined deep context,
  trim per-item diagnostics, slim `classified`; `debug:true` + stored pack stay full. **Fix 4**
  lower `REVIEW_QUEUE_STATUS_LIMIT` 24→8 (`src/retrieval/service.ts:73`).
- **Deferred:** Fix 3 (fit over-downgrade — didn't cause the live symptom; reranker was available)
  and Fix 5 (policy pre-compute — policy already cached). Fix 5 → fold into SP3.

**To execute SP1 (new session):**
1. `git switch -c sp1-retrieval-correctness`
2. Read the SP1 plan; use `superpowers:subagent-driven-development` (fresh subagent per task) or
   `superpowers:executing-plans`. Follow the TDD/eval-first steps verbatim.
3. Gate: `pnpm run eval:retrieval` → `pnpm run build` → `pnpm test` → `git diff --check`.

---

## 4. SP3 — Kill boilerplate, not features (do AFTER SP1)

**Goal:** cut maintenance weight without removing any feature the owner chose to keep. All
verified. Owner decisions: keep ops, keep both surfaces.

**Work items (each its own plan task, TDD where logic changes):**

1. **`validation.ts` (1,434 LOC) → schema library (zod).** Hand-rolled repetitive `expectObject`/
   `readRequired*`/`readEnum` validators (`src/validation.ts`). Replace with zod schemas; serves
   BOTH MCP and HTTP. Target ~70% reduction. Keep the same error mapping (`src/errors.ts`). Gate:
   `pnpm test` (validation has dedicated tests) + `pnpm run build`.
2. **Config + env grouping + minimal local recipe.** `src/config.ts` flattens 59 `TUBEROSA_*`
   vars into an 81-prop `AppConfig`. Group into nested objects (storage, model, backup,
   user-style, worktree, errorLog, atlas…). Backup alone is 8 vars; user-style cluster 4;
   worktree 3. Produce a documented **minimal local set** (≈ `TUBEROSA_STORE`, `TUBEROSA_CACHE`,
   `TUBEROSA_MODEL_PROVIDER`, `TUBEROSA_HTTP_HOST`, plus DB/Redis URLs if postgres/redis). Feeds SP4.
3. **MCP tool hierarchy.** 36 flat tools in `src/mcp/tool-definitions.ts`. Group/label core agent
   tools (≈17: search/session/reflection/feedback/user-style) vs admin/ops (≈12) vs diagnostics
   (≈7). Merge overlaps: error-log `list`+`collect`; atom `gate_stats`+`graph_density`. This is
   *organization*, not removal (owner keeps ops). Gate: `pnpm run eval:agent-context` + MCP tests.
4. **Storage de-duplication + parity bug fix.** ~27% of the 5,300 LOC across postgres/memory stores
   is mechanical duplication. **Parity bug:** `memory-store.updateKnowledge` (~418) skips
   `mergeLabelProvenanceIntoMetadata` that `postgres-store` calls (~437) → label-provenance drift.
   Extract shared search-ranking + relation-validity helpers. Gate: `pnpm test` +
   `pnpm run test:integration` (Docker).
5. **Remove provably-dead code only:** `src/bootstrap/service.ts` `BootstrapService` (~203 LOC,
   never instantiated — verify `grep -rn "new BootstrapService" src` returns nothing);
   `src/error-log/auto-capture.ts` (11-LOC stub); `src/operations/organization-cli.ts` (~140 LOC,
   incomplete multi-user — confirm no caller). **Do NOT** remove BackupService (`index.ts:21`
   starts it), `context_queries` (used by `retrieval/service.ts`), session-replay, diagnostics.
6. **Merge 3 eval fixture loaders** (`src/evaluation/fixture-loader.ts` +
   `context-mapping-fixture-loader.ts` + `knowledge-completeness-fixture-loader.ts`, ~714 LOC) into
   one generic loader (~150 LOC). Gate: all `eval:*` scripts + `pnpm test`.
7. **Fix 5 (deferred from SP1):** read `getRetrievalPolicy()` once per `searchContext`, thread the
   resolved policy down (clarity only; policy is already cached). Low priority.

**Kickoff prompt (paste into a fresh SP3 session):**
> Read `docs/superpowers/HANDOFF-debloat-engagement-2026-06-02.md` and
> `docs/tuberosa-debloat-audit-2026-06-02.md`. We are doing SP3 (boilerplate simplification) of the
> Tuberosa de-bloat engagement. Owner decisions: keep all ops, keep both HTTP+MCP surfaces, only
> remove provably-dead code. Brainstorm SP3 into a spec, then a plan, then implement it eval-gated.
> Start with the `validation.ts` → zod conversion and the storage parity bug. Honor all global
> constraints in §2 of the handoff.

---

## 5. SP2 — Wire the LEARN pillar — STATUS: SHIPPED 2026-06-05

**Branch:** `sp2-wire-learn-pillar`

**Summary:** `extractAtoms` now exists on both `OpenAiModelProvider` and `OllamaGenerationProvider`
via a shared extraction module. The full session→atom→curation nudge loop was validated live with
`qwen2.5:3b-instruct`. All gates green: build clean, 796/796 unit tests, eval:retrieval /
eval:agent-context / eval:knowledge-completeness green, integration 5/5.

**Commits shipped:**
- `c4d5941` — shared atom-extraction prompt, schema, and parser (`src/model/atom-extraction.ts`)
- `6612c4f` — `TUBEROSA_OLLAMA_EXTRACT_MODEL` config for atom extraction
- `54e722d` — `extractAtoms` on `OpenAiModelProvider` via shared extraction module
- `2bb572d` — `OllamaGenerationProvider` — `extractAtoms` + `judgeAtomUtility` via `/api/chat`
- `f87457e` — `ProviderRegistry` extraction passthrough + ollama wiring (honest capability check:
  `extractAtoms` only exists on the registry when a provider backs it)
- `2b84156` — stream Ollama generation to survive undici 300s headers timeout (discovered live:
  undici hard-caps non-streaming header wait at 300s regardless of `AbortSignal`; stream:true +
  NDJSON accumulation; default generation timeout now 600s; reader cancelled in finally)
- `def2fcc` — require ≥1 evidence entry in extraction schema (grammar-enforced) (discovered live:
  `qwen2.5:3b` emitted `evidence:[]` and every atom died at the critic floor; `minItems:1` forces
  grammar-constrained models to emit evidence; critic untouched)

**Live validation (owner-witnessed):** 6/6 sessions extracted 6/6 atoms, floor:accepted:6, 0 gaps,
curation nudge fired at 5. Owner enabled `TUBEROSA_OLLAMA_EXTRACT_MODEL=qwen2.5:3b-instruct` in
`.env`. (`qwen3.5:latest` was impractical — see §7.)

**Original goal:** make atoms → conventions → auto-improving memory actually function, per the
owner's "wire it up" decision. This is the biggest *add*.

**Verified root cause (historical — now fixed):**
- `extractAtoms` was **optional** on the interface: `src/model/provider.ts:27` (`extractAtoms?(...)`).
- Only `HashModelProvider` implemented it (test fixture only). `OpenAiModelProvider`,
  `LocalModelProvider`, and `OllamaGenerationProvider` implemented neither `extractAtoms` nor the
  shared extraction logic.
- Therefore `src/atoms/extractor.ts:41` always early-returned with a real provider → **0 atoms**.

**Kickoff prompt (paste into a fresh SP2 session):**
> Read `docs/superpowers/HANDOFF-debloat-engagement-2026-06-02.md` (esp. §5) and
> `docs/tuberosa-debloat-audit-2026-06-02.md`. We are doing SP2: WIRE UP the LEARN pillar. The root
> cause is that no shipping model provider implements `extractAtoms` (verified: `provider.ts:27/86/136`,
> `extractor.ts:41`), so 0 atoms are ever created. Brainstorm SP2 into a spec, then a plan, then
> implement: add `extractAtoms` to `OpenAiModelProvider` (and Ollama or gate it), verify the full
> session→atom→curation→convention→retrieval loop, tune the critic. Eval-gated. Honor §2 constraints.

---

## 6. SP4 — Usability layer (do LAST, against the simplified system)

**Goal:** make Tuberosa usable and teachable. This is the owner's most-felt gap (no skills, no env
recipe, no examples). Write it against the post-SP1/SP3/SP2 shape so nothing needs rework.

**Deliverables:**
1. **Local env setup guide** — uses the SP3 minimal env recipe. Cover: no-dependency mode
   (`TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash`), the docker
   compose path (postgres+redis, port 3027 loopback), and the ollama/openai provider choice
   (note: atom extraction works on both openai and ollama per SP2 — see the provider matrix in docs/SETUP.md / docs/MINIMAL_ENV.md; FIND works on all providers). One-screen "happy path".
2. **Agent skill** (`.claude/skills/…`) — teaches an agent the real loop: start_session → read
   `contextFit`/`orientation`/`taskBrief` → record decision → finish_session → reflect. Document
   the **slim** pack shape from SP1 Fix 2 and `tuberosa_get_context_pack` for full deep context.
   Tell the agent to verify from source when fit is weak.
3. **User skill / runbook** — when and how a human drives Tuberosa: ingest sources, review
   reflection drafts, approve conventions, run evals, read the atlas.
4. **Real use-case examples** — e.g. "continue yesterday's work", "debug an error with prior
   lessons", "implement a feature using project conventions", each showing the exact tool calls and
   expected outputs.

**Dependencies:** SP1 (slim pack shape), SP3 (env recipe + tool grouping), SP2 (working learn loop)
should be done first so docs are accurate. **No code-logic changes** — docs + skill files.

**Kickoff prompt (paste into a fresh SP4 session):**
> Read `docs/superpowers/HANDOFF-debloat-engagement-2026-06-02.md` (esp. §6). SP1–SP3 (and ideally
> SP2) are done. We are doing SP4: the usability layer — local env setup guide, an agent skill, a
> user runbook, and real use-case examples — written against the current (simplified) system.
> Brainstorm SP4 into a spec, then a plan, then implement. Verify every command and tool call you
> document. Honor §2 constraints (esp. plain-language for a non-native English owner).

---

## 7. Deferred / parked items (don't lose these)

- **SP1 Fix 3** — fit `ready→needs_confirmation` over-downgrade when reranker unavailable
  (`context-fit.ts:230`). Needs a hand-built `ContextFitEvaluator` unit test. Revisit after SP1.
- **HTTP response slimming** — `/context/search` (`http/server.ts:176`) returns the **raw full
  pack** (bigger than MCP was). Not slimmed in SP1 because no in-repo client uses it. Do it if HTTP
  gains a real consumer.
- **Atlas** — only `project-map`/`flows`/`commands` builders are high-signal; `conventions.md` is
  empty until SP2 lands; `risks.md` lists unverified atoms. Consider lazy builder selection (SP3-ish).
- **Reflection 13-gate framework** (`reflection/recommendation.ts`, 611 LOC) — measure hard-gate
  pass rate before deciding whether to slim (SP2-adjacent).
- **Dual-persistence unification deferred** (owner decision 2026-06-05) — approved learning writes
  to *both* convention-atom path and legacy memory path (`reflection/service.ts:100-159`). Owner
  chose not to unify during SP2; revisit as a focused SP3/post-SP3 task.
- **`extractPromptIntent` not passed through registry under ollama/local** — the long-prompt
  intent-extraction path is not wired through `ProviderRegistry` for ollama or local providers.
  This is a FIND-pillar concern, not LEARN; SP2 did not change it. Revisit in SP3 or a follow-up.
- **`qwen3.5:latest` impractical on current hardware for extraction** — thinking model, >5 min per
  request on CPU-only. `qwen2.5:3b-instruct` validated instead (small, fast, grammar-constrained).
  Revisit larger/thinking models when GPU hardware is available.

---

## 8. Key file map (quick reference)

| Area | Files | Notes |
|---|---|---|
| Retrieval | `src/retrieval/{service,classifier,fusion,context-fit,context-pack,policy}.ts` | core; SP1 touches classifier + (via mcp) pack |
| MCP surface | `src/mcp/{server,tool-definitions,helpers}.ts`, `src/mcp-stdio.ts` | `contextPackShortlist` at `server.ts:578`; 36 tools |
| HTTP surface | `src/http/server.ts` | ~75 routes; `/context/search`:173-176 returns raw pack |
| Storage | `src/storage/{store,postgres-store,memory-store,factory}.ts`, `src/storage/postgres/*` | parity bug at memory-store updateKnowledge ~418 |
| Model | `src/model/{provider,factory,local-provider,ollama-provider}.ts` | extractAtoms gap (SP2) |
| Learning | `src/{agent-session,reflection,atoms,user-style,curation}/` | dead until SP2 wires extractAtoms |
| Config | `src/config.ts` | 59 env vars (SP3) |
| Validation | `src/validation.ts` | 1,434 LOC hand-rolled (SP3 → zod) |
| Eval | `src/evaluation/*`, `eval/*.json` | 7 suites; gates merges |
| Memory (Claude) | `/home/nash/.claude/projects/-home-nash-tuberosa/memory/project-debloat-engagement.md` | decisions recorded |
