# SP1 — Retrieval Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three demonstrated-cause retrieval bugs — the classifier turning English words into code symbols, the oversized MCP response (56 KB, exceeds the token limit), and the review-queue over-fetch — without lowering any eval threshold.

**Architecture:** Eval/test-first. Fix 1 tightens one regex in the classifier so a lone capitalized word is no longer a symbol. Fix 2 slims the MCP response at the `contextPackShortlist` boundary (bound the inlined deep context, trim per-item diagnostics, slim `classified`) while the stored pack and `debug:true` keep full fidelity. Fix 4 lowers a fetch constant. Spec: `docs/superpowers/specs/2026-06-02-sp1-retrieval-correctness-design.md`.

**Tech Stack:** TypeScript, `node:test` (run via `tsx`), pnpm, deterministic eval fixtures (hash provider, memory store).

**Scope note — deferred from the original 5 fixes:**
- **Fix 3 (fit over-downgrade): DEFERRED.** The live `needs_confirmation` came from a genuinely low score (top-1 0.46) with the reranker *available* — not from the reranker-fallback downgrade this fix targets. It also needs a hand-built `ContextFitEvaluator` unit test. Revisit after SP1.
- **Fix 5 (policy pre-compute): DEFERRED to SP3.** `getRetrievalPolicy()` is already memoized; the 23 reads are cheap cache hits. Pure clarity refactor — batch it with SP3.

**Node version:** if the shell uses an older Node, prefix commands with
`PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH`. Run only one `pnpm` command at a time.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `eval/retrieval-fixtures.json` | modify | add a plain-English case asserting `symbols: []` |
| `src/retrieval/classifier.ts` | modify | tighten PascalCase symbol extraction (`extractSymbols`, ~497) + add `hasSymbolStructure` helper |
| `src/mcp/server.ts` | modify | export + use `projectShortlistItem`, `slimClassified`, `boundDeepContextForResponse`; trim `contextPackShortlist` (~578); full fidelity when `debug` |
| `test/context-pack-shortlist.test.ts` | create | unit tests for the three pure projection helpers |

---

## Task 1: Fix the classifier symbol over-extraction (eval-first)

**Files:**
- Modify: `eval/retrieval-fixtures.json` (the `cases` array)
- Modify: `src/retrieval/classifier.ts:497-505` (`extractSymbols`) and add a helper near `isLikelyDocumentIdentifier` (~906)
- Test: `pnpm run eval:retrieval`

- [ ] **Step 1: Add the failing fixture case**

In `eval/retrieval-fixtures.json`, append this object to the `cases` array (mind the trailing comma on the previous element):

```json
{
  "id": "classifier-no-symbol-from-plain-verbs",
  "prompt": "Simplify the indexer and Provide a short summary of what changed.",
  "taxon": "nl_to_code",
  "expectedClassification": {
    "symbols": []
  }
}
```

Rationale: `Simplify` and `Provide` are capitalized English verbs in neither stop-list, so today they leak as symbols. This case asserts the classifier extracts **no** symbols. No `expectedKnowledgeIds`, so it does not affect `hitRate`; it only adds a `symbols` classification check.

- [ ] **Step 2: Run the eval and confirm it FAILS**

Run: `pnpm run eval:retrieval`
Expected: FAIL — the new case reports `symbols` mismatch (actual `["Simplify","Provide"]` vs expected `[]`), dropping `exactSymbolMatchRate` / `exactClassificationMatchRate` below 1.

(If the fixture loader rejects the case for a missing required field, copy the missing optional field from a neighbouring case — do not change the assertion.)

- [ ] **Step 3: Add the `hasSymbolStructure` helper**

In `src/retrieval/classifier.ts`, immediately after `isLikelyDocumentIdentifier` (ends ~line 908), add:

```ts
// A real PascalCase code symbol has internal structure: an inner capital (FooBar),
// a digit (Sha256), or an underscore (Foo_Bar). A lone capitalized English word
// (Simplify, Provide, Build, Create) has none and must not be treated as a symbol.
// Explicitly back-ticked identifiers, known suffixes (…Service), and foo() calls are
// captured by the other lanes in extractSymbols, so this only gates the broad PascalCase lane.
function hasSymbolStructure(value: string): boolean {
  return /[A-Z]/.test(value.slice(1)) || /[0-9_]/.test(value);
}
```

- [ ] **Step 4: Tighten the PascalCase lane in `extractSymbols`**

In `src/retrieval/classifier.ts:497-505`, change the `pascalCase` line to add the structure filter:

```ts
function extractSymbols(prompt: string): string[] {
  const codeSpans = [...prompt.matchAll(/`([^`]+)`/g)].map((match) => match[1]!).filter((value) => /^[A-Za-z_$][\w$.:#-]+$/.test(value));
  const camelCase = prompt.match(/\b[A-Z][A-Za-z0-9_]*(?:Service|Controller|Repository|Provider|Handler|Store|Model|Schema|Config|Client)\b/g) ?? [];
  const pascalCase = (prompt.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? [])
    .filter((value) => !isLikelyDocumentIdentifier(value))
    .filter((value) => hasSymbolStructure(value));
  const functions = [...prompt.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)].map((match) => match[1]!);
  return uniqueStrings([...codeSpans, ...camelCase, ...pascalCase, ...functions])
    .filter((value) => !isSymbolStopWord(value, prompt));
}
```

(Only the two `.filter(...)` lines on `pascalCase` are new; everything else is unchanged.)

- [ ] **Step 5: Run the eval and confirm it PASSES**

Run: `pnpm run eval:retrieval`
Expected: PASS — `hitRate=1`, `staleRejectionRate=1`, `exactSymbolMatchRate=1`, `exactClassificationMatchRate=1`. The 4 existing fixture symbols (`PaywallSelectionModal`, `SenderIdentityPolicy`, `MediaUploadHandler`, `SenderQueue`) all have internal capitals, so they still classify.

- [ ] **Step 6: Build + unit tests**

Run: `pnpm run build` then `pnpm test`
Expected: PASS. (If a classifier unit test asserted a bare single-cap symbol, update it to a back-ticked or internally-structured symbol — note it in the commit.)

- [ ] **Step 7: Commit**

```bash
git add src/retrieval/classifier.ts eval/retrieval-fixtures.json
git commit -m "fix(retrieval): stop classifying lone capitalized words as symbols"
```

---

## Task 2: Slim the MCP context-pack response (test-first)

**Files:**
- Modify: `src/mcp/server.ts` (`contextPackShortlist` ~578; add 3 exported helpers + a local `truncateText`)
- Create: `test/context-pack-shortlist.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `test/context-pack-shortlist.test.ts`:

```ts
import test from 'node:test';
import { equal, ok, deepEqual } from 'node:assert/strict';
import {
  boundDeepContextForResponse,
  projectShortlistItem,
  slimClassified,
} from '../src/mcp/server.js';
import type { DeepContext, RankedCandidate, ClassifiedQuery } from '../src/types.js';

function bigDeepContext(): DeepContext {
  const item = (i: number) => ({
    knowledgeId: `k${i}`,
    title: `Item ${i}`,
    summary: 's',
    itemType: 'wiki' as const,
    project: 'demo',
    labels: [],
    references: [],
    source: 'lexical' as const,
    rank: i,
    finalScore: 1 - i * 0.01,
    matchReasons: ['m'],
    chunkIds: [`c${i}`],
    content: 'x'.repeat(5000),
    contextualContent: 'y'.repeat(5000),
    tokenEstimate: 2500,
  });
  const section = (name: 'essential' | 'supporting' | 'optional') => ({
    name,
    items: [item(1), item(2), item(3), item(4), item(5)],
    tokenEstimate: 12500,
  });
  return {
    mode: 'layered',
    budget: 60000,
    tokenEstimate: 37500,
    sections: [section('essential'), section('supporting'), section('optional')],
  };
}

test('boundDeepContextForResponse caps items per section and truncates content', () => {
  const { deepContext, truncated } = boundDeepContextForResponse(bigDeepContext(), 10_000);
  ok(truncated, 'should report truncation');
  for (const section of deepContext.sections) {
    ok(section.items.length <= 3, 'max 3 items per section');
    for (const item of section.items) {
      ok(item.content.length <= 1200, 'content truncated');
      ok(item.contextualContent.length <= 1200, 'contextualContent truncated');
    }
  }
  ok(deepContext.tokenEstimate <= 10_000, 'within ceiling');
});

test('projectShortlistItem drops diagnostic fields, keeps agent-facing fields', () => {
  const item = {
    knowledgeId: 'k1',
    title: 'T',
    itemType: 'wiki',
    project: 'demo',
    finalScore: 0.9,
    matchReasons: ['file match'],
    fitScore: 0.8,
    fitReasons: ['noise'],
    fitMissingSignals: ['noise'],
    evidenceCategory: 'directTaskEvidence',
    evidenceStrength: 'strong',
    usefulnessReason: 'noise',
    actionableMissingSignals: { foo: 'noise' },
    references: [{ refType: 'file', uri: 'a' }, { refType: 'file', uri: 'b' }, { refType: 'file', uri: 'c' }, { refType: 'file', uri: 'd' }],
  } as unknown as RankedCandidate;
  const projected = projectShortlistItem(item) as Record<string, unknown>;
  equal(projected.score, 0.9);
  deepEqual(projected.reasons, ['file match']);
  equal(projected.evidenceCategory, 'directTaskEvidence');
  ok((projected.references as unknown[]).length <= 3, 'references capped at 3');
  equal('fitReasons' in projected, false);
  equal('actionableMissingSignals' in projected, false);
  equal('usefulnessReason' in projected, false);
});

test('slimClassified keeps signals, drops lexicalQuery/intent/preprocessing', () => {
  const classified = {
    project: 'demo',
    taskType: 'review',
    confidence: 0.6,
    files: ['a.ts'],
    symbols: ['Foo'],
    errors: [],
    technologies: ['node'],
    businessAreas: [],
    exactTerms: ['noise'],
    lexicalQuery: 'noise noise noise',
    preprocessing: { lengthClass: 'short' },
    intent: { taskGoal: 'noise' },
  } as unknown as ClassifiedQuery;
  const slim = slimClassified(classified) as Record<string, unknown>;
  deepEqual(slim.files, ['a.ts']);
  deepEqual(slim.symbols, ['Foo']);
  equal('lexicalQuery' in slim, false);
  equal('intent' in slim, false);
  equal('preprocessing' in slim, false);
});
```

- [ ] **Step 2: Run the test and confirm it FAILS**

Run: `node --test --import tsx test/context-pack-shortlist.test.ts`
Expected: FAIL — `boundDeepContextForResponse`, `projectShortlistItem`, `slimClassified` are not exported yet (import error / not a function).

- [ ] **Step 3: Add the three exported helpers + `truncateText` to `src/mcp/server.ts`**

Near the top of the helper section (just above `function contextPackShortlist`), add:

```ts
const DEEP_CONTEXT_RESPONSE_TOKEN_CEILING = 10_000;
const DEEP_CONTEXT_MAX_ITEMS_PER_SECTION = 3;
const DEEP_CONTEXT_ITEM_CONTENT_CHARS = 1200;
const SHORTLIST_MAX_REFERENCES = 3;

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function projectShortlistItem(item: RankedCandidate) {
  return {
    knowledgeId: item.knowledgeId,
    title: item.title,
    itemType: item.itemType,
    project: item.project,
    score: item.finalScore,
    reasons: item.matchReasons,
    fitScore: item.fitScore,
    evidenceCategory: item.evidenceCategory,
    references: (item.references ?? []).slice(0, SHORTLIST_MAX_REFERENCES),
  };
}

export function slimClassified(classified: ClassifiedQuery) {
  return {
    project: classified.project,
    taskType: classified.taskType,
    confidence: classified.confidence,
    files: classified.files,
    symbols: classified.symbols,
    errors: classified.errors,
    technologies: classified.technologies,
    businessAreas: classified.businessAreas,
  };
}

export function boundDeepContextForResponse(
  deepContext: DeepContext,
  ceilingTokens: number = DEEP_CONTEXT_RESPONSE_TOKEN_CEILING,
): { deepContext: DeepContext; truncated: boolean } {
  let truncated = false;
  let runningTokens = 0;
  const sections = deepContext.sections.map((section) => {
    const items = [] as DeepContext['sections'][number]['items'];
    for (const item of section.items) {
      if (items.length >= DEEP_CONTEXT_MAX_ITEMS_PER_SECTION || runningTokens >= ceilingTokens) {
        truncated = true;
        break;
      }
      const content = truncateText(item.content, DEEP_CONTEXT_ITEM_CONTENT_CHARS);
      const contextualContent = truncateText(item.contextualContent, DEEP_CONTEXT_ITEM_CONTENT_CHARS);
      if (content.length < item.content.length || contextualContent.length < item.contextualContent.length) {
        truncated = true;
      }
      const tokenEstimate = Math.ceil((content.length + contextualContent.length) / 4);
      items.push({ ...item, content, contextualContent, tokenEstimate });
      runningTokens += tokenEstimate;
    }
    if (section.items.length > items.length) {
      truncated = true;
    }
    return { name: section.name, items, tokenEstimate: items.reduce((sum, i) => sum + i.tokenEstimate, 0) };
  });
  return {
    deepContext: {
      mode: 'layered',
      budget: deepContext.budget,
      tokenEstimate: sections.reduce((sum, s) => sum + s.tokenEstimate, 0),
      sections,
    },
    truncated,
  };
}
```

Ensure `RankedCandidate`, `ClassifiedQuery`, and `DeepContext` are imported in `src/mcp/server.ts` (add to the existing `import type { … } from '...types...'` line if missing).

- [ ] **Step 4: Run the helper test and confirm it PASSES**

Run: `node --test --import tsx test/context-pack-shortlist.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Use the helpers in `contextPackShortlist`**

In `src/mcp/server.ts:578-633`, rewrite the body so the **default** response is slim and `debug:true` keeps full fidelity:

```ts
function contextPackShortlist(pack: ContextPack, options: { includeDeepContext?: boolean } = {}) {
  const deepContextReturned = shouldReturnDeepContext(pack, options.includeDeepContext);
  const full = Boolean(pack.debug); // debug mode: return everything unchanged

  const bounded = pack.deepContext && deepContextReturned && !full
    ? boundDeepContextForResponse(pack.deepContext)
    : undefined;

  return {
    contextPackId: pack.id,
    confidence: pack.confidence,
    contextFit: pack.contextFit,
    orientation: pack.orientation,
    taskBrief: pack.taskBrief,
    actionableMissingSignals: pack.actionableMissingSignals,
    project: pack.project,
    classified: full ? pack.classified : slimClassified(pack.classified),
    sections: pack.sections.map((section) => ({
      name: section.name,
      tokenEstimate: section.tokenEstimate,
      items: full
        ? section.items.map((item) => ({
          knowledgeId: item.knowledgeId,
          title: item.title,
          itemType: item.itemType,
          project: item.project,
          score: item.finalScore,
          reasons: item.matchReasons,
          fitScore: item.fitScore,
          fitReasons: item.fitReasons,
          fitMissingSignals: item.fitMissingSignals,
          evidenceCategory: item.evidenceCategory,
          evidenceStrength: item.evidenceStrength,
          usefulnessReason: item.usefulnessReason,
          actionableMissingSignals: item.actionableMissingSignals,
          references: item.references,
        }))
        : section.items.map(projectShortlistItem),
    })),
    deepContextAvailable: Boolean(pack.deepContext),
    deepContextReturned,
    deepContextTruncated: bounded?.truncated ?? false,
    deepContext: pack.deepContext
      ? deepContextReturned
        ? (full ? pack.deepContext : bounded!.deepContext)
        : {
          budget: pack.deepContext.budget,
          tokenEstimate: pack.deepContext.tokenEstimate,
          sections: pack.deepContext.sections.map((section) => ({
            name: section.name,
            tokenEstimate: section.tokenEstimate,
            itemCount: section.items.length,
          })),
        }
      : undefined,
    ...(pack.debug ? { debug: pack.debug } : {}),
    impactPrediction: pack.impactPrediction,
    instruction: composeSearchInstruction(
      searchInstruction(pack.contextFit?.fitStatus, deepContextReturned),
      pack.taskBrief?.followUpSearches,
      pack.impactPrediction,
    ),
  };
}
```

When `deepContextTruncated` is true, add a hint to `composeSearchInstruction` (Step 6) so the agent knows to fetch the full pack.

- [ ] **Step 6: Tell the agent how to get the full deep context when truncated**

In `composeSearchInstruction` (`src/mcp/server.ts:635`), add a `deepContextTruncated` parameter and note. Change its signature and the two call sites:

```ts
function composeSearchInstruction(
  base: string,
  followUpSearches: string[] | undefined,
  impactPrediction: ContextPack['impactPrediction'],
  deepContextTruncated = false,
): string {
  let composed = base;
  if (deepContextTruncated) {
    const note = 'Deep context was truncated to keep the response small. Call tuberosa_get_context_pack with this contextPackId for the full chunks.';
    composed = composed ? `${composed}\n${note}` : note;
  }
  if (followUpSearches && followUpSearches.length > 0) {
    const note = `Detected ${followUpSearches.length} follow-up sub-task(s) (taskBrief.followUpSearches). Call tuberosa_search_context again with each sub-task as the prompt when you reach that step.`;
    composed = composed ? `${composed}\n${note}` : note;
  }
  if (impactPrediction && impactPrediction.predictedAffected.length > 0) {
    const top = impactPrediction.predictedAffected.slice(0, 3).map((p) => p.target.value).join(', ');
    const more = impactPrediction.truncated ? ' …' : '';
    const impactNote = `May affect: ${top}${more}. Call tuberosa_predict_impact for the full list.`;
    composed = composed ? `${composed}\n${impactNote}` : impactNote;
  }
  return composed;
}
```

And in `contextPackShortlist`, pass the flag:

```ts
    instruction: composeSearchInstruction(
      searchInstruction(pack.contextFit?.fitStatus, deepContextReturned),
      pack.taskBrief?.followUpSearches,
      pack.impactPrediction,
      bounded?.truncated ?? false,
    ),
```

- [ ] **Step 7: Build + full test suite**

Run: `pnpm run build` then `pnpm test`
Expected: PASS. If an existing MCP test asserts a now-dropped field (`fitReasons`, `lexicalQuery`, full `deepContext`) on a **non-debug** shortlist, update that test to pass `debug: true` or assert the slim shape — note it in the commit.

- [ ] **Step 8: Verify the size win against `tuberosa_get_context_pack` still returning full**

`get_context_pack` (`src/mcp/server.ts:154`) returns the stored pack via `toolJson(pack)` — confirm it is unchanged (full fidelity preserved for the explicit fetch). No code change needed; just confirm by reading the case.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/server.ts test/context-pack-shortlist.test.ts
git commit -m "fix(mcp): slim context-pack response and bound inlined deep context"
```

---

## Task 3: Lower the review-queue fetch limit (Fix 4)

**Files:**
- Modify: `src/retrieval/service.ts:73`

- [ ] **Step 1: Lower the constant**

In `src/retrieval/service.ts:73`, change:

```ts
const REVIEW_QUEUE_STATUS_LIMIT = 24;
```
to:
```ts
// Only the top ~12 review targets are ever surfaced; 8 per status (×6 statuses = 48)
// is plenty for the top-N selection while cutting the over-fetch.
const REVIEW_QUEUE_STATUS_LIMIT = 8;
```

- [ ] **Step 2: Build + full test suite (behavior unchanged)**

Run: `pnpm run build` then `pnpm test`
Expected: PASS — no behavior change; existing `resolveReviewTargets` tests still pass (48 ≥ the 12 surfaced).

- [ ] **Step 3: Commit**

```bash
git add src/retrieval/service.ts
git commit -m "perf(retrieval): reduce review-queue over-fetch (24->8 per status)"
```

---

## Task 4: Final verification

- [ ] **Step 1: Eval gate**

Run: `pnpm run eval:retrieval`
Expected: PASS — `hitRate=1`, `staleRejectionRate=1`, all exact classification rates = 1. No threshold was changed.

- [ ] **Step 2: Build + full suite**

Run: `pnpm run build`
Then: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Whitespace check**

Run: `git diff --check`
Expected: no output.

- [ ] **Step 4: Confirm the size win manually (optional)**

Start the MCP locally (`TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run mcp`) and issue a `tuberosa_search_context` with `includeDeepContext: true`; confirm the serialized result is far smaller than before and `deepContextTruncated`/instruction appears when chunks are large.

---

## Self-review (done by plan author)

- **Spec coverage:** Fix 1 → Task 1; Fix 2 → Task 2; Fix 4 → Task 3; verification → Task 4. Fix 3 and Fix 5 explicitly deferred with rationale (see scope note).
- **Placeholder scan:** none — every code/step is concrete.
- **Type consistency:** helper names (`projectShortlistItem`, `slimClassified`, `boundDeepContextForResponse`, `truncateText`, `hasSymbolStructure`) are used identically in their definitions, call sites, and tests; `deepContextTruncated` is produced in `contextPackShortlist` and consumed in `composeSearchInstruction`.
