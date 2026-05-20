## Question

analyze, get the knowledge about tuberosa to see what is does
  the logic flow, the features, mechanism

  then answer my question:
  - does tuberosa can get the correct knowledge and the related knoledges?
  - is the relate knowledge noisy?
  - Does it get the compact version of the knowledge instead of getting all in the query? If yes, does it retrives the
  knowledge automatically?
  - does tuberosa has clean-up knowledge/memory mechanism
  - what is the downside of using the pgvector and pg database right now?
  - Does tuberosa take action automatically? My goal is make it automatically in everything, get the correct knowledge, save
  knowledge, auto evaluation, prompt/ show the choosing panel to ask the user if it unsafe or not, approve it if needed.
  Tuberosa will come along with user, not let user do the manual work.

## Answer

Tuberosa is doing the core job, but it is not yet the fully automatic companion you want.

It can retrieve correct and related knowledge when the prompt has concrete anchors like files, symbols, errors, project, or task type. Current evals are strong: `pnpm run eval:retrieval` passed `14/14`, knowledge completeness passed `100%` with `0%` fixture noise, and agent-context compliance passed. A precise live query for retrieval internals returned `ready`, covered `4/4` files and `5/5` symbols. The main flow is in [service.ts](/home/nash/tuberosa/src/retrieval/service.ts:91): classify, search metadata/lexical/memory/vector/graph, fuse, rerank, apply feedback/suppression, evaluate fit, assemble pack.

Related knowledge is sometimes noisy. The live context-quality report has 8 recent `selected_but_noisy` records for Tuberosa. The recurring noise is adjacent old workflow memory, generic symbol extraction like `Analyze`, `Answer`, `Removed`, and off-domain context. There are controls already: strict noise mode, direct-vs-adjacent categories, domain match boosts/mismatch penalties, feedback penalties, and context-fit missing signals in [context-fit.ts](/home/nash/tuberosa/src/retrieval/context-fit.ts:122) and [context-pack.ts](/home/nash/tuberosa/src/retrieval/context-pack.ts:59). It is improving, but not noise-free.

Yes, it returns compact knowledge instead of dumping everything. Packs are split into `essential`, `supporting`, and `optional`, within a token budget, with truncated content and provenance. In layered mode it can also attach `deepContext` from selected chunks only, not the whole database. See [context-pack.ts](/home/nash/tuberosa/src/retrieval/context-pack.ts:59) and [service.ts](/home/nash/tuberosa/src/retrieval/service.ts:557). Retrieval is automatic after an agent/client calls `tuberosa_search_context` or `tuberosa_start_session`; Tuberosa does not inject itself into every task unless the agent integration calls it.

Cleanup exists, but it is intentionally conservative. Operational cleanup deletes old proposed packs, orphan feedback, unused queries, and unused sources, not approved knowledge, in [postgres-store.ts](/home/nash/tuberosa/src/storage/postgres-store.ts:1593). Knowledge/memory cleanup happens through review records: noisy/stale/rejected feedback creates gaps or learning proposals, and approved proposals can mark memory `needs_review`, archive it, or create `supersedes` relations in [operations/service.ts](/home/nash/tuberosa/src/operations/service.ts:154). Atomic document re-ingestion also deletes stale section atoms.

The downside of Postgres + pgvector right now: it is operationally heavier than plain files, embedding dimensions are fixed to the schema (`vector(1536)`), changing embedding models means re-embedding/migration risk, vector search is only one weak signal unless labels/references are good, and backup/restore grows because chunks and embeddings are stored. Hash embeddings are deterministic but not truly semantic; OpenAI embeddings/rerank improve quality but add network, cost, and privacy tradeoffs. Schema/index setup is in [001_init.sql](/home/nash/tuberosa/migrations/001_init.sql:108), provider behavior in [provider.ts](/home/nash/tuberosa/src/model/provider.ts:31).

Automation is partial. It already auto-retrieves on session start, retries after rejected/stale/irrelevant feedback, creates knowledge gaps/proposals, auto-captures unexpected errors, maintains backups/mirrors, and can auto-create or even auto-approve session learning only under strict gates in [agent-session/service.ts](/home/nash/tuberosa/src/agent-session/service.ts:202). But it does not yet have the choosing panel/workbench you described. Most unsafe actions still require review through APIs/MCP/CLI.

For your goal, the next product step is clear: build a guided agent-start/review workspace on top of the existing backend. It should auto-start a session, show `proceed / confirm / clarify`, show direct evidence vs adjacent noise, run eval/context-quality checks, auto-save safe learning drafts, and ask the user before risky actions like approving memory, archiving/superseding knowledge, or trusting insufficient context. The backend primitives are mostly there; the missing part is the orchestration/UI that makes manual review feel like a small confirmation instead of work.

---
## Questions:
the last questions:
  - Does it save the output of the AI? The output is also important for making AI self-learn after research/investigate, and
  it makes AI take time and effort to go back to specific problem again
  - Do we have the detect similar knowledge and update the knowledge mechanism? like update the knowledge if it stale or
  outdate?

## Answer:

Yes, but with an important distinction: Tuberosa saves **structured AI output**, not the full raw AI transcript by default.

On session finish, it can store:

- `summary` / `agentOutputSummary`
- changed files
- verification commands
- context used
- context corrections
- explicit `learningSignals`
- optional reflection draft content

That becomes a reflection draft in [agent-session/service.ts](/home/nash/tuberosa/src/agent-session/service.ts:347). If it passes strict gates, it can be auto-approved into searchable memory; otherwise it stays reviewable. So it can preserve the result of research/investigation, but only if the agent supplies a useful summary or learning signals. It does **not** automatically save every tool output, chain of reasoning, or full investigation transcript. That is probably the next missing piece for your goal: an automatic “research trace → durable lesson” summarizer.

For similar/stale knowledge: yes, partially.

Tuberosa detects similar memory when creating a reflection draft by searching existing memories and storing `duplicateCandidates` in [reflection/service.ts](/home/nash/tuberosa/src/reflection/service.ts:45). Auto-approval is blocked if duplicates exist in [agent-session/service.ts](/home/nash/tuberosa/src/agent-session/service.ts:445). For file/import knowledge, re-ingesting the same `sourceUri` updates the existing knowledge item and rebuilds chunks/embeddings in [postgres-store.ts](/home/nash/tuberosa/src/storage/postgres-store.ts:1810).

For stale/outdated knowledge, it supports stale feedback, `freshnessAt`, `supersedes` relations, `needs_review`, and `archived`. Stale feedback creates a learning proposal, and approving that proposal can create a supersedes relation or mark/archive knowledge in [operations/service.ts](/home/nash/tuberosa/src/operations/service.ts:154). Retrieval then demotes stale/rejected/superseded knowledge in [retrieval/service.ts](/home/nash/tuberosa/src/retrieval/service.ts:1349).

What it does **not** fully do yet: automatically merge a better new answer into an old memory, decide the old memory is obsolete, and update/archive it without review. The mechanism exists, but it is review-gated. For your “automatic in everything” goal, the next step is an auto-maintenance loop: detect duplicate/stale memory, propose exact patch/supersede/archive action, show approval panel when risky, and auto-apply only when confidence and safety are high.
