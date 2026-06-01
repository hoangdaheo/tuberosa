# Project Knowledge-Book — Phase 4b (Bootstrap) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Fresh-session note:** Needs only this file + the master spec (`docs/superpowers/specs/2026-05-31-project-knowledge-book-design.md`, §7.1 bootstrap) + the repo. Do **Phase 4a first** (it provides the convention-draft → atom approval path, the `distillation_evidence` gate, and the convention metadata contract this phase writes into). Branch off the latest knowledge-book branch or `main`.

**Goal:** First-time `init`: surface a project's likely conventions so the calling agent can propose them as reviewable convention drafts. A new `tuberosa_bootstrap_handbook` tool returns DETERMINISTIC extraction inputs (detected stack, existing-doc excerpts, recurring-pattern hints) plus an instruction; the agent distills them into conventions via `tuberosa_reflect` (which Phase 4a routes to convention atoms on approval). The `tuberosa bootstrap` CLI gains a non-fatal stage that points the user at the agent tool.

**Architecture (key constraint):** No internal text-generation seam — so bootstrap CANNOT itself author conventions. It assembles deterministic *evidence* (the same kind the atlas already gathers: detected scripts, README/CONTRIBUTING excerpts, area model) and hands it to the calling agent, which proposes draft conventions. Bootstrap output is **review-gated** (master spec §7.1): drafts land pending for one-time human confirmation, not auto-activated.

**Tech Stack:** TypeScript (Node 22, ESM, `.js` suffixes; tests import `.js`), `node --test` + `tsx`.

> **Before coding:** `npx gitnexus analyze`. Keep `pnpm run build && pnpm test` green per commit. This phase doesn't touch retrieval ranking; `pnpm run eval:retrieval` should remain green.

---

### Task 1: Deterministic extraction-inputs assembler

**Files:**
- Create: `src/curation/bootstrap-extract.ts` (`assembleExtractionInputs`)
- Test: `test/bootstrap-extract.test.ts`

**Read first:** `src/atlas/inputs.ts:78-108` (`gatherAtlasInputs` — it already collects `scripts`, `readmeCommands`, `areas` via `buildAreaModel`; reuse this rather than re-deriving). `src/bootstrap/service.ts:34-116` (`run` stages). Decide whether to reuse `gatherAtlasInputs` output directly (preferred — it already has the deterministic signals) vs. a new gather.

- [ ] **Step 1:** Write `test/bootstrap-extract.test.ts`. Define `assembleExtractionInputs(atlasInputs: AtlasInputs, docs?: { readme?: string; contributing?: string }): ExtractionInputs` returning `{ detectedTech: string[]; areas: {key,label,fileCount}[]; scripts: Record<string,string>; docExcerpts: {source,excerpt}[]; recurringHints: string[] }`. Test: given `AtlasInputs` with scripts (`pnpm test`, `tsc`) and area model, plus a README excerpt, it returns detectedTech (e.g. infers `typescript` from tsconfig/scripts) and surfaces the doc excerpt and area summaries. Deterministic (same input → same output). FAIL first.

- [ ] **Step 2:** Implement `src/curation/bootstrap-extract.ts` as a PURE function over `AtlasInputs` (+ optional doc strings the caller reads from disk). Derive `detectedTech` from `scripts`/area file extensions (simple keyword detection: `tsc`/`.ts`→typescript, `react`/`.tsx`→react, `pnpm`→pnpm, `migrate`/`.sql`→postgres). Truncate doc excerpts deterministically. No model calls, no Date.now.

- [ ] **Step 3:** Test PASS; `pnpm run build && pnpm test` green. **Commit:** `feat(curation): deterministic bootstrap extraction-inputs assembler`.

---

### Task 2: `tuberosa_bootstrap_handbook` MCP tool

**Files:**
- Modify: `src/curation/service.ts` (add `bootstrapHandbook` — Phase 4a created this service; if not, create it), `src/mcp/server.ts` (handler near `tuberosa_get_atlas` 546-559; schema near 1638-1649)
- Test: `test/bootstrap-handbook-tool.test.ts` + MCP dispatch test

**Read first:** `src/mcp/server.ts:546-559` (`tuberosa_get_atlas` handler — it builds an `AtlasService` and calls `regenerate`; mirror to get `AtlasInputs`) and `:165-172` (`tuberosa_reflect` handler) for the registration pattern.

- [ ] **Step 1:** Write `test/bootstrap-handbook-tool.test.ts`: `CurationService.bootstrapHandbook({ project, repoPath })` returns `{ extraction: ExtractionInputs, instruction: string }` where `instruction` tells the agent to propose one convention per recurring hint / tech via `tuberosa_reflect` with `metadata.convention=true, curationSource:'bootstrap', scope:'project'|'team', category, steps, trigger, evidenceAtomIds:[]` and that bootstrap drafts are review-gated. FAIL first.

- [ ] **Step 2:** Implement `bootstrapHandbook` in `src/curation/service.ts`: gather `AtlasInputs` (via `gatherAtlasInputs(store, {...})`), read README/CONTRIBUTING from `repoPath` if present (best-effort), call `assembleExtractionInputs`, return `{ extraction, instruction }`. Register `tuberosa_bootstrap_handbook` in `src/mcp/server.ts` (handler + schema: required `project`, optional `repoPath`), mirroring `tuberosa_get_atlas`. Add an MCP dispatch test.

- [ ] **Step 3:** `pnpm run build && pnpm test` green. **Commit:** `feat(curation): tuberosa_bootstrap_handbook tool (agent-driven convention extraction)`.

---

### Task 3: `tuberosa bootstrap` CLI convention-extraction stage (non-fatal)

**Files:**
- Modify: `src/bootstrap/service.ts` (`run` ~34-116; add a stage after atlas, before health), `bin/commands/bootstrap.ts` (optional `--no-conventions` flag), and the `BootstrapReport` type
- Test: extend `test/bootstrap*.test.ts` (find it: `ls test/ | grep bootstrap`)

**Read first:** `src/bootstrap/service.ts:34-116` — the stage pattern (each stage is wrapped in try/catch, pushes to `warnings` on failure, contributes to `nextActions`).

The CLI runs without an agent in the loop, so it can only PREPARE and POINT. The stage assembles `ExtractionInputs` (reusing the atlas inputs already computed in the atlas stage) and adds a `conventions` summary to the report + a `nextActions` line: "Run `tuberosa_bootstrap_handbook project=<p>` (agent) to distill N candidate signals into convention drafts."

- [ ] **Step 1:** Write/extend a bootstrap-service test asserting `run(...)` populates `report.conventions = { candidateSignalCount: N }` and a `nextActions` entry mentioning `tuberosa_bootstrap_handbook`, and that a failure in this stage is NON-FATAL (pushed to `warnings`, run still succeeds). FAIL first.

- [ ] **Step 2:** Add a `conventions?: { candidateSignalCount: number }` field to `BootstrapReport`. In `run`, after the atlas stage (reuse its `AtlasInputs`/contents — or re-gather), call `assembleExtractionInputs`, set `report.conventions`, and push the `nextActions` line. Wrap in try/catch → `warnings` (non-fatal), matching the atlas/health stages. Add an optional `--no-conventions` CLI flag in `bin/commands/bootstrap.ts` to skip it.

- [ ] **Step 3:** `pnpm run build && pnpm test` green. **Commit:** `feat(bootstrap): non-fatal convention-extraction stage pointing to bootstrap_handbook`.

---

## Phase 4b Definition of Done
- `assembleExtractionInputs` deterministically derives tech/areas/scripts/doc-excerpts/recurring-hints from `AtlasInputs`.
- `tuberosa_bootstrap_handbook` returns extraction inputs + an agent instruction; proposed conventions flow through `tuberosa_reflect` → (Phase 4a) review → convention atoms; bootstrap drafts are review-gated.
- `tuberosa bootstrap` CLI surfaces a non-fatal convention-extraction summary + a next-action pointing at the agent tool.
- `pnpm run build && pnpm test` green; `pnpm run eval:retrieval` green (untouched).

## Risks
| Risk | Mitigation |
|---|---|
| Tech detection is naive | v1 keyword heuristic is fine; the agent refines during distillation. Keep it deterministic. |
| Re-gathering AtlasInputs is slow in bootstrap | Reuse the inputs already computed by the atlas stage in `run`. |
| Bootstrap auto-creating conventions without review | Do NOT auto-create; bootstrap only PREPARES; drafts are review-gated per master spec §7.1. |
