# Tuberosa

Tuberosa is a local-first context broker for agentic AI workflows. It sits between coding agents and durable project knowledge, retrieves the right references for a task, and stores reviewed reflection memories so future agents do not repeat the same mistakes.

The current v1 shape is:

- MCP stdio server for AI agent integrations.
- HTTP API for knowledge ingestion, retrieval, feedback, and reflection review.
- Postgres + pgvector for durable knowledge, chunks, labels, references, context packs, feedback, and embeddings.
- Redis for short-lived context-pack caching.
- Provider-pluggable model adapter with a deterministic hash provider for local development and OpenAI embedding support when `OPENAI_API_KEY` is set.

## When To Use It

Use Tuberosa when an agent needs project-specific context before or during work:

- Code references: files, symbols, errors, prior bug fixes, architecture notes.
- Operating knowledge: runbooks, workflow notes, gotchas, review preferences.
- Reflection memories: reviewed lessons from previous agent sessions.
- Retrieval provenance: every suggested context item carries labels, references, scores, and match reasons.

Tuberosa is not a general chat UI yet. The first-class integration surface is MCP, with HTTP as the operational and debugging API.

## Architecture

The request path is:

1. An agent calls `tuberosa_search_context` through MCP, or a client calls `POST /context/search`.
2. Tuberosa classifies the task prompt into project, task type, files, symbols, errors, technologies, and business areas.
3. Tuberosa searches candidates through metadata, lexical full-text, vector similarity, and approved memory search.
4. Results are fused with weighted reciprocal-rank fusion, reranked, and packed into `essential`, `supporting`, and `optional` context sections.
5. The agent or user can select, reject, mark stale, or mark irrelevant context through feedback.
6. Useful lessons can be stored as reflection drafts and approved into searchable memory.

Storage defaults:

- `postgres`: durable production-like store, using pgvector for embeddings and Postgres full-text search for lexical retrieval.
- `memory`: local test/fallback store.
- `redis`: cache for repeated context lookups.
- `none` or `memory`: local cache fallback.

## Requirements

- Node.js `22.13` or newer. `.nvmrc` is pinned to `22.21.1`.
- pnpm `11.1.2` or newer through Corepack.
- Docker Compose if you want the full Postgres + Redis stack.
- Optional: `OPENAI_API_KEY` for OpenAI embeddings. Without it, Tuberosa uses a deterministic hash embedding provider.

## Configuration

Copy the example environment:

```bash
cp .env.example .env
```

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3027` | HTTP server port. |
| `DATABASE_URL` | `postgres://tuberosa:tuberosa@localhost:5432/tuberosa` | Postgres connection string. |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string. |
| `TUBEROSA_STORE` | `postgres` | `postgres` or `memory`. |
| `TUBEROSA_CACHE` | `redis` | `redis`, `memory`, or `none`. |
| `TUBEROSA_MODEL_PROVIDER` | `hash` | `hash` or `openai`. |
| `OPENAI_API_KEY` | empty | Enables OpenAI embeddings when provider is `openai`. |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model name. |
| `EMBEDDING_DIMENSIONS` | `1536` | Embedding dimension count. Must match the pgvector column dimension. |
| `CONTEXT_CACHE_TTL_SECONDS` | `300` | Context pack cache TTL. |

`text-embedding-3-small` defaults to 1536 dimensions, which matches `migrations/001_init.sql`.

## Quick Start With Docker

Docker is the easiest way to run the full stack:

```bash
corepack enable
pnpm install
docker compose up --build -d
curl http://localhost:3027/health
```

Expected health response:

```json
{
  "ok": true,
  "service": "tuberosa",
  "store": "postgres",
  "cache": "redis",
  "modelProvider": "hash"
}
```

The Compose app runs migrations before starting the HTTP server. Postgres is exposed on `localhost:5432`, Redis on `localhost:6379`, and Tuberosa on `localhost:3027`.

Stop the stack:

```bash
docker compose down
```

Remove Postgres data as well:

```bash
docker compose down -v
```

## Quick Start Without Docker

Use this mode when you already have Postgres and Redis running locally:

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm run migrate
pnpm run dev
```

For a no-dependency local smoke test, set these values in `.env`:

```bash
TUBEROSA_STORE=memory
TUBEROSA_CACHE=memory
TUBEROSA_MODEL_PROVIDER=hash
```

Then run:

```bash
pnpm run dev
```

Memory mode does not persist data after process exit.

## Common Commands

```bash
pnpm run build     # TypeScript build
pnpm test          # Node test suite
pnpm run dev       # HTTP app in watch mode
pnpm start         # Run built HTTP app
pnpm run mcp       # MCP stdio server
pnpm run worker    # Worker process placeholder
pnpm run migrate   # Apply SQL migrations
pnpm run eval:retrieval # Deterministic retrieval quality eval
```

If your shell defaults to an older Node version:

```bash
nvm use
```

or prefix commands explicitly:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
```

## Retrieval Evaluation

Run the deterministic retrieval eval suite before changing classification, fusion weights, reranking, or context pack assembly:

```bash
pnpm run eval:retrieval
```

The default fixture lives at `eval/retrieval-fixtures.json`. It seeds an in-memory store, runs each prompt through the normal ingestion and retrieval services, and reports hit rate, MRR, precision@k, stale rejection, unexpected-result avoidance, and exact file/symbol/error classification checks.

Useful options:

```bash
pnpm run eval:retrieval -- --top-k 3
pnpm run eval:retrieval -- --json
pnpm run eval:retrieval -- --fixture eval/retrieval-fixtures.json --fail-under-hit-rate 0.95
```

## HTTP API

All endpoints return JSON.

### Health

```bash
curl http://localhost:3027/health
```

### Add One Knowledge Item

```bash
curl -X POST http://localhost:3027/knowledge \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "sourceType": "manual",
    "sourceUri": "docs/paywall.md",
    "itemType": "wiki",
    "title": "Newsletter paywall workflow",
    "summary": "How newsletter paywall selection should behave.",
    "content": "PaywallSelectionModal must keep selected product ids stable while editors configure newsletter paywall options.",
    "trustLevel": 80,
    "labels": [
      { "type": "business_area", "value": "paywall", "weight": 1 },
      { "type": "technology", "value": "react", "weight": 0.8 },
      { "type": "symbol", "value": "PaywallSelectionModal", "weight": 1 }
    ],
    "references": [
      { "type": "file", "uri": "src/components/paywall-selection-modal.tsx" }
    ]
  }'
```

Required fields:

- `project`
- `sourceType`
- `sourceUri`
- `itemType`
- `title`
- `content`

Useful `itemType` values:

- `spec`
- `workflow`
- `memory`
- `bugfix`
- `code_ref`
- `rule`
- `wiki`
- `conversation`

### Ingest Files

`POST /ingest/files` accepts a project name and an array of file objects:

```bash
curl -X POST http://localhost:3027/ingest/files \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "files": [
      {
        "path": "src/components/paywall-selection-modal.tsx",
        "content": "export function PaywallSelectionModal() { return null; }",
        "labels": [
          { "type": "business_area", "value": "paywall", "weight": 1 }
        ]
      }
    ]
  }'
```

The service infers `wiki` for Markdown/docs paths, `spec` for spec-like paths, and `code_ref` otherwise.

### List Knowledge

```bash
curl 'http://localhost:3027/knowledge?project=newsletter-app&q=paywall&limit=25'
```

`limit` is capped at `100`.

### Search Context

```bash
curl -X POST http://localhost:3027/context/search \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "prompt": "Update PaywallSelectionModal for the newsletter paywall flow",
    "files": ["src/components/paywall-selection-modal.tsx"],
    "symbols": ["PaywallSelectionModal"],
    "taskType": "implementation",
    "tokenBudget": 4000
  }'
```

Response shape:

- `id`: context pack id.
- `queryId`: stored context query id.
- `confidence`: pack-level confidence from top score, classifier confidence, and result density.
- `classified`: extracted files, symbols, errors, technologies, business areas, and lexical query.
- `sections`: `essential`, `supporting`, and `optional` candidate groups.
- `sections[].items[].matchReasons`: why a candidate matched.
- `sections[].items[].references`: source files, URLs, commits, tools, or conversations.

### Get A Context Pack

```bash
curl http://localhost:3027/context/packs/<context-pack-id>
```

### Record Feedback

Use feedback to mark good or bad context and to trigger a retry for rejected/stale/irrelevant packs.

```bash
curl -X POST http://localhost:3027/context/feedback \
  -H 'Content-Type: application/json' \
  -d '{
    "contextPackId": "<context-pack-id>",
    "project": "newsletter-app",
    "feedbackType": "stale",
    "reason": "This points at the legacy paywall flow.",
    "rejectedKnowledgeIds": ["<knowledge-id>"]
  }'
```

Valid `feedbackType` values:

- `selected`
- `rejected`
- `irrelevant`
- `stale`
- `missing_context`

Rejected, irrelevant, and stale feedback cause Tuberosa to retry the search with rejected knowledge excluded.

### Create A Reflection Draft

Reflection drafts are reviewable by default. They do not become searchable memory until approved.

```bash
curl -X POST http://localhost:3027/reflection-drafts \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "title": "Keep paywall product ids stable",
    "summary": "Newsletter paywall edits should preserve selected product ids.",
    "content": "When changing PaywallSelectionModal, preserve selected product ids across render and submit paths because downstream billing configuration depends on stable ids.",
    "triggerType": "user_correction",
    "labels": [
      { "type": "business_area", "value": "paywall", "weight": 1 },
      { "type": "symbol", "value": "PaywallSelectionModal", "weight": 1 }
    ]
  }'
```

Valid `triggerType` values:

- `complex_task_success`
- `error_recovery`
- `user_correction`
- `non_trivial_workflow`
- `manual`

### Approve A Reflection Draft

```bash
curl -X POST http://localhost:3027/reflection-drafts/<draft-id>/approve
```

Approval writes the draft into knowledge as `itemType: "memory"` unless another item type was provided.

## MCP Server

Run the MCP stdio server:

```bash
pnpm run mcp
```

Current MCP methods:

- `tools/list`
- `tools/call`
- `resources/templates/list`
- `resources/read`
- `prompts/list`
- `prompts/get`

Current MCP tools:

| Tool | Purpose |
| --- | --- |
| `tuberosa_search_context` | Classify a task and return a ranked shortlist with confidence, reasons, and references. |
| `tuberosa_get_context_pack` | Fetch the full pack after a shortlist is accepted. |
| `tuberosa_reflect` | Create a reviewable reflection draft. |
| `tuberosa_feedback_context` | Record selected/rejected/stale/irrelevant/missing context feedback. |

Current MCP resource templates:

- `tuberosa://packs/{id}`
- `tuberosa://knowledge/{id}`

Current MCP prompts:

- `tuberosa_bootstrap_session`
- `tuberosa_reflect_after_task`

Recommended agent workflow:

1. Before work starts, call `tuberosa_search_context` with the user prompt, project, cwd, files, symbols, and errors when known.
2. Show the shortlist to the user or apply an explicit acceptance rule.
3. Call `tuberosa_get_context_pack` for the chosen pack.
4. If context is wrong, call `tuberosa_feedback_context` and retry once.
5. After a useful correction or durable lesson, call `tuberosa_reflect`.
6. Approve reflection drafts through HTTP or a future UI before they become memory.

## Agent Integration Guides

### Codex

Codex can run local stdio MCP servers. Add Tuberosa to your Codex config, using the absolute repo path:

```toml
[mcp_servers.tuberosa]
command = "pnpm"
args = ["--dir", "/home/nash/tuberosa", "run", "mcp"]
```

If Codex does not inherit the right Node version, use a shell wrapper:

```toml
[mcp_servers.tuberosa]
command = "/usr/bin/zsh"
args = [
  "-lc",
  "cd /home/nash/tuberosa && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run mcp"
]
```

Suggested project instruction:

```text
Before starting implementation or debugging, call tuberosa_search_context with the user task, cwd, project, files, symbols, and errors when known. Use tuberosa_get_context_pack only after the shortlist looks relevant. Record rejected or stale context with tuberosa_feedback_context.
```

### Claude Code

Add a project-scoped local stdio server:

```bash
claude mcp add --transport stdio --scope project tuberosa -- pnpm --dir /home/nash/tuberosa run mcp
```

Claude Code writes project-scoped MCP config to `.mcp.json`. A manual equivalent is:

```json
{
  "mcpServers": {
    "tuberosa": {
      "command": "pnpm",
      "args": ["--dir", "/home/nash/tuberosa", "run", "mcp"],
      "env": {}
    }
  }
}
```

For user scope instead of project scope:

```bash
claude mcp add --transport stdio --scope user tuberosa -- pnpm --dir /home/nash/tuberosa run mcp
```

### GitHub Copilot

For local VS Code Agent mode, add a workspace MCP config:

```json
{
  "servers": {
    "tuberosa": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["--dir", "/home/nash/tuberosa", "run", "mcp"]
    }
  }
}
```

For Copilot cloud agent, use Tuberosa only if the server and its database are available in the environment where the cloud agent runs. Copilot cloud agent currently relies on MCP tools; do not depend on Tuberosa MCP resources or prompts for that path. Keep `tuberosa_search_context`, `tuberosa_get_context_pack`, and `tuberosa_feedback_context` sufficient as tools.

### MCP Inspector

Use the MCP Inspector to debug server compatibility:

```bash
npx @modelcontextprotocol/inspector pnpm --dir /home/nash/tuberosa run mcp
```

Use it to verify that tools, prompts, and resources list correctly before wiring a new client.

## Matching Functionality

Current matching is intentionally simple and inspectable:

1. `classifyQuery` extracts known task structure from the prompt:
   - project
   - task type
   - file paths
   - symbols
   - error codes
   - technologies
   - business areas
   - exact terms
   - lexical query
2. `searchMetadata` favors labels, references, title, summary, and metadata matches.
3. `searchLexical` uses Postgres full-text search or in-memory token matching.
4. `searchVector` embeds the query and compares against chunk embeddings.
5. `searchMemories` targets approved memories, workflows, rules, and bug fixes.
6. `fuseCandidates` applies weighted reciprocal-rank fusion.
7. The model provider reranks candidates.
8. `assembleContextPack` trims content and splits results into sections within the token budget.

This hybrid design is the right baseline for code and operational memory because exact symbols, file names, and error codes matter as much as semantic similarity.

### Recommended Matching Improvements

Implement matching improvements in this order:

1. Retrieval eval coverage.
   - Expand fixtures with real project prompts, expected knowledge ids, and negative examples.
   - Track hit rate, MRR, precision@k, stale-context rejection, unexpected-result avoidance, and exact classification checks.
   - Include exact file/symbol matching, business-domain matching, prior-error recovery, and missing-context scenarios.
2. Query rewriting.
   - Add a provider hook that can expand vague prompts into structured search queries.
   - Keep the original query in the search set so rewriting cannot erase exact terms.
3. Stronger metadata filters.
   - Treat `project`, `repo`, `file`, `symbol`, `error`, `task_type`, and `freshnessAt` as first-class filters or boosts.
   - Prefer exact file/symbol/error hits over broad semantic similarity.
4. Real reranker provider.
   - Keep the deterministic hash reranker for tests.
   - Add a provider-backed reranker for top 50-200 candidates, then keep 5-12 final context items.
5. Diversity and dedupe.
   - Avoid returning many chunks from the same knowledge item unless they answer different parts of the task.
   - Keep one best chunk per knowledge item by default, then allow expansion when the user fetches the full pack.
6. Freshness and feedback learning.
   - Penalize stale feedback and low-trust knowledge.
   - Boost selected context for similar future prompts within the same project.
7. Security filters.
   - Redact secrets before ingestion and before context injection.
   - Detect prompt-injection patterns in stored knowledge and mark unsafe chunks as non-injectable until reviewed.
8. pgvector tuning.
   - Keep HNSW indexes for vector search.
   - Evaluate `hnsw.iterative_scan` when project filters become selective.
   - Keep embedding dimensions consistent between model config and migration schema.

Do not add more heuristics without eval coverage. Matching should improve through measured retrieval quality, not only manual weight tweaks.

## Admin And Debug UI Direction

The recommended v1 UI is an admin/debug interface, not a full AI chat workspace.

Primary jobs:

- Browse projects, knowledge items, labels, references, and chunks.
- Inspect chunk text, contextual content, token estimates, source metadata, and embedding dimensions.
- Run a search prompt and see the individual metadata, lexical, vector, and memory candidate lists before fusion.
- Show final fused/reranked context packs with confidence, match reasons, and provenance.
- Record selected/rejected/stale feedback from the UI.
- Review and approve reflection drafts.
- Copy MCP setup snippets for Codex, Claude Code, and GitHub Copilot.

Vector-specific UI ideas:

- Show vector dimensions, model provider, embedding model, and chunk id.
- Display nearest-neighbor results for a selected chunk.
- Add a projection view later if the dataset is large enough to justify it.
- Keep raw vector arrays collapsed by default; they are usually less useful than distances, source text, labels, and neighbors.

Suggested first UI stack:

- Keep it served by the existing Node app to avoid another service.
- Add static HTML/CSS/JS or a small Vite app only when interactions outgrow plain static assets.
- Use the existing HTTP API first; add dedicated debug endpoints only for source-level candidate breakdowns and vector neighbor inspection.

## Roadmap

### Near Term

- Expand README and examples as the source of truth for setup and API usage.
- Add integration tests for Postgres/pgvector and Redis, gated behind Docker availability.
- Expand retrieval eval fixtures with real-project regression cases.
- Add source-level debug output for matching: metadata, lexical, vector, memory, fusion, rerank.
- Build the admin/debug UI for knowledge browsing, search testing, and reflection approval.

### Mid Term

- Add a CLI: `tuberosa ingest --project <name> --path <repo-or-docs-path>`.
- Add GitNexus/Graphify import adapters so existing graph/wiki outputs become normalized knowledge.
- Add provider-backed query rewriting and reranking.
- Add prompt-injection and secret-redaction checks.
- Replace the minimal MCP JSON-RPC implementation with the official TypeScript MCP SDK if stricter client compatibility is required.

### Later

- Add remote MCP transport with authentication for hosted agents.
- Add multi-user/project permissions if Tuberosa moves beyond local-first usage.
- Add observability traces for retrieval stages, embedding calls, reranking calls, feedback, latency, and cost.
- Add prompt/version management for search and reflection templates.

## Troubleshooting

### `node:sqlite` or pnpm fails under Node 20

Use Node 22:

```bash
nvm use
corepack enable
pnpm install
```

### pnpm cannot create a global store

The repo is configured for a local pnpm store through `pnpm-workspace.yaml`. If pnpm still tries to use a global store:

```bash
pnpm config set store-dir .pnpm-store --location project
pnpm install
```

### Docker app exits during migration

Check logs:

```bash
docker compose logs --no-color app worker
```

Then rebuild:

```bash
docker compose up --build -d
```

### `curl localhost:3027` fails in a sandboxed environment

Run the server and curl from an environment allowed to bind and access local ports. In Codex-style sandboxes, local networking may require explicit approval.

### OpenAI embeddings fail

Check:

- `TUBEROSA_MODEL_PROVIDER=openai`
- `OPENAI_API_KEY` is set.
- `OPENAI_EMBEDDING_MODEL` supports the configured `EMBEDDING_DIMENSIONS`.
- Postgres `knowledge_chunks.embedding vector(...)` dimension matches the embedding length.

### MCP client does not see tools

Verify with MCP Inspector first. Then check:

- The command uses an absolute repo path.
- The client has the correct Node and pnpm on `PATH`.
- The MCP process writes JSON-RPC to stdio and does not print extra logs to stdout.
- For cloud agents, the environment can access the command, app, Postgres, and Redis.

## References And Inspiration

- Model Context Protocol SDKs: https://modelcontextprotocol.io/docs/sdk
- MCP Inspector: https://modelcontextprotocol.io/docs/tools/inspector
- OpenAI Docs MCP and Codex setup: https://developers.openai.com/learn/docs-mcp
- OpenAI `text-embedding-3-small`: https://developers.openai.com/api/docs/models/text-embedding-3-small
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- GitHub Copilot MCP: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/extend-cloud-agent-with-mcp
- pgvector HNSW guidance: https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes
- Open WebUI Knowledge/RAG behavior: https://docs.openwebui.com/features/workspace/knowledge/
- Langfuse observability and evals: https://langfuse.com/docs
- RAG techniques overview: https://www.microsoft.com/en-us/microsoft-cloud/blog/2025/02/04/common-retrieval-augmented-generation-rag-techniques-explained/
- RecallDB pgvector API/dashboard inspiration: https://recalldb.ai/
- dbSurface pgvector visualization inspiration: https://dbsurface.com/
