# Tuberosa Workbench Rebuild Design

Date: 2026-05-26

## Purpose

Rebuild the Tuberosa Workbench as the primary product experience for learning, operating, and trusting Tuberosa. The current API should remain compatible, but the current tab-heavy UI should be replaced with a guided, friendly workbench that helps a new user understand Tuberosa by running a real task.

Tuberosa's value is evidence-based context mapping for AI agents: given a task, choose useful project knowledge, explain why it was selected, record whether it helped, and turn useful lessons into reviewed memory. The new workbench should make that loop obvious.

## Goals

- Make the first screen a guided real-project task flow.
- Explain Tuberosa by doing, not by showing an admin dashboard first.
- Preserve current HTTP and MCP behavior.
- Replace the current workbench UI rather than restyling it.
- Provide rich but understandable visualizations for context mapping.
- Support three audiences without making the first flow complex:
  - new users evaluating Tuberosa,
  - daily maintainers reviewing queues and quality,
  - agent operators inspecting sessions and handoffs.
- Provide a Playbooks area with tutorials and practical examples.

## Non-Goals

- Do not change retrieval semantics as part of the UI rebuild unless a later implementation plan explicitly adds backend behavior.
- Do not remove or break existing HTTP/MCP endpoints.
- Do not make the graph visualization the only way to understand a result.
- Do not build a marketing landing page. The first screen is the product workflow.

## Product Shape

The new workbench has three primary product areas:

1. Start: the default guided entry point. The user enters a real task prompt, optional project, cwd, files, symbols, errors, and asks Tuberosa to map context.
2. Session Result: the core experience. It shows the verdict, retrieval pipeline, evidence graph, context stack, agent handoff, and next actions.
3. Review: a unified decision workspace for drafts, context-quality feedback, gaps, proposals, conflicts, risky memories, error logs, and maintenance.

The guide becomes Playbooks: interactive tutorials and scenario recipes such as first task, missing context, noisy context, memory review, debugging with Tuberosa, and agent/MCP usage examples.

## Navigation

Replace the current top-level tabs with:

- Start: default route and first-use path.
- Sessions: history of context mapping runs. Opening a session shows the same result view used after mapping a task.
- Review: one prioritized decision queue with filters.
- Knowledge: browse/search approved knowledge, memories, labels, references, trust, freshness, and source.
- Playbooks: tutorials, examples, and scenario recipes.
- System: health, backups, API key, provider/cache/store info, catchup/eval status, and advanced maintenance.

## First-Use Flow

1. User opens `/workbench`.
2. Workbench lands on Start.
3. User enters a real task, for example "Fix the build failure in src/retrieval/service.ts."
4. Workbench calls session start.
5. Session Result shows a human-readable verdict.
6. If context is ready, the UI shows the agent handoff and prompts the user to record a selected decision.
7. If context is weak, the UI shows missing signals, guides ingestion, and offers retry for the same task.
8. User can finish the session or move into Review for generated drafts, gaps, proposals, or feedback items.

## Start Screen

The Start screen is sparse and practical.

Required controls:

- Task textarea: "What is the agent about to do?"
- Project field with saved default.
- Cwd field with saved default.
- Primary action: "Map context."

Advanced drawer:

- Task type.
- Files.
- Symbols.
- Errors.
- Context mode.
- Debug/deep-context options if supported by the existing API.

Support rail:

- Current system readiness.
- API key status when relevant.
- Current project knowledge count if available.
- Recent sessions.

The Start screen should not lead with queue counts or operational dashboards.

## Session Result Screen

The Session Result screen is the signature workbench experience.

Top verdict band:

- Status: ready, needs confirmation, or insufficient.
- Fit score/confidence when useful.
- Policy action.
- Short "what to do next" instruction.

Why section:

- Fit reasons.
- Missing signals.
- Warnings or uncertainty.
- Clear distinction between useful evidence and weak/missing evidence.

Retrieval pipeline:

- Prompt.
- Classify.
- Retrieve.
- Rank/fuse.
- Fit verdict.
- Decision.
- Memory review.

Each stage can show counts, status, warnings, and links to details.

Evidence graph:

- Center node: task/session/context pack.
- Surrounding nodes: files, symbols, docs, memories, feedback, gaps, proposals, and review queues.
- Edges show relationships such as matched file, matched symbol, selected feedback, missing signal, graph connection, or superseded/stale warning.
- Node color or tone represents evidence strength, risk, or status.
- Clicking a node opens a side detail panel.

Context stack:

- Essential.
- Supporting.
- Optional.

Each item shows type, trust/freshness when available, why selected, references, and missing or suppression notes. This stack is the readable fallback if the graph is unavailable or not enough on its own.

Agent handoff:

- Copyable task brief.
- Recommended files and references.
- Commands and verification if present.
- Missing context warnings.
- Policy instruction.

Action footer:

- Record context decision: selected, selected but noisy, rejected, stale, irrelevant, missing context.
- Retry without rejected knowledge when applicable.
- Ingest missing context.
- Retry same task after ingestion.
- Finish session.

## Review Workspace

Review should be one prioritized queue rather than many unrelated tabs.

The default sort is "most important decision first," using existing recommended actions, queue counts, and risk/status information. Filters let users narrow by type:

- Reflection drafts.
- Context-quality feedback.
- Knowledge gaps.
- Learning proposals.
- Conflicts.
- Risky auto memories.
- Error logs.
- Maintenance.

Each review item uses the same decision-card pattern:

- What happened.
- Why it matters.
- Evidence.
- Suggested action.
- Available decisions.

Examples:

- Pending draft: approve, needs changes, reject.
- Knowledge gap: approve, needs changes, dismiss.
- Learning proposal: approve, needs changes, dismiss.
- Conflict: resolve, dismiss.
- Risky memory: mark needs review, archive.
- Error log: triage, archive, create reflection draft where supported.
- Maintenance: preview and apply selected items.

## Knowledge Workspace

Knowledge is for inspection and search, not the first user flow.

It should support:

- Search by title/content where supported.
- Filters for project, item type, status, source, trust, freshness, labels, and references.
- Detail panel for content, labels, references, trust/freshness, source, and related sessions or review history where available.

## Playbooks

Playbooks replace the static guide as the learning surface.

Required playbooks:

- Run your first task.
- Fix missing context.
- Handle noisy context.
- Review a memory.
- Debugging with Tuberosa.
- Agent/MCP usage examples.
- CLI/API examples for advanced users.

Each playbook should combine:

- Short explanation.
- Concrete example.
- Optional action that can run in the workbench.
- Expected result.
- Next step.

## Visual System

The workbench should feel like a friendly learning tool with modern visualizations.

Direction:

- Light UI by default.
- Warm neutral background.
- White working surfaces.
- Restrained accent colors.
- Rounded corners capped around 8px.
- Icons plus visible labels for navigation and beginner-facing actions.
- Visualizations explain workflow and evidence; they are not decoration.
- Avoid oversized marketing hero sections.
- Avoid dense dark observability styling as the default.

Core components:

- Verdict Band.
- Pipeline Rail.
- Evidence Graph.
- Context Stack.
- Decision Card.
- Detail Panel.
- Playbook Step.
- System Readiness Strip.

Dependency stance:

- Keep Preact.
- Add focused graph/chart libraries if they reduce custom complexity and make the evidence graph or pipeline substantially better.
- Prefer native CSS and small local components elsewhere.
- Avoid switching frontend frameworks unless the implementation plan identifies a strong reason.

## API And Data Flow

Preserve current endpoint behavior and add only non-breaking helper endpoints where they simplify the UI.

Existing endpoints to reuse:

- `POST /agent-sessions`
- `GET /agent-sessions`
- `GET /agent-sessions/:id`
- `GET /agent-sessions/:id/context-decisions`
- `POST /agent-sessions/:id/context-decision`
- `POST /agent-sessions/:id/finish`
- `POST /ingest/files`
- `GET /operations/workbench/summary`
- `GET /operations/context-quality`
- `GET /operations/catchup`
- reflection draft list/detail/recommendation/review endpoints
- knowledge, gaps, proposals, conflicts, error logs, maintenance, backups, and organization endpoints

Likely non-breaking helper additions:

1. Session detail view model endpoint: returns everything needed to render a session result by id, including session, pack, decisions, finish/compliance state when available, generated graph data, and handoff text.
2. Evidence graph adapter: backend endpoint or frontend presenter that normalizes context-pack evidence into nodes and edges.
3. Guided ingestion workflow adapter: helps transform missing signals into ingest suggestions and retry actions.
4. Review queue aggregate: returns a single prioritized list of mixed review items so Review does not stitch every queue together manually.

Data flow:

1. Start form builds session input.
2. Backend returns session plus initial context pack.
3. Presenter converts the response into verdict, pipeline, evidence graph, context stack, handoff, and next actions.
4. User records a context decision.
5. If context is missing, user ingests suggested files/docs and retries the same task.
6. User finishes the session.
7. Review queue updates from generated drafts, gaps, proposals, feedback, or maintenance items.

## Error Handling And Empty States

The UI should explain problems in user language and offer one clear recovery action.

No knowledge found:

- Message: "Tuberosa can run the task, but it does not have enough project knowledge yet."
- Actions: ingest files/docs, retry same task, view command/API example.

Needs confirmation:

- Show useful evidence and uncertainty separately.
- Actions: record selected but noisy, add missing references, or continue with caution.

Insufficient:

- Group missing signals by files, symbols, docs, errors, intent, and other.
- Actions: guided ingestion and retry.

API key/auth error:

- Show the System/API key setup control inline or as a focused setup step.

Backend unavailable:

- Explain that the local Tuberosa server is unavailable.
- Show the relevant command to start it.

Partial queue failures:

- Render successful queue sections.
- Show retry controls for failed sections.

Graph unavailable:

- Fall back to Pipeline and Context Stack.

Empty states:

- No sessions: "Map your first task."
- No review items: "Nothing needs a decision."
- No knowledge: "Add project docs or source files."
- No feedback: "Feedback appears after agents record context decisions."

## Testing

Presenter tests:

- Verdict model.
- Pipeline model.
- Evidence graph model.
- Handoff model.
- Review queue model.
- Empty/error states.

Browser smoke test:

- First open lands on Start.
- User maps a real task.
- Result shows verdict, pipeline, evidence graph or graph fallback, context stack, and handoff.
- User records a context decision.
- Insufficient context path offers ingestion and retry.
- Review queue renders mixed items and actions.
- Playbooks render examples.
- System page renders health/setup information.
- No obvious overflow on desktop and mobile.

Existing API tests should stay intact because endpoint behavior remains compatible.

Recommended verification for implementation:

- `pnpm run build`
- `pnpm test`
- `pnpm run test:workbench-browser`
- `git diff --check`

Retrieval evals are not required for a UI-only rebuild unless the implementation changes retrieval/session backend logic.

## Rollout

- Replace current workbench UI files while preserving `/workbench`.
- Keep backend serving behavior compatible.
- Preserve or replace current browser smoke coverage with assertions for the new user flows.
- Add helper endpoints only after proving the current API creates duplicated frontend logic or an unclear user flow.
- Keep CLI and MCP behavior unchanged, except for Playbook documentation references.

## Scope Boundary For Implementation Planning

The implementation plan should treat this as a full replacement, but it should be built in verifiable vertical slices:

1. New shell and Start flow.
2. Session Result presenters and readable context stack.
3. Pipeline and evidence graph.
4. Decision/finish actions.
5. Weak-context ingestion/retry path.
6. Unified Review workspace.
7. Knowledge, Playbooks, and System pages.
8. Browser and presenter test updates.

This keeps the final product a full replacement while preserving review and rollback boundaries during development.
