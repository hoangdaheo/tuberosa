# SP1 — Retrieval Correctness (design)

Date: 2026-06-02
Engagement: Tuberosa de-bloat / simplify (sub-project 1 of 4). See
`docs/tuberosa-debloat-audit-2026-06-02.md` for the full audit and roadmap.
Owner decisions on file: LEARN pillar = wire-up (SP2), ops = keep, surfaces = keep both.

## 1. Problem

A live `tuberosa_start_session` on a plain-English prompt reproduced every owner complaint:

1. **Classifier turns English words into code symbols.** `Simplify`, `Build`, `Provide`,
   `Create` were extracted as `symbols`, polluting `exactTerms` and producing
   `missing symbol:Simplify` signals → an off-target pack.
2. **The returned pack is huge.** `start_session` output was 56,186 chars and exceeded the
   MCP token limit. Each candidate serializes `content` (≤2800) + `contextualContent`
   (≤3600) + ~12 scoring/diagnostic fields. The "compact pack" is unreadable in one shot.
3. Secondary: fit is downgraded `ready→needs_confirmation` even at high score; the review
   queue over-fetches; retrieval policy is re-read 23× per search.

### Root causes (verified against source)

- **Classifier** (`src/retrieval/classifier.ts`):
  - `extractSymbols` (line 497) collects PascalCase via `/\b[A-Z][A-Za-z0-9_]{2,}\b/`
    (line 500) — matches **any** capitalized word.
  - `isSymbolStopWord` (line 889) only drops a word if it is in `SYMBOL_STOP_WORDS`.
    `Simplify`/`Provide` are in **neither** stop-list → always kept.
  - For words that *are* in both lists (`Build`, `Create`), the verb rule (line 894) keeps
    them as symbols unless they appear in the **first sentence** (`firstSentenceContains`,
    line 901). Multi-paragraph prompts put imperative verbs in later lines → kept as symbols.
- **Pack size** (`src/retrieval/context-pack.ts` + `src/types/retrieval.ts`):
  - `sanitizeItems` (line 1234) truncates `content`→2800 and `contextualContent`→3600 but
    keeps **both** (they overlap heavily) and every scoring field on `RankedCandidate`
    (`types/retrieval.ts:188-200`: `fusedScore`, `rerankScore`, `finalScore`, `matchReasons`,
    `fitScore`, `fitReasons`, `fitMissingSignals`, `evidenceCategory`, `evidenceStrength`,
    `usefulnessReason`, `actionableMissingSignals`) plus full `labels`, `references`, `metadata`.
- **Fit** (`src/retrieval/context-fit.ts:230`): blanket `ready→needs_confirmation` whenever
  `rerankerAvailable` is false.
- **Review queue** (`src/retrieval/service.ts:73`): `REVIEW_QUEUE_STATUS_LIMIT = 24`, fetched
  across 6 status queries (line ~985) = 144 rows; only ~12 are used.

## 2. Scope

In scope — five fixes (priority 1 and 2 are the headline):

1. Classifier symbol over-extraction.
2. Returned-pack size.
3. Fit over-downgrade.
4. Review-queue over-fetch.
5. Retrieval-policy pre-compute (internal refactor, no behavior change).

Non-goals: atom/learning changes (SP2), validation/config/tooling (SP3), docs/skills (SP4),
fusion-weight retuning, reranker changes.

## 3. Design per fix

### Fix 1 — Classifier symbol extraction

**Rule:** a code symbol has *internal structure* or is *explicitly marked*. Keep a PascalCase
candidate only when it has an inner uppercase letter or a digit/underscore/dot (true
`FooBar`, `v2Client`, `AWS_REGION`), OR it was back-ticked, suffixed (`…Service` etc., the
existing `camelCase` lane line 499), or a `foo(` call (existing `functions` lane line 502).
A lone `Capital`+lowercase word (`Simplify`, `Provide`, `Build`, `Create`, `Fully`, `English`)
is treated as English and dropped.

**Change:** in `extractSymbols`, replace the broad pascalCase regex with one that requires
internal structure, e.g. keep `value` only if `/[a-z0-9].*[A-Z]/.test(value) || /[._]/.test(value)`
(an inner cap after a lower char, or contains `.`/`_`). Back-ticked code spans (line 498) are
unaffected and still admit any identifier the user explicitly marked. Keep the existing
stop-lists and `isSymbolStopWord` as a secondary net. Also fix `firstSentenceContains` →
`promptContainsAsImperativeLine` so an imperative verb anywhere as a leading word on a line is
recognised (handles bullets / multi-paragraph prompts). The stop-list refinement is secondary;
the regex tightening is the load-bearing change.

**Tradeoff:** a bare single-word symbol with no internal caps and no back-ticks (`User`,
`Order`) is no longer auto-detected. Accepted: rare, and such names are normally back-ticked or
suffixed. Verified: all 4 symbols in the current eval fixtures (`PaywallSelectionModal`,
`SenderIdentityPolicy`, `MediaUploadHandler`, `SenderQueue`) have internal capitals → unaffected.

**Eval-first:** add a fixture case with a multi-line plain-English prompt (mirroring this
engagement's prompt) whose `expectedClassification.symbols` is `[]`. It fails today (leaks
`Simplify` etc.), passes after. Existing classification rates must stay = 1.

### Fix 2 — Returned-pack size

**Verified mechanism:** the MCP response already uses a projection — `contextPackShortlist`
(`src/mcp/server.ts:578`) — and it omits `content`/`contextualContent`. The 56 KB comes from
three places, not from raw candidate content:
1. **Inlined deep context** (`server.ts:612-624`): when `includeDeepContext:true` and fit isn't
   `insufficient`, the response inlines `pack.deepContext` **verbatim**. `buildDeepContext`
   (`service.ts:1144`) is bounded only by `deepContextBudget`, whose default is ~100k tokens →
   a huge chunk dump. This is the dominant driver.
2. **Per-item diagnostics** (`server.ts:600-606`): every shortlist item carries `fitReasons`,
   `fitMissingSignals`, `actionableMissingSignals`, `evidenceStrength`, `usefulnessReason`.
3. **Verbose `classified`** (`server.ts:589`): the full `ClassifiedQuery` including `lexicalQuery`,
   `preprocessing`, and `intent` internals.

**Rule:** the MCP/HTTP **response** carries only what an agent reads; the **stored** pack
(`saveContextPack`) and `debug:true` keep full fidelity.

**Change (all at the serialization boundary, `contextPackShortlist`):**
- **Bound the inlined deep context.** Add `boundDeepContextForResponse(deepContext, ceiling)`
  that caps items per section (≤3), truncates each chunk's content (~1200 chars), and stops at a
  total response ceiling (~10k tokens). When it truncates, set `deepContextTruncated: true` and
  the instruction tells the agent to call `tuberosa_get_context_pack` for the full chunks (which
  read the full stored pack). Do **not** lower the stored `deepContextBudget`.
- **Trim per-item fields** in the shortlist to: `knowledgeId`, `title`, `itemType`, `project`,
  `score` (`finalScore`), `reasons` (`matchReasons`), `evidenceCategory`, top ~3 `references`,
  and `fitScore`. Drop `fitReasons`, `fitMissingSignals`, `actionableMissingSignals`,
  `evidenceStrength`, `usefulnessReason` from the per-item response (still in stored/debug).
- **Slim `classified`** in the response to `{project, taskType, confidence, files, symbols,
  errors, technologies, businessAreas}`; drop `lexicalQuery`, `preprocessing`, and `intent`
  internals (kept in the stored pack).
- `debug:true` returns the full pack unchanged; `saveContextPack` stores the full pack.

**Test-first:** an MCP-level test (via `handleMcpRequest`) runs `search_context` with
`includeDeepContext:true` against a store seeded with large chunks and asserts the serialized
result stays under a byte ceiling (e.g. < 24 KB) and that `deepContextTruncated`/instruction is
set; a second case asserts `debug:true` still returns full fields. `eval:retrieval` operates on
the service (full pack) and stays green.

### Fix 3 — Fit over-downgrade

**Change:** in `context-fit.ts`, only force `ready→needs_confirmation` on reranker
unavailability when `fitScore < ready + margin` (e.g. keep `ready` if `fitScore ≥ 0.80`).
Always still record `reranker_unavailable` in `notes`. The hash reranker used by the eval is
*available*, so this branch does not fire there; behavior on the eval is unchanged.

**Eval-first:** add a fixture where the reranker is available and a strong result must remain
`ready` (guards against regressing the common path). A dedicated unit test covers the
reranker-unavailable + high-score case keeping `ready`.

### Fix 4 — Review-queue over-fetch

**Change:** lower `REVIEW_QUEUE_STATUS_LIMIT` 24 → 8 (6×8 = 48 fetched; top ~12 used). Pure
efficiency; the selected top-N is unchanged for any realistic queue. No eval/behavior change.

### Fix 5 — Policy pre-compute — DEFERRED to SP3

On inspection, `getRetrievalPolicy()` is already memoized after the first read (`policy.ts`
caches), so the "23 reads" are cheap cache hits, not 23 file loads. Threading the resolved
policy through ~23 call sites is a real-regression-risk refactor for near-zero runtime gain.
**Deferred to SP3** (boilerplate/clarity cleanup), where it belongs. SP1 ships Fixes 1–4.

## 4. Verification

Order (one `pnpm` at a time):
1. `pnpm run eval:retrieval` — hitRate=1, staleRejectionRate=1, all classification rates=1.
   New fixtures fail before their fix, pass after. Thresholds are **not** lowered.
2. `pnpm run build`
3. `pnpm test` (includes the new projection + fit unit tests)
4. `git diff --check`

## 5. Risks

- Fix 1 could drop a real bare symbol — mitigated by the internal-structure rule + back-tick
  escape hatch; verified against current fixtures.
- Fix 2 changes the response shape consumed by agents — intended; SP4's agent skill documents
  the slim shape. Storage/replay/debug keep full fidelity.
- Fix 3 touches fit scoring — gated by a new fixture proving the common path stays `ready`.

## 6. Open questions

None blocking. Field list for Fix 2 may be tuned during implementation if a kept field proves
unnecessary (will not add fields beyond the list above without noting it).
