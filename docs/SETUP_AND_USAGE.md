# Tuberosa Setup And Usage

This guide is the operator and developer setup file for Tuberosa. Use it when installing the project, running the local stack, wiring an agent through MCP, exercising the HTTP API, or running QA checks before handoff.

## 1. Purpose

Tuberosa is a local-first context broker for agentic AI tools. It stores project knowledge, retrieves the right context for a task, records feedback when context is wrong, and turns reviewed reflection drafts into searchable memory.

The main runtime surfaces are:

- MCP stdio server for coding agents.
- HTTP API for ingestion, retrieval, feedback, and reflection review.
- Postgres plus pgvector for durable storage.
- Redis for context-pack caching.
- Hash model provider for deterministic local development.
- Optional OpenAI embedding provider when `OPENAI_API_KEY` is configured.

## 2. Requirements

- Node.js `22.13` or newer.
- pnpm `11.1.2` or newer.
- Docker Compose for the full Postgres and Redis stack.
- Optional `OPENAI_API_KEY` for OpenAI embeddings.

The repo pins Node in `.nvmrc`:

```bash
nvm use
```

If your shell still resolves an older Node version, prefix commands with:

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH
```

Do not run multiple `pnpm` commands at the same time in this repo. A previous concurrent run caused transient pnpm workspace-state parsing failures.

## 3. Install

```bash
corepack enable
pnpm install
```

The repo uses a local pnpm store through `pnpm-workspace.yaml`:

```yaml
storeDir: .pnpm-store
```

If pnpm tries to write to a global store, reset the project-local store:

```bash
pnpm config set store-dir .pnpm-store --location project
pnpm install
```

## 4. Configure

Create an environment file:

```bash
cp .env.example .env
```

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3027` | HTTP server port. |
| `TUBEROSA_API_KEY` | empty | Optional HTTP API key. When set, all routes except `/health` require `Authorization: Bearer <key>` or `x-tuberosa-api-key`. |
| `DATABASE_URL` | `postgres://tuberosa:tuberosa@localhost:5432/tuberosa` | Local Postgres connection. |
| `POSTGRES_PASSWORD` | `tuberosa` | Docker Compose Postgres password used by the app and worker. Change this outside local development. |
| `REDIS_URL` | `redis://localhost:6379` | Local Redis connection. |
| `TUBEROSA_STORE` | `postgres` | `postgres` or `memory`. |
| `TUBEROSA_CACHE` | `redis` | `redis`, `memory`, or `none`. |
| `TUBEROSA_AUTO_MIGRATE` | `true` | Run idempotent Postgres migrations during service startup. Keep this enabled for MCP stdio so agents do not start against stale local schema. |
| `TUBEROSA_MODEL_PROVIDER` | `hash` | `hash` or `openai`. |
| `OPENAI_API_KEY` | empty | Enables OpenAI embeddings when provider is `openai`. |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | OpenAI embedding model. |
| `OPENAI_REWRITE_MODEL` | empty | Optional OpenAI Responses model for provider-backed query rewriting before retrieval. |
| `OPENAI_RERANK_MODEL` | empty | Optional OpenAI Responses model for provider-backed candidate reranking after fusion. |
| `EMBEDDING_DIMENSIONS` | `1536` | Must match the pgvector column dimension. |
| `CONTEXT_CACHE_TTL_SECONDS` | `300` | Redis or memory cache TTL for context packs. |
| `TUBEROSA_CONTEXT_MODE` | `layered` | `layered` keeps the compact shortlist and adds deep context; `compact` returns only the shortlist. |
| `TUBEROSA_DEEP_CONTEXT_BUDGET` | `60000` | Target token budget for deep context. Values are clamped from 30000 to 100000. |
| `TUBEROSA_MAX_REQUEST_BYTES` | `10485760` | Maximum HTTP JSON body size. |
| `TUBEROSA_MAX_INGEST_CONTENT_BYTES` | `2097152` | Maximum size for a single knowledge content field before chunking. |
| `TUBEROSA_BACKUP_DIR` | `.tuberosa/backups` | Local folder for portable JSONL backups. Do not commit or share this folder because it can contain private project knowledge. |
| `TUBEROSA_BACKUP_INTERVAL_SECONDS` | `3600` | Scheduled backup interval. Set `0` to disable scheduled backups. |
| `TUBEROSA_BACKUP_STARTUP_DELAY_SECONDS` | `60` | Delay before the first scheduled backup after app start. |
| `TUBEROSA_BACKUP_RETENTION_COUNT` | `24` | Minimum number of latest verified backups to keep. |
| `TUBEROSA_BACKUP_RETENTION_MAX_AGE_DAYS` | `30` | Prune verified backups older than this age, while still keeping the latest backup. |
| `TUBEROSA_BACKUP_WRITE_THROUGH` | `false` | When true, important mutations can request a throttled backup. |
| `TUBEROSA_BACKUP_WRITE_THROUGH_THROTTLE_SECONDS` | `600` | Minimum time between write-through backup requests. |
| `TUBEROSA_PHYSICAL_MIRROR_ENABLED` | `true` | Maintain a readable latest mirror of live DB state under `.tuberosa/current`. |
| `TUBEROSA_PHYSICAL_MIRROR_DIR` | `.tuberosa/current` | Physical mirror directory. This is a convenience view, not the source of truth. |
| `TUBEROSA_PHYSICAL_MIRROR_DEBOUNCE_MS` | `500` | Delay before coalescing automatic physical mirror requests. Manual syncs run immediately. |
| `TUBEROSA_ERROR_LOG_DIR` | `.tuberosa/error-logs` | Local folder for sanitized physical error-log incidents. Do not commit or share this folder because logs can contain private project details. |
| `TUBEROSA_ERROR_LOG_MAX_BYTES` | `262144` | Maximum stored size for one error incident before message, stack, or metadata fields are truncated. |
| `TUBEROSA_ERROR_LOG_AUTO_CAPTURE` | `true` | Automatically record unexpected Tuberosa HTTP and MCP failures into the physical error-log journal. |
| `TUBEROSA_ERROR_LOG_CAPTURE_CLIENT_ERRORS` | `false` | When true, also auto-capture normal client errors such as validation and not-found errors. Keep false for normal development. |

## 5. Connect Codex For The Next Session

This is the recommended first install path when you are currently using Codex and want the next Codex session to test Tuberosa through MCP.

### 5.1 Start Tuberosa locally

From this repository:

```bash
corepack enable
pnpm install
test -f .env || cp .env.example .env
docker compose up --build -d
curl -fsS http://localhost:3027/health
```

Expected response:

```json
{
  "ok": true,
  "service": "tuberosa",
  "store": "postgres",
  "durability": "persistent",
  "backupDir": ".tuberosa/backups",
  "cache": "redis",
  "modelProvider": "hash"
}
```

This starts Postgres, Redis, the HTTP API, and the worker. The app container runs migrations before the HTTP server starts, and Postgres-backed service startup also runs the same idempotent migration preflight by default. The MCP stdio server does not need its own port; Codex starts it as a local child process, uses the same Postgres store, runs the migration preflight, and defaults to memory cache unless `TUBEROSA_CACHE` is explicitly set.

### 5.2 Add the MCP server to Codex

Add this to your Codex config, normally `~/.codex/config.toml`:

```toml
[mcp_servers.tuberosa]
command = "/usr/bin/zsh"
args = [
  "-lc",
  "cd /home/nash/tuberosa && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --import tsx src/mcp-stdio.ts"
]
```

The shell wrapper is the safest local option because it pins Node to the version from this machine, runs from the Tuberosa repo, and avoids package-manager output on stdout. If your Codex environment already has the correct Node and pnpm on `PATH`, this shorter form is also valid as long as pnpm is silent:

The MCP stdio entry point defaults `TUBEROSA_CACHE` to `memory`. That keeps the Codex initialize handshake independent of Redis availability; durable knowledge still uses the configured store.

```toml
[mcp_servers.tuberosa]
command = "pnpm"
args = ["--silent", "--dir", "/home/nash/tuberosa", "run", "mcp"]
```

Restart Codex after changing the config so it reloads the MCP server list.

### 5.3 Test from the next Codex session

In the next Codex session, ask:

```text
Use Tuberosa before starting. Call tuberosa_search_context for this task with project "tuberosa", cwd "/home/nash/tuberosa", and my prompt. Show the shortlist, contextFit, and references before using the context pack.
```

A healthy connection should expose these MCP tools:

- `tuberosa_search_context`
- `tuberosa_get_context_pack`
- `tuberosa_feedback_context`
- `tuberosa_reflect`
- `tuberosa_record_error_log`
- `tuberosa_list_error_logs`
- `tuberosa_collect_error_logs`
- `tuberosa_create_error_log_reflection_draft`
- `tuberosa_get_error_log`
- `tuberosa_update_error_log`
- `tuberosa_resolve_error_log`

Use this operating rule for agent work:

1. Call `tuberosa_search_context` before implementation or debugging.
2. If `contextFit.fitStatus` is `ready`, use the shortlist and fetch the full pack with `tuberosa_get_context_pack`.
3. If it is `needs_confirmation`, confirm the shortlist is relevant before using the full pack.
4. If it is `insufficient`, ask a clarifying question or continue with fresh context.
5. If the shortlist is wrong, call `tuberosa_feedback_context` with `rejected`, `stale`, `irrelevant`, or `missing_context`, then retry once.
6. After a durable correction or workflow lesson, call `tuberosa_reflect`; approve the draft later before it becomes searchable memory.

### 5.4 Seed knowledge for a useful smoke test

Tuberosa is useful only after it has knowledge to retrieve. Add one manual item:

```bash
curl -X POST http://localhost:3027/knowledge \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "tuberosa",
    "sourceType": "manual",
    "sourceUri": "docs/SETUP_AND_USAGE.md",
    "itemType": "workflow",
    "title": "Codex connects to Tuberosa through MCP",
    "summary": "Codex should start the Tuberosa MCP stdio server and search context before work.",
    "content": "For Codex, configure ~/.codex/config.toml with mcp_servers.tuberosa pointing at the Node-pinned MCP stdio command in /home/nash/tuberosa. Restart Codex, call tuberosa_search_context before implementation, and fetch the full pack only after the shortlist fits.",
    "trustLevel": 90,
    "labels": [
      { "type": "project", "value": "tuberosa", "weight": 1 },
      { "type": "technology", "value": "mcp", "weight": 1 },
      { "type": "tool", "value": "codex", "weight": 1 }
    ],
    "references": [
      { "type": "file", "uri": "docs/SETUP_AND_USAGE.md" }
    ]
  }'
```

Then verify retrieval through HTTP:

```bash
curl -X POST http://localhost:3027/context/search \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "tuberosa",
    "prompt": "How should Codex connect to Tuberosa through MCP?",
    "symbols": ["tuberosa_search_context"],
    "taskType": "workflow"
  }'
```

The response should include a context pack with `contextFit`, match reasons, and the setup guide reference.

## 6. Run With Docker

Use Docker for the full production-like local stack:

```bash
docker compose up --build -d
curl http://localhost:3027/health
```

Expected response:

```json
{
  "ok": true,
  "service": "tuberosa",
  "store": "postgres",
  "durability": "persistent",
  "backupDir": ".tuberosa/backups",
  "cache": "redis",
  "modelProvider": "hash"
}
```

The Compose stack runs:

- Postgres/pgvector bound to `127.0.0.1:5432`.
- Redis bound to `127.0.0.1:6379`.
- Tuberosa HTTP app bound to `127.0.0.1:3027`.
- Worker placeholder process.

Stop services:

```bash
docker compose down
```

Remove the database volume as well:

```bash
docker compose down -v
```

## 7. Run Without Docker

Use this when you already have Postgres and Redis running locally:

```bash
pnpm run migrate
pnpm run dev
```

Use memory-only mode for a no-service local smoke run:

```bash
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash pnpm run dev
```

Memory mode does not persist knowledge after the process exits.
It exists for tests, evals, and no-service smoke runs only. Use Postgres plus backups for real second-brain data.

## 8. Common Commands

```bash
pnpm run build
pnpm test
pnpm run test:integration
pnpm run eval:retrieval
pnpm run dev
pnpm start
pnpm run mcp
pnpm run worker
pnpm run migrate
pnpm run import:docs --project tuberosa docs/FLOW_LOGIC.md
pnpm run backup
pnpm run restore --backup <backup-id> --dry-run
pnpm run error-logs collect --project tuberosa --status open --brief
```

Command purpose:

- `build`: TypeScript compile check.
- `test`: unit and deterministic in-memory tests.
- `test:integration`: Docker-gated Postgres and Redis checks.
- `eval:retrieval`: retrieval quality regression suite.
- `eval:agent-context`: agent context compliance regression suite.
- `dev`: HTTP server in watch mode.
- `start`: built HTTP server.
- `mcp`: MCP stdio server for AI agent clients such as Codex.
- `worker`: worker placeholder.
- `migrate`: apply SQL migrations.
- `import:docs`: import local docs through the same ingestion path as the HTTP API.
- `backup`: create a portable JSONL backup in `TUBEROSA_BACKUP_DIR`.
- `backup --status`, `--list`, `--verify`, `--prune`: inspect, verify, and maintain the backup catalog.
- `restore`: dry-run or replace-restore from a backup id or path. Restore runs verification and preflight checks first.
- `error-logs`: collect, inspect, create reflection drafts from, and resolve filesystem-backed incident journals.

## 9. HTTP API Usage

All endpoints return JSON.

When `TUBEROSA_API_KEY` is set, include one of these headers on every endpoint except `/health`:

```bash
Authorization: Bearer <your-key>
x-tuberosa-api-key: <your-key>
```

Knowledge ingestion runs safety checks before embedding or storage:

- credential-like secrets are redacted;
- prompt-injection instructions are blocked;
- malware-like download/execute or destructive shell patterns are blocked;
- retrieval re-checks candidates so legacy unsafe knowledge is not returned to agents.
- search prompts and error strings are redacted before they are stored or embedded.

### Health

```bash
curl http://localhost:3027/health
```

The health response includes `durability`. `persistent` means Postgres is the active store. `ephemeral` means memory mode is active and stored knowledge disappears when the process exits.

### Add Knowledge

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

### Ingest Files

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

Use atomic mode for markdown/docs when you want a large document split into small, labeled knowledge records:

```bash
curl -X POST http://localhost:3027/ingest/files \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "mode": "atomic",
    "files": [
      {
        "path": "docs/paywall.md",
        "content": "# Paywall\n\nCore paywall notes.\n\n## Product id stability\n\nSelected product ids must remain stable while editors configure newsletter paywall options."
      }
    ]
  }'
```

Atomic markdown ingestion stores each useful heading section as its own knowledge item. Each atom keeps the original file reference, line range, section path metadata, inferred labels, and normal chunks/embeddings.

### List Knowledge

```bash
curl 'http://localhost:3027/knowledge?project=newsletter-app&q=paywall&limit=25'
```

Review filters expose operational queues:

```bash
curl 'http://localhost:3027/knowledge?project=newsletter-app&review=questionable'
curl 'http://localhost:3027/knowledge?project=newsletter-app&review=unsafe'
curl 'http://localhost:3027/knowledge?project=newsletter-app&review=stale'
curl 'http://localhost:3027/knowledge?project=newsletter-app&review=risky_auto_memory'
```

Supported `review` values are `questionable`, `unsafe`, `low_trust`, `stale`, `rejected`, `irrelevant`, `orphaned`, `auto_memory`, and `risky_auto_memory`. Use `auto_memory` to audit memories approved from agent-session learning, and `risky_auto_memory` to find auto memories with weak references, weak labels, negative feedback, unsafe metadata, low trust, or non-approved status.

### Inspect Or Update Knowledge

```bash
curl http://localhost:3027/knowledge/<knowledge-id>
```

```bash
curl -X PATCH http://localhost:3027/knowledge/<knowledge-id> \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "needs_review",
    "trustLevel": 35,
    "metadata": {
      "reviewer": "ops"
    }
  }'
```

Knowledge update is intended for review metadata, labels, references, trust, freshness, and status. Re-ingest through `/knowledge`, `/ingest/files`, `/operations/import-files`, or `pnpm run import:docs` when content itself changes so chunks and embeddings stay in sync.

### Review Knowledge Conflicts

Detect reviewable conflicts for approved knowledge that shares strong evidence but has opposing summary or freshness signals:

```bash
curl -X POST 'http://localhost:3027/operations/conflicts/detect?project=newsletter-app'
curl 'http://localhost:3027/operations/conflicts?project=newsletter-app&status=open'
```

Resolve or dismiss a conflict after review:

```bash
curl -X PATCH http://localhost:3027/operations/conflicts/<conflict-id> \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "resolved",
    "metadata": {
      "reviewer": "ops"
    }
  }'
```

Conflict records are review-only. They do not automatically create `supersedes` relations or searchable memory.

### List Labels

```bash
curl 'http://localhost:3027/labels?project=newsletter-app'
```

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

Important response fields:

- `id`: context pack id.
- `queryId`: stored query id.
- `confidence`: pack-level confidence.
- `contextFit`: fit status, fit score, fit reasons, and missing signals for deciding whether to use the pack.
- `classified`: extracted files, symbols, errors, technologies, business areas, and lexical query.
- `sections`: `essential`, `supporting`, and `optional` groups.
- `sections[].items[].matchReasons`: why a candidate matched.
- `sections[].items[].fitReasons`: why a candidate fits the classified task.
- `sections[].items[].references`: file, URL, commit, tool, conversation, or external references.

### Search Context With Debug Trace

Pass `debug: true` when you need to inspect retrieval behavior:

```bash
curl -X POST http://localhost:3027/context/search \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "prompt": "Update PaywallSelectionModal for the newsletter paywall flow",
    "symbols": ["PaywallSelectionModal"],
    "debug": true
  }'
```

The debug trace includes:

- Cache key and whether cache was bypassed.
- Search limits and token budget.
- Rejected knowledge ids and filter decisions.
- Timing per stage.
- Query rewrite input/output summary when `OPENAI_REWRITE_MODEL` is configured.
- Provider rerank input ids and scoring decisions when `OPENAI_RERANK_MODEL` is configured.
- Candidate lists for metadata, lexical, memory, vector, fusion, rerank, and fit.
- Raw, fused, rerank, final, and fit scores when available.
- Final selected candidates by context-pack section.

Debug traces are returned only for that response. They are not persisted in stored context packs and are not cached.

### Get A Context Pack

```bash
curl http://localhost:3027/context/packs/<context-pack-id>
```

List recent packs when investigating why context was returned:

```bash
curl 'http://localhost:3027/context/packs?project=newsletter-app&status=rejected'
```

### Record Feedback

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

Feedback types:

- `selected`
- `rejected`
- `irrelevant`
- `stale`
- `missing_context`

Rejected, irrelevant, and stale feedback trigger one retry with rejected knowledge excluded. They also create open learning proposals for review instead of directly changing labels, graph relations, or approval state.

Feedback also influences later retrieval. Selected context gets a modest ranking boost, while stale, rejected, and irrelevant context is penalized. `missing_context` creates a reviewable knowledge-gap record but does not penalize a specific knowledge item.

List feedback events for review:

```bash
curl 'http://localhost:3027/feedback-events?project=newsletter-app&status=stale'
```

Review feedback-created learning records:

```bash
curl 'http://localhost:3027/operations/learning-proposals?project=newsletter-app&status=open'
curl 'http://localhost:3027/operations/knowledge-gaps?project=newsletter-app&status=open'
```

Reviewers can mark either queue item `open`, `approved`, `dismissed`, or `needs_changes` with `PATCH /operations/learning-proposals/:id` or `PATCH /operations/knowledge-gaps/:id`.

Approving a learning proposal executes a concrete action based on `proposalType`:

- `supersedes` with both `candidateKnowledgeId` and `affectedKnowledgeId` → creates a `supersedes` knowledge relation from candidate to affected and marks the affected knowledge as `needs_review`.
- `supersedes` without `candidateKnowledgeId` → marks the affected knowledge as `needs_review` only (user creates the relation manually).
- `auto_memory_cleanup`, `missing_label`, `missing_reference`, or `missing_relation` → marks the affected knowledge as `needs_review`.

The action runs exactly once. The result is stored in `proposal.metadata.approvalAction` and subsequent approvals are skipped. Approving a knowledge gap records the review decision only; it does not automatically create knowledge or labels.

### Record Error Logs

Use error logs when an agent, command, MCP tool, or Tuberosa runtime path fails and the raw incident should be saved for later debugging. Error logs are filesystem-backed, not database knowledge, and are written under `TUBEROSA_ERROR_LOG_DIR`.

```bash
curl -X POST http://localhost:3027/operations/error-logs \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "category": "agent_tool",
    "severity": "error",
    "title": "Paywall test command failed",
    "summary": "The agent hit a repeatable test failure while editing paywall code.",
    "message": "pnpm test failed in test/paywall.test.ts.",
    "command": "pnpm test",
    "cwd": "/work/newsletter-app",
    "files": ["test/paywall.test.ts"],
    "symbols": ["PaywallSelectionModal"],
    "errors": ["ERR_ASSERTION"],
    "tags": ["tests"],
    "references": [
      { "type": "file", "uri": "test/paywall.test.ts" }
    ]
  }'
```

List and inspect incidents:

```bash
curl 'http://localhost:3027/operations/error-logs?project=newsletter-app&status=open&category=agent_tool'
curl http://localhost:3027/operations/error-logs/<error-log-id>
```

Collect compact incident context for agents:

```bash
curl 'http://localhost:3027/operations/error-logs/collection?project=newsletter-app&status=open&limit=50'
pnpm run error-logs collect --project newsletter-app --status open --limit 50 --brief
pnpm run error-logs list --project newsletter-app --status open --category agent_tool
pnpm run error-logs get <error-log-id> --markdown
```

After the fix is durable, create a reflection draft for the lesson and link it to the incident:

```bash
curl -X POST http://localhost:3027/operations/error-logs/reflection-drafts \
  -H 'Content-Type: application/json' \
  -d '{
    "errorLogIds": ["<error-log-id>"]
  }'

pnpm run error-logs draft <error-log-id>

curl -X PATCH http://localhost:3027/operations/error-logs/<error-log-id> \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "fixed",
    "reflectionDraftId": "<reflection-draft-id>",
    "notes": "Fixed by updating the paywall test fixture."
  }'
```

Record a structured resolution after an agent fixes the incident:

```bash
curl -X POST http://localhost:3027/operations/error-logs/<error-log-id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{
    "rootCause": "The test fixture expected the old paywall response shape.",
    "resolutionSummary": "Updated the fixture and verified the paywall tests.",
    "changedFiles": ["test/paywall.test.ts"],
    "verificationCommands": ["pnpm test"],
    "reflectionDraftId": "<reflection-draft-id>"
  }'

pnpm run error-logs resolve <error-log-id> \
  --root-cause "The test fixture expected the old paywall response shape." \
  --summary "Updated the fixture and verified the paywall tests." \
  --changed-file test/paywall.test.ts \
  --verification-command "pnpm test" \
  --reflection-draft-id <reflection-draft-id>
```

Automatic capture records unexpected Tuberosa HTTP and MCP failures when `TUBEROSA_ERROR_LOG_AUTO_CAPTURE=true`. It stores safe request context only, not full HTTP bodies or full MCP arguments. Normal validation and not-found errors are skipped unless `TUBEROSA_ERROR_LOG_CAPTURE_CLIENT_ERRORS=true`.

### Start An Agent Session

Use sessions when an agent should leave an audit trail for context selection, task outcome, and automatic learning. Users can phrase the task normally; the agent should enrich the request with project, cwd, files, symbols, errors, and task type when those signals are available.

```bash
curl -X POST http://localhost:3027/agent-sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "cwd": "/work/newsletter-app",
    "prompt": "Update PaywallSelectionModal for the newsletter paywall flow",
    "symbols": ["PaywallSelectionModal"],
    "agentName": "Codex",
    "agentTool": "mcp"
  }'
```

The response includes an active session, the initial context pack, and a policy action:

- `proceed`: context fit is ready.
- `confirm`: review the shortlist before relying on it.
- `clarify`: ask for clarification or continue with fresh context.

### Record A Session Context Decision

```bash
curl -X POST http://localhost:3027/agent-sessions/<session-id>/context-decision \
  -H 'Content-Type: application/json' \
  -d '{
    "contextPackId": "<context-pack-id>",
    "feedbackType": "selected",
    "reason": "This context matches the current paywall flow."
  }'
```

Use `rejected`, `irrelevant`, or `stale` to trigger the existing retry behavior with rejected knowledge excluded.

List sessions and context decisions:

```bash
curl 'http://localhost:3027/agent-sessions?project=newsletter-app'
curl 'http://localhost:3027/agent-sessions/<session-id>'
curl 'http://localhost:3027/agent-sessions/<session-id>/context-decisions'
```

### Finish An Agent Session

By default, session finish uses `learningMode: "auto"`. Tuberosa creates a learning candidate from the session prompt, selected context, decisions, summary, labels, references, and provenance. It auto-approves the memory only when strict safety, duplicate, evidence, usefulness, and context-compliance gates pass. Weak candidates are left reviewable instead of becoming trusted memory.

```bash
curl -X POST http://localhost:3027/agent-sessions/<session-id>/finish \
  -H 'Content-Type: application/json' \
  -d '{
    "outcome": "completed",
    "summary": "Updated the paywall selection flow while preserving selected products."
  }'
```

Use `learningMode: "draft_only"` when an agent should draft but never auto-approve, or `learningMode: "off"` when the session should not create learning.

You can still provide an explicit reflection draft. In that case Tuberosa uses the supplied draft and skips automatic extraction:

```bash
curl -X POST http://localhost:3027/agent-sessions/<session-id>/finish \
  -H 'Content-Type: application/json' \
  -d '{
    "outcome": "completed",
    "summary": "Updated the paywall selection flow.",
    "learningMode": "off",
    "reflectionDraft": {
      "title": "Keep paywall selection stable",
      "summary": "Paywall session work should preserve selected products.",
      "content": "When changing PaywallSelectionModal, record the selected context and draft any durable lesson before finishing the agent session.",
      "triggerType": "complex_task_success",
      "references": [
        { "type": "file", "uri": "src/components/paywall-selection-modal.tsx" }
      ],
      "metadata": {
        "taxonomy": "workflow"
      }
    }
  }'
```

The finish response includes `learningDecision`, and may include `learningCandidate` or `autoApprovedMemory`. Explicit and weak auto-created drafts remain reviewable until approved.

### Create A Reflection Draft

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
    ],
    "references": [
      { "type": "file", "uri": "src/components/paywall-selection-modal.tsx" }
    ],
    "metadata": {
      "taxonomy": "incident_lesson",
      "contextPackId": "<context-pack-id>"
    }
  }'
```

### Approve A Reflection Draft

```bash
curl -X POST http://localhost:3027/reflection-drafts/<draft-id>/approve
```

Approval writes the draft into knowledge as searchable memory. Approved memories preserve `metadata.taxonomy`, trigger/provenance metadata, and references from the draft.

List, inspect, or reject pending drafts:

```bash
curl 'http://localhost:3027/reflection-drafts?project=newsletter-app&status=pending'
curl http://localhost:3027/reflection-drafts/<draft-id>
curl -X PATCH http://localhost:3027/reflection-drafts/<draft-id> \
  -H 'Content-Type: application/json' \
  -d '{ "status": "rejected", "metadata": { "reason": "superseded" } }'
```

### Operations Import And Cleanup

Use `/operations/import-files` for API-driven doc refreshes. It uses the same atomic ingestion and stale-atom cleanup as `/ingest/files`.

```bash
curl -X POST http://localhost:3027/operations/import-files \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "newsletter-app",
    "mode": "atomic",
    "files": [
      {
        "path": "docs/paywall.md",
        "content": "# Paywall\n\n## Selection\n\nKeep selected product ids stable."
      }
    ]
  }'
```

Use the CLI for local files:

```bash
pnpm run import:docs --project newsletter-app docs/paywall.md docs/runbook.md
```

Cleanup supports dry runs before deleting old proposed context packs, orphaned feedback rows, old unused queries, and unused sources:

```bash
curl -X POST http://localhost:3027/operations/cleanup \
  -H 'Content-Type: application/json' \
  -d '{ "olderThanDays": 30, "dryRun": true }'
```

### Operations Backups

Create a portable JSONL backup:

```bash
curl -X POST http://localhost:3027/operations/backups \
  -H 'Content-Type: application/json' \
  -d '{ "id": "before-paywall-refactor" }'
```

List existing backups:

```bash
curl http://localhost:3027/operations/backups
```

Check catalog and scheduler health:

```bash
curl http://localhost:3027/operations/backups/status
```

Verify a backup before restore:

```bash
curl -X POST http://localhost:3027/operations/backups/before-paywall-refactor/verify
```

Restore supports a dry run first:

```bash
curl -X POST http://localhost:3027/operations/backups/before-paywall-refactor/restore \
  -H 'Content-Type: application/json' \
  -d '{ "dryRun": true }'
```

Actual restore is intentionally destructive and requires `replace: true`:

```bash
curl -X POST http://localhost:3027/operations/backups/before-paywall-refactor/restore \
  -H 'Content-Type: application/json' \
  -d '{ "replace": true }'
```

CLI equivalents:

```bash
pnpm run backup --id before-paywall-refactor
pnpm run backup --status
pnpm run backup --list
pnpm run backup --verify before-paywall-refactor
pnpm run backup --prune --dry-run --keep-count 24 --max-age-days 30
pnpm run restore --backup before-paywall-refactor --dry-run
pnpm run restore --backup before-paywall-refactor --replace
```

Backups include project records, sources, knowledge items, labels, references, chunks and embeddings, reflection drafts, context queries, packs, feedback events, agent sessions, and agent context decisions. Restoring chunks is necessary because chunks are what retrieval searches and feeds to agents.

The physical mirror under `.tuberosa/current` is different from timestamped backups. It is overwritten from the live store after important knowledge, reflection, relation, import, and session-finish changes, and includes readable Markdown summaries beside JSONL exports. Automatic mirror requests are debounced so rapid mutation bursts coalesce into one latest-state write; manual syncs still run immediately. Use it for human inspection; restore from timestamped backups.

Each new backup manifest records table row counts, per-table SHA-256 checksums, source store, schema version, app version or commit when available, model provider, and embedding dimensions. Older backups without checksum metadata still list and can restore if table coverage and row counts pass, but verification reports degraded health.

### Recovery Runbooks

Dry-run restore:

```bash
pnpm run backup --verify <backup-id>
pnpm run restore --backup <backup-id> --dry-run
```

Replace restore:

```bash
pnpm run backup --id before-restore
pnpm run restore --backup <backup-id> --dry-run
pnpm run restore --backup <backup-id> --replace
pnpm run eval:retrieval
```

Fresh-machine restore:

```bash
corepack enable
pnpm install
test -f .env || cp .env.example .env
docker compose up --build -d
pnpm run migrate
TUBEROSA_BACKUP_DIR=/path/to/backups pnpm run backup --verify <backup-id>
TUBEROSA_BACKUP_DIR=/path/to/backups pnpm run restore --backup <backup-id> --replace
```

Embedding dimension mismatch:

- Restore preflight fails when the backup manifest embedding dimensions do not match `EMBEDDING_DIMENSIONS`.
- Start the app with the same `EMBEDDING_DIMENSIONS` and provider metadata used by the backup, or re-ingest knowledge after changing embedding dimensions so chunks are rebuilt consistently.
- Do not edit the manifest to bypass this check; mismatched vectors make retrieval unreliable.

## 10. MCP Usage

Run the MCP stdio server:

```bash
pnpm run mcp
```

Tools:

- `tuberosa_search_context`
- `tuberosa_get_context_pack`
- `tuberosa_start_session`
- `tuberosa_record_context_decision`
- `tuberosa_finish_session`
- `tuberosa_reflect`
- `tuberosa_feedback_context`
- `tuberosa_record_error_log`
- `tuberosa_list_error_logs`
- `tuberosa_collect_error_logs`
- `tuberosa_create_error_log_reflection_draft`
- `tuberosa_get_error_log`
- `tuberosa_update_error_log`
- `tuberosa_resolve_error_log`

Resource templates:

- `tuberosa://packs/{id}`
- `tuberosa://knowledge/{id}`
- `tuberosa://error-logs/{id}`
- `tuberosa://error-logs/{id}/markdown`

Prompts:

- `tuberosa_bootstrap_session`
- `tuberosa_reflect_after_task`
- `tuberosa_capture_error_for_later`
- `tuberosa_review_error_logs`
- `tuberosa_fix_error_log`
- `tuberosa_review_pending_reflections`

Recommended agent flow:

1. Prefer `tuberosa_start_session` before implementation or debugging.
2. Pass the user's normal prompt as-is, then add inferred project, cwd, files, symbols, errors, task type, `contextMode: "layered"`, and `includeDeepContext: true` when known.
3. If `deepContextReturned` is true, use the returned expanded context before working; otherwise inspect the shortlist and fetch the full pack only after confirming it is appropriate.
4. Follow the returned policy: proceed, confirm, or clarify.
5. Record the selected, rejected, stale, irrelevant, or missing context with `tuberosa_record_context_decision`.
6. If a retry pack is returned, review its context fit before using it.
7. Finish with `tuberosa_finish_session`; by default automatic learning extracts the durable lesson from the session summary and only auto-approves when strict gates pass. If context was intentionally skipped, include `contextBypassReason`.
8. When an error should be fixed later, call `tuberosa_record_error_log` with sanitized message, stack, command, files, symbols, errors, and references.
9. Use direct tools (`tuberosa_search_context`, `tuberosa_feedback_context`, `tuberosa_reflect`, and `tuberosa_record_error_log`) for manual or one-off workflows.
10. Review `learningCandidate` drafts that were marked `needs_changes`, clean up bad memories with knowledge review operations, and link fixed incidents with `tuberosa_update_error_log`.

Use `debug: true` in `tuberosa_search_context` only when diagnosing retrieval quality.

## 11. Agent Configuration

### Codex

```toml
[mcp_servers.tuberosa]
command = "pnpm"
args = ["--silent", "--dir", "/home/nash/tuberosa", "run", "mcp"]
```

Node-pinned wrapper:

```toml
[mcp_servers.tuberosa]
command = "/usr/bin/zsh"
args = [
  "-lc",
  "cd /home/nash/tuberosa && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH node --import tsx src/mcp-stdio.ts"
]
```

### Claude Code

```bash
claude mcp add --transport stdio --scope project tuberosa -- pnpm --silent --dir /home/nash/tuberosa run mcp
```

### GitHub Copilot

Workspace MCP config:

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

For cloud agents, the server and database must exist in the cloud agent environment.

## 12. QA Checklist

Run these checks before handoff after code changes:

```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
pnpm run test:integration
git diff --check
```

For end-to-end HTTP smoke testing with Docker:

```bash
docker compose up --build -d
curl -fsS http://localhost:3027/health
```

Then run:

1. `POST /knowledge` with a known symbol and file reference.
2. `POST /context/search` for that symbol.
3. `POST /context/search` again with `debug: true`.
4. `POST /context/feedback` with `feedbackType: "selected"`.
5. `POST /agent-sessions`.
6. `POST /agent-sessions/:id/context-decision`.
7. `POST /agent-sessions/:id/finish`.
8. `POST /reflection-drafts`.
9. `POST /reflection-drafts/:id/approve`.
10. `POST /context/search` for the reflection memory.

Expected QA outcome:

- Build succeeds.
- Unit tests pass.
- Retrieval eval passes expected metrics.
- Integration tests pass when Docker services are reachable, or skip cleanly when they are not.
- Health endpoint returns `ok: true`.
- Search returns a context pack with references and match reasons.
- Search returns context fit metadata for ready, confirmation-needed, or insufficient context, including graph-connected signals when related knowledge is selected.
- Debug search returns stages and selected candidates.
- Feedback updates context pack status or returns a retry.
- Agent sessions store initial context, decisions, final outcome, and optional reflection draft ids.
- Approved reflection becomes searchable memory.

## 13. Troubleshooting

### pnpm or `node:sqlite` fails under Node 20

Use Node 22:

```bash
nvm use
corepack enable
pnpm install
```

### Docker app exits during migration

```bash
docker compose logs --no-color app worker
docker compose up --build -d
```

### MCP reports missing Postgres relations

Errors such as `relation "agent_sessions" does not exist` or `relation "knowledge_relations" does not exist` mean the local Postgres schema is stale. Keep `TUBEROSA_AUTO_MIGRATE=true` for MCP stdio and other local service entry points, or run:

```bash
pnpm run migrate
```

### `curl localhost:3027` fails in a sandbox

Local networking may require explicit approval in sandboxed environments. Run the server and smoke tests from an environment allowed to bind and access local ports.

### Local Postgres returns `connect EPERM`

In sandboxed agent environments, `connect EPERM 127.0.0.1:5432` is usually a sandbox permission failure, not a Tuberosa schema or storage bug. Re-run the specific Postgres-backed command with the environment's local-network escalation/approval path.

### OpenAI embeddings fail

Check:

- `TUBEROSA_MODEL_PROVIDER=openai`
- `OPENAI_API_KEY` is set.
- `OPENAI_EMBEDDING_MODEL` supports `EMBEDDING_DIMENSIONS`.
- Postgres `knowledge_chunks.embedding vector(...)` matches the configured embedding length.

### OpenAI query rewriting fails

Query rewriting is optional. Unset `OPENAI_REWRITE_MODEL` to disable it, or check that the configured model supports the Responses API and JSON schema output.

### OpenAI reranking fails

Reranking is optional. Unset `OPENAI_RERANK_MODEL` to fall back to deterministic hash reranking, or check that the configured model supports the Responses API and JSON schema output.

### MCP client does not see tools

Verify with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector pnpm --silent --dir /home/nash/tuberosa run mcp
```

Then check absolute paths, Node version, pnpm availability, and that the MCP process does not print non-JSON logs to stdout.
