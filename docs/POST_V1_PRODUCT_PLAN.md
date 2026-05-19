# Post-V1 Product Plan

The v1 roadmap through Phase 10 is now baseline infrastructure. Post-v1 work should preserve local-first operation, reviewed memory, provenance, safety, and compact agent context, but it does not need to stay inside the original MCP-only shape.

## Recommended First Bet: Context-Quality Review Workbench

Goal: turn noisy or missing context feedback into a concrete review loop.

Why first:

- It directly improves Tuberosa's core job: mapping the right knowledge to the current agent task.
- The backend foundation now exists through `GET /operations/context-quality` and `tuberosa_collect_context_quality_feedback`.
- It uses current review primitives instead of requiring a new memory model.
- A first local CLI workbench exists through `pnpm run context-quality`; it formats the report with linked packs, sessions, noisy items, gaps, proposals, and existing review endpoints.
- The CLI can now apply explicit reviewed gap/proposal decisions with `--apply-review`, while keeping mutations routed through the existing operations review paths.

Thin vertical slice:

1. List recent context-quality feedback by project and feedback type.
2. Show the linked context pack, session, noisy adjacent items, missing signals, open gaps, and open proposals.
3. Let a reviewer jump to the right action: update labels/references, review a learning proposal, dismiss a gap, or mark stale/superseded knowledge.
4. Apply gap/proposal review decisions from the CLI only when the reviewer supplies explicit action flags.
5. Preserve every mutation through existing review APIs.

Success criteria:

- A reviewer can answer why a pack was noisy without reading raw database rows.
- `too_much_adjacent_context` and missing-orientation feedback reliably end in a reviewed gap/proposal decision.
- Agents can later retrieve better context without direct ranking hacks.

## Candidate Bet: Guided Agent-Start Workspace

Goal: make the first 60 seconds of an agent task reliable.

Thin vertical slice:

1. Start a Tuberosa session from a prompt.
2. Show orientation, direct evidence, adjacent context, missing signals, and likely verification commands.
3. Require a context decision before work proceeds, with a visible bypass path.
4. Export the selected context and policy in a form agents can paste or consume.

Success criteria:

- Vague continuation tasks consistently surface current handoff, roadmap, likely files, and verification commands.
- Agents record selected, noisy, rejected, stale, or missing context without needing to remember the workflow.

## Candidate Bet: Reflection And Knowledge Review Workbench

Goal: make reviewed memory sustainable as Tuberosa accumulates drafts, conflicts, stale records, and auto-learning candidates.

Thin vertical slice:

1. Review pending reflection drafts with labels, references, duplicate candidates, and safety metadata.
2. Triage knowledge gaps, learning proposals, and conflicts from the same view.
3. Approve, reject, mark needs-changes, archive, or create supersedes relations through existing APIs.

Success criteria:

- Unreviewed drafts stay out of normal retrieval.
- Reviewers can safely clean old v1-ceiling memories without direct storage edits.
- Auto-approved session memories remain visible for audit and cleanup.

## Product Guardrails

- Keep Postgres as the source of truth; exports and mirrors are inspection/recovery layers.
- Do not store secrets, raw private conversation, or prompt-injection content as trusted knowledge.
- Keep normal MCP context compact; put diagnostics and review detail behind explicit operations surfaces.
- Prefer thin vertical slices with clear rollback boundaries over broad UI rewrites.
