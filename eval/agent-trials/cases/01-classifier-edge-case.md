---
id: 01-classifier-edge-case
task_type: debugging
task: |
  Searching for "TS-999 in PaywallSelectionModal" should surface the prior bugfix memory
  as an essential item. Confirm the classifier extracts error TS-999 and symbol
  PaywallSelectionModal, and that fusion ranks the bugfix memory above the generic
  React/paywall wiki entry.
files: []
symbols: []
errors: []
ground_truth:
  changed_files: []
  required_facts:
    - "TS-999 was fixed by preserving selected product ids through the save transition."
    - "The fix lives in src/components/paywall-selection-modal.tsx."
  forbidden_outcomes:
    - "Recommended re-implementing the fix from scratch (it already exists in memory)."
expectations:
  expected_fit_status: ready
  must_include_knowledge_ids:
    - "paywall-ts999-fix"
  must_not_include_knowledge_ids: []
  classification_check:
    errors: ["TS-999"]
    symbols: ["PaywallSelectionModal"]
    files: ["src/components/paywall-selection-modal.tsx"]
    task_type: "debugging"
constraints:
  noise_tolerance: strict
  context_mode: layered
  token_budget: 4000
notes: |
  This is a debugging task where a prior bugfix memory exists. The fusion source-weight
  table boosts bugfix/memory/workflow items for debugging tasks (src/retrieval/policy.ts).
  If the bugfix memory does not appear in `essential`, blame fusion or rerank; if it
  appears but the worker re-implements, blame orientation/taskBrief (it failed to point
  the agent at "use existing fix").
---

# Case 01 — Classifier edge case + prior-bugfix memory should win

## Why this case exists

The `eval/retrieval-fixtures.json` `newsletter-app` fixture defines a `paywall-ts999-fix` memory item with labels `error:TS-999`, `symbol:PaywallSelectionModal`, `file:src/components/paywall-selection-modal.tsx`. A debugging query that names the error and the symbol should rank this memory in `essential` — that's the entire promise of having prior-bugfix memory.

## What we're really testing

1. `classifyQuery` correctly extracts `TS-999` (capitalized hyphenated error code) and `PaywallSelectionModal` (PascalCase symbol from prose).
2. Fusion's debugging-task source-weight boost actually fires.
3. The bugfix memory's `error:TS-999` label gives it enough exact-match boost over the generic React wiki entry.
4. `contextFit` returns `ready` because the error + symbol + file are all anchored.
5. `taskBrief` says "use the existing fix" rather than "implement a fix."

## Suspected failure modes

- Worker re-implements the fix → orientation didn't flag the prior memory loud enough
- `contextFit` is `needs_confirmation` → coverage scoring under-credited the exact-match anchor
- Bugfix memory is in `supporting` not `essential` → fusion source-weight or task-type boost is wrong
