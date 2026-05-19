# Tuberosa Handoff

## Goal

Improve Tuberosa's retrieval quality and signal-to-noise ratio so that context packs give agents direct, actionable evidence — not generic workflow boilerplate. The target is a system that can confidently surface its own source code as evidence for implementation/debugging tasks, suppress chronically noisy items, and produce fit scores that agents can trust.

---

## Current State

**All tests passing: 104/104. Retrieval eval: 11/11 (all metrics at 100%). Agent-context eval: pass.**

Six defects were identified via a live evaluation session (three probes: BM25 implementation, stale-item debugging, session lifecycle exploration) and resolved in this session:

| # | Defect | Status |
|---|--------|--------|
| 1 | Tuberosa's own source files not indexed — zero `code_ref` items in store | Seed script written, awaiting first run |
| 2 | `selected_but_noisy` feedback added `+0.02` (inverted penalty) | Fixed: now subtracts `-0.03` per occurrence |
| 3 | "Walk", "Debug", "Explain" etc. extracted as PascalCase symbols | Fixed: 34 verbs added to `SYMBOL_STOP_WORDS` |
| 4 | `exploration` task type always scored `insufficient` (workflow items not counted) | Fixed: `workflow` added to exploration-aligned types |
| 5 | Hyphenated terms (`intent-suppression`, `selected_but_noisy`) not in `exactTerms` | Fixed: `extractCompoundTerms()` added to classifier |
| 6 | `usefulnessReason` always returned boilerplate template | Fixed: matched files/symbols now appended to guidance reason |

---

## Files Actively Edited This Session

| File | Change |
|------|--------|
| `src/retrieval/classifier.ts` | Added 34 words to `SYMBOL_STOP_WORDS`; added `extractCompoundTerms()` function; wired into `exactTerms` |
| `src/retrieval/context-fit.ts` | Added `'workflow'` to `taskAlignedItemTypes()` for `exploration` case |
| `src/retrieval/service.ts` | Fixed `feedbackScoreAdjustment()` — separated noisy penalty from selected boost |
| `src/retrieval/context-pack.ts` | Updated `usefulnessReason()` — extracts `file:` and `symbol:` from `matchReasons` for `workflowGuidance` items |
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
- Initial concern: the CLAUDE.md rule says "do not adjust thresholds to make tests pass — fix the logic."
- Resolution: the new behavior IS correct — when a relevant `workflow` item is found for an exploration query, `needs_confirmation` is the right fit status (not `insufficient`). The fixture was calibrated against the old wrong behavior. Updated fixture accordingly.
- All other 10 cases unaffected; all retrieval quality metrics remain at 100%.

---

## Pending: Run the Seed Script

The largest remaining gap — no `code_ref` items for Tuberosa's own codebase — is fixed in code but **not yet applied to the running Postgres instance**. The seed script is ready:

```bash
pnpm run seed:self
```

This will ingest ~20 source files across `src/retrieval/`, `src/model/`, `src/agent-session/`, `src/ingest/`, `src/storage/`, `src/operations/`, `src/mcp/` as `code_ref` items, plus all `docs/*.md` as atomic `wiki` items.

After running, smoke-test with a BM25 probe to confirm `src/model/provider.ts` and `src/retrieval/fusion.ts` now surface in context packs for retrieval implementation tasks.

---

## Improve Plan — Next Steps

### Immediate (after seed:self runs)

1. **Smoke-test the seed output** — run `tuberosa_search_context` with a prompt like "add BM25 reranker to retrieval pipeline" and verify that `src/model/provider.ts` and `src/retrieval/fusion.ts` appear in the `essential` section with `evidenceCategory: directTaskEvidence`.

2. **Re-evaluate the three chronic noisy items** — with the inverted feedback penalty now applied, query `tuberosa_collect_context_quality_feedback` after a few sessions to confirm "Own backup schedulers", "Debounce physical mirror", and "Run migrations" are losing rank. If they still dominate, consider adding explicit `task_type` scope labels to those items to narrow when they fire.

3. **Add a `domain` label filter to `searchMetadata`** — the root cause of the noisy items is that label matching in `postgres-store.ts:searchMetadata()` (lines ~806–850) treats all label types equally. Prefer `file`, `symbol`, `error` labels over `domain`, `business_area` matches when scoring metadata candidates. This would be a retrieval-layer fix rather than a data-quality fix.

### Longer term

4. **Context-fit usefulnessReason for non-workflow categories** — the `priorLessons` and `adjacentContext` categories could also benefit from showing matched signals, not just `workflowGuidance`.

5. **Topic/domain scoping** — add `metadata.domain` to knowledge items so that items about `ops/backup` don't score against `retrieval` task contexts.

---

## Audit Checklist for Previous Changes

Before merging or continuing, verify:

- [ ] `pnpm test` → 104/104 pass
- [ ] `pnpm run eval:retrieval` → all 11 cases PASS, all metrics at 100%
- [ ] `pnpm run eval:agent-context` → pass
- [ ] `pnpm run build` → no TypeScript errors
- [ ] `pnpm run seed:self` → runs without error, logs ~20+ ingested items
- [ ] Manual smoke-test: `tuberosa_search_context` with `prompt: "add BM25 reranker"` now includes `code_ref` items for `src/model/provider.ts` or `src/retrieval/service.ts`
- [ ] Manual smoke-test: `tuberosa_search_context` with `prompt: "Walk me through the agent session lifecycle"` → classifier `symbols: []` (no false "Walk" symbol)
- [ ] Manual smoke-test: `tuberosa_search_context` with `prompt: "why is intent-suppression not applying"` → `exactTerms` contains `intent-suppression`
- [ ] Review: `feedbackScoreAdjustment` in `src/retrieval/service.ts` — confirm items with high `selectedNoisyCount` are now scoring lower than before. The three chronic offenders (backup scheduler, physical mirror, migrations) each have 3–4 noisy feedbacks; their score adjustment should now be negative net.

---

## Eval Fixture Change Note

`eval/retrieval-fixtures.json` — `stale-auth-rejection` case:
- **Before:** `expectedContextFitStatus: "insufficient"`
- **After:** `expectedContextFitStatus: "needs_confirmation"`
- **Why:** Adding `workflow` to exploration-aligned item types correctly raises fit for this case since `current-auth-flow` is a workflow item that IS the right answer. The stale rejection (`legacy-auth-flow` excluded) still passes at 100%. This is a fixture correction for correct new behavior, not a threshold hack.
