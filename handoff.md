# Tuberosa Handoff

Date: 2026-05-19

## Goal We Are Working Toward

Tuberosa is a local-first context broker and learning layer for AI agents. The core goal remains reliable context mapping: an agent should start a task, ask Tuberosa for the right project memory, receive compact and explainable context, record whether it was useful, and let Tuberosa learn only through reviewed, safe, provenance-rich memories.

The v1 roadmap in `docs/AGENT_CONTEXT_ROADMAP.md` is now effectively complete through Phase 10:

- Phase 9 hardened retrieval for continuation prompts, stale/superseded memories, missing-context gaps, conflict review, and graph-expanded evidence.
- Phase 10 hardened agent startup context with orientation, direct-evidence ordering, usefulness categories, context-quality feedback, and better session compliance.

New product direction from the user: the v1 roadmap is now baseline context, not a creative ceiling. Future Tuberosa work can explore richer product surfaces such as review workspaces, guided agent-start flows, context-quality dashboards, hosted/collaborative modes, and deeper agent-review experiences, as long as local-first operation, reviewed memory, provenance, safety, and verification discipline remain intact.

## Current State Of The Code

Implemented before this handoff:

- Agent session workflow, context compliance metadata, one-call layered context, feedback-driven ranking, reflection review, operations review endpoints, backup/recovery, knowledge graph relations, and retrieval eval coverage are in place.
- Retrieval supports deterministic structured intent, continuation anchors, graph expansion, stale/superseded suppression, conflict records, knowledge gaps, learning proposals, and evidence-first provider reranking.
- Phase 10 context packs expose `orientation`, `evidenceCategory`, `evidenceStrength`, `usefulnessReason`, and `actionableMissingSignals`.
- Normal startup packs cap `priorLessons` and `adjacentContext`, while debug/deep-context budgets can relax those caps.
- MCP schemas advertise canonical enum values and runtime validation normalizes common task-type aliases such as `development` -> `implementation`.
- Reflection draft labels/references can be reviewed before approval, and post-finish session notes can append context-quality feedback.

Latest changes in the working tree:

- `selected_but_noisy` now behaves as selected context for agent session compliance and learning-pack selection.
- `missing_orientation`, `missing_current_handoff`, and `missing_verification_commands` now satisfy missing-context compliance instead of leaving sessions as `needs_decision`.
- Regression tests cover both of those session-compliance behaviors.
- `CLAUDE.md` now lists current MCP tool families instead of saying the MCP server exposes only four tools.
- `AGENTS.md`, `README.md`, `docs/AGENT_CONTEXT_ROADMAP.md`, `handoff.md`, and `handoff-claude.md` now remove the conservative v1 ceiling and explicitly allow more creative post-v1 Tuberosa product work.
- A reviewed Tuberosa memory was created and approved: "V1 roadmap is no longer a creative ceiling." It records the user correction that v1 should be baseline context, not a restriction against richer product direction.

## Files Actively Edited

- `src/agent-session/service.ts`
  - Adds selected/missing-context helper semantics so context-quality feedback maps correctly to session compliance and learning behavior.

- `test/agent-session.test.ts`
  - Adds regression tests for `selected_but_noisy` compliance and missing context-quality compliance.

- `docs/AGENT_CONTEXT_ROADMAP.md`
  - Marks Phase 10 follow-up behavior as done.
  - Updates assumptions so local-first and v1 remain a baseline, not a ceiling.

- `AGENTS.md`
  - Replaces "Simplicity First" with "Intentional Scope" for Tuberosa product work.
  - Allows creative, cohesive post-v1 product work when it advances Tuberosa's purpose.

- `README.md`
  - Removes the hard "not a general chat UI yet" / admin-debug-only framing.
  - Reframes UI direction as broader product UI exploration with provenance and reviewed-memory constraints.

- `CLAUDE.md`
  - Corrects stale MCP tool documentation.

- `handoff.md`
  - This file; rebuilt because it was empty in the working tree.

- `handoff-claude.md`
  - Removes the old "do not create a separate v2 effort" instruction and replaces it with the new post-v1 baseline-not-ceiling direction.

## Everything Tried That Failed Or Needed Correction

- Earlier audit finding: `selected_but_noisy` was accepted by the API but did not count as selected context in `sessionCompliance()` or `selectedContextPack()`.
  - Fix: added selected-decision semantics for both `selected` and `selected_but_noisy`.
  - Verification: targeted agent-session tests, full test suite, retrieval eval, agent-context eval, integration test, and diff checks passed before this handoff update.

- Related compliance gap: context-quality missing signals (`missing_orientation`, `missing_current_handoff`, `missing_verification_commands`) created knowledge gaps but did not satisfy session missing-context compliance.
  - Fix: those feedback types now map to missing-context compliance.

- `CLAUDE.md` said MCP exposed only four tools.
  - Fix: updated the MCP entry-point docs to mention retrieval, agent-session, reflection-review, feedback, and error-log tools.

- `handoff.md` was empty when this final handoff request started.
  - Fix: rebuilt it from `docs/AGENT_CONTEXT_ROADMAP.md`, current diffs, and the latest session state.

- The Tuberosa context for the "remove v1 constraint" task returned `needs_confirmation` because the prompt had no concrete file/symbol/error signal.
  - Outcome: useful but noisy; recorded `selected_but_noisy`, then recorded a normal `selected` decision as a compatibility workaround because the currently running MCP server may not include the in-work compliance fix until restarted.

- Local HTTP knowledge searches for old v1-ceiling memories returned no matching knowledge rows.
  - Outcome: instead of directly editing storage, created and approved a reviewed reflection memory with the new user policy.

- Known environment issue from prior work: `pnpm run eval:agent-context` can fail inside the sandbox with `listen EPERM` on `/tmp/tsx-*`.
  - Workaround: rerun with escalation when needed. It passed during Phase 10 verification.

- GitNexus was attempted during audit, but the configured GitNexus instance did not have the `tuberosa` repo indexed.
  - Outcome: audit continued with staged diffs and local verification.

## Verification Already Run

Latest checks after the Phase 10 compliance follow-up passed:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/agent-session.test.ts test/api-boundary.test.ts test/retrieval.test.ts
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
git diff --check
git diff --cached --check
```

Latest checks after the v1-ceiling documentation update:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --test --import tsx test/agent-session.test.ts
git diff --check
git diff --cached --check
```

Before committing, rerun at least:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
git diff --check
```

Also run `pnpm run eval:retrieval` for any retrieval, ranking, context-pack, classifier, feedback-scoring, or signal-hygiene change.

## Improve Plan And Next Steps

Next step I would take:

1. **Stabilize the post-v1 product direction.**
   - Write a short post-v1 product plan that turns the new "v1 is baseline, not ceiling" policy into 2-3 candidate product bets.
   - Strong candidates: context-quality review dashboard, guided agent-start workspace, and reflection/knowledge review workbench.

2. **Make context-quality feedback actionable.**
   - Build an operations surface for `selected_but_noisy`, `too_much_adjacent_context`, `missing_orientation`, `missing_current_handoff`, and `missing_verification_commands`.
   - Show affected context packs, noisy items, missing signals, and suggested label/relation/freshness edits.

3. **Enrich item explanations.**
   - Extend `usefulnessReason` beyond category-based text to explicitly mention freshness/stale risk, supersession, graph path, feedback contribution, and exact evidence.
   - Add tests before changing ranking or explanation logic.

4. **Clean up noisy historical memories.**
   - Use the new reviewed policy memory to supersede or mark stale any old memories that still imply "do not create v2" or "stay inside Phase 9/10 only" if they appear in retrieval.
   - Prefer review workflows and `supersedes` relations over direct storage edits.

5. **Restart/reload services before relying on new compliance behavior through MCP.**
   - The code fix is in the working tree, but the currently running MCP/HTTP process may still be using the previous implementation until restarted.

## Notes For The Next Agent

- Start by calling `tuberosa_start_session` and record the context decision; this repo uses Tuberosa as its own continuation workflow.
- Read `docs/AGENT_CONTEXT_ROADMAP.md`, `handoff.md`, and `tuberosa-project.md` before substantial work.
- Do not auto-trust raw conversation as memory. Keep learning grounded, labeled, referenced, and reviewable.
- Do not treat the v1 roadmap as a creative constraint. Use it as baseline context, then plan the next product increment around user value.
- Keep local-first operation, reviewed memory, provenance, and safety discipline intact while exploring broader product ideas.
- Prefer existing abstractions when implementing: `AgentSessionService`, `RetrievalService`, `ReflectionService`, `KnowledgeStore`, review filters, feedback events, reflection drafts, and knowledge relations.
