# Tuberosa Phase 11 — Audit-Failure Repair + Document-Level Tooling

> **Status:** ⏳ PLANNED (2026-05-22) — implementation deferred. This file is the source of truth for the Phase 11 plan; pick it up next session.

## Context

This plan was triggered by a real-world failure during the Phase 10 audit session (2026-05-22):

- The user pointed Tuberosa at a 1,176-line plan file (`implements/enhance_rewrite/tuberosa-enhance-knowledge-quality.md`) and asked "audit each phase". `tuberosa_start_session` returned **one** Phase 3 reflection — a frozen write-up from 2026-05-22 — and the Phase 5/9/10 carry-over bugs the user actually needed were buried in the plan body, not surfaced.
- The Phase 8 brief-groundedness guard then **dropped** the obvious follow-up action `read_file: tuberosa-enhance-knowledge-quality.md` with `brief_warning:dropped_ungrounded_action`, because no candidate in the pack carried that exact file label — even though the file was named in `classified.files`.
- The very first `tuberosa_start_session` call **crashed** with `invalid input syntax for type uuid: "worktree:55b28bc..."` — the Phase 5 worktree synthetic ids leaked into a Postgres `::uuid` cast. We patched the storage boundary at runtime; this plan adds the compile-time guard.

**Intended outcome:** Tuberosa surfaces document-level state (per-phase status, open carry-overs) when a long plan file is named in the prompt, treats caller-authority prompt files as self-grounded, weights current reflections over old ones, and makes the synthetic-id leak structurally impossible in TypeScript. Plus three new MCP tools that expose the document-level view the audit needed.

**Scope** (user-confirmed via AskUserQuestion 2026-05-22): all 8 enhancements as Phase 11 — five retrieval-quality fixes (E1–E5) + three new MCP tools (T1–T3). Each piece is independently flag-gated and reversible.

**Recency defaults** (user-confirmed): 180-day half-life, 0.5 floor.

**Industry references consulted:**
- [Learning TypeScript — Branded Types](https://www.learningtypescript.com/articles/branded-types) and [Nana Adjei Manu — Branded Types in TypeScript: From Structural to Nominal Typing](https://nanamanu.com/posts/branded-types-typescript/) — zero-runtime-cost compile-time invariants for id types.
- [LanceDB — Parent Document & Bigger Chunk Retriever](https://www.lancedb.com/blog/modified-rag-parent-document-bigger-chunk-retriever-62b3d1e79bc6) and [GraphRAG — Parent-Child Retriever](https://graphrag.com/reference/graphrag/parent-child-retriever/) — child-level chunks vote upward to parent documents; weight parents by recency.
- [Memory for Autonomous LLM Agents (arxiv 2603.07670)](https://arxiv.org/pdf/2603.07670) — long-term memory must weight recency to keep current state from being drowned by stale memories.
- [Hindsight — Agent Memory Benchmark Manifesto](https://hindsight.vectorize.io/blog/2026/03/23/agent-memory-benchmark) — session-diff framing for evaluating what changed.

---

## Order of execution + dependencies

```
  E4 (branded ids)  ─┐
                     ├──> E1 (prompt-named-file boost; uses brand for type-safer signatures)
  E3 (recency)      ─┤
                     │
  E2 (groundedness) ─┘──> requires E1 (carve-out without promotion leaves pack confidence dip)
  E5 (PG wrapper)   ─────── independent; defense-in-depth for the bug E4 closes at compile time

  D-extractor       ─┬──> T1 (document summary; reuses marker scan)
                     ├──> T2 (open carryovers; reads markers + LearningProposal + stale relations)
                     │
                     └──> T3 (session diff; independent of above, walks AgentContextDecision)
```

Recommended commit sequence: **E4 → E3 → E1 → E2 → D-extractor → T1 → T2 → T3 → E5**.
E5 last because its blast radius is smallest and the safest revert.

---

## Cross-cutting invariants

- `pnpm run eval:retrieval` stays 14/14 green throughout. Each phase ships its fixture first.
- `pnpm run eval:context-mapping` baseline preserved (precision 25%, recall 100%, entities 100%, noise 75%, placement 100%, fit 100%, forbidden 0%, brief groundedness 100%).
- `pnpm run eval:agent-context`, `pnpm run eval:safety`, `pnpm run sandbox` stay green.
- Every behavior change is gated by an env flag or a `policy.*.enabled` toggle, default-on except where noted.
- MCP surface is backwards-compatible (additive only).
- `HashModelProvider` (offline path) continues to work.
- For retrieval-pipeline changes: write the regression fixture first, then the code that turns it green.

---

# Part A — Retrieval-Quality Repairs (E1–E5)

## E1 — Prompt-named-file → essential-bucket boost

**Why:** durable memories that carry the literal file name from `classified.files` should beat tangentially-related memories from vector/graph hits. This was the load-bearing failure in the audit session.

**Files to modify:**
- `src/retrieval/service.ts` — `intentSuppressionAdjustment` (lines 1767–1894). Insert new positive-boost branch **between line 1860 and 1862**, alongside the existing `worktree_live_evidence` and `domain_match` branches. Composition flows through unchanged via `applyIntentSuppression`'s `nextScore = clampScore(dampedBase + adjustment.boost)` at line 1723.
- `src/retrieval/policy.ts` — add `promptFileMatch: { enabled: boolean; boost: number }` to `RetrievalPolicy` (after line 157, sibling to `queryRewrite`). Default `{ enabled: true, boost: 0.18 }`. Wire through `DEFAULT_POLICY` and `mergePolicy`.
- `src/retrieval/context-pack.ts` — `assembleContextPack` (61–107). After the essential/supporting/optional partition, force-promote any candidate whose `labels[type='file']` or `references[type='file',uri]` matches a `classified.files` entry into `essential`. Evict the lowest-score non-forced essential if over token budget; preserve at least one non-forced anchor.

**Surgical sketch (service.ts, ~20 lines):**

```typescript
// inside intentSuppressionAdjustment, after worktree branch (1845–1860), before domainMatch (1862):
if (policy.promptFileMatch.enabled && classified.files.length > 0) {
  const wanted = new Set(classified.files.map(f => f.toLowerCase()));
  const matchesPromptFile =
    candidate.labels.some(l => l.type === 'file' && wanted.has(l.value.toLowerCase()))
    || candidate.references.some(r => r.type === 'file' && r.uri && wanted.has(r.uri.toLowerCase()));
  if (matchesPromptFile) {
    boost += policy.promptFileMatch.boost;          // default 0.18
    reasons.push('boost:prompt_named_file');
  }
}
```

Boost size 0.18 sits below worktree's `prompt_named` (0.6, live disk evidence still wins) and above `domain_match` (~0.15, so a literal-file durable memory beats a same-domain unrelated memory).

**Regression fixture (write first):**
- `eval/retrieval-fixtures.json` — new case `prompt-named-file-bucket-promotion`. Two seeded memories: a stale Phase-3 reflection (memory+graph+lexical hits, no file label) vs. a Phase-9 reflection with `file=tuberosa-enhance-knowledge-quality.md` label (memory only). Assert the Phase-9 reflection wins and lands in the `essential` section.
- `test/retrieval.test.ts` — companion unit: `prompt-named file gets +0.18 boost and force-promotes to essential`, exercised behind `setRetrievalPolicy({ promptFileMatch: { enabled: true, boost: 0.18 } })`.

**Deviation budget:** Phase-7 RRF calibration — at most 1 of the 14 cases may shift confidence by ≤ 0.03. If `confidenceThresholdRate` drops below 14/14, re-tune boost down to 0.14 before disabling. Brief-groundedness rate expected to **rise** (more file-labeled candidates in essential).

**Rollback:** `policy.promptFileMatch.enabled = false`. Branch becomes a no-op; promotion gated on the same flag.

---

## E2 — Phase 8 brief-groundedness carve-out for prompt-named files

**Why:** when the user names a file in their prompt, that's caller authority. The `read_file` action for it should self-ground the same way `review_target` self-grounds via `target.id`, not be dropped because no retrieved candidate carries the same file label.

**Files to modify:**
- `src/retrieval/context-pack.ts` — `groundActionItem` (lines 831–880). Add an optional `classified?: ClassifiedQuery` parameter; thread it through from `buildActionItems` call site (line 787 — `input.input.classified` is already in scope).

**Surgical sketch (~14 lines):**

```typescript
function groundActionItem(
  item: ContextPackActionItem,
  selected: RankedCandidate[],
  classified?: ClassifiedQuery,           // NEW
): GroundActionDecision {
  if (POLICY_ONLY_ACTIONS.has(item.action)) return { keep: true, item };
  const keywords = actionKeywords(item);

  if (item.action === 'read_file' && item.targetPath) {
    // E2 — caller authority: a prompt-named file self-grounds.
    const wantedFiles = new Set((classified?.files ?? []).map(f => f.toLowerCase()));
    if (wantedFiles.has(item.targetPath.toLowerCase())) {
      const fileMatches = matchingFileCandidates(item.targetPath, selected);
      const evidenceIds = fileMatches.length > 0
        ? uniqueStrings(fileMatches.map(c => c.knowledgeId))
        : [`file:${item.targetPath}`];  // synthetic self-grounding token, mirrors review_target pattern
      return { keep: true, item: { ...item, evidenceIds } };
    }
    // ...existing unchanged: matchingFileCandidates → zero-overlap → drop paths...
  }
  // ...review_target unchanged...
}
```

Call site update at line 787: `groundActionItem(item, input.selected, input.input.classified)`.

**Regression fixture:**
- `test/context-pack-phase8.test.ts` — new case `prompt-named read_file survives brief-groundedness guard`. Build a pack input with `classified.files = ['plan.md']` and zero candidates labeled with that file. Assert `actionItems` contains a `read_file` for `plan.md` with `evidenceIds: ['file:plan.md']`; assert no `dropped_ungrounded_action` warning.
- `eval/context-mapping-fixtures.json` — new case mirroring the original audit failure (prompt names `tuberosa-enhance-knowledge-quality.md`).
- Update `src/evaluation/context-mapping-evaluator.ts` `isActionGrounded` to recognize `file:<path>` self-grounding alongside the existing `target.id === action.targetId` branch.

**Deviation budget:** zero behavior change for the existing 8 context-mapping cases (the carve-out only fires when `targetPath ∈ classified.files`). 100% brief-groundedness preserved by construction.

**Rollback:** shares `policy.promptFileMatch.enabled` with E1 (they're a unit — disable both together).

---

## E3 — Per-candidate recency multiplier

**Why:** today only the feedback-scorer reads any timestamp signal (latest feedback decay at 60-day half-life). A stale Phase-3 reflection currently outranks a current Phase-9 reflection purely on vector + graph match strength. Recency should multiply the candidate's score so current state cascades through downstream selection — not just sit inside the fit gate.

**Defaults confirmed:** 180-day half-life, 0.5 floor (max 50% damping).

**Files to modify:**
- `src/retrieval/policy.ts` — add top-level `recency: { enabled: boolean; halfLifeDays: number; floor: number }` block. Defaults `{ enabled: true, halfLifeDays: 180, floor: 0.5 }`. Wire through `DEFAULT_POLICY` and `mergePolicy`.
- `src/retrieval/feedback-scorer.ts` — new exported helper `computeRecencyMultiplier(freshnessAt, updatedAt, now, policy)`. Sibling of `computeFeedbackPenalty`.
- `src/retrieval/service.ts` — `applyRankingAdjustments` (lines 640–658). Compose recency between `applyFeedbackSummary` and `applyIntentSuppression` so it multiplies the same `finalScore` field feedback just adjusted, before suppression damping.

**Surgical sketch (feedback-scorer.ts, ~16 lines):**

```typescript
export function computeRecencyMultiplier(
  freshnessAt: string | undefined,
  updatedAt: string | undefined,
  now: Date,
  policy = getRetrievalPolicy(),
): number {
  if (!policy.recency.enabled) return 1;
  const anchor = freshnessAt ?? updatedAt;
  if (!anchor) return 1;
  const ts = Date.parse(anchor);
  if (Number.isNaN(ts)) return 1;
  const days = Math.max(0, (now.getTime() - ts) / 86_400_000);
  // Exponential decay; at 180d the factor hits the floor 0.5
  const raw = Math.exp(-days * Math.LN2 / policy.recency.halfLifeDays);
  return Math.max(policy.recency.floor, raw);
}
```

Mass at common ages: 30d → 0.89, 60d → 0.79, 180d → 0.5 (floor), 540d → 0.5 (floor).

**Regression fixture:**
- `eval/retrieval-fixtures.json` — new case `recency-multiplier-current-beats-stale`. Two near-identical seeds with identical labels. `seedA.freshnessAt = now - 30d`, `seedB.freshnessAt = now - 540d`. Disable `policy.suppressionEnabled.stale` so only the multiplier differentiates. Assert `seedA` ranks first.
- `test/feedback-scorer-phase2.test.ts` — extension `computeRecencyMultiplier respects half-life and floor`, 6 cases pinning anchor-missing / NaN / current / 60d / 180d / 540d.

**Deviation budget:** max 50% damping at 180d+. Per-itemType freshness map (`spec`/`rule` already get 540-day freshness windows) keeps load-bearing aged specs from being annihilated by suppression — recency is separate and bounded by the floor. If `eval:context-mapping` precision regresses, raise floor to 0.7 (≤ 30% damping ceiling).

**Rollback:** `policy.recency.enabled = false`. Function short-circuits to return 1.

---

## E4 — `PersistedKnowledgeId` branded type

**Why:** the Phase 5 worktree synthetic-id crash that hit the audit session at minute zero. We patched the runtime in `src/storage/postgres-store.ts` with `isPersistedKnowledgeId` + `filterPersistedKnowledgeIds`. The brand adds a compile-time backup so future code can't accidentally pass a `worktree:<sha>` to a method that casts to `::uuid`.

**Files to modify:**
- `src/types.ts` — declare `PersistedKnowledgeId`, `WorktreeKnowledgeId`, `KnowledgeIdLike` near `SearchCandidate` (lines 553–572). Export helpers `asPersistedKnowledgeId(s)`, `asWorktreeKnowledgeId(s)`, `unsafePersistedId(s)` (test escape hatch).
- `src/storage/postgres-store.ts` — narrow return types of the existing `isPersistedKnowledgeId` predicate (lines 73–79) and `filterPersistedKnowledgeIds` (just added in the audit-pass hotfix). Runtime regex unchanged.
- `src/retrieval/worktree.ts` — line 168: cast `worktree:${sha256(file.rel)}` as `WorktreeKnowledgeId`.
- `src/storage/store.ts` — write-method parameter types accept `PersistedKnowledgeId | string` (string for legacy callers; the brand hint travels via the new helpers).

**Surgical sketch (types.ts, ~14 lines):**

```typescript
declare const persistedBrand: unique symbol;
declare const worktreeBrand: unique symbol;
export type PersistedKnowledgeId = string & { readonly [persistedBrand]: 'PersistedKnowledgeId' };
export type WorktreeKnowledgeId  = string & { readonly [worktreeBrand]:  'WorktreeKnowledgeId'  };
export type KnowledgeIdLike = PersistedKnowledgeId | WorktreeKnowledgeId | string;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function asPersistedKnowledgeId(value: string): PersistedKnowledgeId | undefined {
  return UUID_RE.test(value) ? (value as PersistedKnowledgeId) : undefined;
}
export function asWorktreeKnowledgeId(value: string): WorktreeKnowledgeId {
  return value as WorktreeKnowledgeId;  // worktree provider is the sole producer
}
export function unsafePersistedId(value: string): PersistedKnowledgeId {
  return value as PersistedKnowledgeId;  // test escape; do not use in production code
}
```

Pattern is `string & { readonly __brand: unique symbol }`, zero runtime cost — per [Learning TypeScript branded-types](https://www.learningtypescript.com/articles/branded-types).

**Regression fixture:**
- `test/types.test.ts` (extension) — `branded knowledge ids prevent worktree id reaching persisted method`. Includes a `// @ts-expect-error` line that confirms a `WorktreeKnowledgeId` passed to a method typed `PersistedKnowledgeId` is a compile error. Runtime asserts: `asPersistedKnowledgeId('worktree:abc') === undefined`; `asPersistedKnowledgeId('<valid-uuid>')` returns the branded value.

**Deviation budget:** zero runtime delta. `tsc --noEmit` may flag 2–5 callsites that need `?? unsafePersistedId(...)` or a proper `asPersistedKnowledgeId` cast.

**Rollback:** no env flag — brand erases at runtime. Revert at the TS level if it breaks the build; the Phase-5 runtime regex stays in place.

---

## E5 — Graceful-degradation telemetry wrapper for store calls

**Why:** the audit-session crash was a 500 on the whole MCP call. Defense-in-depth: when a uuid cast fails (PG error `22P02`/`22023`), log to `ErrorLogService` and return an empty result instead of failing the whole request. Bounded so legitimate query failures (connection, permission, syntax) still surface.

**Files to modify:**
- `src/storage/postgres-store.ts` — new private `safeQuery<R>(label, fn, fallback): Promise<R>`. Wrap **read paths only** that accept externally-sourced ids: `getKnowledge`, `listKnowledgeRelations`, `listKnowledgeChunks`, `searchLexical`/`Vector`/`Metadata`/`Memories`/`GraphRelations`, `getFeedbackSummaries`. Writes (`recordFeedback`, `recordAgentContextDecision`) still throw.
- `src/app.ts` — pass `errorLogs: ErrorLogService` into `PostgresKnowledgeStore` constructor (optional; falls back to console).

**Surgical sketch (~22 lines):**

```typescript
private async safeQuery<R>(
  label: string,
  fn: () => Promise<R>,
  fallback: R,
): Promise<R> {
  try {
    return await fn();
  } catch (error: any) {
    const code = error?.code as string | undefined;
    // 22P02 = invalid_text_representation (the uuid-cast crash that hit the audit session)
    // 22023 = invalid_parameter_value
    // Only swallow cast/validation errors. Connection (08*), permission (42501),
    // syntax (42601) MUST bubble.
    const swallow = code === '22P02' || code === '22023';
    if (this.errorLogs) {
      await this.errorLogs.recordLog({
        category: 'database',
        severity: swallow ? 'warning' : 'error',
        title: `postgres-store:${label}:${code ?? 'unknown'}`,
        message: String(error?.message ?? error),
        tags: ['retrieval', 'pg-cast', label],
      }).catch(() => undefined);
    }
    if (!swallow) throw error;
    return fallback;
  }
}
```

Application example: `listKnowledgeChunks` becomes `return this.safeQuery('listKnowledgeChunks', async () => { ... }, []);`.

**Regression fixture:**
- `test/postgres-degradation.test.ts` (new) — mock pool to throw `{ code: '22P02' }`; assert caller receives `[]`/`undefined` (per method signature), `ErrorLogService.recordLog` called once with `category: 'database', severity: 'warning'`. Second case: throw `{ code: '08006' }` (connection lost) → assert error rethrows.
- Extension to `test/integration.test.ts` — sneak a non-UUID id past `filterPersistedKnowledgeIds` via test harness; confirm no thrown MCP error.

**Deviation budget:** zero behavior change in the happy path. Failure path now returns empty results — the existing Phase-5 hotfix already filters at every callsite, so this is purely defense-in-depth.

**Risk:** a swallowed `22P02` could mask a real type bug. The error-log entry surfaces it for review (`tuberosa list-error-logs --category database --severity warning`).

**Rollback:** env flag `TUBEROSA_PG_GRACEFUL_DEGRADATION` (default `true`). When `false`, `safeQuery` becomes `await fn()` and rethrows.

---

# Part B — Document-Level MCP Tools (T1–T3)

## D-extractor — `DocumentMarkerExtractor` (shared infra for T1 + T2)

**Why:** Tuberosa's atomizer (Phase 4) splits markdown by heading and emits `DocumentAtom { breadcrumb, sectionPath, lineStart, lineEnd, ... }`. Status markers in the plan files (`**Status: ✅ DONE`, `**Tried but not done`, `**Known bug`) live in the atom **body**, not in headings — so today there's no structured way to ask "what's open in this doc". The extractor scans atom bodies post-atomize with a small conservative regex set and writes `metadata.markers` so T1 and T2 can read it without re-parsing.

**New file:** `src/ingest/document-markers.ts` (~120 lines)

```typescript
export interface DocumentMarkers {
  status?: 'done' | 'in_progress' | 'blocked' | 'open';
  statusText?: string;          // raw text after the marker (e.g. "✅ DONE (2026-05-22)")
  carryover?: boolean;          // body contains "Tried but not done" or "Carry-over"
  knownBug?: boolean;           // body contains "Known bug"
  resolved?: boolean;           // body contains "RESOLVED" or "FIXED"
  phaseLabel?: string;          // "Phase N" if matched in section title or first line
}

const STATUS_RE = /\*\*Status:\s*([^\n*]+)/i;
const CARRYOVER_RE = /\*\*(?:Tried but not done|Carry-over|Deliberate carry-overs?)/i;
const KNOWN_BUG_RE = /\*\*Known bug/i;
const RESOLVED_RE = /\b(?:RESOLVED|FIXED)\b/i;
const PHASE_RE = /\bPhase\s+(\d+[a-z]?)\b/i;

export function extractDocumentMarkers(atom: DocumentAtom): DocumentMarkers | undefined { ... }
```

**Wiring:** call from `IngestionService.buildAtomKnowledgeInput` (`src/ingest/service.ts:214–269`) so every atom that has markers carries them under `metadata.markers`. Existing atoms get re-extracted via the **backfill script** below.

**Backfill script:** `scripts/backfill-markers.ts` (new)

```typescript
// pnpm run backfill:markers [--project <name>] [--source <uri>]
// Walks store.listKnowledge({project, limit: 5000}), re-runs the extractor on
// each knowledge item's content via store.listKnowledgeChunks([id]), patches
// metadata.markers via store.updateKnowledge(id, { metadata: { ...existing, markers } }).
// Idempotent: skip rows whose metadata.markers.version matches the extractor's version.
```

Add `"backfill:markers": "tsx scripts/backfill-markers.ts"` to `package.json`.

**Storage helper (additive):** extend `ListKnowledgeOptions` (`src/types.ts:427`) with optional `sourceUri?: string` to filter by source path. Implement in both `MemoryKnowledgeStore` (trivial filter) and `PostgresKnowledgeStore` (predicate on `ks.uri = $sourceUri` in `knowledgeSelect`).

---

## T1 — `tuberosa_get_document_summary({ sourcePath, project? })`

**Why:** when the user asks Tuberosa to audit a long evolving document, return a rolled-up parent-document view — every section, breadcrumb, line range, and extracted status marker. This is the parent tier of the parent/child retriever pattern Tuberosa's existing per-chunk hits already implement at the child tier.

**New service:** `src/operations/document-summary.ts` (~180 lines)

```typescript
export interface DocumentSummaryInput { sourcePath: string; project?: string }
export interface DocumentSection {
  knowledgeId: string;
  sectionPath: string[];
  breadcrumb: string;
  headingLevel?: number;
  lineStart: number;
  lineEnd: number;
  title: string;
  summary: string;
  markers?: DocumentMarkers;
  updatedAt: string;
}
export interface DocumentSummary {
  sourcePath: string;
  project?: string;
  totalAtoms: number;
  sections: DocumentSection[];
  openMarkers: { phaseLabel?: string; markers: DocumentMarkers; knowledgeId: string }[];
  generatedAt: string;
}

export class DocumentSummaryService {
  constructor(private readonly store: KnowledgeStore) {}
  async summarize(input: DocumentSummaryInput): Promise<DocumentSummary> {
    const items = await this.store.listKnowledge({
      project: input.project, sourceUri: input.sourcePath, limit: 500,
    });
    const sections = items
      .map(toDocumentSection)
      .sort((a, b) => a.lineStart - b.lineStart);
    const openMarkers = sections
      .filter(s => s.markers && isOpen(s.markers))
      .map(s => ({ phaseLabel: s.markers!.phaseLabel, markers: s.markers!, knowledgeId: s.knowledgeId }));
    return { sourcePath: input.sourcePath, project: input.project,
             totalAtoms: items.length, sections, openMarkers,
             generatedAt: new Date().toISOString() };
  }
}
function isOpen(m: DocumentMarkers): boolean {
  return (m.knownBug && !m.resolved) || m.carryover || m.status === 'in_progress' || m.status === 'blocked';
}
```

**MCP tool descriptor** (in `src/mcp/server.ts`, alongside Phase 10 maintenance tools around lines 991–1047):

```json
{
  "name": "tuberosa_get_document_summary",
  "title": "Get Tuberosa Document Summary",
  "description": "Phase 11 — Roll up every atom indexed from a source document, grouped by section, with extracted status/carry-over markers. Use when the prompt names a long plan/spec/wiki file and the agent needs the current state, not chunk hits.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sourcePath": { "type": "string" },
      "project":    { "type": "string" }
    },
    "required": ["sourcePath"]
  }
}
```

**Dispatch switch case** (alongside `tuberosa_propose_maintenance` at lines 343–362):

```typescript
case 'tuberosa_get_document_summary': {
  const summary = await services.documentSummary.summarize(
    validateDocumentSummaryInput(args)
  );
  return toolJson({
    summary,
    instruction: summary.openMarkers.length > 0
      ? `${summary.openMarkers.length} open items detected — review before proceeding.`
      : 'Document has no open carry-overs.',
  });
}
```

**Validator** (`src/validation.ts`): `validateDocumentSummaryInput(value) → DocumentSummaryInput`. Pattern from Phase 10's `validateMaintenanceProposeInput` (lines 339–354).

**Service wiring** (`src/app.ts`): `const documentSummary = new DocumentSummaryService(store);` add to `AppServices` interface and the returned object.

**Test fixture:** `test/phase11-document-summary.test.ts` — 4 cases:
1. Seed a 3-atom doc, assert `sections.length === 3` and ordering by `lineStart`.
2. Seed atoms with mixed `markers.knownBug=true/resolved=true` and `markers.knownBug=true/resolved=undefined`; assert `openMarkers` only contains the unresolved one.
3. Empty source returns `totalAtoms: 0, sections: []`.
4. `sourcePath` not matching any ingested atom returns the empty shape (no error).

---

## T2 — `tuberosa_list_open_carryovers({ project?, sourcePath?, limit? })`

**Why:** the inverse of the workbench's completion summary — one call that surfaces everything still open across (a) document markers, (b) pending learning proposals with non-ADD write-gate decisions, (c) graph relations with expired `validUntil`. The audit's "what's still open in Phase 5/9/10" question would have been one call instead of reading 1,176 lines.

**Extends:** `src/operations/document-summary.ts` (or new sibling `src/operations/carryover.ts`) — a `CarryoverService` that aggregates three sources.

```typescript
export type CarryoverKind = 'document_marker' | 'pending_proposal' | 'expired_relation';
export interface CarryoverItem {
  kind: CarryoverKind;
  project?: string;
  sourcePath?: string;
  knowledgeId?: string;
  relationId?: string;
  reflectionDraftId?: string;
  label: string;
  reason: string;
  detectedAt: string;
}
export interface OpenCarryoversInput {
  project?: string;
  sourcePath?: string;
  limit?: number;       // default 50, ceiling 200
}
export interface OpenCarryoversResult {
  items: CarryoverItem[];
  counts: Record<CarryoverKind, number>;
  totalDetected: number;
  truncated: boolean;
  generatedAt: string;
}

export class CarryoverService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly documentSummary: DocumentSummaryService,
  ) {}
  async list(input: OpenCarryoversInput): Promise<OpenCarryoversResult> { ... }
}
```

Detection sources:
- **`document_marker`**: walk `listKnowledge({project, sourceUri, limit})`, filter atoms whose `metadata.markers` satisfies `isOpen(...)`.
- **`pending_proposal`**: `listLearningProposals({project, status: 'pending', limit})` — keep rows whose `metadata.writeGate.decision !== 'ADD'` OR `metadata.writeGate.decision === undefined`.
- **`expired_relation`**: `listKnowledgeRelations({project, limit})` filter `metadata.validUntil` parses to a timestamp ≤ now. (Phase 6c stamps these; Phase 10 maintenance prunes them; this surfaces the unpruned ones.)

**MCP tool descriptor + dispatch:** mirror T1's pattern. Input schema fields `project, sourcePath, limit` — none required.

**Validator:** `validateOpenCarryoversInput(value)` in `src/validation.ts`.

**Workbench integration** (`src/operations/workbench-summary.ts:39–195`): mirror Phase 10's maintenance pattern.
- Add `WorkbenchSummaryServices.carryover?: Pick<CarryoverService, 'list'>` (optional — graceful empty when omitted).
- Run `services.carryover.list({ project, limit: filters.limit }).catch(() => undefined)` inline alongside the existing maintenance scan (line 68–70 pattern).
- Add `counts.openCarryovers: number` (the existing `WorkbenchSummaryCounts` interface in `src/types.ts:1682–1705` block).
- Add `openCarryovers: WorkbenchCarryoverPreview` to `WorkbenchSummary`. Compactor `compactCarryoverPreview(result, limit)` mirroring `compactMaintenancePreview` (lines 173–195).
- New priority-3 recommended action `'open_carryovers'` when `counts.openCarryovers > 0`; presenter routes to a new `{ view: 'memory', memoryTab: 'carryovers' }` or reuses the proposals tab if no frontend work is in scope.
- Update `src/workbench/presenters/summaryPresenter.ts` `actionTarget(...)`.
- Update `src/operations/workbench-cli.ts` to surface `Open carryovers:` in the Counts section.

**Test fixture:** `test/phase11-carryover.test.ts` — 5 cases:
1. Seed an atom with `markers.knownBug && !markers.resolved`; assert one `document_marker` item.
2. Seed an atom with `markers.knownBug && markers.resolved=true`; assert it does NOT appear (the audit just resolved the Phase-5 bug — it should drop off the list).
3. Seed a `LearningProposal` with `metadata.writeGate.decision = 'NOOP'`; assert one `pending_proposal` item.
4. Seed a `KnowledgeRelation` with `metadata.validUntil` in the past; assert one `expired_relation` item.
5. Multi-kind scan returns all three; `counts` sums correctly; `truncated=true` when `totalDetected > limit`.

---

## T3 — `tuberosa_diff_sessions({ prevSessionId, currentSessionId, project? })`

**Why:** "what changed since my last session" was the user's fourth want from the feedback. Today it requires reading two `getContextPack` outputs by hand. T3 returns the structured delta in one call.

**New service:** `src/operations/session-diff.ts` (~150 lines)

```typescript
export interface SessionDiffInput {
  prevSessionId: string;
  currentSessionId: string;
  project?: string;
}
export interface KnowledgeDiffEntry {
  knowledgeId: string;
  prevScore?: number;
  currentScore?: number;
  scoreDelta?: number;
  prevSection?: 'essential' | 'supporting' | 'optional';
  currentSection?: 'essential' | 'supporting' | 'optional';
  prevFeedback?: AgentContextDecisionType;
  currentFeedback?: AgentContextDecisionType;
}
export interface SessionDiffResult {
  prevSessionId: string;
  currentSessionId: string;
  addedKnowledgeIds: string[];
  removedKnowledgeIds: string[];
  commonKnowledgeIds: KnowledgeDiffEntry[];  // with deltas
  decisionChurn: number;        // count of selected ↔ rejected flips
  scoreShifts: { knowledgeId: string; delta: number }[];  // sorted by |delta| desc, top 10
  generatedAt: string;
}

export class SessionDiffService {
  constructor(private readonly store: KnowledgeStore) {}
  async diff(input: SessionDiffInput): Promise<SessionDiffResult> {
    const [prev, current] = await Promise.all([
      this.store.getAgentSession(input.prevSessionId),
      this.store.getAgentSession(input.currentSessionId),
    ]);
    if (!prev || !current) throw new Error('session not found');
    const [prevPack, currentPack] = await Promise.all([
      prev.initialContextPackId ? this.store.getContextPack(prev.initialContextPackId) : undefined,
      current.initialContextPackId ? this.store.getContextPack(current.initialContextPackId) : undefined,
    ]);
    const [prevDecisions, currentDecisions] = await Promise.all([
      this.store.listAgentContextDecisions({ sessionId: input.prevSessionId, limit: 200 }),
      this.store.listAgentContextDecisions({ sessionId: input.currentSessionId, limit: 200 }),
    ]);
    // ... build the diff: walk both packs' sections[].items; index by knowledgeId;
    // compute added/removed/common; for common, compute scoreDelta + section move;
    // walk decisions to attach prev/currentFeedback per id; count churn.
    return { ... };
  }
}
```

**MCP tool descriptor:** mirror T1. `prevSessionId` and `currentSessionId` required, `project` optional.

**Validator:** `validateSessionDiffInput(value)` in `src/validation.ts`.

**Workbench integration:** none (T3 is on-demand, not a queue).

**Test fixture:** `test/phase11-session-diff.test.ts` — 4 cases:
1. Both sessions exist, same pack id → `addedKnowledgeIds === [] && removedKnowledgeIds === []`, `commonKnowledgeIds.length === pack.itemCount`, all `scoreDelta === 0`.
2. Different packs with 3 overlapping ids and 2 distinct each → assert counts.
3. Decision churn — session A has `selected` on id X, session B has `rejected` on id X → assert `decisionChurn === 1`.
4. Missing session → throws clear error message.

---

# Files Modified or Created (representative paths)

**New:**
- `src/ingest/document-markers.ts` — `extractDocumentMarkers` + regex set + version constant.
- `src/operations/document-summary.ts` — `DocumentSummaryService`.
- `src/operations/carryover.ts` — `CarryoverService` (if not folded into document-summary.ts).
- `src/operations/session-diff.ts` — `SessionDiffService`.
- `scripts/backfill-markers.ts` — idempotent re-scan of ingested atoms.
- `test/phase11-document-summary.test.ts`
- `test/phase11-carryover.test.ts`
- `test/phase11-session-diff.test.ts`
- `test/postgres-degradation.test.ts` (E5)

**Modified:**
- `src/retrieval/policy.ts` — `promptFileMatch`, `recency` blocks on `RetrievalPolicy`; merge support.
- `src/retrieval/service.ts` — new positive-boost branch in `intentSuppressionAdjustment`; recency multiplier in `applyRankingAdjustments`.
- `src/retrieval/context-pack.ts` — `assembleContextPack` essential-bucket promotion; `groundActionItem` carve-out.
- `src/retrieval/feedback-scorer.ts` — `computeRecencyMultiplier` export.
- `src/storage/postgres-store.ts` — `safeQuery<R>` wrapper; brand return-type narrowing.
- `src/storage/memory-store.ts` — honor new optional `ListKnowledgeOptions.sourceUri`.
- `src/storage/store.ts` — `ListKnowledgeOptions.sourceUri?: string`.
- `src/ingest/document-atomizer.ts` (or `src/ingest/service.ts`) — call `extractDocumentMarkers` and write `metadata.markers`.
- `src/types.ts` — brand types; Phase 11 input/output/preview interface block; `ListKnowledgeOptions.sourceUri`.
- `src/retrieval/worktree.ts` — cast worktree id as `WorktreeKnowledgeId`.
- `src/validation.ts` — three new validators + `validateDocumentSummaryInput`, `validateOpenCarryoversInput`, `validateSessionDiffInput`.
- `src/app.ts` — wire `documentSummary`, `carryover`, `sessionDiff` into `AppServices`; pass `errorLogs` into `PostgresKnowledgeStore`.
- `src/mcp/server.ts` — 3 new tool descriptors + 3 new dispatch cases.
- `src/operations/workbench-summary.ts` — carryover preview integration.
- `src/operations/workbench-cli.ts` — surface `Open carryovers:` count.
- `src/workbench/presenters/summaryPresenter.ts` — new action target route.
- `package.json` — `"backfill:markers"` script.
- `eval/retrieval-fixtures.json` — `prompt-named-file-bucket-promotion`, `recency-multiplier-current-beats-stale` cases.
- `eval/context-mapping-fixtures.json` — `brief-groundedness:prompt-named-file-carveout` case.
- `implements/enhance_rewrite/tuberosa-enhance-knowledge-quality.md` — Phase 11 status block.

---

# Verification

**Per-phase invariant** (run before marking each E/T sub-phase complete):

```bash
pnpm install
pnpm run build
pnpm test
pnpm run eval:retrieval              # 14/14 (15/15 after E1+E3 land), context-fit 100% — must stay
pnpm run eval:context-mapping        # precision 25%, brief 100% — must not regress
pnpm run eval:agent-context          # must stay green
pnpm run eval:safety                 # 100/100/100 — must stay
pnpm run sandbox                     # p50/p95 within 1.2× / 1.5× of Phase 10 baseline
```

**Phase 11 full success criteria** (measured against current `eval/baseline-context-mapping.json`):

- `eval:retrieval` 15/15 (the new `prompt-named-file-bucket-promotion` case + the new `recency-multiplier-current-beats-stale` case both pass).
- `eval:context-mapping` precision ≥ 25%, brief groundedness 100% (preserved by E2 carve-out), forbidden 0%.
- New `pnpm run eval:retrieval` reports show the prompt-named candidate in `essential` for the new case.
- `pnpm run backfill:markers --project tuberosa` exits successfully and patches `metadata.markers` on ≥ 1 atom of `implements/enhance_rewrite/tuberosa-enhance-knowledge-quality.md`.

**End-to-end MCP smoke** (the failure mode this plan fixes):

```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory pnpm run dev
# In Claude Code or another MCP client:
#   tuberosa_get_document_summary({ sourcePath: 'implements/enhance_rewrite/tuberosa-enhance-knowledge-quality.md', project: 'tuberosa' })
#   → returns ~25 sections (one per Phase + Audit pass + Cross-cutting) with markers
#   tuberosa_list_open_carryovers({ project: 'tuberosa' })
#   → returns the union of remaining Tried-but-not-done blocks + pending NOOP proposals + expired relations
#   tuberosa_start_session({ prompt: 'audit each phase of tuberosa-enhance-knowledge-quality.md', files: ['implements/enhance_rewrite/tuberosa-enhance-knowledge-quality.md'], ... })
#   → essential bucket now contains a doc-labeled candidate; brief-groundedness guard keeps the read_file action
```

**Postgres-backed smoke (E4 + E5):**

```bash
docker compose up --build -d
# Verify the previous worktree:<sha> crash no longer reproduces:
#   tuberosa_start_session({ prompt: 'review Phase 5', files: [<some-file-in-cwd>] })
#   → returns a pack with worktree candidates; no MCP error
# Then sneak a bad id into the rejected list and confirm graceful degradation:
#   tuberosa_search_context({ prompt: '...', rejectedKnowledgeIds: ['not-a-uuid'] })
#   → returns results; one ErrorLog row with category='database', severity='warning', tag='pg-cast'
```

---

# Risk Table

| Risk | Catching fixture |
|---|---|
| E1 boost reorders a Phase-7 RRF case | `eval:retrieval` confidence threshold check on all 14 existing cases |
| E1 forced promotion evicts a load-bearing essential | new `prompt-named-file-bucket-promotion` `expectedSectionForKnowledgeIds` |
| E2 carve-out lets a totally-irrelevant `read_file` survive | existing `test/context-pack-phase8.test.ts` zero_overlap cases still drop when `targetPath ∉ classified.files` |
| E3 over-damps a load-bearing aged spec | floor 0.5; per-itemType freshness map keeps specs healthy |
| E4 ts-strict failures in dist build | `tsc --noEmit` in CI; `unsafePersistedId` escape hatch for tests |
| E5 swallows a legitimate query failure | error-log entry with `severity: warning` — weekly review or `tuberosa list-error-logs` |
| E5 applied to write path (would mask data loss) | code-review checklist; only wrap read methods |
| D-extractor regex over-fires on legitimate prose | conservative pattern; backfill script is idempotent and reversible (clear `metadata.markers`, re-run) |
| T1 hits a 5,000-atom document | `limit: 500` constant in service; reviewers truncate ingestion |
| T2 propose runs inline in workbench summary every call | mirror Phase 10 maintenance — catch errors, never block, consider TTL cache if profiling shows hot path |
| T3 missing sessions or packs | service throws clear error; test case #4 |

---

# Rejected Alternatives (one per piece)

- **E1 alt** — put the boost inside `fusion.ts` source weights. **Rejected**: fusion is per-source; this boost is per-candidate and depends on `classified.files`, which fusion doesn't carry. `intentSuppressionAdjustment` is the documented home for per-candidate score deltas.
- **E2 alt** — drop the brief-groundedness guard entirely for `read_file`. **Rejected**: we'd lose the 100% groundedness invariant. The carve-out preserves it for the general case and only exempts caller-authority files — same principle as `review_target.id` self-grounding.
- **E3 alt** — add recency as a fifth `contextFit` contributor. **Rejected**: `contextFit` is composite, not score-shaping. We want recency to multiply the per-candidate `finalScore` so it cascades through downstream selection.
- **E4 alt** — runtime tagged-union `{ kind: 'persisted' | 'worktree', id: string }`. **Rejected**: breaks every existing `knowledgeId === ...` comparison and JSON serialization across 200+ callsites. Branded type is zero-runtime-cost.
- **E5 alt** — wrap at the MCP tool-handler layer. **Rejected**: loses category specificity (every PG error becomes an MCP error) and prevents per-method fallback shapes (`[]` vs `undefined`). Store boundary keeps the failure local.
- **T1/T2 alt** — extract markers at retrieval time instead of ingest time. **Rejected**: scales O(N) per query; ingest-time extraction is O(N) once + O(1) per query. Backfill script handles already-ingested documents.
- **T3 alt** — compute diff in the workbench frontend by fetching two packs. **Rejected**: doubles round-trip cost; can't surface `decisionChurn` without joining with `AgentContextDecision` rows that aren't on the pack. Backend tool is the right home.

---

# Cross-Cutting Feature Flags (Phase 11)

| Piece | Flag | Default | Behavior when off |
|---|---|---|---|
| E1 + E2 | `policy.promptFileMatch.enabled` | `true` | No boost; no carve-out (paired by design) |
| E3 | `policy.recency.enabled` | `true` | `computeRecencyMultiplier` returns 1 |
| E4 | none (compile-time only) | n/a | n/a — TS-level revert if needed |
| E5 | `TUBEROSA_PG_GRACEFUL_DEGRADATION` | `true` | `safeQuery` rethrows |
| D-extractor | `TUBEROSA_DOCUMENT_MARKERS_ENABLED` | `true` | Ingest skips marker extraction; existing markers remain |
| T1/T2/T3 | none (additive MCP tools) | always on | Tools simply exist; clients opt in by calling them |

All MCP tool signatures remain backwards-compatible; every new parameter is optional with safe defaults.
