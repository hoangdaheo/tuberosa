**Executive View**

I treated this as architecture planning only; I did not edit files. Tuberosa already has the right core shape: classify a task, retrieve across metadata/lexical/memory/vector/graph signals, fuse/rerank, score fit, assemble a compact context pack, collect feedback, and turn lessons into reviewed memories. The current weakness is not “missing RAG.” It is reliable context mapping: deciding what is direct evidence, what is adjacent, what is stale/noisy, what is missing, and what the agent should do next.

The product should evolve from “memory + retrieval over project knowledge” into a startup and review layer for AI agents: current worktree truth first, durable memory second, explicit evidence buckets, review-gated learning, and measurable context quality.

**Current Tuberosa**

Goal: Tuberosa is a local-first context broker and “second brain for AI agents,” focused on choosing the right context for a fresh agent window, not merely storing documents. That is stated directly in [docs/tuberosa-project.md](/home/nash/tuberosa/docs/tuberosa-project.md:3) and [docs/tuberosa-project.md](/home/nash/tuberosa/docs/tuberosa-project.md:28).

Current flow:
- Ingestion preserves file/source provenance, labels, references, chunks, and embeddings: [src/ingest/service.ts](/home/nash/tuberosa/src/ingest/service.ts:118).
- Retrieval classifies, rewrites, searches, ranks, evaluates fit, and packs context: [src/retrieval/service.ts](/home/nash/tuberosa/src/retrieval/service.ts:91).
- Fusion already weights metadata/reference/graph/memory/lexical/vector differently: [src/retrieval/fusion.ts](/home/nash/tuberosa/src/retrieval/fusion.ts:4).
- Context fit already tracks missing file/symbol/error/task/project signals: [src/retrieval/context-fit.ts](/home/nash/tuberosa/src/retrieval/context-fit.ts:122).
- Context packs are compact and split into essential/supporting/optional: [src/retrieval/context-pack.ts](/home/nash/tuberosa/src/retrieval/context-pack.ts:59).
- Existing evals cover retrieval IDs, fit status, classification, feedback, and gaps: [src/evaluation/retrieval-evaluator.ts](/home/nash/tuberosa/src/evaluation/retrieval-evaluator.ts:65).

Pros:
- Strong local-first architecture: MCP, HTTP, Postgres/pgvector, Redis, memory fallback.
- Good primitives: labels, references, graph relations, feedback, gaps, reflection drafts, review status.
- Evidence-first ranking is already partly designed.
- Compact packs avoid dumping the whole database.
- Review-gated memories are the right trust model.

Cons:
- Agents can bypass the flow.
- No first-class worktree bridge yet, so current files/diffs/handoffs are not dominant evidence.
- Prompt verbs can become noisy symbols. Example: `classifyQuery` extracts symbols from prompt text, but generic task verbs need stronger filtering: [src/retrieval/classifier.ts](/home/nash/tuberosa/src/retrieval/classifier.ts:50).
- `domain` is inferred, but `labelsFromClassification` does not emit a domain label yet: [src/retrieval/classifier.ts](/home/nash/tuberosa/src/retrieval/classifier.ts:114).
- Evaluation exists, but the sandbox is still too small to prove context-mapping quality.

**Feedback Synthesis**

The key finding from [feedbacks/feedback-synthesis.md](/home/nash/tuberosa/feedbacks/feedback-synthesis.md:9): Tuberosa has useful primitives, but it does not yet carry an agent from startup to completion. The biggest improvements are:

- Treat live worktree files, handoff files, active plans, recent diffs, and prompt-named files as first-class context sources.
- Add a startup brief with `proceed / confirm / clarify`, read-first files, direct evidence, adjacent evidence, missing signals, risky areas, and verification commands.
- Separate durable memory from current truth. Memory advises; current worktree wins for continuation/self-edit work.
- Save research/investigation as compact structured traces, not raw transcripts.
- Add preview-first memory maintenance for duplicates, stale items, supersession, labels, and references.
- Auto-apply only low-risk enrichment. Ask before risky memory approval, archive, supersede, or stale cleanup.

**Second-Brain Mapping Model**

The “second brain” should map a user prompt into an agent-ready operating brief:

- Intent: task type, workflow stage, project, domain, files, symbols, errors, technologies.
- Direct evidence: current worktree, exact file/symbol/error matches, prompt-named files, approved high-confidence references.
- Adjacent evidence: old plans, broad architecture notes, related workflow memories, semantic-only matches.
- Missing signals: named files absent, no current handoff, no changed-file state, insufficient hard anchors.
- Trust state: reviewed memory, unreviewed draft, stale, superseded, rejected, user-selected.
- Action policy: `proceed`, `confirm`, or `clarify`.
- Learning loop: context decision, finish summary, verification commands, reviewed reflection draft, maintenance proposal.

This is where Tuberosa can beat generic MCP tools. MCP standardizes resources/tools/prompts, but it does not decide which context is trustworthy or sufficient. The MCP spec exposes resources, prompts, and tools, while also warning that data access and tool execution need consent and controls: [MCP specification](https://modelcontextprotocol.io/specification/), [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices).

**Core Improvements**

1. Noisy Data Filtering
Add classifier stopwords for task verbs like “Analyze,” “Answer,” “Investigate,” “Improve,” unless explicitly passed as a symbol. Promote evidence buckets over raw ranking: direct evidence must be visibly separate from adjacent evidence. Demote vector-only matches when hard anchors exist. Use feedback to suppress rejected/stale/irrelevant context.

2. Matching Mechanism
Keep hybrid retrieval, but add a `worktree` source before durable memory. Continue using weighted RRF, because this matches industry practice in Elasticsearch and Qdrant hybrid retrieval: [Elasticsearch RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion), [Qdrant hybrid queries](https://qdrant.tech/documentation/search/hybrid-queries/). Then add an evidence gate after fusion: top results should prove why they match by file, symbol, error, domain, selected feedback, relation path, or current worktree reference.

3. Categorize And Labelize Knowledge
Introduce label provenance and confidence: `explicit`, `inferred`, `reviewed`, `feedback_proposed`, `worktree_detected`. Add domain labels from classification and from the source-map/domain map. Make weak/inferred labels auditable. LlamaIndex’s ingestion pipeline is a useful reference for transformation/caching/document management patterns: [LlamaIndex ingestion pipeline](https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/).

4. Memory Model
Borrow the memory hierarchy, not the whole implementation. LangGraph separates short-term thread memory from long-term memory: [LangGraph memory](https://docs.langchain.com/oss/python/concepts/memory). Letta separates core memory from archival memory: [Letta archival memory](https://docs.letta.com/guides/ade/archival-memory). Mem0’s graph memory shows how embeddings plus nodes/edges can recover relational context: [Mem0 graph memory](https://docs.mem0.ai/open-source/features/graph-memory). Tuberosa’s differentiator should be review, provenance, fit, and agent-start orchestration.

5. Evaluation
Use RAG metrics as inputs, not the whole scorecard. Ragas gives context precision, recall, and noise sensitivity: [Ragas metrics](https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/), [Ragas noise sensitivity](https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/noise_sensitivity/). TruLens’ triad is useful for relevance, groundedness, and answer relevance: [TruLens RAG Triad](https://www.trulens.org/getting_started/core_concepts/rag_triad/). BEIR is a good reminder to test heterogeneous retrieval, not one narrow happy path: [BEIR paper](https://arxiv.org/abs/2104.08663).

**Data Sandbox**

Create a new sandbox around context mapping, not just retrieval:

`eval/context-mapping-fixtures.json`
- `knowledge`: approved records, stale records, duplicates, weak semantic distractors.
- `worktree`: current files, untracked plans, changed files, simulated diffs, missing files.
- `sessions`: prior selected/rejected/stale feedback.
- `relations`: supersedes, depends_on, mentions_file, resolves_error.
- `prompts`: user questions/tasks.
- `golden`: expected selected IDs, forbidden IDs, direct evidence, adjacent evidence, missing signals, fit status, startup action, required labels, expected answer facts.

Metrics:
- Intent extraction accuracy.
- Hit@K and MRR for expected knowledge.
- Direct-evidence placement rate.
- Noise@K / forbidden item rate.
- Context precision and recall.
- Fit calibration: expected `ready`, `needs_confirmation`, `insufficient`.
- Worktree precedence score.
- Stale/superseded avoidance.
- Label quality score.
- Startup-action accuracy.
- Maintenance-preview accuracy.

Initial cases:
- Exact file/symbol implementation task.
- Generic prompt verbs should not become symbols.
- Prompt names a local handoff file that only exists in worktree.
- Current worktree contradicts old memory.
- Domain mismatch should demote but not hide adjacent context.
- Vague continuation prompt should use recent selected session plus handoff.
- Duplicate memory should produce preview, not mutation.
- Stale memory should suggest supersession.
- Missing context should create a gap.
- Prompt-injection/secret content should be excluded before embedding.

**Sequential Plan**

Phase 0: Baseline And Cheap Noise Fixes
Fix classifier verb noise, add `domain` labels from classification, and add regression cases for context-quality complaints. Verify with `pnpm run build`, `pnpm test`, `pnpm run eval:retrieval`.

Phase 1: Context-Mapping Sandbox
Build `eval/context-mapping-fixtures.json` and `src/evaluation/context-mapping-evaluator.ts`. Score direct/adjacent/missing evidence, fit calibration, forbidden noise, and label quality. This becomes the quality gate for future retrieval work.

Phase 2: Worktree Evidence Provider
Add `src/retrieval/worktree.ts`. Collect bounded/sanitized git status, prompt-named files, handoff files, recent edits, and optional diff summaries. Add source type `worktree`, with stronger weight than memory for continuation/self-edit tasks.

Phase 3: Startup Brief
Add `src/retrieval/startup-brief.ts`. Return `proceed / confirm / clarify`, read-first files, direct evidence, adjacent evidence, missing signals, risky areas, and verification commands. Surface it through MCP session start and the workbench.

Phase 4: Label Governance
Add label provenance/confidence and a controlled taxonomy. Create reviewable proposals for missing labels, references, and relations. Add audits for broad labels, weak symbols, and stale domain tags.

Phase 5: Evidence-First Ranking V2
Update fusion/rerank to handle worktree, domain, freshness, feedback, and relation path evidence explicitly. Add an admission gate so vector-only matches cannot crowd out exact/worktree evidence on anchored tasks.

Phase 6: Preview-First Maintenance
Add maintenance preview/apply actions for duplicate, stale, superseded, weak auto-memory, missing label, missing reference, and missing relation candidates. Sourcegraph Batch Changes is the right interaction model: compute preview first, then apply after review: [Sourcegraph Batch Changes](https://sourcegraph.com/docs/batch_changes/how-tos/creating_a_batch_change).

Phase 7: Research Trace
Store compact research outcomes: sources consulted, claims kept, rejected assumptions, decisions, files affected, verification commands. Do not store raw transcripts. Approved traces become searchable knowledge.

Phase 8: Workbench Orchestration
Build the choosing panel: active session, startup brief, context fit, missing signals, maintenance previews, pending drafts, and context-quality feedback. This makes the agent-start ritual visible instead of optional.

Phase 9: Scale And Provider Quality
Tune pgvector indexes, optional OpenAI embeddings/rerankers, latency budgets, and privacy gates. Keep Postgres as source of truth unless evaluation proves an external vector DB is worth the operational cost.

Current verification status from this analysis run: `pnpm run eval:retrieval`, `pnpm run eval:knowledge-completeness -- --mode fixture`, and `pnpm run eval:agent-context` passed. The important caveat is coverage: the current evals prove known cases, not the full context-mapping behavior Tuberosa needs.