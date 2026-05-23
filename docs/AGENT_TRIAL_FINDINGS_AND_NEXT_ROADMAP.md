# Tuberosa: Trial Findings + Next Roadmap

Authored 2026-05-23 after running the agent-trial harness end-to-end on `trial-fusion-vector-penalty`. Companion to `AGENT_TRIAL_FRAMEWORK_ROADMAP.md` (which was static analysis); this doc is grounded in what the trial actually surfaced when child + debater + mother ran on a real task.

## 1. Did Tuberosa feed appropriate knowledge?

**Partially — about 65% useful.** Verdict from the trial: `tuberosa_partially_correct`.

What was right:
- Classification correctly extracted the relevant symbols and files for an exploration task.
- The two essential items (`fusion.ts:sourceWeight`, `policy.ts:DEFAULT_POLICY`) were substantively correct and the most important evidence for the task.
- One supporting item from `docs/FLOW_LOGIC.md` confirmed the design intent.

What was wrong — and only the debater caught most of it:

| Problem | Severity | What it cost |
|---|---|---|
| Pack omitted `taskProfiles` layer (`policy.ts:222-253`) | High | The child published incorrect arithmetic (`0.92 - 0.08 = 0.84`) when the true value for the classified `exploration` task is `0.92 + 0.04 - 0.08 = 0.88`. A working agent would have shipped a wrong answer. |
| Pack omitted `effectiveSourceWeight()` (`policy.ts:394`) | High | The function that actually wires base weights to task profiles wasn't surfaced. Child collapsed the layer. |
| `k-flow-logic-fusion` content stitched two non-adjacent doc paragraphs and presented as verbatim | Medium | Hallucination-by-pack. The child accepted the stitched quote without flagging. |
| `k-policy-default` cites line 184 but spans 184-196 | Medium | Off-by-N citations make verification slow and erode trust. |
| `k-fusion-source-weight` used `...` ellipsis to elide lines 155-162 | Medium | Truncation hid the task-itemType boost logic, also part of the same function. |
| `k-paywall-modal-noise` referenced `src/components/paywall-selection-modal.tsx` — file doesn't exist in this repo | High | A fabricated path slipped through into optional. |
| `k-old-stale-fusion-memory` directly contradicts `k-policy-default` | High | `suppressionEnabled.{stale,superseded,evidenceMismatch}=true` but none of the suppressors fired. |
| `contextFit.fitStatus = "ready"` despite an inter-pack contradiction | High | Tuberosa told the agent the pack was good when it wasn't. |
| `orientation.verificationCommands` named `test/fusion-profiles.test.ts` but the test's assertions were never surfaced | Medium | Recommended a verification path the agent has no shortcut to. |

**Net signal**: the essential items carry the load, but the assembly + suppression + per-item integrity all need tightening. A working agent that follows the pack would have produced a confident answer that was numerically off.

## 2. What should Tuberosa do when approaching a new task?

This is the design question worth lingering on. Today Tuberosa runs the same pipeline shape on every query and returns whatever lands. The trial suggests it should be more deliberate, in this order:

### 2.1 Plan its retrieval, then surface the plan

Before executing, classify and decide which sources are *likely* to dominate. Skip stages that contribute nothing:
- Hard signals present (file/symbol/error) → metadata + lexical + graph are likely to win; vector is fallback.
- No hard signals → vector + memory carry more weight.
- The gated query-rewrite (`service.ts:144-167`) is the precedent for this kind of decision; extend the same gating to per-source execution.

Then **surface the plan in the pack**:
```json
"retrievalPlan": {
  "sourcesExecuted": ["metadata", "lexical", "graph"],
  "sourcesSkipped": ["vector"],
  "reason": "anchored search with file:fusion.ts + symbol:hardSignalVectorPenalty — exact hits expected to dominate"
}
```
Agents that see this can reason about whether the pack's blind spots match their question.

### 2.2 Pre-flight verify every claim against the source

The single biggest finding from the trial. Before returning a pack, run these cheap checks on each candidate:
- `references[].uri` exists on disk (or in physical mirror).
- If `content` quotes a code snippet, the quote should be byte-exact against the file at the cited line OR explicitly tagged `supportType: "paraphrase"`.
- If `content` quotes a doc, the quote should appear in the doc *contiguously* — not stitched.
- Line citations should land at the start of the cited content (`±1` line tolerance, configurable).

Items that fail get either auto-corrected (e.g., fix the line number) or dropped with a `verification_failed` note.

### 2.3 Detect inter-pack contradictions before assembling

`KnowledgeStore.detectConflicts` exists but runs offline. Lift the same logic into a retrieval-time pass over the top 12 candidates. If two `essential` candidates disagree (same label, contradicting summaries; same file, different behavior assertions), downgrade `fitStatus` to `needs_confirmation` and add `contextFit.contradictions[]` so the agent sees both sides.

### 2.4 Refuse to return a weak pack

When `contextFit.fitStatus = "insufficient"`, Tuberosa today still returns whatever it found. Better: return a `clarification_required` response with a structured ask:
```json
{
  "status": "clarification_required",
  "missingSignals": ["explicit file scope", "task type"],
  "suggestedQuestions": ["Which file are you editing?", "Is this a refactor or a debug?"]
}
```
The agent can then re-query with better signals — instead of bluffing through a weak pack.

### 2.5 Confidence as a vector, not a scalar

Replace `confidence: 0.78` with:
```json
"confidence": {
  "overall": 0.78,
  "classifier": 0.74,
  "ranking": 0.81,
  "fit": 0.74,
  "fact_verified": 0.62,
  "low": 0.65,
  "high": 0.86,
  "weakest_link": "fact_verified"
}
```
Now the agent can see *what* is uncertain. A pack with `fact_verified: 0.62` is one to triple-check, not blindly cite.

## 3. What's the improvement for Tuberosa through the task?

"Through the task" reads as in-task learning — how findings made *during* a task feed back into the system. Today there's no clean path.

### 3.1 A trial-finding ingest endpoint

A new MCP tool: `tuberosa_record_trial_finding`. Accepts the debater's output shape (the 9 failure-mode strings I observed are a perfect starting vocabulary) and:
- Each `tuberosa_failure_modes[]` entry → a `learning_proposal` of type `pipeline_quality_issue`.
- Each `inter_pack_contradictions[]` entry → a `knowledge_conflict` row.
- Each `pack_fact_check[]` entry with verdict `contradicted_by_code` → marks the affected knowledge `needs_review`.
- Each `counter_context.missed_facts[]` → a `knowledge_gap` row scoped to the original prompt fingerprint.

This is what makes the agent harness compound. Without it, every trial's findings die in a JSON file.

### 3.2 Claim-level feedback (not just item-level)

`tuberosa_feedback_context` accepts item-level types (selected, stale, etc.). Add claim-level: when an agent asserts "this specific sentence in item X was wrong", the feedback should be tied to the claim, not the whole item. Implementation:
```json
{ "feedbackType": "claim_wrong",
  "knowledgeId": "...",
  "claimId": "...",
  "actualTruth": "...",
  "verifiedAgainst": "src/...ts:N" }
```
This routes into a much finer-grained review queue than "the whole memory is bad".

### 3.3 Within-session re-retrieval after a missing-context flag

Right now, `missing_context` feedback is recorded but doesn't drive a follow-up. The session is over. Better: when the agent records `missing_context` with specific missing signals (`"missing": ["taskProfiles", "effectiveSourceWeight"]`), Tuberosa should auto-retry the search with those terms appended to the lexical query and return a *delta pack* with just the new candidates. Agents shouldn't have to re-prompt to fill a known gap.

### 3.4 Outcome attribution

Once `solved_with_pack` / `failed_with_pack` exist (P2.1 from the earlier roadmap), tie each outcome to the pack and feed it into per-knowledge-item utility scoring. After enough trials, items with high "appeared in pack but never used" rates get nominated for archival.

## 4. Things I want but Tuberosa doesn't support right now

Drawing directly from what the trial wanted but couldn't get:

### 4.1 Retrieval-time fact verification (the #1 ask)
What it would do: before any pack is returned, every quoted snippet is byte-checked against the source file. Broken references get dropped. Off-by-N line citations get corrected. Stitched quotes get marked `supportType: "synthesized"`.

### 4.2 Per-claim provenance
Each pack item should carry `claims[]: [{ id, text, sourceUri, line, supportType: "exact"|"paraphrase"|"inference", verifiedAt }]`. Agents cite `pack:itemId:claimId` instead of vague `pack:itemId`. Debaters verify atomically.

### 4.3 Inter-pack contradiction in `contextFit`
A first-class `contextFit.contradictions: [{ leftId, rightId, claim_left, claim_right }]` field that downgrades fit status when populated.

### 4.4 Confidence breakdown + interval
See §2.5. Per-stage confidence + low/high band + weakest-link diagnostic.

### 4.5 Retrieval plan in the response
See §2.1. `retrievalPlan: { sourcesExecuted, sourcesSkipped, reason }` so agents understand the blind spots.

### 4.6 Pack diff across runs
When Tuberosa is improving, agents want a way to ask: "for the same prompt fingerprint, what items changed between today's run and last week's?" Useful for regression hunting and for understanding why a previously-good pack got worse.

### 4.7 Trial-finding ingest pipeline
See §3.1. `tuberosa_record_trial_finding` + the back-pressure into learning proposals + knowledge conflicts + gaps.

### 4.8 Self-test mode
`tuberosa doctor --trials` runs the seed agent-trial cases against a memory-backed store and reports pass/partial/fail. Catches regressions in classifier / fusion / fit before they ship.

### 4.9 Agent attribution on feedback
Every feedback event records *which agent role* produced it (`mother | child | debater | human`). The same event from a mother carries more weight than the same event from a child. Today `metadata.agentSessionId` exists but role is buried.

### 4.10 Explanation budget on search
A search input flag `explainBudget: 500` (tokens) that asks Tuberosa to spend up to N tokens narrating *why* each top item won. A debug-trace-lite for live agents (the existing `debug: true` is too verbose and bypasses cache).

### 4.11 Stale-memory automatic suppression for code-contradiction
When a `memory` item's claims contradict a `code_ref` item that points at the actual file, the memory should auto-suppress (`status: needs_review`, `metadata.suppression: code_contradiction`) — not just rely on freshness penalty. The trial proved freshness alone wasn't enough.

### 4.12 Fix-then-fixture workflow
A command that converts a trial finding into a new entry in `eval/retrieval-fixtures.json` automatically. Today every roadmap item ends in "...and add a fixture to lock this in" but the conversion is manual.

## Priority ordering (what to do first)

Based on this trial alone:

| Priority | Item | Why |
|---|---|---|
| P0 | Fix worktree-UUID leak | Trials cannot run live until this is fixed. See `AGENT_TRIAL_FRAMEWORK_ROADMAP.md#P0.1`. |
| P0 | §4.1 Retrieval-time fact verification | Single root cause of half the trial findings. |
| P1 | §4.3 Inter-pack contradictions in `contextFit` | Stale memory slipped through despite `suppressionEnabled=true`; contradictions need a retrieval-time pass. |
| P1 | §4.2 Per-claim provenance | Enables agents and debaters to verify atomically; precondition for §4.1. |
| P1 | §2.4 Refuse to return weak packs | The single biggest UX leverage point — agents bluff through weak packs today. |
| P2 | §3.1 Trial-finding ingest pipeline | The harness is useless without this. |
| P2 | §2.5 Confidence as a vector | Better agent decisions with the same retrieval. |
| P2 | §2.1 Retrieval plan in pack | Cheap to add; high agent value. |
| P3 | §4.6 Pack diff across runs | Nice-to-have, helpful for development. |
| P3 | §4.8 `tuberosa doctor --trials` | Operational hygiene. |
| P3 | §4.12 Fix-then-fixture workflow | Process improvement. |

## Practical signals for what to use Tuberosa for *today*

While the above changes ship over time, today's agents using Tuberosa should treat it as:

- **Trusted for**: pointer retrieval ("which files matter for X", "is there a prior bugfix for Y"), workflow lookup, project labels.
- **Verify before citing**: any code snippet (line numbers and content), any "behavior X happens when Y" claim, any cross-paragraph doc quote.
- **Don't trust without checking**: claims in `memory`-type items that contradict the live code (freshness alone isn't enough), inter-item agreement (Tuberosa won't flag contradictions for you).
- **Use `noiseTolerance: strict` + `contextMode: compact`** for refactor/answer tasks. Reserve `layered` for exploration.

The harness made this gap quantifiable: out of 5 pack items, 2 were the kind a worker would have happily used as-is without the debater. That's the agent-trust ceiling Tuberosa sits at today, and §4.1 + §4.3 are the moves that raise it most.
