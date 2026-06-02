# SP3 — Kill Boilerplate, Not Features — Design

Created 2026-06-02. Part of the Tuberosa de-bloat engagement (`docs/superpowers/HANDOFF-debloat-engagement-2026-06-02.md`, §4). Sequenced after SP1 (done, merged to `main`: commits `7398648`, `81fed94`, `9ab45a3`).

## 1. Goal

Cut maintenance weight (repetitive validators, flat config, flat tool list, duplicated store logic, duplicated fixture loaders, repeated policy reads) **without removing any feature the owner chose to keep**. Every change is eval-gated and reversible.

Owner standing decisions (do not re-litigate): keep all local ops machinery; keep both HTTP and MCP surfaces; remove only **provably-dead** code, verified by grep that no caller/instantiation exists.

## 2. Verification findings that change the plan

These were established by grep before any design choice. They override the handoff where they conflict.

### 2.1 Item 5 ("remove provably-dead code") yields ZERO safe removals

The handoff named three targets. All three are live:

| Target | Handoff claim | Verified status | Evidence |
|---|---|---|---|
| `src/error-log/auto-capture.ts` | 11-LOC stub, remove | ❌ live | imported by `src/http/server.ts:6` and `src/mcp/server.ts:3` (`shouldAutoCapture`) |
| `src/operations/organization-cli.ts` | no caller, remove | ❌ live | used by `scripts/organization.ts` (the `pnpm run organization` ops command) and `test/organization-cli.test.ts`; it is ops machinery the owner keeps |
| `src/bootstrap/service.ts` `BootstrapService` | never instantiated, remove | ❌ live | instantiated at `bin/commands/bootstrap-factory.ts:28` (`new BootstrapService({...})`); wired into the `tuberosa bootstrap` CLI (`bin/tuberosa.ts`); covered by `test/bootstrap-{service,deep,cli}.test.ts`; documented in `wiki/`. The handoff's verification command (`grep -rn "new BootstrapService" src`) only searched `src/`; the instantiation lives in `bin/`. |

**Conclusion:** delete none of them. The grep-before-delete rule is working as intended — the audit's `src/`-only scope produced three false-deads. Item 5 becomes a written verification note, not a code change.

### 2.2 The validation test contract is pass/fail, not message-exact

`test/validation.test.ts` is table-driven over 65 cases asserting only `expect: 'ok' | 'fail'`. The only error-shape assertion (`test/api-boundary.test.ts:999`) constructs a `ValidationError` by hand and checks the JSON-RPC `-32602` mapping, which lives in `src/errors.ts` (kept). Therefore the zod conversion must preserve **pass/fail behavior** and **throw `ValidationError`**, but does **not** need byte-identical message strings.

### 2.3 Confirmed facts

- `src/validation.ts` = 1,434 LOC; ~50 exported `validate*` functions + enum constants (`TASK_TYPES`, `KNOWLEDGE_ITEM_TYPES`, `CONTEXT_MODES`, …) that other files import (e.g. `tool-definitions.ts`). Callers: `src/http/server.ts`, `src/mcp/server.ts`, `src/mcp/tool-definitions.ts`, `src/operations/context-quality-cli.ts`, `src/operations/service.ts`.
- `zod` is **not** yet a dependency.
- Parity bug confirmed: `postgres-store.updateKnowledge` (`:436`) calls `mergeLabelProvenanceIntoMetadata`; `memory-store.updateKnowledge` (`:424`) never does → label-provenance drift when labels are updated. `mergeLabelProvenanceIntoMetadata`/`buildLabelProvenanceMap`/`LABEL_PROVENANCE_METADATA_KEY` are private to `postgres-store.ts`.
- `AppConfig` is a flat interface (`src/config.ts:1`), built by `loadConfig()` (`:82`), read by 9 files. Env vars include `TUBEROSA_*` plus non-prefixed (`PORT`, `DATABASE_URL`, `REDIS_URL`, `NODE_ENV`, `OPENAI_API_KEY`, `EMBEDDING_DIMENSIONS`, `CONTEXT_CACHE_TTL_SECONDS`).
- `src/mcp/tool-definitions.ts` declares 36 tools in one `tools()` array. Overlap pairs exist: `tuberosa_list_error_logs`/`tuberosa_collect_error_logs` (`:485`/`:502`); `tuberosa_atom_gate_stats`/`tuberosa_atom_graph_density` (`:604`/`:616`).
- `src/retrieval/service.ts` calls `getRetrievalPolicy()` 9 times across `searchContext` and helpers.
- Eval fixture loaders: `fixture-loader.ts` (265), `context-mapping-fixture-loader.ts` (189), `knowledge-completeness-fixture-loader.ts` (260) = 714 LOC.

## 3. Approach (chosen)

Conservative, parity-first, one branch off `main`, each item its own eval-gated and separately-committable task. TDD where logic changes. Rejected alternative: a schema-first "big bang" that exports zod schemas and rewrites every http/mcp/cli call site to `Schema.parse` — more diff, touches every call site, no functional gain (tests import the function names).

## 4. Per-item design

### Item 1 — `validation.ts` → zod (internal), keep the public API
- Add `zod` dependency.
- Create `src/schemas/*.ts` holding zod schemas grouped by input family (knowledge, context-search, agent-session, reflection, error-log, maintenance, backup, ingest…).
- Keep **every exported `validate*` function name** in `src/validation.ts` as a thin wrapper: `export const validateX = (v: unknown) => parseOrThrow(xSchema, v, 'X input')`. All 5 caller files and the test file are untouched.
- One adapter `parseOrThrow(schema, value, label)` converts a `ZodError` into `ValidationError(message, details)` where `details` is the flattened zod issues (path + message). `src/errors.ts` is unchanged, so HTTP 400 / JSON-RPC -32602 mapping holds.
- Preserve exported enum constants by deriving them from zod enums (or re-exporting the same `as const` arrays) so `tool-definitions.ts` etc. keep importing them.
- Preserve special behavior: taskType alias normalization (`bugfix`/`bug`/`investigation` → `debugging`, `coding`/`development` → `implementation`), `tokenBudget` clamp to 200_000, defaults, char-limit checks (research-trace), and "at least one of" checks (research-trace references).
- **Tests:** keep the 65 pass/fail cases green; add cases for alias normalization, clamp, defaults, and `ValidationError.details` shape. **Gate:** `pnpm test` → `pnpm run build`. Target ~70% reduction of `validation.ts`.

### Item 2 — config/env grouping + minimal local recipe
- Refactor `AppConfig` into nested objects: `storage`, `model`, `backup`, `userStyle`, `worktree`, `errorLog`, `atlas`, plus a top-level `http`/`context` group as needed.
- **Env-var string names stay identical** — only the in-code `AppConfig` shape and the 9 consumers' access paths change. The typed nested interface makes the compiler flag every consumer that must be updated.
- Produce a documented minimal local set (feeds SP4): `TUBEROSA_STORE`, `TUBEROSA_CACHE`, `TUBEROSA_MODEL_PROVIDER`, `TUBEROSA_HTTP_HOST`, plus `DATABASE_URL`/`REDIS_URL` when postgres/redis.
- **Tests:** unit-test `loadConfig()` nested shape + defaults for representative vars. **Gate:** `pnpm run build` → `pnpm test`.

### Item 3 — MCP tool grouping (organization, not removal)
- Add a `category: 'core' | 'admin-ops' | 'diagnostics'` annotation to each tool entry and order the array by category. The MCP `tools/list` protocol response stays a flat list (no protocol change); the category is for in-code organization and optional description prefixes.
- Verify-then-merge the two overlap pairs: only merge `list_error_logs`+`collect_error_logs` (and `atom_gate_stats`+`atom_graph_density`) if their semantics are genuinely redundant; otherwise leave them and document why. No tool that an agent or ops path depends on is dropped.
- **Tests:** assert tool count and names after any merge; keep dispatch tests green. **Gate:** `pnpm run eval:agent-context` + MCP/api-boundary tests.

### Item 4 — storage parity bug + safe de-dup (chosen depth: parity bug + provably-identical pure helpers)
- Create `src/storage/shared/label-provenance.ts` exporting `mergeLabelProvenanceIntoMetadata`, `buildLabelProvenanceMap`, `LABEL_PROVENANCE_METADATA_KEY`. Import from both stores.
- Fix the parity bug: `memory-store.updateKnowledge` now calls `mergeLabelProvenanceIntoMetadata` exactly as postgres does (provenance merged before namespace derivation).
- Then extract only provably-identical pure helpers (e.g. search-ranking comparators, relation-validity predicates) where the two stores already do the same thing. Measure LOC saved; stop where parity risk rises. No forced 27% target.
- **Tests:** write a **failing test first** proving memory-store writes label provenance on `updateKnowledge` with labels; parity tests on each extracted helper. **Gate:** `pnpm test` → `pnpm run test:integration` (Docker; if the stack is down, state that and rely on memory-store + postgres unit coverage).

### Item 5 — provably-dead removal
- No removals (see §2.1). Document the three false-deads. Optionally add a one-line note to the audit doc so the finding is not lost.

### Item 6 — merge 3 eval fixture loaders → 1
- One generic, parametrized loader in `src/evaluation/fixture-loader.ts` covering the three fixture shapes (retrieval, context-mapping, knowledge-completeness). Delete the two extra files.
- **Tests:** every eval suite loads unchanged through the new loader. **Gate:** all `eval:*` scripts + `pnpm test`.

### Item 7 — thread resolved retrieval policy (clarity only)
- Read `getRetrievalPolicy()` once at the top of `searchContext`, pass the resolved policy object down to the helpers that currently re-read it (9 call sites). Behavior-identical; the policy is already cached, so this is clarity, not performance.
- **Gate:** `pnpm run eval:retrieval` must stay green. No heuristic change expected; if any heuristic would change, add a failing fixture first.

## 5. Sequencing

`1 → 2 → 3 → 4 → 6 → 7`, with item 5 folded in as the verification note. One commit per item, each after its gate is green.

## 6. Non-goals (out of scope)

HTTP response slimming (no in-repo consumer); SP1 Fix 3 (fit `ready→needs_confirmation` downgrade); the LEARN pillar (SP2); atlas changes; any feature removal; hunting for dead code beyond the three named targets.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Storage parity drift (item 4) | parity-first; shared helper called identically by both stores; failing-test-first; integration gate; conservative depth |
| zod error-shape drift (item 1) | single `parseOrThrow` adapter; `errors.ts` unchanged; added `details`-shape tests; tests are pass/fail, not message-exact |
| config nesting churn across 9 consumers (item 2) | env-var names unchanged; typed nested interface so the compiler flags every missed consumer |
| Accidentally dropping a needed MCP tool (item 3) | verify-then-merge only; assert tool names after merge; organization not removal |
| Retrieval regression from policy threading (item 7) | `eval:retrieval` gate green; no heuristic change |

## 8. Global constraints honored

Eval-first / no threshold-lowering; `eval:retrieval` green before any retrieval/classifier/fusion/context-fit/context-pack change and a failing fixture before any heuristic change; session changes gated by `eval:agent-context`; store parity across postgres-store and memory-store; MCP stdout protocol-only; run one `pnpm` command at a time (Node 22.21.1); branch off `main` before committing; no `Co-Authored-By: Claude` trailer; plain-language reporting for a non-native English owner.
