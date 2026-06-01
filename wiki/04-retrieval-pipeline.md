# 04 — Retrieval Pipeline

A single `searchContext(input)` call walks through ten stages. This guide explains each, the configuration that affects it, and where to look in the source.

## Source of truth

`RetrievalService.searchContext` lives at `src/retrieval/service.ts`. Reading it top-to-bottom is the fastest way to get oriented.

## Input

```jsonc
{
  "project":     "newsletter-app",                  // optional but recommended
  "cwd":         "/home/me/projects/newsletter",    // optional, helps worktree match
  "prompt":      "Update PaywallSelectionModal …",  // the only required field
  "files":       ["src/components/paywall.tsx"],    // optional hints
  "symbols":     ["PaywallSelectionModal"],
  "errors":      ["TypeError: cannot read x"],
  "taskType":    "implementation",                  // optional explicit override
  "contextMode": "layered",                         // "layered" | "compact"
  "noiseTolerance": "strict",                       // "balanced" | "strict"
  "includeDeepContext": true,
  "deepContextBudget": 60000,
  "tokenBudget": 8000,
  "bypassCache": false,
  "debug": false,
  "namespace": { "project": "newsletter-app" },
  "rejectedKnowledgeIds": []
}
```

## The 10 steps

### 1. Receive

`RetrievalService.searchContext(input)`. Validates the input shape, applies `safe.redactSearchInput` (strips secrets), and resolves a `worktreeId` from `cwd`.

### 2. Classify (`src/retrieval/classifier.ts`)

`classifyQuery(prompt)` pulls task signals from the raw prompt:

| Signal | Example match |
|---|---|
| `project` | When the prompt mentions a known project name |
| `taskType` | `debugging` / `implementation` / `refactor` / `review` / `planning` / `exploration` / `testing` / `unknown` |
| `files` | `src/foo.ts`, `docs/*.md` |
| `symbols` | `PaywallSelectionModal`, `fuseCandidates` |
| `errors` | `ECONNREFUSED`, error-code-shaped tokens |
| `technologies` | `postgres`, `redis`, `react` |
| `businessAreas` | `paywall`, `auth` (whitelisted) |
| `domains` | `retrieval`, `ingestion`, … |
| `exactTerms` | identifiers preserved verbatim |

Output: a `ClassifiedQuery` consumed by every downstream step.

### 3. Rewrite (only if needed)

`RetrievalService` runs a quick probe first: do a tiny lexical search on the original prompt. If the top results look strong (cosine threshold + label coverage), **skip** the rewrite — saves a model round-trip. Otherwise call `modelProvider.rewriteQuery(prompt)` to get a tighter query and reuse the probe's embedding so we never embed twice.

The probe-vs-rewrite gate is controlled by `config/retrieval-policy.json`.

### 4. Search in parallel

Four candidate sources run concurrently against the store:

| Source | What it returns | Postgres / memory |
|---|---|---|
| `searchMetadata` | items matching extracted labels/refs | exact-match joins on `knowledge_labels` |
| `searchLexical` | Postgres FTS hits on title + content | `tsvector @@ websearch_to_tsquery` |
| `searchVector` | nearest neighbours by chunk embedding | `pgvector` cosine via `<=>` |
| `searchMemories` | approved reflection memories | filter `itemType='memory' AND status='approved'` |

Then a fifth list:

- **Graph relations** — `searchGraphRelations` takes the top seed IDs from the four lists and walks `knowledge_relations` (with policy from `retrieval-policy.json`).

### 5. Fuse (`src/retrieval/fusion.ts`)

Weighted Reciprocal-Rank Fusion across the five lists:

```
score(item) = Σ source_weight[s] / (rrf_k + rank_in_s(item))
```

Source weights live in `config/retrieval-policy.json` under `sourceWeights`. Defaults are tuned by `pnpm run calibrate-fusion` against the sandbox corpus.

### 6. Rerank (`src/model/provider.ts`)

Top slice of the fused list is reranked. Default is `HashModelProvider` (deterministic, no API key). Switch via `TUBEROSA_MODEL_PROVIDER`:

- `hash` — deterministic, used in tests.
- `openai` — structured-output rerank via `/v1/responses`.
- `ollama` — local reranker model (e.g. `dengcao/Qwen3-Reranker-0.6B`).

### 7. Adjust (`src/retrieval/service.ts`)

Apply per-item score deltas:

- `applyRankingAdjustments` — adds boosts from `aboutness` (domain/project/business-area match), feedback history (selected = boost, rejected = penalty).
- `applyIntentSuppression` — penalises items where `status='archived'`, items that are `supersededBy` something else, or items whose evidence doesn't match the classified task.

### 8. Check fit (`src/retrieval/context-fit.ts`)

Computes a `contextFit` block:

```jsonc
{
  "status": "ready" | "needs_confirmation" | "insufficient",
  "score":  0.78,
  "missingSignals": ["missing file:src/foo.tsx", "missing symbol:Bar"],
  "diagnostics": { ... }
}
```

Thresholds:

| Status | Default trigger |
|---|---|
| `ready` | fit ≥ 0.72 |
| `needs_confirmation` | fit ≥ 0.45 |
| `insufficient` | fit < 0.45 |

When `noiseTolerance="strict"`, weak items (low score AND no exact-term hit) are dropped here.

### 9. Assemble (`src/retrieval/context-pack.ts`)

Survivors are split into three sections within `tokenBudget`:

- `essential` — high-confidence items the agent should read first.
- `supporting` — helpful but secondary.
- `optional` — nice-to-have; fills remaining budget.

The split is based on rank position and a per-item `essentialThreshold`. Each item carries `matchReasons` so the slot it landed in is explainable.

### 10. (Layered mode) Deep context

When `contextMode="layered"` and `includeDeepContext=true`, the chosen knowledge IDs are expanded into their full chunks, up to `deepContextBudget` (default 60k tokens, clamped 30k–100k). The result lands in `pack.deepContext`.

`contextMode="compact"` skips this entire step — useful for low-latency callers.

## Two flags that change the path

- `"bypassCache": true` — skip the Redis pack cache and re-run the pipeline. Use when you want a fresh result without invalidating the cache for other callers.
- `"debug": true` — also bypasses the cache, plus the response includes `debug.candidates` (per-stage lists) and `debug.timings` (ms per stage). Heavy; not for production agents.

## Where each piece is configurable

| Knob | Where |
|---|---|
| Source weights | `config/retrieval-policy.json` → `sourceWeights` |
| Task-type profiles | `config/retrieval-policy.json` → `taskProfiles` |
| Fit thresholds | `src/retrieval/context-fit.ts` constants |
| Aboutness weights | `src/retrieval/service.ts` (`applyRankingAdjustments`, `applyIntentSuppression`) |
| Graph expansion budget | `config/retrieval-policy.json` → `graph` |
| Probe-vs-rewrite gate | `config/retrieval-policy.json` → `rewrite` |
| Deep-context budget | `TUBEROSA_DEEP_CONTEXT_BUDGET` env (clamped 30k–100k) |
| Pack cache TTL | `CONTEXT_CACHE_TTL_SECONDS` env (default 300) |

> Rule: **don't tweak weights without a fixture case**. The `eval/retrieval-fixtures.json` file pins the expected behaviour. Run `pnpm run eval:retrieval` before and after any change to the pipeline.

## Calibration

```bash
pnpm run sandbox          # build the synthetic corpus + run golden prompts
pnpm run sandbox:ablate   # per-source ablation: which source is doing the work?
pnpm run calibrate-fusion # emit a calibrated config/retrieval-policy.json patch
```

`sandbox:ablate` zeros each source in turn and shows which prompts depend on it. Use to spot redundant or load-bearing sources.

## Pack shape returned to the agent

```jsonc
{
  "id":         "<context-pack-id>",
  "confidence": 0.92,
  "classified": { "files": [...], "symbols": [...], "businessAreas": [...] },
  "contextFit": { "status": "ready", "score": 0.98, "missingSignals": [] },
  "sections": {
    "essential":  [ { "id": "<knowledge-id>", "title": "…", "score": 0.91,
                      "matchReasons": ["symbol:fuseCandidates", "vector match",
                                       "boost:domain_match:retrieval"] } ],
    "supporting": [ … ],
    "optional":   [ … ]
  },
  "deepContext": {
    "items": [ { "id": "<knowledge-id>",
                 "chunks": [{ "ord": 0, "text": "…", "tokenEstimate": 215 }] } ],
    "budget": { "used": 12434, "limit": 60000 }
  },
  "actionableMissingSignals": [...],
  "orientation": { "verificationCommands": [...], "missingSignals": {...} }
}
```

`matchReasons` examples: `vector match`, `symbol:fuseCandidates`, `feedback:selected:3`, `boost:domain_match:retrieval`, `graph:refines:atom-7`.

## Read next

- [05-agent-session-lifecycle.md](05-agent-session-lifecycle.md) — how an agent uses a pack.
- [06-reflection-memory.md](06-reflection-memory.md) — how feedback shapes future ranking.
- [11-configuration.md](11-configuration.md#retrieval) — all retrieval env vars.
- [14-development-and-extension.md](14-development-and-extension.md#sandbox) — sandbox & calibration internals.
