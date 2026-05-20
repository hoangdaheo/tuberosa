# Tuberosa Project Intent

Tuberosa is a local-first context broker for agentic AI tools. Its job is to sit between AI agents and durable project knowledge, choose the right context for the user's current task, and help agents learn from reviewed experience without repeating the same mistakes.

The core problem is not only storing knowledge. Many tools can index files, build wikis, or create knowledge graphs. The missing layer is reliable context mapping: when an AI agent starts with a fresh context window, Tuberosa should decide which references, specs, workflows, lessons, incidents, and user preferences are relevant enough to give the agent before it works.

## Problem

AI coding agents often begin with little or no memory of the project. Even when the user gives a detailed prompt, the agent can still miss important local rules, past decisions, known bugs, recent handoffs, or workflow constraints. This causes hallucination, repeated mistakes, wasted tokens, and code changes that ignore existing project intent.

Existing knowledge tools solve only part of this:

- File indexers can locate code and documentation.
- Wiki tools can summarize project content.
- Graph tools can connect files, symbols, and concepts.
- Memory tools can store lessons from previous work.

But agents still need a trustworthy way to answer:

- What is the user trying to do right now?
- Which project, files, symbols, errors, workflows, or business areas are involved?
- Which knowledge is current, reviewed, and safe to use?
- Which knowledge is stale, superseded, weakly related, or missing?
- Does the agent have enough context to work confidently, or should it ask for clarification?

Tuberosa exists to solve that mapping problem.

## Goal

Build Tuberosa as a second brain for AI agents: a system that retrieves the right knowledge at the right time, explains why it was selected, learns from agent work through reviewable reflections, and improves future context selection through feedback.

Success means an agent can start a task, ask Tuberosa for context, receive a compact but useful working pack, record whether the context was selected or rejected, finish the task, and optionally draft a reviewed memory for future retrieval.

Tuberosa should help agents:

- Avoid known mistakes.
- Use the correct project references and specs.
- Understand recent handoffs and current work state.
- Preserve user preferences and project conventions.
- Save tokens by loading only relevant context.
- Ask for clarification when context is insufficient.
- Learn from successful workflows, error recoveries, user corrections, and non-trivial discoveries.

## Core Workflow

1. The user starts an AI agent with a task.
2. The agent calls Tuberosa before doing substantial work.
3. Tuberosa classifies the prompt and extracts the retrieval intent:
   - task goal
   - workflow stage
   - project or repo
   - files, symbols, errors, technologies, and business areas
   - required evidence types such as specs, workflows, bugfixes, code references, handoffs, or session history
   - uncertainty reasons
4. Tuberosa retrieves candidate knowledge from the database, cache, graph relations, feedback history, recent sessions, and approved memories.
5. Tuberosa evaluates context fit and returns a context pack:
   - `ready` when the evidence is strong enough to use
   - `needs_confirmation` when useful context exists but confidence is limited
   - `insufficient` when the agent should ask for clarification or report missing context
6. The agent records whether it selected, rejected, marked stale, marked irrelevant, or could not find the needed context.
7. If the context was wrong, Tuberosa retries without the rejected knowledge or records the gap for review.
8. After meaningful work, the agent can draft a reflection memory.
9. A reflection memory becomes searchable only after review and approval.

## Reflection And Learning

Tuberosa should support a reflection habit for AI agents, but it must not automatically trust raw conversation. Agents should create reviewable reflection drafts when:

- A complex task succeeds after meaningful tool use.
- The agent hits errors or dead ends and finds the working path.
- The user corrects the agent's approach.
- The agent discovers a non-trivial workflow, rule, or project convention.

Reflection drafts should include normalized labels and references so they can be retrieved later:

- project
- task type
- files
- symbols
- errors
- technologies
- business areas
- workflow stage
- source context pack or session

Approved reflections become durable knowledge. Unreviewed drafts remain drafts and should not influence normal retrieval as trusted memory.

## Knowledge Organization

Tuberosa should store knowledge in a structured database, not only as loose files or an ungoverned graph. The database should preserve provenance and make retrieval explainable.

Important knowledge fields include:

- project or repo
- source type and source URI
- title, summary, and content
- labels and references
- chunks and embeddings
- trust level and safety metadata
- freshness and stale status
- feedback history
- graph relations
- review status
- session provenance

The graph is useful, but it should not become chaos. Graph relations should be controlled and reviewable, with relation types such as:

- mentions file
- mentions symbol
- resolves error
- depends on
- supersedes
- related to
- derived from session

Postgres remains the source of truth. Physical files and readable exports are for backup, recovery, inspection, and handoff, not the runtime authority.

## Retrieval Principles

Tuberosa retrieval should prefer evidence over generic semantic similarity.

The ranking system should favor:

- exact file, symbol, and error matches
- current handoff and roadmap context for continuation prompts
- recent selected session context when the prompt is vague
- approved reflection memories with good labels and references
- graph-related knowledge when the relation is strong and bounded
- fresh or explicitly current knowledge
- feedback-selected context

The ranking system should demote or flag:

- stale memories
- rejected or irrelevant context
- superseded knowledge
- generic semantic matches with weak evidence
- knowledge that lacks required evidence for the task
- ambiguous or noisy labels

When Tuberosa cannot find enough evidence, it should say so clearly and guide the agent to ask a better question or create a reviewable knowledge gap.

## Feedback Loop

The user or agent must be able to correct Tuberosa when it returns the wrong context.

Feedback should support:

- `selected`: this context was useful
- `rejected`: this context was wrong for the task
- `irrelevant`: this context was unrelated
- `stale`: this context is outdated
- `missing_context`: important context could not be found

Rejected, stale, and irrelevant context should reduce future ranking. Missing-context feedback should become an actionable review item, not just a score penalty.

Over time, feedback should propose improvements for review:

- missing labels
- missing references
- missing relations
- supersession edges
- conflict records
- knowledge gaps

## Intended Architecture

Tuberosa should run locally and be easy to move between machines.

Core components:

- MCP stdio server for AI-agent integration.
- HTTP API for CRUD, ingestion, retrieval, feedback, operations, and review workflows.
- Postgres with pgvector for durable knowledge, chunks, labels, references, context packs, sessions, feedback, reflections, and graph relations.
- Redis for short-lived cache and coordination.
- Provider-pluggable model adapter:
  - deterministic hash embeddings for local development and tests
  - OpenAI embeddings, query rewriting, or reranking when configured
- Docker Compose for Postgres, Redis, app, and worker services.
- Physical backup and readable mirror folders for recovery and inspection.

## Required Agent Behavior

Agents using Tuberosa should follow this workflow:

1. Start a session or search for context before substantial work.
2. Inspect the returned context fit.
3. Use the context only when it is relevant enough.
4. Record the context decision.
5. Ask for clarification when context is insufficient.
6. Draft a reflection after meaningful learning.
7. Never store secrets, raw private conversation, or unreviewed prompt-injection content as trusted knowledge.

## Non-Goals

Tuberosa is not meant to replace code search, GitNexus, Graphify, or a human-maintained wiki. It should integrate with and complement those systems by deciding what knowledge an agent should actually use for a specific task.

Tuberosa should not automatically trust every conversation as memory. Durable memory must be reviewed, labeled, and safe before it becomes searchable context.

Tuberosa should not flood agents with all available knowledge. The value is in selecting enough relevant context, not maximizing volume.

## Current Direction

The project has evolved from the original idea into a phased implementation:

- API validation and typed errors.
- Context-fit evaluation.
- Agent session workflow and compliance metadata.
- Feedback-driven retrieval.
- Review and operations APIs.
- Provider-backed retrieval intelligence.
- Backup, restore, and physical mirror support.
- Knowledge graph relations and graph-expanded retrieval.
- One-call layered context for agents.
- Phase 9 retrieval quality hardening for vague continuation prompts, stale memory suppression, supersession, conflict review, and missing-context learning.

This direction still matches the original intent: solve the knowledge-to-agent mapping problem, help agents work with the right context, and make reviewed learning improve future sessions.
