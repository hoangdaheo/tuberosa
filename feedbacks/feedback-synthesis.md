# Synthesized AI Feedback

## Inputs

- `feedbacks/ai-feedbacks.md`
- `feedbacks/ai-claude-feedbacks.md`
- Extracted questions and downsides from `feedbacks/tuberosa-concern-answer.md`

## Core Finding

Tuberosa is useful and already has the right primitives, but it does not yet carry a task end to end by itself. It retrieves compact, relevant context when the task has concrete anchors, and it correctly avoids overclaiming when evidence is weak. The main gap is orchestration: agents must still remember to call it, inspect fit, read current worktree files, and review unsafe learning or maintenance actions.

For continuation and handoff work, current local files are often more authoritative than stored memory. Tuberosa needs to treat live worktree evidence, handoff files, active plans, and recent diffs as first-class context sources while keeping durable memory review-gated.

## Questions To Preserve

The concern-answer file raised these product questions that should remain visible in future planning:

- Can Tuberosa retrieve the correct knowledge and related knowledge for the task?
- Is related knowledge noisy?
- Does it return compact knowledge instead of dumping all matching content?
- Does retrieval happen automatically?
- Does Tuberosa have a cleanup or memory-maintenance mechanism?
- What are the downsides of using Postgres and pgvector right now?
- Does Tuberosa take actions automatically, or does the user still need to drive review and approval?
- Does it save AI output from research or investigation so future agents avoid repeating the same work?
- Can it detect similar, stale, or outdated knowledge and update it?

## Current Strengths

- Retrieval works best when prompts name files, symbols, errors, projects, task types, or workflows. The current flow classifies the task, searches multiple sources, fuses and reranks candidates, applies feedback/suppression, evaluates fit, and assembles a compact context pack.
- Context packs are compact by design. They split knowledge into essential, supporting, and optional sections within a token budget, with provenance and truncated content. Layered mode can attach selected deep context without dumping the whole database.
- Tuberosa has useful review primitives: context decisions, reflection drafts, duplicate candidates, learning gates, knowledge gaps, stale feedback, supersedes relations, archived status, and learning proposals.
- The backend already supports many pieces needed for the user's automation goal: session start, context fit, feedback retry, proposal generation, error-log capture, backups, mirrors, and strict-gated session learning.
- The workbench and operations APIs are moving in the right direction: compact summary records, API-key protection for operational summary data, recommendation gates, and explicit review flows.

## Main Gaps

- Agents still bypass Tuberosa by reflex. Even a cheap `tuberosa_search_context` or `tuberosa_get_workbench_summary` call would have prevented several known mistakes, but nothing makes that startup ritual unavoidable.
- Tuberosa does not yet have a worktree-aware context bridge. It can know that handoff files are missing from memory, but it cannot reliably surface current uncommitted files, untracked plans, recent edits, or git diff truth.
- Continuation and handoff prompts need a dedicated startup brief. The desired shape is `proceed / confirm / clarify`, exact read-first files, current handoff/plan status, direct versus adjacent evidence, missing signals, risky areas, verification commands, and the required context-decision action before finish.
- Stored memory and current worktree truth are not clearly separated. Agents need to see when "memory says this exists" differs from "the file currently exists and changed."
- Self-edit work needs a trust shift. When Tuberosa is editing its own repository, stored memory should be advisory, worktree evidence should dominate, and automatic approval should be conservative.
- Research and investigation output is not automatically condensed into durable lessons. Tuberosa can save structured summaries, learning signals, notes, changed files, and verification commands, but it does not save raw transcripts and does not yet auto-summarize research traces.
- Memory cleanup exists, but it is conservative and review-gated. Tuberosa can detect duplicates, stale items, supersession candidates, gaps, and proposals, but it does not automatically merge, supersede, archive, or approve knowledge without review.
- The desired choosing panel is missing. The user wants Tuberosa to come along with the agent: auto-start, show context fit, recommend safe actions, ask before risky actions, and approve/apply only when confidence and safety are high.

## Noise And Fit

Related knowledge is sometimes noisy. Recent feedback described adjacent old workflow memory, generic extracted symbols, and off-domain context. The correct product behavior is not to hide uncertainty; it should return `needs_confirmation` when context is useful but incomplete and explain the missing signals.

Useful fit categories for startup output:

- Direct evidence: current worktree files, exact file/symbol/error matches, approved memories with strong labels and references.
- Adjacent evidence: related roadmap, older workflow memories, broad architecture context, or weak semantic matches.
- Missing signals: handoff files, current plan files, active session state, changed files, verification history, or prompt-named files absent from both memory and worktree.

## Downsides And Tradeoffs

- Postgres plus pgvector is operationally heavier than plain files. It requires service setup, migrations, backups, restore handling, and index maintenance.
- Embedding dimensions are schema-bound, currently shaped around `vector(1536)`. Changing embedding models creates re-embedding and migration risk.
- Vector search is only one weak signal unless labels, references, relations, and feedback are good. Generic semantic similarity can retrieve plausible but wrong context.
- Backup and restore size grow because chunks and embeddings are stored.
- Deterministic hash embeddings are useful for local development and tests but are not truly semantic. OpenAI embeddings or rerankers improve quality but add network, cost, and privacy tradeoffs.
- Automatic action is intentionally partial. Retrieval can start automatically when an agent calls Tuberosa, but unsafe memory approval, archive, supersede, and stale cleanup still need review.
- Saving AI output is structured, not raw. This protects privacy and noise quality, but it means agents must supply useful summaries, learning signals, or a future compact research trace.

## Product Direction

The next product step is a guided agent-start and review workspace:

- Auto-start a session when an agent begins substantial work in a Tuberosa-aware repo.
- Show a startup brief with `proceed / confirm / clarify`.
- Prefer worktree truth for handoff, continuation, and self-edit tasks.
- Show direct evidence, adjacent evidence, and missing signals separately.
- Record context decisions before finish.
- Save compact research outcomes, not raw transcripts.
- Preview duplicate/stale/superseded memory maintenance before mutation.
- Auto-apply only low-risk enrichment, such as additive labels or references.
- Ask the user before risky actions like approving memory, archiving knowledge, superseding knowledge, or trusting insufficient context.

## Operating Ritual For Agents

When working in a Tuberosa-aware repo, the agent should:

1. Check the workbench summary or active state.
2. Search context with the user's prompt before substantial work.
3. Start a session when the work is meaningful.
4. Read the startup brief and any read-first files.
5. Prefer current worktree files over stored memory when they disagree.
6. Record whether context was selected, noisy, rejected, stale, irrelevant, or missing.
7. Finish with changed files, verification commands, and compact learning signals.

## Concrete Lessons To Remember

- `ContextSearchInput.contextMode` valid values are `compact` and `layered`, not `lean`.
- Browser tests should stay outside normal `test/*.test.ts`; use a dedicated script so normal tests do not require Chrome or port binding.
- The Playwright workbench test should skip cleanly when `dist/workbench/app.js` is missing.
- Browser-test knowledge must be seeded through `IngestionService.ingestKnowledge()`, not direct store writes, or retrieval has no chunks or relations.
- `WorkbenchSummary` must stay compact: no raw draft content, knowledge content, large metadata blobs, raw agent-output bodies, `agentBrief`, or backup manifest checksums.
- `/workbench` can remain public, but `/operations/workbench/summary` must follow API-key protection.
- `WorkbenchSummary.counts` is flat numbers; capped flags live in `WorkbenchSummary.countMetadata.capped`.
- `WorkbenchSummary.contextQuality` is `{ records, totalMatched, filters }`.
- `WorkbenchSummary.openErrorLogs` is `{ records, totalMatched }`.
- `WorkbenchSummary.recommendedActions[]` items use `{ priority, target, label, count, href, reason }`.
- The `signal_confidence` learning gate must treat "no learning signals on the draft" as pass, not unknown.
- Browser-bound code in `src/workbench/` must not import server modules such as `src/reflection/recommendation.ts`; use browser-safe local/shared types.
- After moving to a bundled SPA, tests that assert endpoint strings should inspect the bundle, not only the HTML shell.
- Static bundle root discovery must work in both tsx dev mode and compiled mode by walking up to `package.json`.
- The default dev port is `3027`; if a stale process holds it, use a free port such as `3128` for smoke tests.
- Backup health should not report `scheduler.enabled && !running` during startup delay as a problem.
- Successful backups should clear stale scheduler `lastError`.
