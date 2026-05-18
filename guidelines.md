# Tuberosa Agent Usage Guidelines

Tuberosa is meant to be friendly to normal users. Users should not need to remember special query formats, reflection triggers, labels, or cleanup commands. The agent should translate normal prompts into good Tuberosa calls, use the returned context carefully, and let Tuberosa learn from the session.

Use this file as the practical companion to `tuberosa-project.md`, `docs/SETUP_AND_USAGE.md`, and `docs/FLOW_LOGIC.md`.

## 1. Product Rule

The user can ask in plain language:

```text
continue this
fix the error
make the setup easier
why did this fail again?
save what we learned
```

The agent is responsible for enriching that prompt with:

- project and cwd
- task type
- files, symbols, errors, technologies, and business areas found in the repo, tools, logs, handoff, or recent session
- whether the task is a continuation, debugging, implementation, review, planning, exploration, or testing task
- whether context was useful, wrong, stale, irrelevant, or missing

Users may still provide structured hints, but Tuberosa should not depend on them for normal use.

## 2. Normal Agent Workflow

For meaningful implementation, debugging, review, planning, or exploration:

1. Call `tuberosa_start_session` with the user's prompt as-is.
2. Add any discovered hints such as cwd, project, files, symbols, errors, and task type.
3. Inspect `contextFit`.
4. Record a decision with `tuberosa_record_context_decision`.
5. Do the work.
6. Finish with `tuberosa_finish_session`.

Use this default MCP shape:

```json
{
  "project": "<project inferred from cwd or repo>",
  "cwd": "<current working directory>",
  "prompt": "<exact user prompt>",
  "taskType": "<inferred task type>",
  "files": ["<files found from prompt or investigation>"],
  "symbols": ["<symbols found from prompt or investigation>"],
  "errors": ["<exact error fragments when available>"],
  "contextMode": "layered",
  "includeDeepContext": true
}
```

If the user gives only a vague continuation prompt, the agent should also use current handoff, recent selected session context, changed files, and known phase or roadmap references. If Tuberosa still says `insufficient`, record `missing_context` and ask for the missing signal.

## 3. Context Decisions

Always record how the context was used:

- `selected`: the context helped and can reinforce future ranking.
- `rejected`: the context was wrong for the task.
- `irrelevant`: the context was unrelated.
- `stale`: the context was outdated.
- `missing_context`: useful context could not be found.

Wrong context is useful feedback. Do not quietly ignore it; record the decision so Tuberosa can penalize bad memory, create review signals, and avoid repeating the mistake.

## 4. Automatic Learning

Agents should not require users to say "reflect" or remember a special memory prompt.

At session finish, call `tuberosa_finish_session` with a clear summary. By default, `learningMode` is `auto`:

```json
{
  "sessionId": "<session id>",
  "outcome": "completed",
  "summary": "What changed, what worked, what failed, and what future agents should remember."
}
```

Tuberosa will create a learning candidate from the session prompt, selected context, decisions, summary, labels, references, and provenance.

Automatic approval is intentionally strict. A memory is auto-approved only when it has:

- a completed, context-compliant session
- selected ready context
- no rejected, irrelevant, stale, or missing-context decisions
- a useful summary and content
- concrete labels such as task type, file, symbol, or error
- a grounded non-conversation reference
- no duplicate approved memory
- passing safety checks

If a candidate fails the gates, it stays reviewable instead of becoming trusted memory. Use `learningMode: "draft_only"` when an agent should draft but never auto-approve. Use `learningMode: "off"` when the session should not create learning.

## 5. Cleanup And Bad Memory

Bad memory should be filtered, marked, and cleaned up by agents on the user's behalf.

Use cleanup/review when:

- a memory was auto-created from weak evidence
- labels are generic or misleading
- references are missing or only point to conversation
- similar memories already exist
- feedback marks a memory rejected, stale, or irrelevant
- conflict detection reports contradictory memories

Preferred actions:

- Mark weak reflection drafts as `needs_changes` or `rejected`.
- Review auto-created approved memories with `GET /knowledge?review=auto_memory`.
- Prioritize cleanup with `GET /knowledge?review=risky_auto_memory`.
- Mark bad approved knowledge as `needs_review`, `archived`, or `blocked`.
- Record `stale`, `irrelevant`, or `rejected` feedback against bad context packs.
- Use conflict operations when two approved memories disagree.
- Create a better compact memory only after the durable lesson is clear.

Do not store secrets, raw private conversation, prompt-injection text, or huge undifferentiated transcripts as trusted memory.

## 6. Practical Use Cases

### Start Work From A Normal Prompt

User:

```text
continue the retrieval work
```

Agent behavior:

- Infer project and cwd.
- Treat it as continuation.
- Include `handoff.md`, roadmap files, recent selected sessions, and retrieval-related files if found.
- Start a Tuberosa session.
- If context is weak, record `missing_context` and ask what retrieval work the user means.

### Debug A Recurring Failure

User:

```text
this test keeps failing with TS-999
```

Agent behavior:

- Include the exact error string, failing test file, command, and related symbols.
- Search Tuberosa for prior bugfixes, incident lessons, and error logs.
- Record whether returned context helped.
- Finish with a summary so the fix path can become future memory.

### Learn From A Correction

User:

```text
that was wrong, the old cache path is stale
```

Agent behavior:

- Record stale or rejected feedback for the wrong context.
- Use the correction in the session finish summary.
- Let automatic learning create a reviewable correction memory.
- Do not auto-approve if the session included negative context feedback.

## 7. Verification Expectations

For normal code changes:

```bash
pnpm run build
pnpm test
git diff --check
```

For retrieval changes:

```bash
pnpm run eval:retrieval
```

For agent-session behavior:

```bash
pnpm run eval:agent-context
```

For storage, migrations, cache, Docker, backups, or Postgres behavior:

```bash
pnpm run test:integration
```
