# Tuberosa Flow Logic

This file describes the internal flow logic of Tuberosa: how knowledge enters the system, how context is matched, how feedback retries work, and how reflection drafts become durable memory.

## 1. System Goal

Tuberosa solves the context-selection problem for agentic AI tools. The agent should not start from an empty context window when project knowledge, past corrections, runbooks, and references already exist. Tuberosa acts as a broker:

1. Store normalized knowledge with labels and references.
2. Classify an incoming agent task.
3. Retrieve likely relevant knowledge through multiple search stages.
4. Fuse and rerank candidates into a compact context pack.
5. Let the user or agent accept, reject, or mark stale context.
6. Save durable lessons as reviewable reflection drafts.
7. Approve reflections into searchable memory.

## 2. Runtime Components

Main services:

- `src/app.ts`: creates config, store, cache, model provider, ingestion, retrieval, and reflection services.
- `src/http/server.ts`: exposes HTTP endpoints.
- `src/mcp/server.ts`: exposes MCP tools, resources, and prompts.
- `src/ingest/service.ts`: builds chunks and embeddings from knowledge.
- `src/ingest/document-atomizer.ts`: splits markdown/docs into section-level knowledge atoms.
- `src/security/knowledge-safety.ts`: scans knowledge for secrets, prompt-injection, and malware-like instructions.
- `src/retrieval/service.ts`: orchestrates context search.
- `src/retrieval/classifier.ts`: extracts task structure from prompts.
- `src/retrieval/fusion.ts`: merges candidates with weighted reciprocal-rank fusion.
- `src/retrieval/context-fit.ts`: evaluates whether retrieved candidates actually fit the task.
- `src/retrieval/context-pack.ts`: builds final context sections.
- `src/retrieval/debug.ts`: builds optional retrieval debug traces.
- `src/agent-session/service.ts`: coordinates session start, context decisions, finish outcomes, and optional reflection drafts.
- `src/reflection/service.ts`: creates and approves memory drafts.
- `src/operations/service.ts`: exposes review, audit, cleanup, and importer operations without coupling them to retrieval.
- `src/storage/store.ts`: storage interface.
- `src/storage/postgres-store.ts`: durable storage implementation.
- `src/storage/memory-store.ts`: in-memory test and fallback implementation.
- `src/cache.ts`: Redis, memory, and null cache adapters.
- `src/model/provider.ts`: hash and OpenAI model providers.

## 3. Data Model

Important entities:

- Project: named workspace or repo boundary.
- Knowledge source: origin of knowledge, such as a file, manual note, reflection, wiki, or import.
- Knowledge item: approved knowledge record with item type, title, summary, content, labels, references, trust level, metadata, and freshness timestamp.
- Knowledge chunk: chunked content with contextual content, token estimate, embedding, metadata, and full-text search vector.
- Label: normalized metadata such as project, repo, file, symbol, error, technology, business area, task type, or user preference.
- Reference: file, URL, commit, tool, conversation, or external pointer.
- Context query: stored search prompt, fingerprint, classification, and token budget.
- Context pack: proposed, selected, or rejected pack of ranked candidates.
- Feedback event: selected, rejected, irrelevant, stale, or missing-context signal.
- Agent session: audit record for one agent task, initial context, context decisions, outcome, and reflection draft links.
- Reflection draft: pending, approved, or rejected learning memory.

Storage note: SQL uses `knowledge_references`, not `references`, because `references` is a reserved identifier.

## 4. Ingestion Flow

Entry points:

- HTTP `POST /knowledge`
- HTTP `POST /ingest/files`
- Reflection approval through `POST /reflection-drafts/:id/approve`
- Future CLI or import adapters

Flow:

1. Client sends `KnowledgeInput` or file ingestion input.
2. File ingestion uses `mode: "document"` by default, or `mode: "atomic"` when the caller wants markdown/docs split into section-level knowledge items.
3. In document mode, one file becomes one `KnowledgeInput`.
4. In atomic mode, supported markdown/docs are split by headings into independent knowledge atoms.
5. Each atom gets its own title, summary, content, source URI, file reference, line range, section path metadata, and section/domain labels.
6. `IngestionService` normalizes item type, title, summary, labels, and references.
7. File and atom ingestion call `classifyQuery` on the path and content sample to infer labels.
8. `KnowledgeSafetyService` redacts detected secrets and blocks prompt-injection or malware-like knowledge before embedding or storage.
9. Content is split into chunks with `splitIntoChunks`.
10. Each chunk gets contextual content containing project, item type, title, summary, labels, references, and chunk text.
11. Model provider embeds each contextual chunk.
12. Store persists project, source, knowledge item, labels, references, chunks, token estimates, embeddings, and safety metadata.

Design rule:

- Ingestion should preserve provenance. Every useful context item should carry source URI, labels, and references so agents can inspect why it was retrieved.
- Atomic ingestion should keep the useful idea as the ranking unit. Large documents should become small, labeled, independently retrievable knowledge items before normal chunking.
- Safety checks run before embedding so redacted secrets are not sent to external embedding providers.

## 5. Retrieval Flow

Entry points:

- HTTP `POST /context/search`
- MCP `tuberosa_search_context`

Flow:

1. `RetrievalService.searchContext` redacts detected secrets from prompt/error input, then normalizes:
   - default `tokenBudget` to `4000`
   - default `rejectedKnowledgeIds` to `[]`
   - default `debug` to `false`
2. `classifyQuery` extracts:
   - project
   - task type
   - files
   - symbols
   - errors
   - technologies
   - business areas
   - exact terms
   - lexical query
3. If the configured model provider supports query rewriting, retrieval asks it for a compact lexical rewrite and extra exact terms.
4. Query rewrite output is sanitized, merged with deterministic classification, and never allowed to replace the original prompt.
5. It creates a stable fingerprint from prompt, project, repo hint, cwd, task type, files, symbols, errors, token budget, rejected ids, effective lexical query, exact terms, and rewrite model.
6. It checks the cache unless `bypassCache` or `debug` is true.
7. The store creates a `context_queries` row.
8. Candidate searches run in parallel:
   - metadata search
   - lexical search
   - memory search
   - vector search
9. Vector search embeds the redacted prompt plus effective lexical query, then compares against chunk embeddings.
10. `KnowledgeSafetyService` filters blocked candidates and redacts any legacy unsafe content before ranking.
11. `fuseCandidates` merges all source lists by knowledge id using weighted reciprocal-rank fusion.
12. Fusion keeps the strongest chunk per knowledge item and merges match reasons.
13. Model provider reranks the fused top candidates. Hash mode stays deterministic; OpenAI mode can use `OPENAI_RERANK_MODEL` when configured.
14. Store feedback summaries are applied to reranked candidates:
   - selected feedback gives a modest final-score boost
   - stale, rejected, and irrelevant feedback apply final-score penalties
   - candidate metadata records feedback counts, latest signal, and score adjustment
15. Retrieval safety checks run again before fit evaluation.
16. `ContextFitEvaluator` scores candidate and pack fit across project, files, symbols, errors, task type, trust, freshness, safety, and prior feedback signals.
17. `assembleContextPack` removes weak tail candidates before packing:
    - anchored searches require a stronger final score
    - general searches use a lower final-score floor
    - the top candidate is preserved so sparse searches still return the best available context
18. The remaining candidates are split into:
    - `essential`
    - `supporting`
    - `optional`
19. The pack is saved and cached without debug output.
20. If `debug: true`, a debug trace is attached only to the returned response.

## 6. Candidate Search Stages

Metadata search:

- Uses classified files, symbols, errors, technologies, business areas, and exact terms.
- Matches labels, references, title, summary, and metadata.
- Useful for exact code references and business-domain labels.

Lexical search:

- Uses Postgres full-text search in Postgres mode.
- Uses token matching in memory mode.
- Useful for exact words in chunk text and contextual content.

Memory search:

- Searches approved `memory`, `workflow`, `rule`, and `bugfix` items.
- Useful when prior corrections or durable lessons should guide the current task.

Vector search:

- Embeds the query and compares with chunk embeddings.
- Useful for semantic matches when exact terms are incomplete.
- Weighted below exact metadata and lexical matches when files, symbols, or errors are present.

Fusion:

- Combines stage results by knowledge id.
- Applies source weights:
  - metadata strongest
  - reference reserved for future direct reference search
  - memory
  - lexical
  - vector
- Boosts debugging tasks toward bugfix, memory, and workflow items.
- Boosts planning tasks toward spec, wiki, and workflow items.

Rerank:

- Hash provider reranks deterministically for tests.
- OpenAI provider can rewrite queries when `OPENAI_REWRITE_MODEL` is set.
- OpenAI provider can rerank fused candidates when `OPENAI_RERANK_MODEL` is set.
- If rerank is unset, OpenAI provider falls back to deterministic hash reranking.

## 7. Debug Trace Flow

Set `debug: true` in HTTP or MCP search input.

Debug mode:

- Bypasses cache so source stages are actually recomputed.
- Returns a `debug` object on the response.
- Does not save debug data in stored context packs.
- Does not cache debug data.

Debug trace fields:

- `fingerprint`: stable query fingerprint.
- `cache`: cache key, hit flag, and bypass flag.
- `limits`: search limit, rerank limit, and token budget.
- `filters`: rejected knowledge ids and filter decisions.
- `queryRewrite`: original lexical query, rewritten lexical query, added exact terms, reasons, and model when a provider rewrite was used.
- `providerRerank`: provider rerank model, candidate ids sent for rerank, and provider scoring decisions when provider rerank was used.
- `timingsMs`: classification, rewrite, embedding, stage search, fusion, rerank, fit, assembly, save, and total timings.
- `stages`: metadata, lexical, memory, vector, fusion, rerank, and fit candidate lists.
- `selected`: final candidates by context-pack section.

Candidate debug fields:

- knowledge id
- chunk id
- title
- item type
- project
- source
- rank
- raw score
- fused score
- rerank score
- final score
- fit score
- trust level
- token estimate
- match reasons
- fit reasons and missing fit signals
- references

Use debug traces when tuning search weights, diagnosing missing context, building the admin/debug UI, or investigating stale context.

## 8. Context Fit And Pack Assembly

`ContextFitEvaluator` runs after rerank and before assembly. It does not replace provenance or match reasons; it adds a separate fit signal so agents can tell whether the shortlist is usable for the task.

Candidate fit uses:

- project match
- exact file, symbol, and error coverage
- technology and business-area coverage
- task-type alignment
- trust level
- freshness metadata
- safety metadata
- prior feedback or rejected ids

Pack-level `contextFit` includes:

- `fitStatus`: `ready`, `needs_confirmation`, or `insufficient`
- `fitScore`: normalized fit score
- `fitReasons`: coverage reasons for the shortlist
- `missingSignals`: concrete signals that were not covered

When fit is `insufficient`, agents should ask a clarifying question or continue without relying on the pack. Sparse searches still return the best available candidate, but the fit metadata makes the uncertainty explicit.

`assembleContextPack` enforces token budget and section shape:

- Candidates below the final-score floor are removed before sectioning, except the top candidate.
- Anchored searches are prompts with files, symbols, errors, business areas, or technologies.
- Anchored searches use a stricter final-score floor so unrelated optional context does not leak into packs.
- General searches use a lower final-score floor to keep useful semantic matches.
- Minimum effective budget is `900` tokens.
- Essential section receives about 52 percent of budget.
- Supporting section receives about 34 percent.
- Optional section receives the remainder.
- Essential section can include up to 4 candidates.
- Supporting section can include up to 6 candidates.
- Optional section can include up to 8 candidates.
- Content and contextual content are truncated before return.

Pack confidence is calculated from:

- top final score
- classifier confidence
- result density

The confidence is capped below `1` to avoid pretending retrieval is certain.

## 9. Feedback Flow

Entry points:

- HTTP `POST /context/feedback`
- MCP `tuberosa_feedback_context`

Feedback types:

- `selected`
- `rejected`
- `irrelevant`
- `stale`
- `missing_context`

Flow:

1. Store writes a feedback event.
2. If `contextPackId` is present, the pack status is updated:
   - `selected` becomes selected.
   - every other feedback type becomes rejected.
3. `rejected`, `irrelevant`, and `stale` trigger retry.
4. Retry input uses the original prompt and project.
5. Retry rejected ids include:
   - all knowledge ids in the rejected pack
   - explicit `rejectedKnowledgeIds` from feedback
6. Retry sets `bypassCache: true`.
7. Search runs again with rejected knowledge excluded.

Missing-context feedback is recorded but does not automatically retry because there may be no known ids to exclude.

Feedback history is also used in future searches. `KnowledgeStore.getFeedbackSummaries` returns compact per-knowledge counts for selected, rejected, irrelevant, and stale feedback. Retrieval applies those summaries after rerank and before context-fit evaluation so useful context can rise slightly and stale or rejected context is less likely to win.

Missing-context events are kept as review signals. They do not penalize any specific knowledge item because they often mean the right knowledge is absent.

## 10. Agent Session Flow

Entry points:

- HTTP `POST /agent-sessions`
- HTTP `POST /agent-sessions/:id/context-decision`
- HTTP `POST /agent-sessions/:id/finish`
- MCP `tuberosa_start_session`
- MCP `tuberosa_record_context_decision`
- MCP `tuberosa_finish_session`

Start flow:

1. Caller provides prompt, project, cwd, agent name/tool, and optional retrieval hints.
2. `AgentSessionService` calls normal retrieval.
3. Store creates an active session linked to the initial context pack.
4. Response includes the context shortlist/full pack and a policy:
   - `proceed` when context fit is ready
   - `confirm` when fit needs confirmation
   - `clarify` when fit is insufficient

Decision flow:

1. Caller records selected, rejected, irrelevant, stale, or missing-context feedback.
2. Service writes normal retrieval feedback so context-pack status and retry behavior stay consistent.
3. Store writes an agent context decision linked to the session.
4. Rejected, irrelevant, and stale decisions may return a retry pack through the existing feedback retry path.

Finish flow:

1. Caller records outcome: completed, failed, blocked, or cancelled.
2. Caller may include a reflection draft payload.
3. Service creates a pending reflection draft and links its id to the session.
4. Store marks the session finished with summary, metadata, timestamps, and reflection draft ids.

Design rule:

- Session orchestration should depend on retrieval, reflection, and `KnowledgeStore`; retrieval ranking and reflection approval remain independent services.

## 11. Reflection Flow

Entry points:

- HTTP `POST /reflection-drafts`
- MCP `tuberosa_reflect`

Draft creation flow:

1. `ReflectionService.createDraft` trims title, summary, and content.
2. It classifies the draft content.
3. It generates suggested labels from classification plus caller-provided labels.
4. It normalizes `metadata.taxonomy` to one of:
   - `project_fact`
   - `domain_rule`
   - `workflow`
   - `user_preference`
   - `incident_lesson`
   - `code_reference`
5. It stores provenance in metadata, including agent session id, context pack id, trigger type, and references when available.
6. It validates minimum title, summary, and content lengths.
7. It searches existing memory-like items for duplicate candidates.
8. Store creates a pending reflection draft.

Approval flow:

1. HTTP `POST /reflection-drafts/:id/approve` approves the draft.
2. Approved draft is ingested as a knowledge item.
3. Default project is `personal` when the draft has no project.
4. Default item type is `memory`.
5. Labels include project, trigger type as user preference, and suggested labels.
6. References include `reflection://draft/<id>` plus caller-provided references.
7. Metadata preserves taxonomy, trigger type, approved draft id, and provenance.
8. The memory becomes searchable by normal retrieval.

Safety rule:

- Do not save secrets, raw private conversation, or unreviewed prompt-injection content as durable memory.

## 12. Knowledge Review And Operations Flow

Entry points:

- HTTP `GET /knowledge`
- HTTP `GET /knowledge/:id`
- HTTP `PATCH /knowledge/:id`
- HTTP `GET /labels`
- HTTP `GET /context/packs`
- HTTP `GET /feedback-events`
- HTTP `GET /agent-sessions`
- HTTP `GET /agent-sessions/:id`
- HTTP `GET /agent-sessions/:id/context-decisions`
- HTTP `GET /reflection-drafts`
- HTTP `GET /reflection-drafts/:id`
- HTTP `PATCH /reflection-drafts/:id`
- HTTP `POST /operations/import-files`
- HTTP `POST /operations/cleanup`
- HTTP `POST /operations/backups`
- HTTP `GET /operations/backups`
- HTTP `POST /operations/backups/:id/restore`
- CLI `pnpm run import:docs`
- CLI `pnpm run backup`
- CLI `pnpm run restore`

Review flow:

1. `OperationsService` exposes read/update operations over `KnowledgeStore`.
2. `GET /knowledge` supports normal project/query listing and review filters:
   - `questionable`
   - `unsafe`
   - `low_trust`
   - `stale`
   - `rejected`
   - `irrelevant`
   - `orphaned`
3. `PATCH /knowledge/:id` updates review status, trust level, freshness, labels, references, and metadata.
4. Content updates should use ingestion endpoints or the importer so chunks and embeddings are rebuilt.
5. Draft review uses list/get/update endpoints before approval turns a draft into searchable memory.
6. Audit listings expose context packs, feedback events, sessions, and session decisions so users can inspect why context was returned and how it was used.

Cleanup flow:

1. Caller posts `olderThanDays` and optional `dryRun`.
2. Store computes counts for old proposed context packs, orphaned feedback rows, unused old context queries, and unused knowledge sources.
3. Dry runs return counts without deleting.
4. Non-dry runs delete only operational debris, not approved knowledge items.

Importer flow:

1. `/operations/import-files` and `pnpm run import:docs` both call `OperationsService.importFiles`.
2. The service delegates to `IngestionService.ingestFiles`.
3. Atomic markdown imports reuse existing stale-atom cleanup so refreshing docs does not leave obsolete section atoms behind.

Backup flow:

1. `TUBEROSA_BACKUP_DIR` points at the physical backup folder.
2. `POST /operations/backups` or `pnpm run backup` asks the store for a full export snapshot.
3. `OperationsService` writes a `manifest.json` plus table-level JSONL files.
4. Backups include `knowledge_chunks` because chunks and embeddings are the retrieval units that feed agents.
5. `GET /operations/backups` reads manifests from the backup folder.
6. Restore dry runs read the manifest and JSONL files, then return table row counts without mutating storage.
7. Actual restore requires `replace: true` and reloads the known Tuberosa tables from backup data.

Design rule:

- Operations code should orchestrate review and maintenance, while retrieval, reflection, ingestion, and persistence keep their own responsibilities.

## 13. Cache Logic

Cache key:

```text
context:<fingerprint>
```

Fingerprint includes:

- prompt
- project
- repo hint
- cwd
- task type
- files
- symbols
- errors
- token budget
- rejected knowledge ids

Fingerprint intentionally excludes `debug`.

Cache is skipped when:

- `bypassCache` is true
- `debug` is true

Saved packs are compact. Debug traces are stripped before saving and caching.

## 14. Model Provider Logic

Hash provider:

- Deterministic.
- Works offline.
- Used by default.
- Suitable for tests and local development.

OpenAI provider:

- Used when `TUBEROSA_MODEL_PROVIDER=openai` and `OPENAI_API_KEY` is set.
- Calls the configured `OPENAI_REWRITE_MODEL` through the Responses API when query rewriting is enabled.
- Calls the configured `OPENAI_RERANK_MODEL` through the Responses API when provider-backed reranking is enabled.
- Calls OpenAI embeddings endpoint.
- Embedding dimensions must match database schema.
- Reranking falls back to deterministic hash rerank when `OPENAI_RERANK_MODEL` is unset.

Provider design rule:

- Keep provider behavior behind `ModelProvider` so retrieval can evolve without changing storage or API code.

## 15. Storage Logic

The `KnowledgeStore` interface owns durable operations:

- upsert knowledge
- list, get, and update knowledge review metadata
- list labels
- search lexical, vector, metadata, and memories
- create context query
- save, list, and get context packs
- record and list feedback
- create, list, and get agent sessions
- record and list agent context decisions
- finish agent session
- create, list, update, and approve reflection drafts
- cleanup operational debris
- export and restore backup snapshots
- close resources

Postgres store:

- Uses SQL migrations.
- Uses pgvector for embeddings.
- Uses generated tsvector for lexical search.
- Persists feedback, packs, agent sessions, context decisions, drafts, labels, references, and chunks.

Memory store:

- Used for tests and fallback mode.
- Implements the same interface.
- Keeps behavior deterministic.
- Is explicitly ephemeral. It is not a production second-brain store.

Design rule:

- Retrieval and reflection depend on the store interface, not concrete database code.

## 16. MCP Flow

Initialize:

1. Client sends `initialize`.
2. Server returns protocol version, tools, resources, and prompts capabilities.

Tool flow:

1. `tools/list` returns direct retrieval tools and session workflow tools.
2. `tools/call` dispatches by name.
3. `tuberosa_search_context` returns compact shortlist details, context fit, and candidate fit reasons.
4. `tuberosa_get_context_pack` returns full pack.
5. `tuberosa_start_session` creates a session and returns a shortlist plus policy.
6. `tuberosa_record_context_decision` records feedback and a session audit decision.
7. `tuberosa_finish_session` records outcome and optionally creates a pending reflection draft.
8. `tuberosa_reflect` creates a pending draft.
9. `tuberosa_feedback_context` records feedback and may return a retry pack.

Resource flow:

- `tuberosa://packs/{id}` reads stored context pack.
- `tuberosa://knowledge/{id}` reads stored knowledge item.

Prompt flow:

- `tuberosa_bootstrap_session` tells an agent to search and confirm context before work.
- `tuberosa_reflect_after_task` tells an agent when and how to draft memory.

## 17. QA Flow

For code changes:

```bash
pnpm run build
pnpm test
git diff --check
```

For retrieval changes:

```bash
pnpm run eval:retrieval
```

For storage, migrations, cache, or Docker changes:

```bash
pnpm run test:integration
docker compose up --build -d
curl -fsS http://localhost:3027/health
```

Functional smoke sequence:

1. Add knowledge.
2. Search context.
3. Search context with debug.
4. Fetch context pack.
5. Record selected feedback.
6. Start an agent session.
7. Record a context decision.
8. Finish the session with an optional reflection draft.
9. Create reflection draft.
10. Approve reflection draft.
11. Search for the approved memory.

Expected behavior:

- Knowledge is chunked and embedded.
- Search returns relevant references, match reasons, and context fit metadata.
- Debug output shows all candidate stages.
- Selected feedback updates pack status.
- Stale/rejected/irrelevant feedback retries with rejected knowledge excluded.
- Agent sessions preserve initial context, decisions, outcome, and reflection draft links.
- Approved reflection memory is retrievable.

## 18. Maintainability Principles

- Keep orchestration in services and persistence in stores.
- Keep optional debug logic outside the core matching algorithm.
- Keep normal MCP responses compact.
- Add retrieval heuristics only with eval coverage.
- Keep provider-specific model calls behind `ModelProvider`.
- Keep cache implementation behind `Cache`.
- Keep SQL schema changes in migrations.
- Prefer focused tests for changed behavior.
- Preserve provenance on every knowledge item.
