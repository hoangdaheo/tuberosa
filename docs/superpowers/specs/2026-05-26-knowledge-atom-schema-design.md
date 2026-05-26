# Knowledge Atom Schema — Design (Concern B)

**Status:** Draft for review
**Date:** 2026-05-26
**Concern:** B in the six-concern decomposition (B → D → A → C → E → F)
**Author:** Brainstorming session with user
**Companion specs (planned):**
- D: write-gate, dedup, decay
- A: long-prompt preprocessing
- C: graph relations and impact propagation
- E: project export bundle
- F: user-style preference layer

---

## 1. Problem

Tuberosa's current stored knowledge is shapeless prose. Users inspecting the corpus describe it as vague: an item may be technically relevant but cannot guide a non-expert reader (human or agent) to act. The agent ends up making decisions on top of low-signal context, and a new teammate who installs Tuberosa cannot rely on it to teach them the project.

The retrieval pipeline already categorizes items by `evidenceCategory`, applies feedback boosts, and emits orientation. The missing piece is **the shape of the content itself**. Categorization and ranking cannot rescue a memory whose body is a paragraph of unanchored prose.

## 2. Goal

Define an actionable knowledge unit — the **knowledge atom** — with:

- a strict schema floor that rejects vague memories at write time;
- promotion tiers that let high-reuse atoms compound rank weight while ignored atoms decay;
- a producer pipeline that converts agent session output into atoms automatically;
- a migration path for existing vague memories.

Atoms must be readable by a non-expert and machine-actionable by an agent without further interpretation.

## 3. Non-goals (deferred)

| Out of scope here | Belongs in |
|---|---|
| Typed link traversal at retrieval time | C (graph layer) |
| Cross-project export of canonical atoms | E (project export) |
| User-style / personal-preference atoms | F (user-style layer) |
| Semantic dedup beyond cosine similarity | D (write-gate hardening) |
| Long-prompt preprocessing | A |

## 4. Atom data model

A knowledge atom is a self-contained, retrievable unit. It replaces the free-form `content` blob for `itemType=memory`. Other `itemType` values (`code_ref`, `wiki`, `spec`, `workflow`, `rule`, `bugfix`, `conversation`) remain unchanged; only `memory` migrates to the atom shape.

```typescript
interface KnowledgeAtom {
  id: UUID
  project: string

  // FLOOR — rejected if any are missing or empty
  claim: string                         // one sentence, ≤ 240 chars, declarative
  type:  AtomType
  evidence: Evidence[]                  // ≥ 1, each must resolve at write time
  trigger:  Trigger                     // when this atom applies

  // OPTIONAL — required to qualify for tier promotion
  verification?: Verification
  pitfalls?: string[]
  links?:    AtomLink[]

  // SYSTEM
  tier:        AtomTier                 // 'draft' | 'verified' | 'canonical'
  reuseCount:  number
  lastReusedAt?: Date
  status:      'active' | 'legacy_archived' | 'superseded'
  audit: {
    producedBy: 'agent_session' | 'user' | 'migration_llm'
    producedAtSessionId?: UUID
    createdAt: Date
    updatedAt: Date
  }
}

type AtomType =
  | 'fact'         // invariant the codebase enforces
  | 'procedure'    // multi-step how-to
  | 'decision'     // recorded choice + rationale
  | 'gotcha'       // anti-pattern / sharp edge
  | 'convention'   // project style

type AtomTier = 'draft' | 'verified' | 'canonical'

type Evidence =
  | { kind: 'file',          path: string, lineStart?: number, lineEnd?: number, commitSha?: string }
  | { kind: 'commit',        sha: string, message?: string }
  | { kind: 'test',          path: string, testName: string }
  | { kind: 'url',           uri: string, fetchedAt: Date }
  | { kind: 'prior_session', sessionId: UUID, decisionId?: UUID }

interface Trigger {
  errors?:     string[]                 // e.g. ['vector dimension mismatch']
  files?:      string[]                 // glob patterns: ['src/retrieval/fusion.ts']
  symbols?:    string[]                 // ['fuseCandidates']
  taskTypes?:  TaskType[]               // ['debugging', 'refactor']
  intentTags?: string[]                 // free-form: ['migration', 'release']
}

interface Verification {
  command?:   string                    // e.g. 'pnpm run eval:retrieval'
  testRef?:   { path: string, testName: string }
  assertion?: string                    // human-readable expected outcome
}

interface AtomLink {
  toAtomId: UUID
  kind:     'supersedes' | 'refines' | 'depends_on' | 'co_changes_with' | 'related_to'
  confidence: number                    // 0..1
}
```

### Why these five atom types

The taxonomy is chosen to cover what coding agents actually need:

| Type | Example claim |
|---|---|
| `fact` | "`EMBEDDING_DIMENSIONS` must equal the `vector(N)` column dim in `migrations/001_init.sql`." |
| `procedure` | "To add a migration: write SQL, bump version, run `pnpm run migrate`, then `pnpm run eval:retrieval`." |
| `decision` | "Chose pgvector over qdrant because Postgres is already a hard dependency and HNSW recall is sufficient." |
| `gotcha` | "MCP stdio process must not `console.log` — stdout is JSON-RPC only." |
| `convention` | "All new retrieval heuristics require a failing fixture case in `eval/retrieval-fixtures.json` first." |

Anything that does not fit one of these is probably not a memory — it is a `wiki`, `spec`, or `code_ref`.

## 5. Tier promotion mechanics

Tier controls the rank multiplier applied in `RetrievalService.applyRankingAdjustments`. Promotion is the system's self-healing mechanism: atoms earn rank by being reused, not by being written confidently.

| Tier | Required state | Rank multiplier |
|---|---|---|
| `draft` | floor + auto-critic pass | × 0.6 |
| `verified` | + `verification` field present + `reuseCount ≥ 2` + last reuse within 90 days | × 1.0 |
| `canonical` | + human approval (workbench action) + `links.length ≥ 2` | × 1.4 |

Promotion through the tiers is monotonic — an atom moves up by gaining qualifications, never by editing its tier directly. Demotion is automatic and based on signals:

- `verified` with no reuse in 180 days → back to `draft`.
- Any tier with `selected_but_noisy` count ≥ 3 → routed to the review queue (does not auto-demote, but a human decides).
- Any tier with `rejected` or `stale` feedback → review queue.

A **reuse event** is defined as: the atom appeared in a context pack that received `selected` or `selected_but_noisy` feedback, AND its `verification.command` (if set) exited successfully when the agent ran it. The verification check is best-effort: if no command is recorded, the selected event alone counts, but the atom cannot move past `verified` without a verification field eventually being added.

## 6. Producer pipeline at `finish_session`

```
agent finish_session(outcome, summary, transcript hints, changed files)
   │
   ▼
AtomExtractor.extract(session)
   │   LLM call with structured-output schema = KnowledgeAtom floor.
   │   Inputs: session prompt, decisions (selected/rejected), changed files,
   │           verification commands the agent ran, learning signals.
   │   Returns: 0..N candidate atoms.
   │
   ▼
AtomCritic.evaluate(candidate) — deterministic, no LLM:
   ✓ floor fields present and non-empty
   ✓ every `evidence` pointer resolves:
       file: path exists in repo at given commit (or HEAD if unspecified)
       commit: SHA exists in `git cat-file`
       test: path exists; testName found in file
       url: fetched successfully during extraction (cached in audit)
       prior_session: session id exists
   ✓ semantic-dedup against existing atoms in same project:
       cosine(embed(claim + trigger), existing) < 0.92
   ✓ trigger is non-trivial:
       at least one of errors|files|symbols|taskTypes is non-empty
       rejects `taskTypes=[everything]` or empty trigger
   ✓ claim length ≤ 240 chars and not a verbatim restatement of trigger
   │
   ├── PASS  → store as tier='draft', searchable immediately
   └── FAIL  → review queue with per-check failure reasons
```

Design constraints:

- **Extraction is LLM-driven.** It uses the existing `ModelProvider` interface (`hash` for tests, OpenAI/Ollama in prod). The structured-output schema *is* the `KnowledgeAtom` floor — the model cannot return malformed atoms.
- **Critic is deterministic.** No LLM in the gate. Keeps it cheap, predictable, and testable via fixture cases in `eval/retrieval-fixtures.json`.
- **Failures are observable.** Every rejected candidate writes a `KnowledgeGap` row with `metadata.source = 'atom_critic'` and the failing check, so the reviewer can see what was almost-good.

## 7. Migration of existing vague memories

A one-shot CLI command: `pnpm run migrate-knowledge-to-atoms`.

```
for each existing knowledge item where itemType ∈ ('memory', 'bugfix', 'rule'):
  if item.migrated_at is set: skip (idempotent)
  → AtomExtractor.extract(item)    // LLM re-extract from existing content
  → for each candidate: AtomCritic.evaluate(candidate)
  if ≥1 candidate passes:
    store atoms with audit.producedBy='migration_llm', tier='draft'
    mark original.status='legacy_replaced'
    link each atom to original via AtomLink kind='refines'
  else:
    mark original.status='legacy_archived'
  set item.migrated_at = now()
```

Retrieval policy during the 14-day **grace window**:

- `legacy_replaced` items: rank multiplier × 0.2 (visible but heavily down-ranked).
- `legacy_archived` items: excluded from retrieval immediately.

After the grace window:

- `legacy_replaced` items: kept read-only for audit, not surfaced in retrieval.
- `legacy_archived` items: unchanged.

CLI flags:

- `--dry-run` — emits `docs/migration-report.md` showing what would be extracted vs. archived. No DB writes.
- `--resume` — default behavior; processes only unmigrated items.
- `--project <name>` — restrict to one project.

## 8. Integration with the existing pipeline

The atom system is a layer on top of the existing `KnowledgeStore`. It is deliberately additive — no destructive changes to current tables.

| Touch point | Change |
|---|---|
| `src/storage/postgres-store.ts` | New `knowledge_atoms` table; nullable `parent_knowledge_id` FK to `knowledge`. New migration file. |
| `src/storage/memory-store.ts` | Mirror in-process structure for atoms. Required so retrieval-eval fixtures stay green. |
| `src/retrieval/service.ts` | Atoms join fusion as a 7th candidate source between `memory` and `worktree`. Tier multiplier applied in `applyRankingAdjustments` next to feedback boosts. |
| `src/retrieval/context-pack.ts` | New `evidenceCategory = 'verifiedAtom'`. Atoms with `tier ∈ {verified, canonical}` always sort above `priorLessons` from legacy memories. |
| `src/agent-session/finish.ts` | Calls the new `AtomExtractor` after the existing reflection-draft path. Atoms and reflection drafts coexist; an approved reflection draft of `type ∈ {procedure, decision}` becomes a canonical atom. |
| `src/atoms/` (new) | `extractor.ts`, `critic.ts`, `tier.ts`, `migration.ts`. Self-contained, testable in isolation. |
| `eval/retrieval-fixtures.json` | New fixture cases asserting that floor failures reject, semantic dedup rejects, evidence resolution rejects, and tier multipliers are applied in order. |

## 9. Schema (SQL sketch)

```sql
CREATE TABLE knowledge_atoms (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project              TEXT NOT NULL,
  parent_knowledge_id  UUID NULL REFERENCES knowledge(id) ON DELETE SET NULL,

  claim                TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('fact','procedure','decision','gotcha','convention')),
  evidence             JSONB NOT NULL,
  trigger              JSONB NOT NULL,

  verification         JSONB NULL,
  pitfalls             JSONB NULL,
  links                JSONB NULL,

  tier                 TEXT NOT NULL DEFAULT 'draft' CHECK (tier IN ('draft','verified','canonical')),
  reuse_count          INTEGER NOT NULL DEFAULT 0,
  last_reused_at       TIMESTAMPTZ NULL,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','legacy_archived','superseded')),

  produced_by          TEXT NOT NULL,
  produced_session_id  UUID NULL REFERENCES agent_sessions(id) ON DELETE SET NULL,
  embedding            vector(1536) NULL,         -- for semantic dedup

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_atoms_project_tier_idx ON knowledge_atoms (project, tier);
CREATE INDEX knowledge_atoms_status_idx       ON knowledge_atoms (status);
CREATE INDEX knowledge_atoms_embedding_idx    ON knowledge_atoms USING hnsw (embedding vector_cosine_ops);

-- legacy item flag
ALTER TABLE knowledge ADD COLUMN migrated_at TIMESTAMPTZ NULL;
ALTER TABLE knowledge ADD COLUMN legacy_status TEXT NULL CHECK (legacy_status IN ('legacy_replaced','legacy_archived'));
```

## 10. Acceptance criteria

A new agent installing Tuberosa for the first time on a small project (≤ 20 sessions of usage):

- ✅ Every `tier ∈ {verified, canonical}` atom shown to the agent passes a non-expert readability check: a person unfamiliar with the project can identify what the atom asserts, when it applies, and how to verify it from the atom alone.
- ✅ No atom is stored without an evidence pointer that resolves at write time.
- ✅ `pnpm run eval:retrieval` is green, including new fixture cases for critic rejections and tier multipliers.
- ✅ Migration `--dry-run` on the existing Tuberosa corpus produces a report; running for real leaves the corpus in a state where no `itemType=memory` item is searchable unless it is either an atom or a `legacy_replaced` within the grace window.
- ✅ At least 70% of session-produced atoms during a typical day pass the auto-critic. (If lower, the extractor prompt or critic thresholds need tuning.)
- ✅ A user can inspect `legacy_archived` items through the workbench but they never appear in a context pack.

## 11. Risks and open questions

| Risk | Mitigation |
|---|---|
| LLM extractor produces shallow atoms that pass the floor but are still vague. | Critic adds a "claim restatement" check (claim must not be a verbatim restatement of the trigger). Fixture cases catch obvious failure modes. Reuse decay surfaces low-value atoms over time. |
| 0.92 semantic-dedup threshold either over-merges or under-merges in practice. | Threshold lives in `policy.ts`, calibrated via sandbox + ablation in concern D. Make it a fixture-tested parameter, not a magic number in code. |
| Migration LLM cost on a large existing corpus. | `--dry-run` first; batch with rate-limiting; use `hash` provider for shape testing before paying for real extraction. |
| Two parallel concepts (atoms + reflection drafts) confuse users. | Section 8 explicitly subordinates reflection drafts: an approved draft of an actionable type becomes a canonical atom; drafts remain the human review surface for atom promotion. |
| Tier demotion thrashing — atoms ping-ponging between `draft` and `verified`. | Demotion only on **no** reuse in 180 days; promotion needs `≥ 2` reuses. Hysteresis is built into the thresholds. |

## 12. Next steps

1. User reviews this spec (review-gate).
2. After approval, invoke `writing-plans` to produce an implementation plan covering: schema migration, `src/atoms/` module, extractor + critic, retrieval integration, eval fixtures, migration CLI.
3. Open concern D (write-gate, dedup, decay) — much of D's substance is already pinned by §5–§7 here, so D will be a tighter spec.
