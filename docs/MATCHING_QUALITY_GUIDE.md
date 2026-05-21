# Matching Quality & Sandbox Track — Usage Guide

This guide is the developer-facing companion to `roadmap-claude.md`. Every phase that has landed (1 → 5) is documented here with: **what's new**, **how to run it**, and **detailed examples**. The goal is to make the new knobs discoverable so you can tune retrieval, run the sandbox, or stand up a brand-new Tuberosa install without re-reading the source.

If you only have 30 seconds, read the [TL;DR](#tldr). Otherwise skim the phase headings.

---

## TL;DR

| Phase | What you can now do | Entry point |
| --- | --- | --- |
| 1 — Sandbox & baseline | Run a 332-item synthetic corpus + 44 golden prompts and get per-source / per-itemType / per-filter metrics. | `pnpm run sandbox` |
| 2 — Noise-filter hardening | Tune freshness, duplicate detection, domain mismatch, suppression telemetry, PII redaction via a single `RetrievalPolicy`. | `config/retrieval-policy.json` |
| 3 — Categorization & labeling | Hierarchical ontology, content-driven itemType inference, label enricher with provenance, AST symbol extraction. | Wired automatically at ingestion. |
| 4 — Matching engine | Local cross-encoder reranker (optional ONNX), provider registry, per-task fusion profiles, calibrated weights, policy-driven graph hops. | `TUBEROSA_MODEL_PROVIDER=local` + `pnpm run calibrate-fusion` |
| 5 — One-command install | `tuberosa init` / `doctor` / `mcp` CLI. Embedded fallback when Docker is missing. | `npx tuberosa init` |

Master verification you should run after touching any of the above:

```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run eval:knowledge-completeness
pnpm run eval:agent-context
pnpm run sandbox
pnpm run sandbox:ablate
```

Current baseline (Phase 4, hash provider): hit 95.5%, MRR 0.488, noise 9.1%, stale_sup 100%, dup_sup 100%, itemType_diag 68.7%, p50 ~18ms.

---

## Phase 1 — Knowledge-Mapping Sandbox & Baseline

### What's new

- `eval/sandbox/generator.ts` — deterministic generator that emits a 332-item corpus across six tiers (gold / adjacent noise / stale / duplicates / adversarial / sparse) and seeds graph relations.
- `eval/sandbox/prompts.ts` — 44 golden prompts across 7 task types, each carrying `expectedSelectedSandboxIds`, `forbiddenSandboxIds`, `expectedNoiseFilteredSandboxIds`, `expectedItemTypes`, `expectedLabels`, `groundingFacts`.
- `scripts/sandbox.ts` — single-file runner that ingests the corpus, runs all prompts with `debug=true`, computes hit / MRR / noise / per-tier / per-itemType / per-filter precision / latency, and writes `eval/sandbox/report.md`.
- **Per-source ablation** — `--ablate` zeroes out each candidate source in turn (`lexical`, `vector`, `metadata`, `memory`, `graph`) and reports the delta on hit and MRR.
- **Fusion-debug export** — every `ContextPack` can carry a `debug.fusionBreakdown` with per-candidate per-source contributions. Off by default for production responses; the sandbox passes `debug: true` to turn it on.
- **Per-filter telemetry** — safety filters and retrieval suppression now emit `FilterEvent { filter, action, knowledgeId, reason }` into the pack metadata. Sandbox computes per-filter true-positive rates.
- **Threshold gate** — `eval/sandbox/thresholds.json` lists the minimum acceptable values for hit, MRR, noise, stale suppression, etc. The runner exits non-zero with `--fail-under` when any threshold misses.

### How to run

```bash
pnpm run sandbox                       # baseline + report
pnpm run sandbox -- --ablate           # baseline + per-source ablation rows
pnpm run sandbox -- --json             # full JSON instead of human summary
pnpm run sandbox -- --fail-under       # CI gate: exit 1 if any threshold fails
pnpm run sandbox -- --seed 0xC0FFEE    # reproduce a specific fixture
pnpm run sandbox -- --report path/to/report.md --thresholds path/to/thresholds.json
```

### Example — quick baseline

```text
$ pnpm run sandbox
Sandbox seed=12648430 knowledge=332 prompts=44
hit=95.5% mrr=0.4882 noise=9.1%
stale_sup=100.0% dup_sup=100.0% adv_block=100.0%
catchall=39.4% latency_p50=18ms p95=25ms
itemType_diag=68.7% label_diag=8.0%
thresholds: PASS
```

### Example — per-source ablation

```text
$ pnpm run sandbox:ablate
…
  ablate-lexical: hit=77.3% mrr=0.4029
  ablate-vector:  hit=81.8% mrr=0.4389
  ablate-metadata: hit=84.1% mrr=0.4342
  ablate-memory:  hit=95.5% mrr=0.5862   ← memory is currently a net loss for MRR
  ablate-graph:   hit=90.9% mrr=0.5418
thresholds: PASS
```

If `memory` ablation **improves** MRR while leaving hit unchanged, your memory candidates are noisy — that's the cue to re-weight `sourceWeights.memory` in `RetrievalPolicy` or tune the memory suppression confidence (Phase 2).

### Example — turning on fusion debug in your own code

```ts
const pack = await retrievalService.searchContext({
  prompt: 'why does paywall.ts throw TS999?',
  project: 'tuberosa',
  files: ['src/billing/paywall.ts'],
  taskType: 'debugging',
  debug: true,                       // ← enables debug.fusionBreakdown + filterEvents
});

for (const entry of pack.debug?.fusionBreakdown ?? []) {
  console.log(entry.knowledgeId, entry.fusedScore, entry.contributions);
  // contributions: [{ source: 'metadata', rank: 3, rawScore: 0.81, sourceWeight: 1.15, contribution: 0.018 }, …]
}
```

Debug fields are **stripped before the pack leaves the MCP boundary** unless the caller explicitly requested debug — they never leak into agent context by accident.

### Where to look

- Tier shapes & adversarial content: `eval/sandbox/generator.ts`.
- Prompt fixtures: `eval/sandbox/prompts.ts`.
- Metrics & report rendering: `scripts/sandbox.ts`.
- Threshold floor: `eval/sandbox/thresholds.json`.

---

## Phase 2 — Noise-Filter Hardening

### What's new

Every threshold that used to be a literal in code is now a knob on `RetrievalPolicy`:

- **Per-itemType freshness windows** — `code_ref` decays slower than `memory`, `spec`/`rule` are near-immune. See `DEFAULT_POLICY.freshnessPolicy` in `src/retrieval/policy.ts`.
- **Duplicate detector** — 7-gram Jaccard + cosine similarity, decisions are `allow`/`flag`/`block`/`reject`. Excludes same `sourceUri` so re-ingesting a file is treated as an update, not a duplicate (`src/ingest/duplicate-detector.ts`).
- **Domain mismatch suppression** — downweights candidates whose strongest label set lives in a different domain than the classified prompt. Telemetry shows when it fires correctly.
- **Sanitizer telemetry + pluggable classifier** — `SuspiciousContentClassifier` interface with the regex pass as default; the hook is ready for a local ML classifier in Phase 4+.
- **PII redaction patterns** — emails, phone numbers, IPv4 (all off by default).
- **Suppression confidence** — every suppression delta becomes a `SuppressionEvent { reason, deltaScore, confidence, evidence }`; the sandbox grades whether suppressions matched the tier-label ground truth.
- **Calibration via JSON** — `config/retrieval-policy.json` is read at startup; missing fields fall back to `DEFAULT_POLICY`. You can also point `TUBEROSA_RETRIEVAL_POLICY=/abs/path.json` somewhere else.

### How to use

#### Pattern A — tune via the JSON file (no code change, no restart in dev)

Edit `config/retrieval-policy.json`. Anything you omit falls back to `DEFAULT_POLICY`. Example: relax stale rejection for `spec` items and turn on email PII redaction.

```json
{
  "freshnessPolicy": {
    "spec":  { "currentDays": 720, "staleDays": 1825, "stalePenalty": -0.03 },
    "rule":  { "currentDays": 720, "staleDays": 1825, "stalePenalty": -0.03 }
  },
  "piiRedaction": { "emails": true, "phones": false, "ipv4": false }
}
```

After editing, call `resetRetrievalPolicyCache()` (tests) or restart the server — the policy is cached after the first read.

#### Pattern B — tune via code (tests / library use)

```ts
import { DEFAULT_POLICY, setRetrievalPolicy } from './src/retrieval/policy.js';

setRetrievalPolicy({
  ...DEFAULT_POLICY,
  suppressionEnabled: { ...DEFAULT_POLICY.suppressionEnabled, domainMismatch: false },
  duplicateDetector: 'off',
});
```

#### Pattern C — opt out entirely

```json
{ "useFreshnessMap": false, "duplicateDetector": "off", "suppressionEnabled": { "stale": false, "domainMismatch": false } }
```

### Example — duplicate detection at ingestion

```ts
import { IngestionService } from './src/ingest/service.js';

await ingestion.ingestKnowledge({
  project: 'demo',
  sourceType: 'file',
  sourceUri: 'docs/auth.md',
  title: 'Auth flow',
  itemType: 'wiki',
  content: 'When a user signs in we issue a session token...',
  trustLevel: 80,
  labels: [{ type: 'business_area', value: 'auth' }],
  references: [],
});

// Re-ingesting the *same source URI* updates in place (no duplicate error).
// Ingesting a *different sourceUri* with ≥0.85 Jaccard + ≥0.92 cosine similarity
// throws DuplicateIngestionError; with one signal it stores a duplicateCandidate flag.
```

### Example — reading suppression events from a debug pack

```ts
const pack = await retrieval.searchContext({ prompt: '…', taskType: 'debugging', debug: true });
for (const event of pack.debug?.suppressionEvents ?? []) {
  console.log(`[suppress ${event.reason}] ${event.knowledgeId} Δ${event.deltaScore.toFixed(3)} conf=${event.confidence}`);
  // example: [suppress domain_mismatch] kb-22 Δ-0.300 conf=0.74 evidence=domain:storage vs prompt domain:auth
}
```

### Example — PII redaction in action

```ts
import { KnowledgeSafetyService } from './src/security/knowledge-safety.js';
import { setRetrievalPolicy, DEFAULT_POLICY } from './src/retrieval/policy.js';

setRetrievalPolicy({ ...DEFAULT_POLICY, piiRedaction: { emails: true, phones: true, ipv4: false } });
const safety = new KnowledgeSafetyService();
const sanitized = safety.scanAndRedactText('Contact alice@example.com or 415-555-0100 — IP 10.0.0.5 is fine');
// → "Contact [redacted-email] or [redacted-phone] — IP 10.0.0.5 is fine"
```

### Where to look

- Policy schema and defaults: `src/retrieval/policy.ts`.
- Duplicate detector: `src/ingest/duplicate-detector.ts`.
- Suppression event emission: `src/retrieval/service.ts` (`applyIntentSuppression`).
- Pluggable classifier + PII patterns: `src/security/knowledge-safety.ts`.

---

## Phase 3 — Categorization & Labeling Upgrade

### What's new

- **Hierarchical label ontology** (`src/relations/ontology.ts`). A leaf label like `technology:react` now also tags its ancestors (`frontend`) with attenuated weight and `provenance: { source: 'ontology' }`. Retrieval matches at any level — a `domain:storage` candidate still ranks for a prompt tagged `domain:postgres`.
- **Content-driven itemType inference** (`src/ingest/item-type-inference.ts`). When a caller passes `itemType: 'memory'`, the ingestion service decides the real type from content + references + metadata (rules in priority order: `error_recovery` → `bugfix`, test refs → `workflow`/`bugfix`, MUST/SHALL headings → `rule`, code-fence ≥40% + code refs → `code_ref`, etc.). Explicit non-memory itemTypes from callers are **trusted** (no override).
- **Label enricher chain** (`src/ingest/label-enricher.ts`). `HeuristicLabelEnricher` re-runs the classifier on title+summary+content and tags labels with `provenance: { source: 'classifier', confidence }`. Restricted to *axis* label types (`technology`, `business_area`, `domain`, `task_type`, `project`) — file/symbol/error labels stay caller-curated. Optional `LlmLabelEnricher` is gated by `TUBEROSA_LLM_LABELS=true`.
- **`LabelProvenance` on every label** — `{ source: 'prompt' | 'classifier' | 'ontology' | 'reviewer' | 'llm' | 'ast' | 'heuristic', confidence }`. Fusion uses the confidence as a multiplier on the task-type boost.
- **AST-aware code labeling** (`src/relations/ast-extractor.ts`). Uses the TypeScript compiler API (already in deps) to extract exported symbols + call expressions from `.ts/.tsx/.js/.mjs/.cjs` content. Seeds `mentions_symbol` + `depends_on` relations.
- **Sandbox confusion matrices** — `itemTypeDiagonalRate` (selected item-type ∈ expectedItemTypes / total) and `labelDiagonalRate` reported alongside hit/MRR.

### How to use

Most of Phase 3 is automatic — ingestion wires the enricher chain and the inference call. The user-facing surface is the `RetrievalPolicy` rollback flags:

```json
{ "useOntology": false, "useItemTypeInference": false, "useAstExtractor": false }
```

### Example — ontology expansion at ingestion

```ts
import { expandLabelsThroughOntology } from './src/relations/ontology.js';

const input = [
  { type: 'technology', value: 'react', weight: 0.9 },
];
const expanded = expandLabelsThroughOntology(input, { enabled: true });
// expanded becomes:
// [
//   { type: 'technology', value: 'react', weight: 0.9 },
//   { type: 'technology', value: 'frontend', weight: ~0.63,
//     provenance: { source: 'ontology', confidence: 0.85 } },
// ]
```

A prompt that classifies `technology:frontend` will now match the React-tagged item; the React leaf still outranks because its weight is higher.

### Example — itemType inference

```ts
import { inferItemType } from './src/ingest/item-type-inference.js';

const result = inferItemType({
  content: '## Decision\nWe MUST use Postgres pgvector for embeddings.',
  references: [],
  metadata: {},
  hint: 'memory',
});
// result.itemType === 'rule', confidence 0.82, reasons: ['rule heading or normative language → rule']
```

In the ingestion path the gate is `input.itemType === 'memory'` — explicit `code_ref`/`workflow`/etc. itemTypes from callers are kept as-is. This is intentional: tests and the reflection-review pipeline pass concrete types on purpose, and overriding them caused regressions in Phase 3 §1.

### Example — AST extraction at ingestion

When a `code_ref` item references a `.ts` file, the AST extractor seeds relations automatically:

```ts
import { extractAstSymbols, relationsFromAst } from './src/relations/ast-extractor.js';

const ast = extractAstSymbols(
  'export function tally(items: Item[]) { return items.reduce(sum, 0); }',
  { filename: 'src/util/tally.ts' },
);
// ast.exportedSymbols → ['tally']
// ast.calls → ['reduce'] (stop words like console/setTimeout filtered)

const relations = relationsFromAst(storedItem, ast);
// relations[0] → mentions_symbol → tally (confidence 0.92)
// relations[1] → depends_on → reduce (confidence 0.7)
```

If parsing throws (malformed JSX, weird syntax), the extractor swallows the error and the existing regex-based inference still runs.

### Example — provenance-aware fusion

```ts
// Two candidates have the same task_type:debugging label, but with different provenance:
const labels = [
  { type: 'task_type', value: 'debugging', provenance: { source: 'reviewer', confidence: 0.98 } }, // human-curated
  { type: 'task_type', value: 'debugging', provenance: { source: 'llm', confidence: 0.55 } },      // best-effort
];
// The reviewer-tagged candidate gets ~1.0× the task-type boost; the llm-tagged candidate gets ~0.78×.
// See labelConfidenceMultiplier() in src/retrieval/fusion.ts.
```

### Where to look

- Ontology trees: `src/relations/ontology.ts`.
- itemType rules: `src/ingest/item-type-inference.ts`.
- Enricher chain + provenance merge: `src/ingest/label-enricher.ts`.
- AST extraction: `src/relations/ast-extractor.ts`.
- Confusion-matrix metrics: `scripts/sandbox.ts` (`itemTypeConfusion`, `labelConfusion`).

---

## Phase 4 — Matching Engine (Local Cross-Encoder + Calibrated Fusion)

### What's new

- **Local cross-encoder reranker** (`src/model/local-provider.ts`). Lazy-loads `@xenova/transformers` (not a hard dependency!) and runs a small cross-encoder like `bge-reranker-base` to rerank the top-K candidates. Falls back to the hash reranker when the package or model is missing — installs stay light, tests stay offline.
- **Provider registry** (`src/model/registry.ts`). Each provider declares which methods it implements (`embed`, `rewriteQuery`, `rerank`). `TUBEROSA_MODEL_PROVIDER=local` composes "hash embeddings + local cross-encoder rerank" with one switch.
- **Per-task fusion profiles** (`RetrievalPolicy.taskProfiles`). The static `applyTaskTypeAdjustments` is now table-driven: each task type adds source-weight deltas and itemType boosts on top of the global weights.
- **Per-task coverage profiles** (`RetrievalPolicy.coverageProfiles`). The context-fit aggregator weighs file/symbol/error/technology/business-area differently per task — for `debugging` errors dominate, for `refactor` symbols dominate.
- **Policy-driven graph hops** (`RetrievalPolicy.graphHopWeights` + `relationKindMultipliers`). The literal 0.95 / 0.68 multipliers in `postgres-store.ts` and `memory-store.ts` became knobs. Per-relation-kind multipliers let `supersedes` outweigh `mentions_file`. Optional depth-2 expansion gated by `graphMaxHops`.
- **Calibration script** (`scripts/calibrate-fusion.ts`). Runs the sandbox prompt set, observes which source contributed most to expected items, emits a bounded `config/retrieval-policy.json` patch.

### How to use

#### A. Run the calibration script

```bash
pnpm run calibrate-fusion -- --dry-run     # print the patch, don't write
pnpm run calibrate-fusion                   # write to config/retrieval-policy.json
pnpm run calibrate-fusion -- --seed 42 --output config/calibration-experiment.json
```

The script bounds every weight into `[0.7, 1.4]` and rounds to 3 decimals. The patch includes a `calibration: { calibratedAt, seed, notes }` block so reviewers can tell the file was generated.

#### B. Enable the local cross-encoder

1. Add the package: `pnpm add @xenova/transformers` (~150MB on first run because of the model weights).
2. Run with `TUBEROSA_MODEL_PROVIDER=local`. On the first call the model downloads into `~/.cache/tuberosa/models/` (override with `TUBEROSA_MODEL_CACHE_DIR`).
3. Tune the top-K and model id via env vars: `TUBEROSA_RERANKER_MODEL=Xenova/bge-reranker-base` (default), `TUBEROSA_RERANKER_TOPK=16`.

If the package isn't installed, the provider logs one stderr line and falls back to the hash reranker. Tests can inject their own `LocalCrossEncoderScorer` to keep CI offline:

```ts
import { LocalCrossEncoderProvider } from './src/model/local-provider.js';

const provider = new LocalCrossEncoderProvider({
  scorer: { async score(_prompt, cands) { return cands.map(() => 0.5); } },
});
```

#### C. Tweak per-task profiles via JSON

```json
{
  "useTaskProfiles": true,
  "taskProfiles": {
    "debugging": {
      "sourceWeights": { "metadata": 0.06, "graph": 0.05, "memory": 0.03, "vector": -0.04 },
      "itemTypeBoosts": [{ "itemTypes": ["bugfix", "memory"], "bonus": 0.04 }]
    },
    "refactor": {
      "sourceWeights": { "metadata": 0.04, "lexical": 0.03 },
      "itemTypeBoosts": [{ "itemTypes": ["code_ref", "rule"], "bonus": 0.03 }]
    }
  }
}
```

Set `useTaskProfiles: false` to revert to the global weights.

#### D. Tweak coverage profiles

```json
{
  "useCoverageProfiles": true,
  "coverageProfiles": {
    "debugging":  { "file": 0.2, "symbol": 0.2, "error": 0.3, "technology": 0.1, "businessArea": 0.08 },
    "refactor":   { "file": 0.22, "symbol": 0.3, "error": 0.14, "technology": 0.14, "businessArea": 0.1 }
  }
}
```

#### E. Tweak graph hops

```json
{
  "graphHopWeights": { "target": 0.95, "seed": 0.68, "depth2": 0.42 },
  "relationKindMultipliers": {
    "supersedes": 1.1,
    "resolves_error": 1.05,
    "mentions_file": 0.95
  },
  "graphMaxHops": 1
}
```

Depth-2 expansion is **opt-in** (`"graphMaxHops": 2`). On the synthetic sandbox it adds 6-9ms p50 latency without moving MRR; it pays off on projects with denser graphs.

### Example — composed provider (hash embeddings + local rerank)

```ts
import { buildProviderRegistry } from './src/model/registry.js';

const provider = buildProviderRegistry({
  modelProvider: 'local',
  embeddingDimensions: 1536,
  // ...other AppConfig fields
});

// provider.embed → hash
// provider.rerank → @xenova/transformers if installed, hash fallback otherwise
// provider.rewriteQuery → hash (returns undefined; no rewrite)
```

### Example — what the calibration script writes

```text
$ pnpm run calibrate-fusion -- --dry-run
…
Per-task profiles emitted: 7
{
  "patch": {
    "sourceWeights": {
      "metadata": 1.227,
      "lexical":  1.172,
      "vector":   0.978,
      "memory":   0.987,
      "graph":    1.156,
      "reference": 1.0
    },
    "taskProfiles": {
      "implementation": { "sourceWeights": { "graph": 0.206, "memory": -0.147, "lexical": 0.172, "vector": -0.022 } },
      "debugging":      { "sourceWeights": { "graph": 0.155, "memory":  0.061, "lexical": 0.108, "vector": -0.043 } },
      …
    },
    "calibration": { "calibratedAt": "2026-05-21T…", "seed": 12648430, "notes": "Generated by scripts/calibrate-fusion.ts" }
  }
}
```

Apply by removing `--dry-run`. Re-run the sandbox to confirm it didn't regress before committing.

### Where to look

- Local provider: `src/model/local-provider.ts`.
- Registry composition: `src/model/registry.ts`.
- Calibration script: `scripts/calibrate-fusion.ts`.
- Per-task profiles + helpers: `src/retrieval/policy.ts` (`effectiveSourceWeight`, `coverageProfileFor`, `graphHopMultiplier`).
- Graph SQL: `src/storage/postgres-store.ts` (`buildRelationKindMultiplierSql`).

---

## Phase 5 — One-Command Install & Local-First Polish

### What's new

- **`bin/tuberosa.ts`** — CLI entry registered as `bin.tuberosa = "dist/bin/tuberosa.js"` in `package.json`. Three subcommands:
  - `tuberosa init` — bootstrap the local stack.
  - `tuberosa doctor` — diagnose install issues.
  - `tuberosa mcp` — run the MCP stdio server with embedded-mode defaults.
- **Embedded mode** — when Docker is missing (or `--no-docker`), the CLI prints the env vars that put Tuberosa into pure in-memory mode: `TUBEROSA_STORE=memory`, `TUBEROSA_CACHE=memory`, `TUBEROSA_MODEL_PROVIDER=hash`. No Postgres, no Redis, data volatile.
- **`.tuberosa/compose.yml`** — project-local compose file with Postgres + Redis only (no `app` container — see roadmap deviation §1). Generated on first `init` and left in place on re-runs.
- **MCP snippet printed by `init`** — drop straight into `~/.codex/config.toml` or the equivalent Claude Code / Cursor file.

### How to use

```bash
npx tuberosa init                       # full local stack (Docker) or embedded fallback
npx tuberosa init --no-docker           # force embedded mode even if Docker is around
npx tuberosa init --skip-migrate        # bring the stack up without running migrate
npx tuberosa init --port 4040           # change the HTTP port the snippet prints
npx tuberosa init --root /path/to/proj  # operate on a different project root
npx tuberosa doctor                     # text report (Node/pnpm/Docker/port/Postgres/migrations/MCP stdio)
npx tuberosa doctor --json              # machine-readable
npx tuberosa mcp                        # MCP stdio with embedded defaults
npx tuberosa help                       # full usage
```

### Example — fresh-machine flow

```text
$ npx tuberosa init
Wrote /work/myapp/.env from .env.example.
Wrote /work/myapp/.tuberosa/compose.yml.
[…docker compose up output…]
[…pnpm run migrate output…]

Tuberosa is up.
  HTTP:     http://127.0.0.1:3027/health
  Postgres: 127.0.0.1:5432
  Redis:    127.0.0.1:6379

MCP snippet (Claude Code / Codex / Cursor):
  [mcp_servers.tuberosa]
  command = "npx"
  args = ["tuberosa", "mcp"]
  # cwd = "/work/myapp"
Re-run `npx tuberosa init` to reconcile a missing compose file or .env.
```

### Example — diagnosing a port collision

```text
$ npx tuberosa doctor
Tuberosa doctor
---------------
✓ node version: Node 22.21.1
✓ pnpm: pnpm 11.1.2
✓ docker: Docker version 29.3.1
✗ port 3027: port 3027 is already held by pid 4242
    fix: Stop the process holding port 3027 or pass --port to override.
· postgres reachability: DATABASE_URL not set; will use embedded-mode defaults.
✓ migrations: migrations/ present
✓ mcp stdout sanity: MCP entrypoint keeps stdout clean

Result: 1 fail, 0 warn, 6 ok/skip.
```

Exit code: non-zero only when at least one check **fails** (warnings don't fail the run, so the doctor is safe to chain in CI as a smoke test).

### Example — embedded mode for a quick demo

```text
$ npx tuberosa init --no-docker
Wrote /work/myapp/.env from .env.example.

Embedded-mode init (forced by --no-docker).
  Data is volatile — no Postgres, no Redis. Useful for trying Tuberosa.

Run the MCP stdio server with embedded defaults:
  npx tuberosa mcp

Or set these vars for `pnpm run dev`:
  TUBEROSA_STORE=memory
  TUBEROSA_CACHE=memory
  TUBEROSA_MODEL_PROVIDER=hash

MCP snippet (Claude Code / Codex / Cursor):
  [mcp_servers.tuberosa]
  command = "npx"
  args = ["tuberosa", "mcp"]
  env = {
    TUBEROSA_STORE = "memory"
    TUBEROSA_CACHE = "memory"
    TUBEROSA_MODEL_PROVIDER = "hash"
  }
  # cwd = "/work/myapp"
```

### Example — wiring `npx tuberosa mcp` into a Claude Code project

`~/.config/claude-code/config.toml` (or wherever your client reads):

```toml
[mcp_servers.tuberosa]
command = "npx"
args    = ["tuberosa", "mcp"]
# Optional: keep durable Postgres state by exporting these before npx runs.
# env = { TUBEROSA_STORE = "postgres", DATABASE_URL = "postgres://tuberosa:tuberosa@127.0.0.1:5432/tuberosa" }
```

`tuberosa mcp` inherits stdio without printing any banner — JSON-RPC frames travel through stdout unmodified. It honours any value the user already exported (e.g., `TUBEROSA_STORE=postgres`); embedded-mode defaults only fill the gaps.

### Where to look

- Top-level dispatcher: `bin/tuberosa.ts`.
- Subcommands: `bin/commands/init.ts`, `bin/commands/doctor.ts`, `bin/commands/mcp.ts`.
- Compose template: `bin/commands/compose-template.ts`.
- Tests (15 cases, full mock fs + spawn): `test/cli.test.ts`.

---

## Cross-phase appendix

### Verifying the whole stack after a change

```bash
pnpm run build                      # tsc + workbench bundle
pnpm test                           # 207/207 unit tests (Phase 5)
pnpm run eval:retrieval             # 14/14 hand-picked cases at 100% on every metric
pnpm run eval:knowledge-completeness
pnpm run eval:agent-context
pnpm run sandbox                    # the synthetic harness
pnpm run sandbox:ablate             # per-source MRR deltas
```

The sandbox is the load-bearing eval; retrieval-fixtures are sentry cases for specific regressions (paywall, stale-auth, continuation-handoff, etc.).

### Rolling back any Phase 1-5 feature

Every new behaviour has an explicit rollback flag (recorded per phase above). The summary:

| Feature | Rollback flag / env |
| --- | --- |
| Sandbox in CI | `TUBEROSA_SANDBOX=off` (skips the benchmark block) |
| Per-itemType freshness | `RetrievalPolicy.useFreshnessMap=false` |
| Duplicate detector | `RetrievalPolicy.duplicateDetector='off'` |
| Specific suppression reasons | `RetrievalPolicy.suppressionEnabled.<reason>=false` |
| PII redaction | `RetrievalPolicy.piiRedaction.{emails,phones,ipv4}=false` |
| Ontology expansion | `RetrievalPolicy.useOntology=false` |
| itemType inference | `RetrievalPolicy.useItemTypeInference=false` |
| AST extractor | `RetrievalPolicy.useAstExtractor=false` |
| LLM label enricher | `TUBEROSA_LLM_LABELS=true` is opt-in; default is off |
| Per-task fusion profiles | `RetrievalPolicy.useTaskProfiles=false` |
| Per-task coverage profiles | `RetrievalPolicy.useCoverageProfiles=false` |
| Depth-2 graph expansion | `RetrievalPolicy.graphMaxHops=1` (default) |
| Local cross-encoder | `TUBEROSA_MODEL_PROVIDER=hash` (default) |
| `tuberosa init` CLI | additive; remove `bin/` + the `bin` entry in `package.json` |

### Reading the tracking docs

- `roadmap-claude.md` — the plan, per-phase status, plan deviations.
- `file-tracking.md` — per-file diff per phase (created / modified / verified / rollback).
- `failure-tracking.md` — every approach that was tried and reverted, with the reason.

Treat the tracking docs as the source of truth for "did this actually land?" when the roadmap status field looks optimistic.
