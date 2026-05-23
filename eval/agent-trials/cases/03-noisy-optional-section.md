---
id: 03-noisy-optional-section
task_type: refactor
task: |
  Rename `PaywallSelectionModal` to `PaywallProductPicker` across the codebase.
  This is a mechanical refactor; the worker should NOT need any business-domain
  context, prior bugfix history, or workflow notes — only file references and
  symbol locations.
files: ["src/components/paywall-selection-modal.tsx"]
symbols: ["PaywallSelectionModal"]
errors: []
ground_truth:
  changed_files:
    - "src/components/paywall-selection-modal.tsx"
  required_facts:
    - "PaywallSelectionModal is defined in src/components/paywall-selection-modal.tsx"
  forbidden_outcomes:
    - "Worker read auth/billing/newsletter unrelated context items"
    - "Worker spent budget on prior-lesson memory not needed for rename"
expectations:
  expected_fit_status: ready
  must_include_knowledge_ids: []
  must_not_include_knowledge_ids: []
  noise_tolerance_check:
    description: |
      In strict mode, the pack's `optional` section should contain at most 2 items
      and none of them should be `taxonomy: incident_lesson` or `taxonomy: workflow`
      unrelated to refactor mechanics.
constraints:
  noise_tolerance: strict
  context_mode: compact
  token_budget: 2000
notes: |
  Refactor task type currently has its own source-weight profile in policy.ts. We
  expect a tight, mechanical pack. If the worker reports any optional-section
  item as "noise", that should escalate to a `too_much_adjacent_context` feedback
  event and a learning proposal for the noisy item.

  The `taskBrief.mode` should be 'refactor' and `actionableMissingSignals` should
  highlight call-site files (where the symbol is referenced) rather than business
  context.
---

# Case 03 — Mechanical refactor should not pull adjacent context

## Why this case exists

Phase 10 introduced `priorLessons` cap and `adjacent_context` quality feedback because agents complained about being drowned in tangentially-related memory. This case is the regression check: in strict mode, a mechanical refactor should produce a tight pack.

## What we're really testing

1. The `optional` section budget cap (`DEFAULT_USEFULNESS_CAPS.adjacentContext: 4`) actually holds in strict mode.
2. The `taskBrief.mode === 'refactor'` and `orientation.recommended_files` lists call-site files (not business context).
3. The child reports that no optional item helped → mother proposes either removing those items from retrieval entirely OR shrinking the cap further for refactor.
4. The strict noise-tolerance downgrade (`applyNoiseTolerance` in `service.ts`) actually applies when fit signals are sparse.

## Suspected failure modes

- Optional section still pulls in `business_area:paywall` wiki — fix: tighten refactor-task source weights for `business_area` labels.
- `orientation` does not list "call sites" as recommended files — fix: refactor mode should grep the symbol's import graph and add those to recommended_files.
