# Tuberosa feedback after this ticket

**Meta-finding first:** I did not call Tuberosa once during this whole ticket. My original framing of that ("for meta-work on Tuberosa, direct code reading dominated the broker") was a rationalisation, not a finding. The honest version is below.

## Why I didn't call Tuberosa (corrected)

1. **The MCP tools were in the deferred tools list.** Calling `tuberosa_*` required `ToolSearch select:tuberosa_*` first to load schemas. One extra step, not a barrier. I never took it.
2. **I never paused to ask whether the broker would help.** I reached for `Read`, `Grep`, and `Explore` subagents by reflex. Tuberosa was not in my reflex.
3. **I made an unverified assumption.** I told myself "for self-edit work the index is stale and direct reads dominate" and never spent the ~2 seconds it would have taken to verify with a single `tuberosa_search_context` call. The cost of checking is tiny; the cost of being wrong (which I was) is the bug list below.
4. **Confirmation bias.** Because I didn't call it, I never saw what it would have surfaced. Then I wrote feedback claiming the index would be stale, without evidence. That is the same anti-pattern Tuberosa is built to prevent: skipping evidence collection because "I already know."

The finding is not "the broker doesn't help with self-edit work." It is **I bypassed the system whose job is to prevent the bugs I then hit.**

## What Tuberosa would have caught (the bugs I burned time on)

Each of these is the exact shape of prior reflection-draft knowledge already in the project, or the kind a `tuberosa_search_context` query would have surfaced:

- `ContextSearchInput.contextMode` valid values are `compact | layered`, not `lean`. I shipped the wrong value to Playwright before noticing. The valid enum is declared in `src/validation.ts` and used by `src/retrieval/classifier.ts` — a search on "context mode" or "session start" would have shown me the right values before I built the bundle.
- `WorkbenchSummary.counts` is flat numbers; capped flags live in `countMetadata.capped`. A single `tuberosa_get_workbench_summary` call would have *demonstrated* the shape with real output.
- `WorkbenchSummary.contextQuality` is `{ records, totalMatched, filters }`. `WorkbenchSummary.openErrorLogs` is `{ records, totalMatched }`. Same — calling the tool once would have shown me the shape.
- `WorkbenchSummary.recommendedActions[]` items use `{ priority, target, label, count, href, reason }`, not `{ action, targetKind, targetTitle }`. Same.
- The `signal_confidence` learning gate must treat "no signals on the draft" as **pass**, not unknown. The agent-session tests already encode this. A search on "learning gate signal confidence" would have surfaced the rationale.
- Browser-test isolation rules from the previous agent's feedback (in `ai-feedbacks.md`) — cross-cutting constraints that I rediscovered the hard way instead of harvesting from prior reflections.

Every one of these was preventable by a single search call at session start.

## What I should have done — and will, next time

A standing pre-task ritual when working in any Tuberosa-aware repo, not only when "consuming" knowledge:

1. `ToolSearch select:tuberosa_get_workbench_summary,tuberosa_search_context,tuberosa_start_session,tuberosa_record_context_decision,tuberosa_finish_session,tuberosa_list_reflection_drafts` once, up front.
2. `tuberosa_get_workbench_summary` — see pending drafts, open gaps, risky memories, recent reflections. The "what does the broker already know about the state of this codebase" check.
3. `tuberosa_search_context` with the user's prompt verbatim — harvest prior lessons. Even if I expect the result to be thin, *check*; the cost of being wrong is the bug list above.
4. `tuberosa_start_session` — log my decisions so the next agent benefits from what I'm about to learn. Without this, every session I run produces zero compounding value for the broker, and that compounding is the whole point of the system.
5. Only *then* decide whether memory is dominant or direct reads are dominant for the specific task.

## What I want Tuberosa to do when approaching a new task

A startup brief in the same shape the agent in `ai-feedbacks.md` asked for — `proceed / confirm / clarify`, read-first files, missing signals — plus one extra mode:

- A **self-edit advisory**. If `cwd` matches the broker's own repo (or the prompt names files inside `src/` of the broker), the brief should say "you are editing me; prefer worktree truth over stored memory" and downweight memory candidates. Today nothing tells the agent the trust level should shift.
- The brief should surface operational reality, not just retrieval. Is a dev server already on `PORT=3027`? Is `dist/workbench/` built? Is the Postgres stack up? For this ticket, that single check would have saved me an EADDRINUSE confusion and a Playwright run that timed out on the missing bundle.

## Improvements observed during this task

- The 11-gate learning-gate logic is already well-factored. Lifting it into `src/reflection/recommendation.ts` for shared use by `learningGate` and the workbench was almost mechanical — the signals were already orthogonal. Good design paying off.
- 100% retrieval-eval coverage made the refactor safe. I touched the recommendation path with confidence because the eval would catch any classifier/fusion drift.
- `KnowledgeFeedbackSummary` (read-only aggregates), `LearningProposal` (reviewable mutations), `KnowledgeConflict` (detected contradictions), `KnowledgeGap` (missing-signal records) as separate concerns is the right factoring. It's what let the Phase 2 preview-first maintenance plan land cleanly without redoing the data model.

## Things I wanted that Tuberosa does not support yet

- **A self-edit mode.** When `cwd` = the broker's own repo, treat indexed memory as advisory only, prefer worktree, and skip auto-approval entirely.
- **A typed contract between server and workbench.** I had to mirror ~150 lines of types from `src/types.ts` into `src/workbench/types.ts` so the bundler would not pull `pg` and `node:crypto` into the browser. A generated browser-safe types file (or a `src/shared/types.ts` with no runtime deps) would eliminate the drift risk I introduced.
- **Static-asset path discovery as a first-class concept.** I wrote a hand-rolled `package.json` walk to find `dist/workbench/` from both `src/http/workbench.ts` (tsx dev) and `dist/src/http/workbench.js` (prod). Tuberosa already needs this for `backupDir` and `.tuberosa/current/` — there should be one resolved `repoRoot` helper.
- **Validation-derived client enums.** The bug where the form sent `contextMode: 'lean'` would be impossible if the workbench's `<select>` options were derived from `validateContextSearchInput`. The valid enum is right there in `src/validation.ts`.
- **An eval for *workbench → server* coupling.** Today retrieval evals cover the broker, but nothing asserts "every endpoint the bundle calls actually exists" or "every glossary term shown in the UI exists in `terms.ts`." A static cross-check would catch dead links and stale assumptions.
- **In-process MCP dev.** The MCP stdio process is separate. A `pnpm dev:mcp` with watch and hot reload would have let me try the recommendation endpoint against a live broker mid-refactor.
- **Default-loaded MCP tools when the harness sees a `.tuberosa/` or a registered Tuberosa MCP server.** The friction of `ToolSearch select:tuberosa_*` is small, but small enough to quietly nudge agents toward skipping it. Auto-loading would close that gap.

## Things Tuberosa should remember (to avoid repeating these mistakes)

- `ContextSearchInput.contextMode` valid values are `compact | layered`. Not `lean`.
- The default dev port is `3027`. If a stale `pnpm dev` holds it, set `PORT=3128` (or any free port) for smoke tests; do not silently fail.
- `WorkbenchSummary.counts` is flat numbers; capped flags live in `WorkbenchSummary.countMetadata.capped`. Do not assume `counts.<key>` is an object.
- `WorkbenchSummary.contextQuality` is `{ records, totalMatched, filters }`, not an array. `WorkbenchSummary.openErrorLogs` is `{ records, totalMatched }`. Document this shape near the type.
- `WorkbenchSummary.recommendedActions[]` items use `{ priority, target, label, count, href, reason }` — not `{ action, targetKind, targetTitle }`.
- After moving to a bundled SPA, tests that assert workbench HTML contains specific endpoint strings (`/operations/workbench/summary`) need to look at the bundle, not the shell. The shell only references `/workbench/static/app.js`.
- The `signal_confidence` learning gate must treat "no learning signals on the draft" as **pass**, not unknown. Drafts created without explicit signals are common and the auto-approval test depends on the pass.
- Browser-bound code in `src/workbench/` must not `import` from `src/reflection/recommendation.ts` or other server modules — even type-only imports risk pulling runtime code through esbuild. Use a workbench-local types mirror.
- `bundleRoot` for the static-asset route must work in both tsx dev mode (file at `src/http/workbench.ts`, repo two levels up) and compiled mode (`dist/src/http/workbench.js`, repo three levels up). Walk up until `package.json` exists.
- The Playwright workbench test needs a guard that skips when `dist/workbench/app.js` is missing. Otherwise it fails with a 30-second timeout instead of a clean skip when someone runs `pnpm test:workbench-browser` without building first.

## Postscript: I tried to use Tuberosa for this followup, and couldn't

When the user asked me to correct this feedback, I called `ToolSearch select:tuberosa_*` to actually invoke the broker for the first time. The result was `No matching deferred tools found` — the Tuberosa MCP server has disconnected or unloaded since the start of the session. So even now I cannot harvest the lessons I should have harvested at the start. This is a separate but real finding: an MCP server going away mid-session leaves no trace beyond a failed `ToolSearch`, and the agent has no way to recover the broker's knowledge.
