---
id: 02-stale-memory-debate
task_type: implementation
task: |
  Replace the legacy paywall flow with the new flow described in the current wiki.
  The codebase currently uses the new flow. Make sure the worker doesn't follow
  the stale memory that still references the legacy flow.
files: ["src/components/paywall-selection-modal.tsx"]
symbols: ["PaywallSelectionModal"]
errors: []
ground_truth:
  changed_files: []
  required_facts:
    - "The codebase already uses the new flow."
    - "The memory item titled 'legacy paywall handoff' is stale and contradicts current code."
  forbidden_outcomes:
    - "Worker recommended adopting the legacy flow"
    - "Worker did not detect the contradiction between the wiki and the memory item"
expectations:
  expected_fit_status: needs_confirmation
  must_include_knowledge_ids:
    - "current-paywall-flow-wiki"
  must_not_include_knowledge_ids:
    - "legacy-paywall-memory"
  contradiction_expected: true
constraints:
  noise_tolerance: strict
  context_mode: layered
  token_budget: 4000
notes: |
  Inter-pack contradiction is the centerpiece. The debater MUST detect it. If the
  child worker follows the stale memory, that's a Tuberosa failure (the memory
  should have been suppressed by freshness/feedback or flagged at retrieval time).

  If the stale memory does NOT exist in the test fixture yet, the harness should
  flag this as "fixture coverage gap" and propose adding it. This is itself a
  finding the mother judge should record as a P2 improvement.
---

# Case 02 — Stale memory vs current wiki: does Tuberosa flag the contradiction?

## Why this case exists

`KnowledgeStore.detectConflicts` runs offline and surfaces overlapping knowledge with disagreeing summaries. But at retrieval time, an agent can still receive both the stale memory AND the current wiki in the same pack with no warning. The debater's `inter_pack_contradictions` field is designed to catch this; we want the mother to confirm that retrieval-time detection (or at least orientation-level warning) is missing and propose adding it.

## What we're really testing

1. Does the freshness penalty (`policy.freshnessWindowFor`) actually downrank the legacy memory?
2. Does the worker spot the contradiction before acting, or does it blindly follow the higher-ranked item?
3. Does the debater identify and quantify the contradiction?
4. Does the mother conclude that Tuberosa needs a retrieval-time contradiction signal in `contextFit` or `orientation`?

## Suspected outcome (which itself is the finding)

The current pipeline returns both items, the freshness penalty may or may not be enough, and orientation/taskBrief does not currently highlight "your pack contains conflicting items." This is the expected finding that justifies a P1 feature: retrieval-time contradiction detection.
