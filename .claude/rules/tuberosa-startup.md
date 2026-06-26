# Rule: Tuberosa MCP startup

For any non-trivial implementation, debugging, review, or planning task in this repo, call Tuberosa before reading or editing code.

If the `tuberosa_*` tools are deferred, load them first with ToolSearch/select for:

- `tuberosa_start_session`
- `tuberosa_record_context_decision`
- `tuberosa_finish_session`
- `tuberosa_search_context`
- `tuberosa_get_context_pack`

Then call `tuberosa_start_session` with:

- `project: "tuberosa"`
- `cwd: "/home/nash/tuberosa"`
- the user's prompt as `prompt`
- `contextMode: "layered"`
- `noiseTolerance: "strict"`
- `includeDeepContext: true`
- known `files`, `symbols`, and `errors` when the prompt names them

Inspect `contextFit`, `orientation`, and `taskBrief` before proceeding. Record a `selected`, `selected_but_noisy`, `rejected`, `stale`, `irrelevant`, or `missing_context` decision with `tuberosa_record_context_decision` before substantive work. Finish meaningful sessions with `tuberosa_finish_session`.

If ToolSearch says no matching `tuberosa_*` tools exist, or the MCP server disconnects, state that explicitly in the response and continue from direct repo evidence. Do not rationalize skipping Tuberosa as a product judgment unless the tool call was actually attempted or the task is trivial.

## Tuberosa skills (teaching layer)

| Task | Read this skill |
|------|-----------------|
| What is Tuberosa? Which tools exist? FIND vs LEARN | `.claude/skills/tuberosa-guide/SKILL.md` |
| Drive a coding task through the session loop | `.claude/skills/tuberosa-agent-loop/SKILL.md` |
| Onboard / comprehend a project into Tuberosa (and keep it fresh) | `.claude/skills/tuberosa-onboard-project/SKILL.md` |
| Operate Tuberosa as a human (ingest, review, evals) | `.claude/skills/tuberosa-operating/SKILL.md` |
| Which command/tool does what day to day (session loop, lifecycle, maintenance tasks) | `.claude/skills/tuberosa-using/SKILL.md` |
| Set up the environment | `docs/SETUP.md` |

These teach the rule above; they do not replace it. The skills live at a **flat** path (`.claude/skills/<name>/SKILL.md`) so Claude Code's Skill tool discovers them — skills nested two levels deep are never auto-loaded.
