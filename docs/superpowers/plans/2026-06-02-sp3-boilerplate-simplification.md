# SP3 Boilerplate Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut maintenance weight in Tuberosa (hand-rolled validators, flat config, flat MCP tool list, duplicated store logic, duplicated fixture loaders, repeated policy reads) without removing any feature, keeping every eval green.

**Architecture:** One branch off `main`, six effective work items done in order, each its own eval-gated and separately-committable task. zod becomes the internal validator engine behind unchanged public `validate*` function names. Config gains a nested shape with identical env-var names. Stores share a small set of pure helpers, fixing a label-provenance parity bug along the way. Item 5 (dead-code removal) is a verified no-op (all three targets are live).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 22.21.1, `node --test` + `tsx`, zod (new), Postgres + Redis (integration), pnpm.

**Spec:** `docs/superpowers/specs/2026-06-02-sp3-boilerplate-simplification-design.md`

**Global constraints (every task honors):** run one `pnpm` command at a time; if shell Node is older, prefix `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH`; MCP stdout protocol-only (no `console.log`/`process.stdout.write` in the MCP path); store parity across `postgres-store.ts` and `memory-store.ts`; no `Co-Authored-By: Claude` trailer; eval-first — `eval:retrieval` green before any retrieval/classifier/fusion/context-fit/context-pack change, and a **failing fixture before** any heuristic change.

---

## File Structure

**Created:**
- `src/schemas/primitives.ts` — shared zod primitives (`zString`, `zPositiveNumber`, `zStringArray`, enum helpers) and the `parseOrThrow` adapter.
- `src/schemas/knowledge.ts`, `src/schemas/context.ts`, `src/schemas/agent-session.ts`, `src/schemas/reflection.ts`, `src/schemas/error-log.ts`, `src/schemas/maintenance.ts`, `src/schemas/backup.ts`, `src/schemas/ingest.ts` — zod schemas grouped by input family.
- `src/storage/shared/label-provenance.ts` — `LABEL_PROVENANCE_METADATA_KEY`, `buildLabelProvenanceMap`, `mergeLabelProvenanceIntoMetadata`, `withLabelProvenanceMetadata` (moved out of `postgres-store.ts`).
- `src/storage/shared/ranking.ts` — provably-identical pure ranking/relation-validity helpers shared by both stores (only what is verified identical).
- `test/schemas.test.ts` — focused zod-adapter + edge tests (additive; the existing `test/validation.test.ts` stays as the behavioral contract).
- `test/label-provenance-parity.test.ts` — proves both stores write label provenance identically on `updateKnowledge`.
- `test/config-shape.test.ts` — asserts the nested `AppConfig` shape + defaults.

**Modified:**
- `src/validation.ts` — `validate*` functions become thin wrappers over schemas; keeps and re-exports the enum constants.
- `src/config.ts` — `AppConfig` nested; `loadConfig()` builds nested objects from the same env var names.
- the 9 `AppConfig` consumers — update access paths.
- `src/mcp/tool-definitions.ts` — add `category` to each tool, order by category, optionally merge verified-redundant overlap pairs.
- `src/storage/postgres-store.ts`, `src/storage/memory-store.ts` — import shared helpers; memory-store calls `mergeLabelProvenanceIntoMetadata`.
- `src/evaluation/fixture-loader.ts` — generic loader; delete `context-mapping-fixture-loader.ts` + `knowledge-completeness-fixture-loader.ts` after callers migrate.
- `src/retrieval/service.ts` — read `getRetrievalPolicy()` once per `searchContext`, thread it down.
- `docs/tuberosa-debloat-audit-2026-06-02.md` — one-line correction note on the three false-deads.

---

## Task 0: Branch + add zod

**Files:** `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Create the branch off main**

Run:
```bash
git switch -c sp3-boilerplate-simplification
```
Expected: `Switched to a new branch 'sp3-boilerplate-simplification'`

- [ ] **Step 2: Add zod**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm add zod
```
Expected: zod added to `dependencies` in `package.json`; lockfile updated.

- [ ] **Step 3: Verify build still compiles**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
```
Expected: exit 0, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build(sp3): add zod dependency"
```

---

## Item 1 — validation.ts → zod (internal), public API unchanged

### Task 1.1: The `parseOrThrow` adapter + primitives

**Files:**
- Create: `src/schemas/primitives.ts`
- Test: `test/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/schemas.test.ts
import test from 'node:test';
import { equal, deepEqual, throws } from 'node:assert/strict';
import { z } from 'zod';
import { parseOrThrow } from '../src/schemas/primitives.js';
import { ValidationError } from '../src/errors.js';

test('parseOrThrow returns parsed value on success', () => {
  const schema = z.object({ prompt: z.string() });
  deepEqual(parseOrThrow(schema, { prompt: 'x' }, 'ctx'), { prompt: 'x' });
});

test('parseOrThrow throws ValidationError with details on failure', () => {
  const schema = z.object({ prompt: z.string() });
  throws(
    () => parseOrThrow(schema, { prompt: 42 }, 'context search input'),
    (err: unknown) =>
      err instanceof ValidationError &&
      err.code === 'validation_error' &&
      err.status === 400 &&
      Array.isArray((err as ValidationError).details) &&
      ((err as ValidationError).details as Array<{ path: string }>).some((d) => d.path.includes('prompt')),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/schemas.test.ts
```
Expected: FAIL — cannot find module `../src/schemas/primitives.js`.

- [ ] **Step 3: Write the adapter + primitives**

```ts
// src/schemas/primitives.ts
import { z } from 'zod';
import { ValidationError } from '../errors.js';

/** Flattened zod issue shape stored in ValidationError.details. */
export interface SchemaIssue {
  path: string;
  message: string;
}

/**
 * Parse `value` with `schema`. On success returns the typed value.
 * On failure throws ValidationError(message, details) so src/errors.ts maps it
 * to HTTP 400 / JSON-RPC -32602 exactly as the old hand-rolled validators did.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const details: SchemaIssue[] = result.error.issues.map((issue) => ({
    path: [label, ...issue.path.map(String)].filter(Boolean).join('.'),
    message: issue.message,
  }));
  const first = details[0];
  const message = first ? `${first.path}: ${first.message}` : `${label}: invalid input.`;
  throw new ValidationError(message, details);
}

/** Non-empty trimmed string (matches readRequiredString semantics). */
export const zRequiredString = z.string().min(1);

/** Optional string; absent stays absent (matches readOptionalString). */
export const zOptionalString = z.string().min(1).optional();

/** Array of non-empty strings. */
export const zStringArray = z.array(z.string());

/** Strictly positive number (matches readOptionalPositiveNumber). */
export const zPositiveNumber = z.number().positive();
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/schemas.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/schemas/primitives.ts test/schemas.test.ts
git commit -m "feat(sp3): add zod parseOrThrow adapter and primitives"
```

### Task 1.2: Convert `validateContextSearchInput` (representative first conversion, incl. enums + aliases + clamp)

**Files:**
- Create: `src/schemas/context.ts`
- Modify: `src/validation.ts` (replace the body of `validateContextSearchInput`; keep the export and the enum constants)
- Test: existing `test/validation.test.ts` (the 65-case contract — must stay green), `test/schemas.test.ts` (add alias/clamp cases)

> **Why this one first:** it exercises every hard part at once — required string, enum, optional enum, string arrays, positive-number clamp, boolean, and the taskType alias normalization. Get this pattern right and the rest are mechanical.

- [ ] **Step 1: Add failing alias/clamp tests**

```ts
// append to test/schemas.test.ts
import { validateContextSearchInput } from '../src/validation.js';

test('contextSearch: taskType alias bugfix -> debugging', () => {
  equal(validateContextSearchInput({ prompt: 'x', taskType: 'bugfix' }).taskType, 'debugging');
});

test('contextSearch: taskType alias coding -> implementation', () => {
  equal(validateContextSearchInput({ prompt: 'x', taskType: 'coding' }).taskType, 'implementation');
});

test('contextSearch: tokenBudget clamps to 200000', () => {
  equal(validateContextSearchInput({ prompt: 'x', tokenBudget: 9_999_999 }).tokenBudget, 200_000);
});
```

- [ ] **Step 2: Run to verify the alias/clamp tests pass already (current impl), and capture the contract baseline**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/validation.test.ts test/schemas.test.ts
```
Expected: PASS (these behaviors already exist in the hand-rolled version; this locks them before the rewrite).

- [ ] **Step 3: Build the zod schema and rewrite the wrapper**

```ts
// src/schemas/context.ts
import { z } from 'zod';
import { CONTEXT_MODES, CONTEXT_NOISE_TOLERANCES, TASK_TYPES } from '../validation.js';

/** Aliases preserved from the hand-rolled readOptionalTaskType. */
const TASK_TYPE_ALIASES: Record<string, (typeof TASK_TYPES)[number]> = {
  development: 'implementation',
  coding: 'implementation',
  bug: 'debugging',
  bugfix: 'debugging',
  bug_fix: 'debugging',
  investigation: 'debugging',
};

const taskTypeSchema = z.preprocess(
  (v) => (typeof v === 'string' && v in TASK_TYPE_ALIASES ? TASK_TYPE_ALIASES[v] : v),
  z.enum(TASK_TYPES),
).optional();

export const contextSearchSchema = z.object({
  prompt: z.string().min(1),
  project: z.string().min(1).optional(),
  repoHint: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  taskType: taskTypeSchema,
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
  // Mirror clampOptional(readOptionalPositiveNumber(...), 200_000):
  // reject <= 0, clamp > 200_000 down to 200_000. Verify against the
  // `CS tokenBudget negative/zero/positive` contract cases.
  tokenBudget: z.number().positive().transform((n) => Math.min(n, 200_000)).optional(),
  contextMode: z.enum(CONTEXT_MODES).optional(),
  noiseTolerance: z.enum(CONTEXT_NOISE_TOLERANCES).optional(),
  deepContextBudget: z.number().positive().optional(),
  includeDeepContext: z.boolean().optional(),
  rejectedKnowledgeIds: z.array(z.string()).optional(),
  bypassCache: z.boolean().optional(),
  debug: z.boolean().optional(),
}).strip();
```

```ts
// src/validation.ts — replace the function body, keep the export signature
import { contextSearchSchema } from './schemas/context.js';
import { parseOrThrow } from './schemas/primitives.js';

export function validateContextSearchInput(value: unknown): ContextSearchInput {
  return parseOrThrow(contextSearchSchema, value, 'context search input') as ContextSearchInput;
}
```

- [ ] **Step 4: Run the full contract + schema tests**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/validation.test.ts test/schemas.test.ts
```
Expected: PASS — all 65 contract cases for `validateContextSearchInput` plus the alias/clamp cases.

- [ ] **Step 5: Typecheck**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/context.ts src/validation.ts test/schemas.test.ts
git commit -m "refactor(sp3): back validateContextSearchInput with zod"
```

### Task 1.3: Convert the remaining validators, family by family

> Apply the Task 1.2 pattern. Do one schema file per family, converting the listed functions to thin wrappers. After **each file**, run the contract suite and build, then commit. Do NOT delete the enum constants — they stay exported from `validation.ts` (other files import them). If a constant is more naturally defined in a schema file, re-export it from `validation.ts`.

Families and the exact `validate*` functions to convert (every current export):

- **knowledge** (`src/schemas/knowledge.ts`): `validateKnowledgeInput`, `validateKnowledgePatchInput`, `validateKnowledgeRelationInput`, `validateKnowledgeRelationPatchInput`, `validateKnowledgeConflictPatchInput`, `validateKnowledgeGapPatchInput`, `validateLearningProposalPatchInput`, `validateKnowledgeReviewFilter`, `validateKnowledgeStatusQuery`, `validateLearningReviewStatusQuery`, `validateLearningProposalTypeQuery`.
- **ingest** (`src/schemas/ingest.ts`): `validateIngestFilesRequest` (+ internal `validateIngestFileInput`).
- **agent-session** (`src/schemas/agent-session.ts`): `validateStartAgentSessionInput`, `validateRecordAgentContextDecisionInput`, `validateFinishAgentSessionInput`, `validateCaptureAgentLearningSignalInput`, `validateAppendAgentSessionNoteInput` (+ internal `readLearningSignal`, `readOptionalResearchTrace`, `readResearchTraceStep` with the `MAX_RESEARCH_TRACE_*` limits and the "at least one of file/symbol/command/knowledgeId" rule).
- **reflection** (`src/schemas/reflection.ts`): `validateReflectionDraftInput`, `validateReflectionDraftPatchInput`, `validateReflectionDraftIdArguments`, `validateReflectionDraftListInput`, `validateReflectionDraftReviewInput`.
- **feedback/context-quality** (add to `src/schemas/context.ts`): `validateContextSearchInput` (done), `validateFeedbackInput`, `validateContextQualityReportInput`, `validateContextPackIdArguments`.
- **error-log** (`src/schemas/error-log.ts`): `validateErrorLogInput`, `validateErrorLogPatchInput`, `validateErrorLogListInput`, `validateCollectErrorLogsInput`, `validateCreateErrorLogReflectionDraftInput`, `validateResolveErrorLogInput`, `validateErrorLogIdArguments`.
- **maintenance** (`src/schemas/maintenance.ts`): `validateMaintenanceProposeInput`, `validateMaintenanceApplyInput` (+ internal `readMaintenanceItem`, risk defaults map, evidence-source enum).
- **backup/ops** (`src/schemas/backup.ts`): `validateCleanupOperationsInput`, `validateCreateBackupInput`, `validateBackupRetentionInput`, `validateRestoreBackupInput`.

Keep these helpers/exports in `validation.ts`: `expectRecord` (used by callers), and all `*_TYPES`/`*_MODES`/`*_STATUSES` constants.

For **each** family file:

- [ ] **Step A: Convert the functions to wrappers** (one `parseOrThrow` call each, mirroring special behaviors: char limits, "at least one of", defaults like `reason ?? ''`, second-arg id overrides such as `validateFinishAgentSessionInput(value, sessionId?)` and `validateResolveErrorLogInput(value, id?)` — keep the second parameter and merge it after parse).
- [ ] **Step B: Run the contract suite + any family-specific tests**

Run (example for agent-session; include all test files that import the converted functions):
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/validation.test.ts test/api-boundary.test.ts test/research-trace.test.ts
```
Expected: PASS.

- [ ] **Step C: Build**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
```
Expected: exit 0.

- [ ] **Step D: Commit**

```bash
git add src/schemas/<family>.ts src/validation.ts
git commit -m "refactor(sp3): back <family> validators with zod"
```

### Task 1.4: Item-1 gate — full suite + LOC check

- [ ] **Step 1: Full unit test suite**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```
Expected: all tests pass.

- [ ] **Step 2: Confirm the reduction target**

Run:
```bash
wc -l src/validation.ts
```
Expected: substantially smaller than 1,434 (target ~70% reduction, i.e. roughly ≤ ~450 LOC; report the actual number — do not pad to hit a number).

- [ ] **Step 3: Confirm no `validate*` export was dropped**

Run:
```bash
git show main:src/validation.ts | grep -oE "export (function|const) [A-Za-z0-9_]+" | sort -u > /tmp/before.txt
grep -oE "export (function|const) [A-Za-z0-9_]+" src/validation.ts | sort -u > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "NO EXPORTS DROPPED"
```
Expected: `NO EXPORTS DROPPED` (or only intended additions). If any export is missing, restore it before continuing.

---

## Item 2 — config/env grouping + minimal local recipe

### Task 2.1: Define the nested `AppConfig` shape (failing test first)

**Files:**
- Modify: `src/config.ts`
- Test: `test/config-shape.test.ts`

Nested groups (env-var names unchanged): `storage` (store, cache, databaseUrl, redisUrl, autoMigrate, embeddingDimensions), `model` (provider + openai* + ollama* + timeouts + llmCriticEnabled), `http` (port, host, apiKey, requireApiKeyForNonLoopback, maxRequestBytes), `context` (mode, cacheTtlSeconds, deepContextBudget), `backup` (dir, intervalSeconds, startupDelaySeconds, retentionCount, retentionMaxAgeDays, writeThrough, writeThroughThrottleSeconds), `mirror` (enabled, dir, debounceMs), `atlas` (dir, autoRegen), `errorLog` (dir, maxBytes, autoCapture, captureClientErrors), `worktree` (enabled, maxFiles, maxMtimeAgeHours), `archival` (enabled, intervalHours), `graphInference` (enabled), `ingest` (maxIngestContentBytes), `userStyle` (enabled, userId, teamId, conventionsEnabled, clusterIntervalHours, clusterWindowDays, minClusterEvents), plus top-level `env`, `defaultProject`, `defaultCwd`, `persistReplay`.

- [ ] **Step 1: Write the failing test**

```ts
// test/config-shape.test.ts
import test from 'node:test';
import { equal } from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig groups storage/model/backup with defaults', () => {
  const prev = { ...process.env };
  try {
    delete process.env.TUBEROSA_STORE;
    delete process.env.OPENAI_API_KEY;
    const cfg = loadConfig();
    equal(cfg.storage.store, 'postgres');
    equal(cfg.model.provider, 'hash');
    equal(cfg.backup.dir, '.tuberosa/backups');
    equal(cfg.http.host, '127.0.0.1');
  } finally {
    process.env = prev;
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/config-shape.test.ts
```
Expected: FAIL — `cfg.storage` is undefined (still flat).

- [ ] **Step 3: Rewrite `AppConfig` interface + `loadConfig()` into nested objects**

Reading the SAME env vars (e.g. `process.env.TUBEROSA_STORE`, `process.env.TUBEROSA_BACKUP_DIR`) into the nested fields. Do not rename any env var.

- [ ] **Step 4: Run the shape test**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/config-shape.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config-shape.test.ts
git commit -m "refactor(sp3): nest AppConfig into grouped objects"
```

### Task 2.2: Update the 9 consumers (compiler-driven)

**Files:** the 9 files importing from `config.js` (the build will name them).

- [ ] **Step 1: Build to get the exact list of broken accessors**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
```
Expected: TypeScript errors at each old flat access (`config.backupDir`, etc.). Fix each to the nested path (`config.backup.dir`).

- [ ] **Step 2: Repeat build until clean**

Run the build again after edits until exit 0.

- [ ] **Step 3: Full suite**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```
Expected: all pass (test config literals updated to nested shape too).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(sp3): migrate config consumers to nested AppConfig"
```

### Task 2.3: Minimal local env recipe doc

**Files:** Create `docs/MINIMAL_ENV.md`

- [ ] **Step 1: Write the recipe** (no-dependency mode, docker compose mode, provider choice) using verified var names. Example no-dependency block:

```bash
TUBEROSA_STORE=memory
TUBEROSA_CACHE=memory
TUBEROSA_MODEL_PROVIDER=hash
TUBEROSA_HTTP_HOST=127.0.0.1
```

- [ ] **Step 2: Commit**

```bash
git add docs/MINIMAL_ENV.md
git commit -m "docs(sp3): minimal local env recipe"
```

---

## Item 3 — MCP tool grouping (organization, not removal)

### Task 3.1: Add category metadata + ordering

**Files:**
- Modify: `src/mcp/tool-definitions.ts`
- Test: `test/api-boundary.test.ts` (or the MCP tools test) — add a tool-count/name assertion.

- [ ] **Step 1: Write the failing test (lock the tool set)**

```ts
// add to the MCP tools test
import { tools } from '../src/mcp/tool-definitions.js';

test('tool set: 36 tools, each has a category', () => {
  const list = tools();
  equal(list.length, 36);
  for (const t of list) {
    // category is informational metadata, not part of the JSON-RPC schema
    equal(typeof (t as { category?: string }).category, 'string');
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/api-boundary.test.ts
```
Expected: FAIL — `category` undefined.

- [ ] **Step 3: Add `category: 'core' | 'admin-ops' | 'diagnostics'` to each tool and sort the returned array by category** (core first). Ensure the field is stripped/ignored where the array is serialized into the `tools/list` JSON-RPC response if the response shape is strict — verify `src/mcp/server.ts` `tools/list` handler only forwards `name`/`description`/`inputSchema`.

- [ ] **Step 4: Run the test + dispatch tests**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/api-boundary.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tool-definitions.ts src/mcp/server.ts test/api-boundary.test.ts
git commit -m "refactor(sp3): group MCP tools by category"
```

### Task 3.2: Verify-then-merge the two overlap pairs

**Files:** `src/mcp/tool-definitions.ts`, `src/mcp/server.ts`

- [ ] **Step 1: Read both pairs' input schemas and dispatch handlers** (`tuberosa_list_error_logs` vs `tuberosa_collect_error_logs`; `tuberosa_atom_gate_stats` vs `tuberosa_atom_graph_density`). Decide redundancy:
  - If one is a strict superset (same handler, optional flag), merge into a single tool with an optional discriminator argument and update the dispatch.
  - If they call different services / return different shapes, **do not merge** — leave them and add a one-line code comment explaining why.

- [ ] **Step 2: If merged, update the count assertion** in the test to the new total and assert the removed tool name is gone and the survivor handles both behaviors.

- [ ] **Step 3: Gate — agent-context eval + MCP tests**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
```
Expected: green.

Then:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/api-boundary.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(sp3): merge verified-redundant MCP tool overlaps"
```

---

## Item 4 — storage parity bug + safe de-dup

### Task 4.1: Extract the shared label-provenance helper

**Files:**
- Create: `src/storage/shared/label-provenance.ts`
- Modify: `src/storage/postgres-store.ts` (import instead of local defs)

- [ ] **Step 1: Move the functions** `LABEL_PROVENANCE_METADATA_KEY`, `buildLabelProvenanceMap`, `mergeLabelProvenanceIntoMetadata`, `withLabelProvenanceMetadata` from `postgres-store.ts` (around `:3085`) into the new file, exported. Import them back into `postgres-store.ts`.

- [ ] **Step 2: Build**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
```
Expected: exit 0.

- [ ] **Step 3: Run storage tests (no behavior change yet)**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/storage/shared/label-provenance.ts src/storage/postgres-store.ts
git commit -m "refactor(sp3): extract shared label-provenance helper"
```

### Task 4.2: Fix the parity bug (failing test first)

**Files:**
- Test: `test/label-provenance-parity.test.ts`
- Modify: `src/storage/memory-store.ts` (`updateKnowledge`, ~`:418`)

- [ ] **Step 1: Write the failing parity test**

```ts
// test/label-provenance-parity.test.ts
import test from 'node:test';
import { deepEqual } from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { LABEL_PROVENANCE_METADATA_KEY } from '../src/storage/shared/label-provenance.js';

test('memory-store.updateKnowledge writes label provenance into metadata', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.createKnowledge({
    project: 'p', itemType: 'code_ref', title: 't', summary: 's', content: 'c',
    labels: [{ type: 'file', value: 'a.ts' }],
  });
  const updated = await store.updateKnowledge(created.id, {
    labels: [{ type: 'file', value: 'a.ts', source: 'agent' as never }],
  });
  // After update with labels, provenance must be present (parity with postgres-store).
  deepEqual(
    Object.prototype.hasOwnProperty.call(updated!.metadata ?? {}, LABEL_PROVENANCE_METADATA_KEY),
    true,
  );
});
```

> Adjust the label/source shape to match `LabelInput` exactly (read `buildLabelProvenanceMap` to see which labels produce provenance entries — only labels carrying provenance fields do). Use a label that genuinely yields a provenance entry so the assertion is meaningful.

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/label-provenance-parity.test.ts
```
Expected: FAIL — memory-store does not write provenance.

- [ ] **Step 3: Fix `memory-store.updateKnowledge`**

Mirror postgres-store: merge provenance before deriving the namespace.

```ts
// src/storage/memory-store.ts (inside updateKnowledge, replacing the mergedMetadata line)
import { mergeLabelProvenanceIntoMetadata } from './shared/label-provenance.js';
// ...
const mergedMetadataBase = patch.metadata ? { ...current.metadata, ...patch.metadata } : (current.metadata ?? {});
const mergedMetadataWithProvenance = patch.labels
  ? mergeLabelProvenanceIntoMetadata(mergedMetadataBase, patch.labels)
  : mergedMetadataBase;
const namespace = patch.namespace ?? current.namespace ?? deriveNamespace({
  project: current.project,
  itemType: current.itemType,
  metadata: mergedMetadataWithProvenance,
});
const metadataWithNamespace = writeNamespaceToMetadata(mergedMetadataWithProvenance, namespace);
```
Then use `metadataWithNamespace` for the stored `metadata` field (unchanged below).

- [ ] **Step 4: Run the parity test + full suite**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/label-provenance-parity.test.ts
```
Expected: PASS.

Then:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/storage/memory-store.ts test/label-provenance-parity.test.ts
git commit -m "fix(sp3): memory-store writes label provenance on updateKnowledge (store parity)"
```

### Task 4.3: Extract only provably-identical pure helpers

**Files:** Create `src/storage/shared/ranking.ts`; modify both stores.

- [ ] **Step 1: Identify candidates** — diff the two stores' search-ranking comparators and relation-validity predicates. Only extract functions whose bodies are byte-identical (ignoring whitespace). Do not unify functions that differ.

Run to find candidates:
```bash
grep -nE "function |private .*\(" src/storage/postgres-store.ts | head -60
grep -nE "function |private .*\(" src/storage/memory-store.ts | head -60
```

- [ ] **Step 2: Move each identical helper** into `ranking.ts`, import into both stores.

- [ ] **Step 3: Build + full suite + integration**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
```
Then:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```
Then (Docker stack up):
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
```
Expected: all pass. If the Docker stack is down, state that explicitly and rely on unit coverage; do not silently skip.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(sp3): share provably-identical store ranking helpers"
```

---

## Item 5 — provably-dead removal: verified no-op

**Files:** `docs/tuberosa-debloat-audit-2026-06-02.md`

- [ ] **Step 1: Add a correction note** to the audit's "Safe removals" table noting all three are live: `auto-capture.ts` (imported by http+mcp servers), `organization-cli.ts` (used by `scripts/organization.ts` + tested), `BootstrapService` (instantiated in `bin/commands/bootstrap-factory.ts`, CLI-wired, 3 tests). No code removed.

- [ ] **Step 2: Commit**

```bash
git add docs/tuberosa-debloat-audit-2026-06-02.md
git commit -m "docs(sp3): record that the three 'dead' targets are live (no removals)"
```

---

## Item 6 — merge 3 eval fixture loaders into one

### Task 6.1: Generic loader (failing test first)

**Files:**
- Modify: `src/evaluation/fixture-loader.ts`
- Delete (later): `src/evaluation/context-mapping-fixture-loader.ts`, `src/evaluation/knowledge-completeness-fixture-loader.ts`
- Test: existing eval-loader tests if present; otherwise add `test/fixture-loader.test.ts`.

- [ ] **Step 1: Inspect the three loaders' public functions and shapes**

Run:
```bash
grep -nE "^export " src/evaluation/fixture-loader.ts src/evaluation/context-mapping-fixture-loader.ts src/evaluation/knowledge-completeness-fixture-loader.ts
```

- [ ] **Step 2: Write a test** that loads each of the three fixture files (`eval/retrieval-fixtures.json`, the context-mapping fixtures, the knowledge-completeness fixtures) through the generic loader and asserts the parsed counts match the old loaders.

- [ ] **Step 3: Run to verify it fails**, then implement a parametrized `loadFixtures<T>(path, schema)` (reuse zod from Item 1 for the fixture schemas) covering all three shapes. Keep thin named wrappers if the eval scripts import specific function names.

- [ ] **Step 4: Migrate the eval scripts** (`scripts/eval-*.ts`) to the generic loader; delete the two extra loader files.

- [ ] **Step 5: Gate — every eval suite + unit tests**

Run each, one at a time:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:context-mapping
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:knowledge-completeness
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```
Expected: all green; `eval:retrieval` keeps `hitRate=1`, `staleRejectionRate=1`, classification rates = 1.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(sp3): merge 3 eval fixture loaders into one generic loader"
```

---

## Item 7 — thread resolved retrieval policy once per searchContext

### Task 7.1: Read policy once, pass it down

**Files:** `src/retrieval/service.ts`

- [ ] **Step 1: Baseline the eval before touching retrieval**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
```
Expected: green (records the pre-change baseline).

- [ ] **Step 2: Read once at the top of `searchContext`** (`const policy = getRetrievalPolicy();`) and pass `policy` as a parameter to the helpers that currently call `getRetrievalPolicy()` internally (lines ~166, ~1069, ~1136, ~1543, ~2295, ~2422, ~2454). Leave `getRetrievalPolicyFingerprint()` (~1947) as-is. This is a pure plumbing change — no value should change.

- [ ] **Step 3: Build**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
```
Expected: exit 0.

- [ ] **Step 4: Gate — eval:retrieval must stay identical**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
```
Expected: green, same metrics as Step 1. If any metric changes, the plumbing changed behavior — revert and investigate (do NOT lower thresholds).

- [ ] **Step 5: Full suite**

Run:
```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/retrieval/service.ts
git commit -m "refactor(sp3): resolve retrieval policy once per searchContext"
```

---

## Final gate (whole SP3)

- [ ] **Step 1: Run every gate, one command at a time**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:context-mapping
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:knowledge-completeness
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
```
Expected: all green (integration only if Docker stack is up).

- [ ] **Step 2: Diff check**

```bash
git diff --check
git diff main --stat
```
Expected: no whitespace errors; the stat shows reductions in `validation.ts`, the evaluation loaders, and the stores.

- [ ] **Step 3: Report** the LOC deltas per item and confirm no feature/tool/export was removed (except verified-redundant merged tools, if any).
```
