# Tuberosa Team Knowledge OS Implementation Plan

Generated: 2026-05-22

## Summary

Tuberosa should evolve into a local-first agent context supply chain for teams:
approved sources enter the knowledge base, review and maintenance queues improve
them, context packs distribute the right slice to agents, and Git exports let
teams share durable knowledge without sharing private runtime state.

Locked strategy choices:

- Optimize for a Team Knowledge OS.
- Share reviewed knowledge only.
- Keep Postgres as the runtime source of truth.
- Ship a Team Knowledge Pack as the first vertical slice.
- Use human-readable Markdown plus deterministic manifests for Git review.

Current repo strengths:

- MCP and HTTP surfaces for agent integration.
- Normalized knowledge items with labels, references, relations, trust, and freshness.
- Hybrid retrieval with metadata, lexical, vector, memory, graph, and worktree sources.
- Context fit, orientation, task brief, and deep context.
- Agent-session compliance, feedback, reviewable reflections, learning proposals, gaps, conflicts, maintenance, backups, and physical mirror.

Main product gap:

- Team-shareable knowledge conventions and a safe Git exchange format are not first-class.
- Runtime state and durable team knowledge need a clearer boundary.

## Product Analysis

### Goal

The practical goal is not only "make AI smarter." It is to reliably feed the
correct project knowledge to an agent at the right moment, then convert useful
conversation outcomes into reviewed, durable, reusable knowledge.

Tuberosa should make this loop explicit:

1. Capture project knowledge and reviewed lessons.
2. Normalize each item with labels, references, trust, freshness, and ownership.
3. Retrieve a compact context pack for a concrete agent task.
4. Record whether the context helped, was noisy, stale, missing, or wrong.
5. Generate reviewable gaps, proposals, conflicts, or reflections.
6. Promote only reviewed, grounded knowledge into shared memory.
7. Export approved team knowledge to Git for team review and local re-import.

### Pros

- Local-first and private by default.
- Agents receive selected task context instead of a generic memory dump.
- Review gates reduce bad-memory amplification.
- Feedback, stale markers, and supersedes relations make knowledge maintainable.
- Git-reviewed packs can make team knowledge portable without central SaaS.
- Database authority avoids a risky bidirectional sync engine.

### Cons

- Requires review discipline and clear ownership.
- Retrieval quality depends on label/reference quality.
- Local setup needs Postgres, Redis, and migrations for full behavior.
- Git merge behavior for knowledge files needs deterministic IDs and ordering.
- Export/import must avoid leaking private session data.

### Downsides To Manage

- Stale shared knowledge can harm every team member's agents.
- Review queues can become backlog if not assigned.
- Auto-approved memories can create low-quality noise if gates are too permissive.
- Provider-specific embeddings should not be treated as portable Git artifacts.
- Markdown files are easier to review but less precise than database tables.

## First Shippable Slice: Team Knowledge Pack

### Directory Shape

Create a Git-reviewed export format under:

```text
tuberosa-knowledge/
  manifest.json
  CONVENTIONS.md
  projects/
    <project>/
      owners.json
      knowledge/
        spec/
        workflow/
        rule/
        code_ref/
        wiki/
        memory/
        bugfix/
      relations.jsonl
```

Recommended `.gitignore` policy:

- Keep `.tuberosa/backups/`, `.tuberosa/current/`, `.tuberosa/error-logs/`, sessions, packs, feedback, and raw drafts uncommitted.
- Commit only curated `tuberosa-knowledge/` packs after review.

### Export Rules

Export only:

- Approved `spec`, `workflow`, `rule`, `code_ref`, and `wiki` items.
- Approved reviewed `memory` and `bugfix` items when they have grounded references.
- Non-inferred or high-confidence reviewed relations between exported items.

Do not export:

- Agent sessions.
- Context packs.
- Context queries.
- Feedback events.
- Raw reflection drafts.
- Error logs.
- Backups.
- Embeddings and chunks.
- Secrets, raw private conversation, or unreviewed prompt-injection content.

### Markdown Frontmatter

Each knowledge file should use Markdown with YAML frontmatter:

```yaml
schemaVersion: 1
stableId: "sha256:<project>:<sourceUri>"
project: "tuberosa"
sourceUri: "docs/SETUP_AND_USAGE.md"
itemType: "workflow"
title: "Codex connects to Tuberosa through MCP"
summary: "Codex should start the Tuberosa MCP stdio server and search context before work."
trustLevel: 90
freshnessAt: "2026-05-22T00:00:00.000Z"
owner: "platform"
reviewedAt: "2026-05-22T00:00:00.000Z"
labels:
  - type: "project"
    value: "tuberosa"
    weight: 1
references:
  - type: "file"
    uri: "docs/SETUP_AND_USAGE.md"
checksum: "sha256:<content-checksum>"
```

The body contains the approved knowledge content.

### Manifest

`manifest.json` should include:

- `schemaVersion`
- `generatedAt`
- `project`
- `exportedBy`
- `sourceStore`
- `itemCount`
- `relationCount`
- `files`
- `checksums`
- `excludedTables`
- `policy`

The manifest must be deterministic except for `generatedAt`; verification should
support a stable mode that ignores timestamp fields.

### Import Rules

Import flow:

1. Parse manifest and all Markdown frontmatter.
2. Validate schema, item types, label axes, references, owners, and checksums.
3. Run safety scan before ingestion.
4. Dry-run by default and report create/update/skip/conflict counts.
5. Apply only with an explicit flag.
6. Upsert by `metadata.teamPack.stableId` first, then `sourceUri`.
7. Rebuild chunks and embeddings locally through existing ingestion.
8. Recreate exported relations only after all items are known locally.

Conflict policy:

- Same stable ID and same checksum: skip.
- Same stable ID and different checksum: update and preserve local ID.
- Same source URI but different stable ID: report conflict in dry-run; require apply with conflict strategy later.
- Missing grounded reference: reject import unless explicitly marked as local-only.

## CLI And API

### CLI First

Add a CLI script:

```bash
pnpm run team-pack -- export --project tuberosa --out tuberosa-knowledge
pnpm run team-pack -- verify --path tuberosa-knowledge
pnpm run team-pack -- import --path tuberosa-knowledge --dry-run
pnpm run team-pack -- import --path tuberosa-knowledge --apply
```

Implementation should be CLI-first to keep the first slice small and easy to
test. HTTP/workbench polish can follow once the pack contract is stable.

### Later HTTP Surface

Optional future endpoints:

- `GET /operations/team-pack/export`
- `POST /operations/team-pack/verify`
- `POST /operations/team-pack/import`

These should reuse the same service code as the CLI.

## Team Standards And Terms

Use these terms consistently in docs, code, workbench, and MCP prompts:

- Context broker: the service that chooses task-relevant project knowledge.
- Knowledge item: one approved durable unit.
- Team Knowledge Pack: Git-reviewed export of approved team knowledge.
- Private runtime state: sessions, packs, feedback, logs, unreviewed drafts.
- Reviewed memory: reflection approved by a human or strict learning gate.
- Context decision: selected, rejected, stale, noisy, or missing signal.
- Knowledge gap: missing context that should be reviewed or ingested.
- Learning proposal: reviewable cleanup or improvement suggestion.
- Supersedes relation: a relation showing one item replaces another.

Canonical label axes:

- `project`
- `repo`
- `domain`
- `business_area`
- `task_type`
- `technology`
- `workflow_stage`
- `severity`
- `file`
- `symbol`
- `error`
- `user_preference`

Team review rule:

- Every shared item needs a grounded reference, owner, freshness policy, trust level, and review note.

## Implementation Plan

### 1. Add Team Pack Domain Types

Add types for:

- Team pack manifest.
- Team pack item frontmatter.
- Export options.
- Verify report.
- Import dry-run report.
- Import apply report.

Keep these types separate from backup types because backups are database recovery
artifacts, while team packs are reviewed knowledge exchange artifacts.

### 2. Add Team Pack Service

Create a service that:

- Lists approved exportable knowledge.
- Serializes Markdown files deterministically.
- Writes `manifest.json`, `CONVENTIONS.md`, project owners, and relations.
- Verifies pack shape and checksums.
- Imports pack items through existing ingestion.
- Recreates relations after item import.

Reuse existing `KnowledgeStore`, `OperationsService`, `IngestionService`, and
`KnowledgeSafetyService` boundaries instead of adding a parallel storage path.

### 3. Add CLI Script

Add:

- `scripts/team-pack.ts`
- `src/operations/team-pack-cli.ts`
- `src/operations/team-pack-service.ts`
- package script: `team-pack`

Argument parsing can follow existing operation CLI patterns.

### 4. Add Tests

Add tests for:

- Export includes only approved shareable item types.
- Export excludes sessions, packs, feedback, drafts, logs, chunks, and embeddings.
- Markdown files are deterministic.
- Manifest checksums detect tampering.
- Verify catches invalid labels, missing references, and unknown item types.
- Dry-run reports create/update/skip/conflict.
- Apply import recreates retrievable knowledge.
- Relations survive round trip when both sides are exported.

### 5. Add Docs

Add or update docs with:

- Team Knowledge Pack purpose.
- What is safe to commit.
- Review checklist for knowledge PRs.
- Import/export commands.
- Privacy warnings.
- Convention examples.

## Test Plan

Run after implementation:

```bash
pnpm run build
pnpm test
pnpm run eval:retrieval
git diff --check
```

For storage or import/export behavior that touches Postgres:

```bash
pnpm run test:integration
```

## Research Basis

- MCP server primitives and tool safety: https://modelcontextprotocol.io/specification/2025-06-18/server/index
- MCP tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- LangGraph long-term memory and namespaces: https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- Letta memory blocks and archival memory: https://docs.letta.com/guides/core-concepts/memory/memory-blocks
- Mem0 open-source memory: https://docs.mem0.ai/open-source/overview
- Graphiti temporal knowledge graph: https://github.com/getzep/graphiti
- AIDE Memory local-first agent memory: https://www.aide-memory.dev/
- Lithos Git-versioned AI memory: https://getlithos.dev/
- Engram local-first knowledge base: https://engram-kb.org/
- AGENTS.md context-file effectiveness warning: https://arxiv.org/abs/2602.11988

## Assumptions

- Large-team sharing should optimize privacy and reviewability before full runtime replication.
- Git is the reviewed exchange layer, not the runtime authority.
- First implementation is CLI-first and local-only.
- Workbench and HTTP improvements follow after the pack contract is stable.
