# Mother Judgment — `trial-fusion-vector-penalty`

Trial run 2026-05-23 22:55:57. Mother synthesis by main-context Opus (1M).

## Verdict

`partial` — the task was answerable from the pack but the answer the child published was **arithmetically wrong** in a way that only the debater caught.

## What happened

| Stage | Grade | Evidence |
| --- | --- | --- |
| Classification | A | Pack correctly extracted symbols (`hardSignalVectorPenalty`, `sourceWeight`, `fuseCandidates`), files, `taskType: exploration`. |
| Source search | B | Essential items pointed at the right files. Two relevant items missing: `effectiveSourceWeight()` at `policy.ts:394` and `taskProfiles.exploration` at `policy.ts:244-247`. |
| Fusion | B | Top-ranked items were correct. The contradictory memory and the noise item both made it into optional — fusion didn't down-rank them enough on its own. |
| Rerank | C | Stale memory item kept rank position despite being older and lower-trust than the policy.ts excerpt. |
| Feedback adjustment | F | `suppressionEnabled.stale=true` and `.superseded=true` should have caught the directly-contradictory legacy memory; they didn't. |
| Context fit | C | Returned `ready`. Truthfully it should have been `needs_confirmation` because the pack contained items that directly contradict each other. |
| Pack assembly | D | Essential snippets used `...` ellipsis and off-by-N line citations; one supporting item stitched two non-adjacent doc paragraphs and presented as verbatim. |
| Orientation | C | `verificationCommands` named `test/fusion-profiles.test.ts` but the test's assertions were never surfaced. |
| Safety | A | No leaks. |

## Root cause

A single root cause explains most failures: **Tuberosa returns claims about code without re-verifying them against the code at retrieval time.** The pack was constructed at ingestion (or in this trial, by my hand), kept around, and shipped without a fresh on-disk check. That allowed:
- Stitched quotes
- Off-by-N line citations
- A non-existent file path in `references`
- A stale memory item whose claims directly contradict the live policy.ts

The debater proved each of these with a 30-second `grep`/`Read`. Tuberosa should do the same before returning.

## The debater's nine failure modes (lifted verbatim)

1. `stale_memory_not_suppressed`
2. `noise_in_optional_section`
3. `contradiction_undetected_at_retrieval`
4. `stitched_quote_passed_as_verbatim`
5. `off_by_two_line_citation`
6. `missing_taskProfile_layer` (caused the child's arithmetic error)
7. `truncated_essential_snippet`
8. `verification_command_not_grounded`
9. `unverified_file_reference`

## Tuberosa feedback to record (would write via `tuberosa_feedback_context` if MCP worked)

- `selected_but_noisy` on the pack — reason: pack had two unrelated/contradictory items in optional.
- `too_much_adjacent_context` on `k-paywall-modal-noise` — bogus path, no domain overlap.
- `stale` on `k-old-stale-fusion-memory` — directly contradicts current policy.ts.
- `missing_context` — list `effectiveSourceWeight()` and `taskProfiles.exploration` as missing.

These are the events that should flow back into ranking + the learning-proposal queue.
