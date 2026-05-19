# Tuberosa Handoff

## Goal

Improve Tuberosa's retrieval quality and signal-to-noise ratio so that context packs give agents direct, actionable evidence — not generic workflow boilerplate. The target is a system that can confidently surface its own source code as evidence for implementation/debugging tasks, suppress chronically noisy items, and produce fit scores that agents can trust.

---

## Current State

**All tests passing: 104/104. Retrieval eval: 11/11 (all metrics at 100%). Agent-context eval: pass. Build: clean.**

Nine defects resolved across two sessions:

| # | Defect | Status |
|---|--------|--------|
| 1 | Tuberosa's own source files not indexed — zero `code_ref` items in store | Fixed: `seed:self` ran, 25 files / 111 items ingested |
| 2 | `selected_but_noisy` feedback added `+0.02` (inverted penalty) | Fixed: now subtracts `-0.03` per occurrence |
| 3 | "Walk", "Debug", "Explain" etc. extracted as PascalCase symbols | Fixed: 34 verbs added to `SYMBOL_STOP_WORDS` |
| 4 | `exploration` task type always scored `insufficient` (workflow items not counted) | Fixed: `workflow` added to exploration-aligned types |
| 5 | Hyphenated terms (`intent-suppression`, `selected_but_noisy`) not in `exactTerms` | Fixed: `extractCompoundTerms()` added to classifier |
| 6 | `usefulnessReason` always returned boilerplate template | Fixed: matched files/symbols now appended to reason |
| 7 | `searchMetadata` scored all label types equally — broad `domain`/`business_area` labels scored same as precise `file`/`symbol`/`error` | Fixed: precise labels score 0.94; broad labels score 0.82 |
| 8 | `fusion.ts` `matchReasons` only scanned text content — items matched via file/symbol labels got no `file:` reason | Fixed: label values checked alongside text content |
| 9 | `usefulnessReason` matched-signal suffix only applied to `workflowGuidance` | Fixed: extracted `extractMatchedSignals()` helper applied to all categories |

---

## Files Actively Edited

| File | Change |
|------|--------|
| `src/retrieval/classifier.ts` | Added 34 words to `SYMBOL_STOP_WORDS`; added `extractCompoundTerms()` function; wired into `exactTerms` |
| `src/retrieval/context-fit.ts` | Added `'workflow'` to `taskAlignedItemTypes()` for `exploration` case |
| `src/retrieval/service.ts` | Fixed `feedbackScoreAdjustment()` — separated noisy penalty from selected boost |
| `src/retrieval/context-pack.ts` | Extracted `extractMatchedSignals()` helper; applied to `priorLessons`, `workflowGuidance`, and `adjacentContext` |
| `src/retrieval/fusion.ts` | `matchReasons()` now checks candidate `labels` array (by type) alongside text content for file/symbol/error signals |
| `src/storage/postgres-store.ts` | `searchMetadata()` splits terms into `preciseTerms` (file/symbol/error) vs `broadTerms`; CASE WHEN scores precise matches at 0.94, broad at 0.82; ORDER BY raw_score DESC |
| `eval/retrieval-fixtures.json` | Updated `stale-auth-rejection` fixture: `expectedContextFitStatus` changed from `insufficient` to `needs_confirmation` (correct new behavior) |
| `scripts/seed-tuberosa-src.ts` | New script — ingests Tuberosa's own `src/` and `docs/` into the knowledge store |
| `package.json` | Added `"seed:self": "tsx scripts/seed-tuberosa-src.ts"` |

---

## Everything Tried That Failed or Needed Correction

**`ingestFiles` wrong call signature**
- First attempt called `services.ingestion.ingestFiles(allFiles)` with one argument.
- Actual signature: `ingestFiles(project: string, files: IngestFileInput[], options?: IngestFilesOptions)`.
- Fix: changed to `services.ingestion.ingestFiles(PROJECT, allFiles)`.

**`stale-auth-rejection` fixture regression**
- Adding `'workflow'` to exploration-aligned item types raised the fit score for this case from `insufficient` to `needs_confirmation`.
- Resolution: the new behavior IS correct — when a relevant `workflow` item is found for an exploration query, `needs_confirmation` is the right fit status. The fixture was calibrated against the old wrong behavior. Updated fixture accordingly.

---

## Improve Plan — Next Steps

### Immediate (no blockers)

1. **Re-evaluate the three chronic noisy items** — with the inverted feedback penalty and tiered label scoring now applied, run a few sessions and check if "Own backup schedulers", "Debounce physical mirror", "Run migrations" are losing rank. They have 3–4 noisy feedbacks each; tiered scoring now demotes them when matched only by broad `domain` labels.

2. **Verify `code_ref` items surface in context packs** — start a new session with prompt "add BM25 reranker to retrieval pipeline" and confirm `src/model/provider.ts` and `src/retrieval/fusion.ts` appear in `essential` with `evidenceCategory: directTaskEvidence`. These are now indexed and will surface via both the label-tier scoring (file labels score 0.94) and the fusion label-match reason path.

3. **Process pending reflection drafts** — 12 drafts are in `needs_changes` or `pending` state. Use `tuberosa_list_reflection_drafts` and `tuberosa_review_reflection_draft` to approve or reject them.

### Longer term

4. **Topic/domain scoping** — add `metadata.domain` to knowledge items so items about `ops/backup` don't score against `retrieval` task contexts. This goes beyond tiered scoring and would filter candidates at the search stage.

5. **Context-fit usefulnessReason for `directTaskEvidence`** — the current string `"Direct task evidence from X, Y, Z."` uses `directSignals` (classification outputs), not matched file/symbol reasons. Consider appending matched signals here too for consistency.

6. **Re-seed when source files change** — `pnpm run seed:self` is idempotent (upserts by path), but should be re-run after significant source refactors so code_ref chunks stay current.

---

## Audit Checklist

- [x] `pnpm test` → 104/104 pass
- [x] `pnpm run eval:retrieval` → all 11 cases PASS, all metrics at 100%
- [x] `pnpm run eval:agent-context` → pass
- [x] `pnpm run build` → no TypeScript errors
- [x] `pnpm run seed:self` → ran successfully, 25 files / 111 items ingested
- [ ] Manual smoke-test: `tuberosa_search_context` with `prompt: "add BM25 reranker"` → includes `code_ref` items for `src/model/provider.ts` or `src/retrieval/service.ts` with `file:` match reasons
- [ ] Manual smoke-test: `tuberosa_search_context` with `prompt: "Walk me through the agent session lifecycle"` → classifier `symbols: []` (no false "Walk" symbol)
- [ ] Manual smoke-test: `tuberosa_search_context` with `prompt: "why is intent-suppression not applying"` → `exactTerms` contains `intent-suppression`
- [ ] Manual smoke-test: verify backup/mirror/migrations items have lower rank after tiered scoring — they match via `domain` label, not `file`/`symbol`, so they should now score at 0.82 instead of 0.94 in metadata search
- [ ] Restart MCP server to activate all code changes in live process

---

## Eval Fixture Change Note

`eval/retrieval-fixtures.json` — `stale-auth-rejection` case:
- **Before:** `expectedContextFitStatus: "insufficient"`
- **After:** `expectedContextFitStatus: "needs_confirmation"`
- **Why:** Adding `workflow` to exploration-aligned item types correctly raises fit for this case since `current-auth-flow` is a workflow item that IS the right answer. The stale rejection (`legacy-auth-flow` excluded) still passes at 100%. This is a fixture correction for correct new behavior, not a threshold hack.
