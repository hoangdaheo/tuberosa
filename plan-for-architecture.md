# Tuberosa Architecture Plan — Phase 2: Worktree Bridge, Handoff Mode, Preview Maintenance, Research Trace

## Context

Tuberosa shipped Phase 1 (browser-tested workbench, API-key protection, compact summaries, learning-gate auto-approval). The Preact workbench refactor with the 11-signal recommendation engine and a glossary/guide is also done. Retrieval and agent-context evals are 100%.

But the agent that used Tuberosa for a real continuation task left structured feedback in `ai-feedbacks.md`:

1. Retrieval correctly returned `needs_confirmation` — *but* the most useful sources for the task were *uncommitted local files* (`handoff.md`, `plan-for-handoff.md`, `tuberosa-concern-answer.md`). Tuberosa cannot read worktree state, so it marked them as missing signals instead of surfacing them.
2. The agent wanted a single "startup brief" verdict (`proceed / confirm / clarify`) with explicit read-first files, missing signals that block confidence, verification commands, and risky areas. The current pack has the *pieces* (orientation, contextFit, taskBrief) but does not compose them into one decisive brief.
3. The agent wanted "stored memory says X exists" distinguished from "current worktree file exists and changed." Today, both look the same.
4. Memory maintenance is review-gated (good) but lacks a *preview* mode — humans cannot see proposed dedup/supersede actions without committing to them.
5. Research insights are only captured as `learningSignals` (structured, optional) — there is no compact post-hoc trace, and the workbench does not surface what reasoning the agent actually used.

External research (Aider, Continue.dev, Cline, Cursor Rules; Mem0, Letta/MemGPT, LangGraph, Generative Agents; Sourcegraph Batch Changes, Zotero, LlamaIndex IngestionPipeline; ReAct/Reflexion, CrewAI Cognitive Memory, AutoGen Tracing, Claude Extended Thinking) confirms each gap maps to a well-established pattern that other systems use. This plan adapts those patterns to Tuberosa's local-first, human-in-the-loop philosophy.

Out of scope: changing the retrieval ranker, embedding migrations, new storage backends, multi-tenant rework. Retrieval and agent-context evals must stay 100%.

## What ships today (recap)

- Retrieval: classify → metadata/FTS/vector/memory/graph search → RRF fuse → rerank → adjustments → context fit → assemble. `RetrievalWorkflowStage='continuation'` and `isContinuationIntent` already exist in `src/retrieval/classifier.ts:495-497`.
- Sessions: `startSession` returns `policy: 'proceed'|'confirm'|'clarify'` (`src/agent-session/service.ts:320-339`) and a `contextPack` with `taskBrief`, `orientation`, `contextFit`.
- Reflection drafts: created on finish, evaluated by the 11-gate `learningGate` (delegated to `src/reflection/recommendation.ts`).
- Operations: `LearningProposal`, `KnowledgeConflict`, `KnowledgeGap` lists with status; mutations currently happen on PATCH directly (`src/operations/service.ts:173-241`).
- Workbench (Preact): summary sidebar, session/quality/memory/guide tabs, per-draft recommendation panel with pros/cons/blockers.

## External landscape (one paragraph each)

**Workspace-aware coding agents (Aider, Continue.dev, Cline, Cursor Rules).** All of them treat current workspace state as a *live provider* invoked at request time, not as pre-indexed memory. Aider maintains a repo map (file list + key symbols) and injects git diffs into the prompt. Continue exposes `@diff`, `@open`, `@codebase` as mention-able providers. Cline reads the whole repo into plan-mode context and proposes diffs before mutation. Cursor Rules live as `.mdc` files versioned alongside code. The recurring pattern: *workspace truth and stored knowledge are separate sources, and the agent (or system) chooses when to consult each.*

**Agent long-term memory (Mem0, Letta, LangGraph Memory, Generative Agents).** Each system separates ephemeral context from durable memory and consolidates with explicit operations. Mem0 classifies extracted facts as ADD / UPDATE / DELETE / NOOP; Letta gives the agent `core_memory_replace` and `archival_memory_insert` tools; LangGraph distinguishes semantic / episodic / procedural memory; Stanford's Generative Agents synthesize reflections from observations at importance thresholds. Recurring pattern: *mutations to memory are first-class, named operations with rationale — not opaque embedding updates.*

**Preview-first knowledge-base mutation (Sourcegraph Batch Changes, Zotero, LlamaIndex IngestionPipeline).** Each one stages mutations as un-applied changesets / candidates / pipeline output, requires explicit apply, and supports refinement before commitment. Sourcegraph `src batch preview` returns a URL where changes can be inspected without pushing; Zotero presents duplicate clusters and requires per-merge confirmation; LlamaIndex caches transformation output before upserting. Recurring pattern: *dry-run → preview → review → apply, with state persisted between preview and apply so multiple reviewers can iterate.*

**Compact reasoning trace (ReAct/Reflexion, CrewAI Cognitive Memory, AutoGen tracing, Claude extended thinking).** All four separate the *thinking* pass (verbose, budgeted, sometimes hidden) from the *summary* pass (compact, structured, queryable). ReAct uses `Thought → Action → Observation` cycles; Reflexion wraps them with self-evaluation; CrewAI auto-decomposes outputs into atomic facts after every task; AutoGen uses OpenTelemetry-style structured traces; Claude exposes a "thinking" block separate from the answer. Recurring pattern: *two budgets — full trace for replay/debug, compact derived summary for memory.*

## Architecture directions

### Direction 1 — Worktree-aware context bridge

**Goal.** When `ContextSearchInput.cwd` is set, retrieval consults a bounded, sanitized view of the current worktree (git status, recently edited files, prompt-named local docs) alongside stored memory, and the resulting candidates carry a `source: "worktree" | "memory"` provenance.

**Reuse, not rebuild.**
- `ContextSearchInput.cwd` already plumbed through to the classifier (`src/retrieval/classifier.ts:189-191`).
- `extractContinuationFiles` at `src/retrieval/classifier.ts:434-442` already hardcodes a handful of doc names — generalise it.
- `addContinuationProvenance` at `src/retrieval/service.ts:611-650` already augments inputs with session history; this is the natural seam to inject worktree evidence.

**Pattern to adopt.** Continue.dev's `@diff` / `@open` providers + Aider's repo map. Worktree state becomes one of the *parallel candidate sources* (alongside metadata / FTS / vector / memory / graph), then enters the same RRF fusion path with a tuned weight.

**Recommended approach.**
- New module `src/retrieval/worktree.ts` exporting `collectWorktreeEvidence({ cwd, prompt, includeUntracked, recentMinutes, maxFiles, maxBytesPerFile })` → `WorktreeEvidenceSummary`. Reads:
  - `git status --porcelain=v1` (bounded list of changed + staged + untracked files)
  - `git log -n 20 --name-only --since="2 days ago"` (recently touched files)
  - Heads of *prompt-named* and *handoff-family* local markdown files (`handoff*.md`, `plan-*.md`, `*concern-answer*.md`, plus any file path the prompt names verbatim) — first ~80 lines or first 2 sections, whichever shorter.
- Returns paths + status + a short section/status summary. **Never** raw diff content, **never** full file bodies. Sanitize through `KnowledgeSafetyService` before returning.
- Surfaces as a sixth candidate source `worktree` in `RetrievalService.searchContext` with `source: 'worktree'` on each `RankedCandidate`. Default RRF weight tuned via the eval harness — start at parity with memory.
- Knowledge gaps generated from missing signals now check the worktree first before being recorded — "missing" means missing in *both* worktree and memory.

**API additions.**
```ts
interface ContextSearchInput {
  // ... existing fields
  includeWorktree?: boolean; // defaults true when cwd is set, false otherwise
}

interface WorktreeFileEvidence {
  path: string;
  status: 'modified' | 'added' | 'untracked' | 'staged' | 'recently-edited';
  summary?: string;   // first heading or first 1-2 sentences (sanitized)
  bytes: number;
  skippedReason?: 'too-large' | 'binary' | 'unsafe-secret-pattern';
}

interface WorktreeEvidenceSummary {
  cwd: string;
  collectedAt: string;
  branch?: string;
  files: WorktreeFileEvidence[];
  truncated: boolean;
}
```
And on `ContextPack`: `worktreeEvidence?: WorktreeEvidenceSummary` plus `source: 'worktree' | 'memory'` on candidates that originated from the worktree.

**Risks & tradeoffs.**
- Filesystem reads add latency. Cap at ~50 files, ~16 KB each, with parallel bounded reads. The cwd → repo discovery uses `git rev-parse --show-toplevel` once per session.
- Worktree evidence is *not* durable knowledge. It is advisory only; it cannot enter the knowledge store unless the agent finishes a session and a reflection draft references it. This is the line that protects against poisoning the corpus with transient state.
- Secrets in untracked files. Run the existing `KnowledgeSafetyService` redactor before exposing anything; respect `.gitignore` heuristics; never read paths matching `.env*`, `*.pem`, `*.key`, `*credentials*`.

---

### Direction 2 — Handoff / continuation workflow with startup brief

**Goal.** When the prompt is a continuation/handoff, return one decisive `StartupBrief` with `action: proceed | confirm | clarify`, an ordered list of read-first files (worktree-first), direct vs adjacent evidence, missing signals that block confidence, and verification commands. The brief composes existing pieces — it does not replace them.

**Reuse, not rebuild.**
- `isContinuationIntent` (`src/retrieval/classifier.ts:495-497`) already detects continuation prompts.
- `RetrievalWorkflowStage='continuation'` and `RetrievalIntent.requiredEvidenceTypes` (with `'handoff'`, `'session_history'`) (`src/retrieval/classifier.ts:196-223`) already exist.
- `sessionPolicy(fitStatus)` (`src/agent-session/service.ts:320-339`) already maps fit to `proceed / confirm / clarify`.
- `ContextPackTaskBrief`, `ContextPackOrientation`, `ActionableMissingSignals` already carry the parts to assemble.

**Pattern to adopt.** Continue.dev's mention-based context providers + Cursor Rules' "rules are versioned with code" insight: *the local plan-of-record beats stored memory*. When local `handoff.md` and `plan-*.md` exist, they become priority-1 read-first files regardless of vector score.

**Recommended approach.**
- New compositor `buildStartupBrief({ classified, contextPack, worktreeEvidence, decisions })` in `src/retrieval/startup-brief.ts`.
- Logic:
  - If `classified.hasContinuationIntent && worktree has handoff.md|plan-*.md` → `action: 'proceed'` (with confidence = `ready`) *only if* the local plan files agree with stored memory; otherwise `'confirm'` with the plan files as priority read-first.
  - If `classified.hasContinuationIntent && neither worktree nor memory has handoff state` → `action: 'clarify'`, list the missing signals, suggest the agent ask the user.
  - Otherwise: derive from existing `sessionPolicy(contextPack.contextFit.fitStatus)` so non-continuation flows are unchanged.
- Pack a single `StartupBrief` onto `ContextPack.startupBrief`:
```ts
interface StartupBrief {
  action: 'proceed' | 'confirm' | 'clarify';
  rationale: string;                 // one-line "why this verdict"
  readFirst: Array<{ path: string; source: 'worktree' | 'memory'; reason: string }>;
  handoffStatus?: { found: boolean; files: string[]; mismatchWithMemory: boolean };
  directEvidence: string[];          // knowledgeIds
  adjacentEvidence: string[];        // knowledgeIds
  missingSignals: ActionableMissingSignals;
  riskyAreas: string[];              // "src/storage/postgres-store.ts schema changes"
  verificationCommands: string[];
  requiredDecisionBeforeFinish: 'selected' | 'missing_context' | 'bypass';
}
```
- The agent-session start response gains `startupBrief` and the workbench Session view renders it as the headline panel.
- Continuation prompts get a stronger classifier: extend `extractContinuationFiles` to (a) match `*.md` files literally named in the prompt, (b) detect `tuberosa-*.md` family, (c) include any file in `worktreeEvidence.files` whose status is `modified|staged` and that matches a doc heuristic.

**Risks & tradeoffs.**
- Misclassifying a non-continuation as continuation pollutes the brief. Mitigate with a tightened `isContinuationIntent` (require either an explicit verb like "continue|resume|handoff" *or* an explicit reference to a handoff file path).
- The brief should not double-bill content. Direct/adjacent evidence references *knowledge IDs* only; the workbench resolves them to titles. This keeps the brief compact (< 2 KB).
- Mismatch detection between local plan and memory needs a clear heuristic: compare titles/headings, not body text, to avoid noisy mismatches.

---

### Direction 3 — Preview-first memory maintenance

**Goal.** Add `POST /operations/maintenance/preview` that scans for duplicates, stale memories, supersession candidates, weakly grounded auto-memories, and orphan labels — *without* mutation. Add `POST /operations/maintenance/apply` that re-runs the check on a selected preview action and applies *only* if it still holds. Auto-apply remains restricted to low-risk label/reference enrichment.

**Reuse, not rebuild.**
- `KnowledgeStore.searchMemories` already returns duplicate candidates ranked by similarity.
- `detectKnowledgeConflicts` (`src/operations/service.ts:881`) already runs pair-wise contradiction checks.
- `LearningProposal` with `proposalType: 'supersedes' | 'missing_label' | 'missing_reference' | 'missing_relation' | 'auto_memory_cleanup'` already exists as the durable record.
- `KnowledgeFeedbackSummary` carries `selectedCount`, `rejectedCount`, `staleCount` per item — the substrate for staleness scoring.

**Pattern to adopt.** Sourcegraph Batch Changes' `preview → published:false → apply` lifecycle, with each detected action persisted as an unapproved `LearningProposal` carrying the original snapshot.

**Recommended approach.**
- `MaintenanceService` (`src/operations/maintenance.ts`) with `preview(input)` and `apply(actionId, options)` methods.
- `preview` runs five detectors in parallel and returns a `MaintenancePreview` per project:
```ts
interface MaintenanceAction {
  id: string;                       // deterministic hash of (kind + targetIds)
  kind: 'dedupe' | 'supersede' | 'stale_demote' | 'auto_memory_cleanup'
      | 'label_enrichment' | 'reference_enrichment' | 'relation_repair';
  risk: 'low' | 'medium' | 'high';  // low → auto-applicable; medium/high → require explicit apply
  target: { knowledgeIds: string[]; relationIds?: string[] };
  rationale: string;                // human-readable explanation
  evidence: string[];               // pointers to feedback / duplicate scores / freshness gaps
  beforeSnapshot: unknown;          // for rollback / re-check
}

interface MaintenancePreview {
  generatedAt: string;
  project?: string;
  actions: MaintenanceAction[];
}
```
- `apply(actionId)` re-runs the action's detector to confirm preconditions, applies the mutation, and stores a `LearningProposal` with `status: 'applied'` + the `beforeSnapshot` for audit. If preconditions changed, returns `'expired'` without mutating.
- Low-risk actions (label/reference enrichment that *adds without removing*) can be auto-applied via an opt-in `autoApplyLowRisk: true` flag, defaulting to *off*.
- Workbench: new "Maintenance" sub-tab under Memory with the action list grouped by kind + risk, a "Preview" button that runs the scan, and per-action "Apply" / "Reject" / "Open" controls. Risky/medium actions require a confirmation dialog (matches the existing `DraftDetail` "approve anyway" pattern).

**Risks & tradeoffs.**
- The preview can be expensive if the corpus is large. Bound it: process at most N candidates per detector (paged), cache results for 5 minutes per project.
- Re-check on apply is essential. Without it, a stale preview could revive a memory the user already deleted.
- Snapshots add storage. Cap snapshot size; for relation repair, store only the relation tuple, not the related knowledge.

---

### Direction 4 — Compact research trace + browser verification

**Goal.** When a session finishes, accept an optional `researchTrace` input *or* auto-derive one from `learningSignals + sessionNotes + decisions + changedFiles + verificationCommands`. Persist only the compact, structured trace — never raw transcripts. Make the trace visible in the workbench so reviewers see what reasoning the agent actually used. Add a "verification" session mode for browser/UI work that records DOM/network audit evidence.

**Reuse, not rebuild.**
- `AgentLearningSignal` (`src/types.ts:818-829`) already carries `kind: 'tip'|'decision'|'mistake'|'verification'|'file_change'|'user_preference'|'follow_up'`, `text`, `source`, `confidence`, `files`, `symbols`, `errors`, `references`.
- `AgentSessionNote` (`src/types.ts:850-865`) carries free-text notes plus optional `feedbackType`.
- `FinishAgentSessionInput` already accepts `learningSignals`, `summary`, `changedFiles`, `verificationCommands` (`src/types.ts:1095-1107`).
- The Preact workbench already renders these in the finish-result card.

**Pattern to adopt.** ReAct's structured `Thought → Action → Observation` trace + Claude extended thinking's separation of full trace from compact summary. We store only the compact summary on the session; the full transcript remains with the agent (out of scope).

**Recommended approach.**
- New input `researchTrace?: ResearchTraceInput` on `FinishAgentSessionInput`. Schema is intentionally narrow:
```ts
interface ResearchTraceStep {
  kind: 'thought' | 'action' | 'observation' | 'decision';
  text: string;            // ≤ 240 chars
  refs?: { files?: string[]; symbols?: string[]; commands?: string[]; knowledgeIds?: string[] };
}
interface ResearchTraceInput {
  steps: ResearchTraceStep[];   // ≤ 12 steps; older ones drop
  outcomeSummary: string;       // ≤ 480 chars
}
```
- If `researchTrace` is omitted, derive one in `agent-session/service.ts:finishSession` by:
  - mapping each `learningSignal` to a step (kind by signal.kind),
  - mapping each session note with `feedbackType` to a step (kind=decision),
  - appending one `observation` step per verification command, and
  - composing `outcomeSummary` from `summary ?? agentOutputSummary ?? signal summary`.
- The trace lives in `session.metadata.researchTrace` and is mirrored into the reflection draft metadata under `provenance.researchTrace` — visible in the workbench DraftDetail without exposing raw content.
- **Browser verification mode.** Add `mode: 'verification'` to `StartAgentSessionInput`. In this mode, finish-session accepts an optional `verificationEvidence: { route?: string; selectorChecks?: Array<{ selector: string; assertion: string; passed: boolean }>; networkSummary?: { requests: number; failures: number } }` that flows into the trace as `observation` steps.

**Risks & tradeoffs.**
- Auto-derivation must never store raw transcript text. The derivation reads only already-structured signals/notes, which are length-bounded by the existing validation.
- Trace caps (12 steps / 240 chars per step) keep storage predictable but may drop nuance — that's intentional. The full transcript stays with the agent.
- Verification mode is opt-in to avoid bloat for non-UI tasks.

## Cross-cutting concerns

- **Secrets safety.** Worktree reads, research-trace derivation, and maintenance snapshots all go through `KnowledgeSafetyService.sanitize*`. Add a regression test that seeds a fake secret in an untracked file and confirms it never reaches the workbench or API response.
- **Backward compatibility.** No database migration; new fields live in existing `metadata` JSON columns and on the in-memory store. Old clients that don't read `startupBrief` / `worktreeEvidence` continue to work.
- **Eval coverage.** Add fixture cases to `eval/retrieval-fixtures.json`:
  - "continuation prompt + worktree-only handoff.md" → expect `startupBrief.action='proceed'`, `readFirst[0].source='worktree'`.
  - "continuation prompt + memory only, no worktree" → expect `startupBrief.action='confirm'`.
  - "continuation prompt + neither" → expect `startupBrief.action='clarify'`.
  Add a maintenance-preview eval that seeds duplicates and asserts the preview surfaces them with `kind='dedupe'`, `risk='medium'`. Add an agent-context eval case for an auto-derived trace.
- **Workbench surfacing.** The Preact app adds two pieces: a `StartupBriefPanel` at the top of the Session view (replaces `SessionResult`'s current header), and a `MaintenanceTab` under Memory with preview / apply controls. All glossary terms (`handoff`, `worktree evidence`, `maintenance preview`) get entries in `src/workbench/glossary/terms.ts`.

## Phased rollout

The phases are designed so each phase is independently shippable and reverts cleanly.

**Phase A — Worktree provider + startup-brief skeleton (1–2 working days)**
- `src/retrieval/worktree.ts`, `WorktreeEvidenceSummary` types.
- Wire into `RetrievalService.searchContext` as a sixth candidate source (off by default, on when `cwd` set).
- Compose a v0 `StartupBrief` that *re-packages* existing `policy` + `orientation` + `taskBrief` without new heuristics, plus worktree read-first files.
- Workbench Session view renders the brief.
- New retrieval eval cases for worktree-only handoff and worktree+memory agreement.

**Phase B — Continuation classifier hardening + brief verdict logic (1 day)**
- Tighten `isContinuationIntent` and `extractContinuationFiles` per Direction 2.
- Add the `proceed / confirm / clarify` decision logic to `buildStartupBrief`.
- Add the "mismatch with memory" detection (title/heading overlap).
- Eval cases for the three brief verdicts.

**Phase C — Maintenance preview + apply (2 days)**
- `src/operations/maintenance.ts` with five detectors. Reuse `searchMemories`, `detectKnowledgeConflicts`, `KnowledgeFeedbackSummary`.
- New HTTP endpoints + MCP tools `tuberosa_maintenance_preview` and `tuberosa_maintenance_apply`.
- Workbench Maintenance sub-tab.
- Re-check-before-apply test that mutates state between preview and apply and verifies the apply returns `'expired'`.

**Phase D — Research trace + verification mode (1 day)**
- `ResearchTraceInput` type and `FinishAgentSessionInput.researchTrace` plumbing.
- Auto-derivation function with caps.
- Browser verification mode: extend the existing Playwright test (`test/browser/workbench-browser.test.ts`) to exercise a verification-mode session and assert the trace appears in the workbench DraftDetail.

Phase A unblocks B; C and D are independent of B but should ship after A so they see the new evidence sources.

## Critical files

Existing files to be modified (no full rewrites):
- `src/retrieval/classifier.ts:434-442, 495-497` — generalise continuation file extraction.
- `src/retrieval/service.ts:91-100, 611-650` — add worktree provider as a sixth candidate source.
- `src/retrieval/context-fit.ts` — incorporate worktree evidence into "missing signal" inference.
- `src/agent-session/service.ts:86-137, 320-339` — emit `startupBrief`; consume optional `researchTrace`.
- `src/operations/service.ts:106-241` — keep existing PATCH paths; route through new `MaintenanceService` for new previews.
- `src/http/server.ts` — add `/retrieval/worktree-preview` (debug), `/operations/maintenance/preview`, `/operations/maintenance/apply`. Reuse the existing API-key gate and `validate*` factories.
- `src/types.ts` — add `WorktreeEvidenceSummary`, `StartupBrief`, `ResearchTraceInput`, `MaintenanceAction`, `MaintenancePreview`. Add `includeWorktree` to `ContextSearchInput`. Add `worktreeEvidence`, `startupBrief` to `ContextPack`. Add `researchTrace` to `FinishAgentSessionInput`.
- `src/security/knowledge-safety.ts` — `sanitizeWorktreeEvidence`, `sanitizeResearchTrace` helpers (reuse existing redactors).
- `src/workbench/views/SessionView.tsx` — render `StartupBriefPanel`.
- `src/workbench/views/MemoryView.tsx` — add Maintenance sub-tab.
- `src/workbench/glossary/terms.ts` — add `worktree_evidence`, `startup_brief`, `maintenance_preview`, `research_trace`, `verification_mode`.

New files:
- `src/retrieval/worktree.ts` — `collectWorktreeEvidence`.
- `src/retrieval/startup-brief.ts` — `buildStartupBrief`.
- `src/operations/maintenance.ts` — preview/apply, detectors.
- `src/agent-session/research-trace.ts` — `deriveResearchTrace`.
- `eval/maintenance-fixtures.json` — seed corpus for the preview eval.
- `test/worktree.test.ts`, `test/startup-brief.test.ts`, `test/maintenance.test.ts`, `test/research-trace.test.ts`.

## Verification

End-to-end checks before declaring each phase done:

- `pnpm test` — full unit suite stays green; new files add coverage for the four directions.
- `pnpm run eval:retrieval` — 100% on every metric. New continuation/worktree fixture cases included.
- `pnpm run eval:agent-context` — passed. New trace-derivation case included.
- `pnpm run eval:knowledge-completeness` — passed.
- `pnpm test:integration` — Postgres + Redis path still healthy (skips if Docker is down).
- `pnpm test:workbench-browser` — extended to assert the `StartupBriefPanel` renders for a continuation prompt that has only a worktree handoff file, and that the Maintenance tab shows a preview action for a seeded duplicate.
- **Secrets regression.** New `test/secrets-regression.test.ts` seeds a fake `OPENAI_API_KEY=...` line in an untracked file and confirms it never appears in any worktree-evidence, startup-brief, maintenance-preview, or research-trace response.
- **Manual smoke.** Start session at `/workbench` with the local `handoff.md` present; verify the brief shows `action='proceed'`, `readFirst[0].path='handoff.md'`, `readFirst[0].source='worktree'`. Delete the file, restart — verdict becomes `confirm` or `clarify`. Open Memory → Maintenance, click Preview, then Apply a label-enrichment action; verify the action is recorded as an applied `LearningProposal` with `beforeSnapshot`.
- **Bundle size.** Workbench bundle stays under 100 KB gzipped after the new panel + sub-tab.
