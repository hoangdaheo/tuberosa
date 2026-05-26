# Long-Prompt Preprocessing — Design (Concern A)

**Status:** Draft for review
**Date:** 2026-05-26
**Concern:** A in the six-concern decomposition (B → D → A → C → E → F)
**Author:** Brainstorming session with user

---

## 1. Problem

Tuberosa's first pipeline stages (`redact → continuation provenance → classify`) assume prompts are a few sentences. When the user pastes a whole markdown file or multi-page task brief, four things break:

1. **Token-budget overrun on embedding.** OpenAI's `text-embedding-3-small` caps at 8192 tokens. A 20k-token prompt either fails the embed call or silently truncates — the resulting embedding represents only the first chunk.
2. **Classifier extracts hundreds of false-positive signals.** The regex sweeps in `classifier.ts` pull every file path, symbol, and capitalized word. `classified.files` can carry 200 paths, weighting collapses to noise, and metadata search returns garbage.
3. **Continuation-provenance walker blows up.** `addContinuationProvenance` (`src/retrieval/service.ts:862`) still tries to harvest signals from the last 6 sessions and merge them into the already-noisy classification, burning time without improving the pack.
4. **No mechanism to chunk the prompt itself.** A multi-task prompt ("first refactor X, then add tests for Y, then update docs Z") is treated as one query. Retrieval can't focus on each sub-task.

## 2. Goal

A new preprocessing stage that runs before `classifyQuery` and produces a bounded, focused input regardless of prompt length:

- a **token-bounded embedding seed** — either the original prompt (when small enough) or an LLM-extracted core intent (when long);
- a **relevance-scored, capped signal set** for the classifier;
- **gated** continuation-walker that does not fire for long or multi-task prompts;
- a **sub-task breakdown** surfaced to the agent so multi-task prompts get one focused pack plus follow-up suggestions.

## 3. Non-goals (deferred)

| Out of scope here | Belongs in |
|---|---|
| Auto-fan-out: running the full pipeline N times for N sub-tasks and merging | Future extension; current design hands control to the agent |
| Cross-call sub-task tracking (Tuberosa remembering that the agent already ran sub-task 1) | Agent-session lifecycle, not preprocessor |
| Re-ranking the sub-task list itself by "likely-first" | Trivial later; LLM order is fine for v1 |
| Exposing per-signal scores in the agent-facing pack | Scores remain in `debug` payload only |

## 4. Pipeline placement

A new stage runs before `classifyQuery`. Downstream stages (classify, fuse, rank, assemble) are unchanged — they operate on a `PreprocessedInput` shape that satisfies `ContextSearchInput` plus an additive `promptPreprocessing` block.

```
RetrievalService.searchContext
   │
   ▼ redactSearchInput          (unchanged)
   ▼ addContinuationProvenance  (gated per §7)
   ▼ preprocessLongPrompt       ← NEW
   │   ├─ length routing       (§5)
   │   ├─ intent pass          (§6, long only)
   │   └─ signal sweep         (§8, medium + long)
   ▼ classifyQuery              (reads from PreprocessedInput)
   ▼ findCandidates / fuse / rank / assemble  (unchanged)
```

## 5. Length routing

```typescript
function lengthClass(prompt: string): 'short' | 'medium' | 'long' {
  const tokens = estimateTokens(prompt);
  if (tokens <= 800)  return 'short';
  if (tokens <= 6000) return 'medium';
  return 'long';
}
```

Behavior by class:

| Class | Tokens | Intent LLM | Signal sweep | Continuation walker | Embedding source |
|---|---|---|---|---|---|
| **short** | ≤ 800 | no | no (existing classifier extraction) | yes (if phrase match) | original prompt |
| **medium** | 801 – 6 000 | no | yes (capped, scored) | yes (if phrase match AND ≤ 1 sub-task) | original prompt |
| **long** | > 6 000 | yes | yes | no | primary intent (1-3 sentences) |

The 800/6000 cuts live in `retrieval-policy.json` (`promptPreprocessing.thresholds`) so they're calibration parameters, not magic numbers. `estimateTokens` uses the existing token estimator (`~ ceil(chars / 4)`) — same heuristic Tuberosa already uses for budgeting.

## 6. Intent extraction pass (long prompts only)

A new optional method on `ModelProvider`:

```typescript
interface ModelProvider {
  extractPromptIntent?(input: {
    prompt: string;
    cwd?: string;
    files?: string[];
    symbols?: string[];
  }): Promise<{
    primary: string;                 // 1-3 sentences, the immediate goal
    subTasks: string[];              // each 1-2 sentences, detected later/parallel work
    detectedTaskType?: TaskType;
    detectedTechnologies?: string[];
    confidence: number;              // 0..1
  }>;
}
```

The structured-output JSON schema for OpenAI is:

```jsonc
{
  "type": "object",
  "properties": {
    "primary":    { "type": "string", "minLength": 10, "maxLength": 600 },
    "subTasks":   { "type": "array", "items": { "type": "string", "minLength": 5, "maxLength": 300 }, "maxItems": 8 },
    "detectedTaskType":     { "type": "string", "enum": ["debugging","implementation","refactor","review","planning","exploration","testing","unknown"] },
    "detectedTechnologies": { "type": "array", "items": { "type": "string" }, "maxItems": 10 },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  },
  "required": ["primary", "subTasks", "confidence"]
}
```

**Provider defaults:**

| Provider | `extractPromptIntent` defined? | Long-prompt behavior |
|---|---|---|
| `hash` (tests) | no | fall back to densest-signal **anchor window** (§9), no `subTasks` |
| `openai` | yes | **on by default** |
| `ollama` | yes | **on by default** |

Disable per-env: `TUBEROSA_LONG_PROMPT_INTENT_ENABLED=false`.

**Cache:** verdicts keyed by `prompt_intent:<sha256(prompt)>` in Redis with 7-day TTL. The same prompt resubmitted does not re-pay the LLM cost.

## 7. Continuation-walker gating

`addContinuationProvenance` runs only when **all** of:

- `lengthClass !== 'long'`, AND
- the prompt matches the existing continuation phrase regex (`src/retrieval/service.ts:1183`), AND
- post-intent `subTasks.length ≤ 1` (or no intent pass ran).

Rationale: a long multi-task prompt is a fresh starting point, not a continuation. Running the walker on it adds noise from unrelated past sessions.

## 8. Structural signal sweep

Runs over the **full prompt** for medium and long classes (and is the only signal source for medium). Deterministic, no LLM.

```typescript
interface ScoredSignal {
  value: string;
  score: number;          // 0..1
  reasons: Array<'frequency' | 'code_block' | 'imperative_proximity' | 'cwd_match'>;
}

function sweepSignals(prompt: string, cwd?: string): {
  files:         ScoredSignal[];
  symbols:       ScoredSignal[];
  errors:        ScoredSignal[];
  technologies:  ScoredSignal[];
  businessAreas: ScoredSignal[];
}
```

Per-signal scoring:

| Score component | Contribution |
|---|---|
| **frequency** | log-normalized count, saturates around the 3rd mention |
| **code_block** | +0.30 if the signal appears inside a fenced code block (``` ``` ```` ```` ``` ```) or inline-code span |
| **imperative_proximity** | +0.20 if within 10 tokens of an imperative verb (`update`, `refactor`, `fix`, `add`, `remove`, `rename`, `migrate`, `verify`, `port`, `delete`) |
| **cwd_match** | +0.20 (files only) if the path resolves to an existing file under `cwd` |

After scoring, anything below `minScore = 0.25` is dropped, then per-type caps apply:

| Signal type | Cap | Rationale |
|---|---|---|
| `files` | 10 | Code work rarely touches more than ~10 files at once |
| `symbols` | 12 | Allows multi-class refactors; covers symbol-heavy debugging |
| `errors` | 6 | Error codes are sparse; 6 is generous |
| `technologies` | 6 | Anything beyond ~6 is noise |
| `businessAreas` | 4 | Business areas are by definition coarse |

All thresholds live in `retrieval-policy.json` under `promptPreprocessing.signalSweep`. Caps reach is reached only by genuinely strong signals — the score floor protects against a single fly-by mention.

**Cache:** `prompt_signals:<sha256(prompt + cwd)>` in Redis with 1-hour TTL (signals can shift as files appear/disappear under `cwd`).

## 9. Hash-provider fallback: anchor window

When the provider has no `extractPromptIntent` (test path), a deterministic **densest-signal anchor window** is used for embedding instead of LLM intent extraction:

```typescript
function pickAnchorWindow(prompt: string, windowTokens: number = 1500): { start: number; end: number; text: string } {
  // Score each 1500-token window by signal density (count of file paths,
  // symbols, errors, and imperative verbs).
  // Return the highest-scoring window's slice.
}
```

This keeps unit tests deterministic and lets self-hosted Ollama users disable intent extraction without breaking long prompts entirely. The pack metadata records `embeddingSource: 'anchor_window'` so the agent (and the workbench) can tell.

## 10. `PreprocessedInput` shape

```typescript
interface PreprocessedInput extends ContextSearchInput {
  // ContextSearchInput.prompt is rewritten:
  //   - short / medium   → original prompt
  //   - long with intent → primary intent string
  //   - long, no intent  → anchor window text
  prompt: string;

  promptPreprocessing?: {
    lengthClass: 'short' | 'medium' | 'long';
    originalTokenEstimate: number;
    embeddingSource: 'original' | 'primary_intent' | 'anchor_window';
    primaryIntent?: string;       // long with LLM only
    subTasks?: string[];          // long with LLM only
    structuralSignals: {
      files:         ScoredSignal[];
      symbols:       ScoredSignal[];
      errors:        ScoredSignal[];
      technologies:  ScoredSignal[];
      businessAreas: ScoredSignal[];
    };
    continuationGated: boolean;
    cacheHits: { intent: boolean; signals: boolean };
  };
}
```

The classifier (`classifyQuery`) reads `prompt` (now bounded) for its existing lexical/regex work, and **also reads `promptPreprocessing.structuralSignals`** to override its own extraction. The override rule is straightforward: when `promptPreprocessing` is present, the classifier uses the swept signals as-is rather than running its own regex sweeps for files/symbols/errors/technologies/businessAreas. The short-prompt path is unchanged because `promptPreprocessing` is undefined there.

## 11. Surfacing in the response

`ContextPack` gains one additive field:

```typescript
interface ContextPack {
  // ... existing
  classified: ClassifiedQuery & {
    preprocessing?: PreprocessedInput['promptPreprocessing'];
  };
}
```

And the `taskBrief` block gains:

```typescript
interface TaskBrief {
  // ... existing
  followUpSearches?: string[];   // mirror of subTasks for agent ergonomics
}
```

The MCP tool description for `tuberosa_search_context` is amended:

> For prompts > 6000 tokens, the response includes `subTasks` you can pass back to `tuberosa_search_context` as separate searches when you reach those steps. Multi-task prompts get one focused pack for the primary task plus a follow-up list.

When `followUpSearches.length > 0`, the pack's top-level `instruction` field appends:

> Detected N follow-up tasks. Call `tuberosa_search_context` again with each sub-task when you start that step.

## 12. Configuration

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_LONG_PROMPT_INTENT_ENABLED` | `true` for openai/ollama, `false` for hash | Force-disable per env. |
| `TUBEROSA_LONG_PROMPT_INTENT_TTL_SECONDS` | `604800` (7d) | Redis cache TTL for intent verdicts. |
| `TUBEROSA_LONG_PROMPT_SIGNALS_TTL_SECONDS` | `3600` (1h) | Redis cache TTL for swept signals. |
| `retrieval-policy.json` → `promptPreprocessing.thresholds.medium` | `800` | tokens |
| `retrieval-policy.json` → `promptPreprocessing.thresholds.long` | `6000` | tokens |
| `retrieval-policy.json` → `promptPreprocessing.signalSweep.minScore` | `0.25` | drop below this before capping |
| `retrieval-policy.json` → `promptPreprocessing.signalSweep.caps` | per §8 | per-type caps |

## 13. Acceptance criteria

- ✅ A 12k-token prompt produces a pack with `lengthClass='long'`, an `embeddingSource='primary_intent'` (or `anchor_window` for hash provider), and a non-empty `subTasks` array.
- ✅ A 5k-token prompt produces `lengthClass='medium'`, no `primaryIntent`, swept signals capped to the per-type limits.
- ✅ A prompt mentioning 200 distinct symbols yields `classified.symbols.length === 12` after preprocessing.
- ✅ A continuation phrase ("continue where we left off") in a 7k-token prompt does **not** trigger `addContinuationProvenance` (verified via debug trace).
- ✅ Identical long prompt resubmitted within 7 days hits the intent cache; identical (prompt + cwd) within 1 hour hits the signals cache.
- ✅ `tuberosa_search_context` MCP tool response for a multi-task prompt includes the `subTasks`/`followUpSearches` arrays and the appended `instruction`.
- ✅ `pnpm run eval:retrieval` stays green; new fixture cases for the four bullets above pass.
- ✅ The OpenAI embed call never receives more than 7500 tokens of content (within safety margin of the 8192 cap).

## 14. Risks and open questions

| Risk | Mitigation |
|---|---|
| LLM intent extraction loses critical sub-task detail. | Sub-tasks are surfaced separately; agent can re-call. Confidence is returned and low-confidence packs include an `instruction` to ask the user before proceeding. |
| Token estimator (chars/4) misestimates for non-English / code-heavy prompts and routes wrong. | Acceptable for v1. Real failure mode is over-routing to `long`, which only pays one LLM call — bounded cost. A real tokenizer (tiktoken) is a follow-up. |
| Anchor-window fallback picks the wrong window for the test-mode `hash` provider. | Fallback is deterministic given the prompt; eval fixtures pin the expected window per test prompt. |
| Sub-task surfacing tempts the agent to call Tuberosa 5x for a 5-sub-task prompt, ballooning cost. | The `instruction` advises calling "when you reach that step," not preemptively. Cache layer dampens repeated calls anyway. |
| Per-signal scoring tuning becomes a perpetual back-and-forth. | All weights live in policy; `calibrate-fusion` style runs can tune over fixture corpora. |
| Cross-version migrations: existing short-prompt callers expect `classified` to be populated by the regex path, not the sweep. | Preprocessor only runs for medium/long. Short path is unchanged. Verified by retrieval eval pre-existing cases. |

## 15. Next steps

1. User reviews this spec.
2. After approval, write the A implementation plan.
3. Continue to concern C — graph relations and impact propagation.
