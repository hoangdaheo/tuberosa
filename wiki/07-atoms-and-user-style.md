# 07 — Atoms and User-Style

Two layers that sit alongside knowledge items:

- **Atoms** — fine-grained claims with evidence, triggers, verification, and a typed graph.
- **User-style atoms** — atoms scoped to a single human across all their projects.

## Why atoms?

Knowledge items are document-shaped. They're great for runbooks and code references but too coarse for individual claims like "MCP stdout is JSON-RPC only" or "Worker has its own DB pool". Atoms capture one claim each, with structured evidence and triggers — so the retrieval pipeline can match them on exact files/symbols/errors instead of full-text alone.

## Atom shape

```jsonc
{
  "id": "<uuid>",
  "project": "tuberosa",
  "parentKnowledgeId": "<optional knowledge item id>",

  "claim": "MCP stdout is reserved for JSON-RPC; diagnostics go to stderr",
  "type":  "convention",            // fact | procedure | decision | gotcha | convention

  "evidence": [
    { "kind": "file",    "path": "src/mcp-stdio.ts" },
    { "kind": "commit",  "sha":  "abc1234", "message": "MCP stdout guard" }
  ],
  "trigger": {
    "files":   ["src/mcp/**"],
    "symbols": ["console.log"],
    "errors":  [],
    "taskTypes": ["debugging", "implementation"],
    "intentTags": []
  },
  "verification": {
    "command":  "node --test --import tsx test/mcp-stdio.test.ts",
    "testRef":  { "path": "test/mcp-stdio.test.ts", "testName": "no stdout pollution" }
  },
  "pitfalls": ["A stray console.log breaks every MCP client."],

  "tier":   "verified",             // draft | verified | canonical
  "status": "active",               // active | legacy_archived | superseded | archived
  "scope":  "project",              // project | user

  "reuseCount": 7,
  "lastReusedAt": "2026-05-20T10:00:00Z",

  "links": [
    { "toAtomId": "<id>", "kind": "refines",    "confidence": 0.8 },
    { "toAtomId": "<id>", "kind": "supersedes", "confidence": 1.0 }
  ],

  "audit": {
    "producedBy":           "agent_session",    // agent_session | user | migration_llm
    "producedAtSessionId":  "<session-id>",
    "createdAt": "2026-04-12T08:11:00Z",
    "updatedAt": "2026-05-20T10:00:00Z"
  }
}
```

Types (`src/types/atoms.ts`):

```ts
type AtomType   = 'fact' | 'procedure' | 'decision' | 'gotcha' | 'convention';
type AtomTier   = 'draft' | 'verified' | 'canonical';
type AtomStatus = 'active' | 'legacy_archived' | 'superseded' | 'archived';
type AtomScope  = 'project' | 'user';
type AtomLinkKind = 'supersedes' | 'refines' | 'depends_on' | 'co_changes_with' | 'related_to';
```

## Tier lifecycle

```
   created
      │
      ▼
   ┌─────────┐   critic pass    ┌──────────┐   human/heuristic   ┌──────────┐
   │  draft  │ ───────────────▶ │ verified │ ──────────────────▶ │ canonical│
   └─────────┘                   └──────────┘                      └──────────┘
```

- `draft` — created by an agent (or user); not yet ranked highly in retrieval.
- `verified` — passed the critic gate (claim has evidence, trigger is non-empty, dedup OK).
- `canonical` — promoted by a human reviewer OR auto-promoted after sustained `reuseCount` with no negative feedback.

## Status lifecycle

Independent of tier:

- `active` — surfaces in retrieval.
- `superseded` — another atom replaces it (`supersedes` link); not returned unless explicitly asked.
- `legacy_archived` — archived during migration from knowledge items.
- `archived` — explicitly archived; resurrect with `tuberosa_resurrect_atom` / `POST /atoms/{id}/resurrect`.

## How atoms surface in retrieval

The retrieval pipeline ([04-retrieval-pipeline.md](04-retrieval-pipeline.md)) treats atoms as a parallel source:

- `searchAtomsByTrigger` — exact match on classified `files` / `symbols` / `errors` / `taskTypes`.
- `searchAtomsByEmbedding` — cosine similarity on the atom's canonical text.
- Graph expansion follows `links` to pull adjacent atoms.

Atom hits are fused alongside knowledge candidates. The pack lists each atom in `matchReasons` (`atom:trigger:src/foo.ts`, `atom:link:refines:<id>`, …).

## Atom critic

`src/atoms/critic.ts` runs on every draft:

| Check | Pass requirement |
|---|---|
| Claim non-trivial | More than N tokens, not boilerplate |
| Evidence present | At least one `evidence[]` entry |
| Trigger non-empty | At least one of files/symbols/errors/taskTypes |
| Dedup | No active atom with cosine ≥ critic threshold AND matching trigger |
| Safety | Passes `safe.decideSafety` (redaction + injection check) |
| Triviality rules | Not a paraphrase of a `triviality-rules.ts` entry |

A failed critic returns a `WriteRejection` with reasons; the draft is not stored.

LLM critic (optional): `src/atoms/llm-critic.ts` adds a model-side check for claim quality. Off by default; toggle in `config/retrieval-policy.json`.

## Archival

`src/atoms/archival.ts` runs as a maintenance pass:

- Atoms with `reuseCount` 0 and `createdAt` older than the decay window → `archived`.
- Atoms whose evidence file no longer exists → marked `legacy_archived` after a grace period.
- Superseded atoms are auto-archived if their successor has sustained reuse.

Counters and rates live behind `tuberosa_atom_gate_stats` / `GET /operations/atom-gate/stats`.

## Atom graph

Edges between atoms form a directed graph. The HTTP route `GET /operations/organization/atom-graph.jsonl` exports it as JSONL (one row per edge), and `tuberosa_atom_graph_density` / `GET /operations/atom-graph/density` returns size/density metrics.

Impact analysis: `tuberosa_predict_impact` / `POST /operations/atom-graph/impact` takes a target (file or symbol set) and returns the atoms within N hops, ranked by how likely they are to break:

```bash
curl -sX POST http://localhost:3027/operations/atom-graph/impact -d '{
  "project": "tuberosa",
  "files":   ["src/retrieval/fusion.ts"],
  "symbols": ["fuseCandidates"],
  "depth":   2
}'
```

Use before refactors — pairs well with `gitnexus_impact` for symbol-level coverage.

## User-style atoms

A subset of atoms with `scope: "user"` that follow a person across projects. Conflict resolution against project conventions is driven by `priority`:

| `priority`              | What it does |
|-------------------------|--------------|
| `personal_workflow`     | Overrides project conventions when they conflict (e.g. "I always use `pnpm`"). |
| `coding_preference`     | Yields to project conventions when they conflict. |

### Create one

**HTTP:**
```bash
curl -sX POST http://localhost:3027/user-style-atoms -d '{
  "userId":  "nguyen",
  "claim":   "I prefer pnpm over npm for all Node projects",
  "type":    "convention",
  "priority":"personal_workflow",
  "trigger": { "files": ["package.json"], "taskTypes": ["implementation"] },
  "evidence":[{ "kind": "url", "uri": "https://pnpm.io", "fetchedAt": "2026-04-01T00:00:00Z" }]
}'
```

**MCP:** `tuberosa_record_user_style` with the same body shape.

### Where they live

- Stored in the same `knowledge_atoms` table with `scope='user'` and `user_id` set.
- Persisted on disk in the physical mirror under `.tuberosa/current/user-style/<userId>/`.
- Round-tripped via export bundles in `user-style/<userId>/*.md`.

### Cross-project bleed

User-style atoms **intentionally bypass** the project namespace filter (`src/retrieval/service.ts`). That's correct for personal workflows but is documented as a privacy exception. If you use "project" as a hard tenant boundary, set `retrievalPolicy.crossProjectUserStyle` (see [12-security-model.md](12-security-model.md#cross-project-user-style)).

### Conflict resolution

When a user-style atom conflicts with a project convention, `src/user-style/conflict-resolver.ts` decides:

- `personal_workflow` user-style → wins, project convention is annotated as overridden.
- `coding_preference` user-style → loses, project convention surfaces first.

Conflicts are surfaced in the workbench review queue.

### finish-session router

`src/user-style/finish-session-router.ts` runs on every `tuberosa_finish_session`. If the agent recorded a `user_preference` learning signal, the router decides whether to draft a user-style atom in addition to the regular reflection draft.

## Eval & telemetry

- `pnpm test` covers atom critic, tier transitions, archival, graph density, user-style conflict resolution.
- `tuberosa_atom_gate_stats` reports per-tier counts, accept/reject rates, and recent rejection reasons.
- `tuberosa_atom_graph_density` reports edge counts, average degree, and orphan atoms.

## Read next

- [03-knowledge-model.md](03-knowledge-model.md) — items vs atoms.
- [04-retrieval-pipeline.md](04-retrieval-pipeline.md) — where atoms join the candidate stream.
- [08-export-import-bundle.md](08-export-import-bundle.md) — atoms in `.tuberosa-pack` bundles.
- [12-security-model.md](12-security-model.md#cross-project-user-style) — user-style privacy implications.
