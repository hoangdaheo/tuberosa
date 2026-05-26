# Write-Gate, Dedup, and Decay — Design (Concern D)

**Status:** Draft for review
**Date:** 2026-05-26
**Concern:** D in the six-concern decomposition (B → D → A → C → E → F)
**Depends on:** [B — Knowledge Atom Schema](2026-05-26-knowledge-atom-schema-design.md)
**Author:** Brainstorming session with user

---

## 1. Problem

B established a schema floor (claim/type/evidence/trigger) and atom-vs-atom semantic dedup at cosine ≥ 0.92. That is sufficient to reject malformed atoms, but it does **not** reject *well-formed-but-useless* atoms — claims like "ran pnpm test, all tests passed" or "updated docs/foo.md" satisfy the floor yet should never become memory. The corpus also accumulates duplicates *across* item shapes (atoms vs. legacy `knowledge_items`) that B's atom-only dedup does not catch. And without active archival, every atom that survives the floor lives forever, even when nobody reuses it.

Three pollution sources remain unsolved after B:

1. **Trivial-but-well-formed atoms** — status reports, test-run announcements, doc-update notes.
2. **Cross-shape duplicates** — a new atom and an old `memory`/`bugfix`/`rule` knowledge item asserting the same thing.
3. **Inactive atoms accumulating** — tier demotes after 180 days, but `status='active'` stays forever.

## 2. Goal

Add three layers on top of B's pipeline that together solve the visible pollution problem:

- a **triviality gate** (rule-based + optional LLM critic) before B's schema floor;
- **cross-type dedup** between atoms and legacy `knowledge_items`;
- a scheduled **archival job** that retires inactive or negatively-signalled atoms without deleting them.

Plus the observability needed to know whether any of it is working.

## 3. Non-goals (deferred)

| Out of scope here | Belongs in |
|---|---|
| Long-prompt extraction producing too many candidate atoms | A — bounded preprocessing |
| Suggesting `supersedes` relations between near-duplicate atoms | C — graph layer |
| Exporting only verified atoms for teammates | E — project export |
| Per-user style atoms with their own gate | F |

## 4. Pipeline order

D inserts two new stages around B's existing critic. Order matters — cheapest deterministic checks first, expensive LLM check last.

```
input candidate
   │
   ▼ stage 1: triviality rules             ← NEW in D, deterministic
   │   pass / reject → log to atom_gate_events
   ▼ stage 2: schema floor (B)
   │   pass / reject → log
   ▼ stage 3: cross-type dedup
   │           atom ↔ atom    (B, ≥ 0.92)
   │           atom ↔ legacy  (D, ≥ 0.88)  ← NEW in D
   │   pass / reject / queue-for-migration → log
   ▼ stage 4: LLM critic for borderline    ← NEW in D, optional
   │   pass / reject / pending → log
   ▼ store as draft tier
```

Every stage writes exactly one row to `atom_gate_events` (§8). The row records stage, outcome, and reasons — the source of truth for §8 observability.

## 5. Stage 1: deterministic triviality rules

A small stop-list runs before B's schema floor. Patterns are tuned for what coding-agent sessions emit in practice.

```typescript
// src/atoms/triviality-rules.ts
export interface TrivialityRule {
  name: string;
  test: (atom: KnowledgeAtomInput) => boolean;
}

export const DEFAULT_TRIVIALITY_RULES: TrivialityRule[] = [
  { name: 'test_result',
    test: (a) => /^(ran|run|executed|all)\s.*(passed|completed|succeeded|green|ok)\b/i.test(a.claim) },
  { name: 'doc_update_announcement',
    test: (a) => /^updated?\s+\S+\.(md|json|yaml|yml|txt|toml)\b/i.test(a.claim) },
  { name: 'commit_status',
    test: (a) => /^(committed?|pushed?|merged?|shipped?|deployed?)\b/i.test(a.claim) },
  { name: 'rename_announcement',
    test: (a) => /^(refactored|renamed|moved|added|removed)\s+[A-Za-z0-9_]+\.?$/i.test(a.claim) },
  { name: 'no_concrete_trigger',
    test: (a) => !(a.trigger.errors?.length || a.trigger.files?.length || a.trigger.symbols?.length) },
  { name: 'sparse_claim',
    test: (a) => contentWords(a.claim).length < 5 },
];

const TRIVIALITY_STOP_WORDS = new Set(['the','a','an','of','to','in','on','is','was','and','or','for']);

function contentWords(claim: string): string[] {
  return claim.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !TRIVIALITY_STOP_WORDS.has(w));
}
```

A rule hit returns `{ ok: false, reasons: ['triviality:<rule-name>'] }`. Rules are an injectable list on `AtomCritic` — projects can extend the defaults via configuration, but the defaults ship with the recommended set.

## 6. Stage 2: schema floor (unchanged — owned by B)

The schema-floor critic from B runs unchanged: empty fields, length cap, claim-restates-trigger, etc. D only adds a telemetry event when this stage rejects.

## 7. Stage 3: cross-type dedup

Extends B's atom-vs-atom dedup to also check against legacy `knowledge_items` of types that should have been atoms (`memory`, `bugfix`, `rule`). Other types (`wiki`, `spec`, `code_ref`, `workflow`, `conversation`) intentionally coexist with atoms and are **not** deduped against.

```typescript
async function evaluateDedup(
  input: KnowledgeAtomInput,
  store: KnowledgeStore,
  models: ModelProvider,
): Promise<{ outcome: 'pass' | 'reject' | 'queue_legacy_migration'; reason?: string }> {
  const embedding = await models.embed(`${input.claim}\n${(input.trigger.errors ?? []).join(' ')}`);

  // B: atom ↔ atom
  const atomMatches = await store.searchAtomsByEmbedding(embedding, {
    project: input.project, limit: 5, threshold: 0.92,
  });
  if (atomMatches.length > 0) {
    return { outcome: 'reject', reason: `duplicate of atom ${atomMatches[0].atom.id}` };
  }

  // D: atom ↔ legacy knowledge_items
  const legacyMatches = await store.searchKnowledgeByEmbedding(embedding, {
    project: input.project, limit: 5, threshold: 0.88,
    itemTypes: ['memory', 'bugfix', 'rule'],
    excludeLegacyStatuses: ['legacy_replaced', 'legacy_archived'],
  });
  if (legacyMatches.length === 0) return { outcome: 'pass' };

  // Race-safe: instead of accepting a duplicate, queue the legacy item for migration
  // so it becomes the source of truth, then the next attempt to extract the same
  // claim naturally dedups against the new atom.
  return {
    outcome: 'queue_legacy_migration',
    reason: `near-duplicate of legacy knowledge_items.${legacyMatches[0].knowledge.id}`,
  };
}
```

Two new `KnowledgeStore` methods D adds:

- `searchKnowledgeByEmbedding(embedding, options)` — vector search restricted to chosen `itemType`s and legacy statuses.
- `countNegativeFeedback(knowledgeId, withinDays)` — used by §9 archival.

The 0.88 threshold for legacy is intentionally looser than 0.92 for atom-vs-atom because legacy items are long prose, so their embeddings don't tighten as cleanly around the same claim.

## 8. Stage 4: LLM critic for borderline atoms

A second-stage critic runs only when stage 1 didn't reject **and** the atom looks borderline.

**Borderline** is deterministic:

- Stage 1 passed by ≤ 2 content-word margin above the `sparse_claim` threshold, OR
- Trigger has only `taskTypes` (no concrete errors/files/symbols).

The LLM critic asks one question:

> Is this a generalizable lesson — would it help a future agent on a similar but different task? Reject if it merely describes one-time events or restates trivia.

```typescript
// Provider interface addition (src/model/provider.ts)
interface ModelProvider {
  // ...existing
  judgeAtomUtility?(input: {
    claim: string;
    type: AtomType;
    trigger: Trigger;
  }): Promise<{ generalizable: boolean; reason: string; confidence: number }>;
}
```

Verdict is cached in Redis under `atom_critic:<sha256(claim + type)>` with a 7-day TTL. Repeated extractions of the same claim across sessions don't pay twice.

**Default behavior by provider:**

| Provider | `judgeAtomUtility` defined? | Stage 4 default |
|---|---|---|
| `hash` (tests) | no | skipped — atom passes with no flag |
| `openai` | yes | **on by default** |
| `ollama` | yes | **on by default** |

User can override per-provider via env: `TUBEROSA_LLM_CRITIC_ENABLED=false`.

When the provider has no `judgeAtomUtility` method, borderline atoms pass with `metadata.gate.pendingLlmCritic = true`. The workbench surfaces these for batch human review later, but they are searchable at draft tier in the meantime — better than dropping legitimate edge cases.

## 9. Active archival

A scheduled job archives atoms (and legacy items past their grace window) without deleting them. Archived atoms stay fetchable by id and visible in the workbench under an "Archived" tab; they are excluded from default retrieval.

### 9.1 New status value

```sql
-- migrations/006_atom_archival.sql
ALTER TABLE knowledge_atoms
  DROP CONSTRAINT IF EXISTS knowledge_atoms_status_check,
  ADD  CONSTRAINT knowledge_atoms_status_check
       CHECK (status IN ('active', 'legacy_archived', 'superseded', 'archived'));

CREATE INDEX IF NOT EXISTS idx_atoms_archival_scan
  ON knowledge_atoms (tier, last_reused_at) WHERE status = 'active';
```

### 9.2 Archival triggers

| Trigger | Scope | Threshold |
|---|---|---|
| **Time** | `tier = 'draft'` only | `age(lastReusedAt ?? createdAt) > 365 days` |
| **Signal** | any tier except `canonical` | `(rejected + stale + irrelevant) feedback events in last 90 days ≥ 3` |

`verified` and `canonical` atoms are immune to time-based archival — they earned their tier through reuse and (for canonical) human approval. They can still be archived via signal threshold, but `canonical` requires 5 negative signals instead of 3 (raising the bar on human-approved items).

### 9.3 Archival job

```typescript
// src/atoms/archival.ts
const TIME_THRESHOLD_DAYS = 365;
const NEGATIVE_SIGNAL_THRESHOLD = 3;
const CANONICAL_SIGNAL_THRESHOLD = 5;
const NEGATIVE_SIGNAL_WINDOW_DAYS = 90;

export async function runArchivalSweep(
  store: KnowledgeStore,
  now: Date = new Date(),
): Promise<ArchivalReport> {
  const candidates = await store.listAtoms({ status: 'active', limit: 1000 });
  const archivedByTime: string[] = [];
  const archivedBySignal: string[] = [];

  for (const atom of candidates) {
    if (atom.tier === 'draft'
        && daysSince(atom.lastReusedAt ?? atom.audit.createdAt, now) > TIME_THRESHOLD_DAYS) {
      await store.updateAtom(atom.id, { status: 'archived' });
      archivedByTime.push(atom.id);
      continue;
    }
    const threshold = atom.tier === 'canonical' ? CANONICAL_SIGNAL_THRESHOLD : NEGATIVE_SIGNAL_THRESHOLD;
    const negativeCount = await store.countNegativeFeedback(atom.id, NEGATIVE_SIGNAL_WINDOW_DAYS);
    if (negativeCount >= threshold) {
      await store.updateAtom(atom.id, { status: 'archived' });
      archivedBySignal.push(atom.id);
    }
  }
  return { archivedByTime, archivedBySignal, scannedAt: now.toISOString() };
}
```

### 9.4 Schedule

A new worker entry in `src/worker.ts` runs `runArchivalSweep` every `TUBEROSA_ARCHIVAL_INTERVAL_HOURS` (default 24). It is also runnable on demand:

```bash
pnpm run archival-sweep            # one-shot
pnpm run archival-sweep -- --dry-run --report /tmp/archival.md
```

### 9.5 Resurrection

```
POST /atoms/:id/resurrect
  → status = 'active', lastReusedAt = now
```

Plus an MCP tool `tuberosa_resurrect_atom` for agents that find an archived atom by direct id reference (rare but possible — a session note may cite an archived atom).

### 9.6 Legacy item archival

When B's 14-day grace window closes for a `legacy_replaced` knowledge item, the same archival sweep flips it to `status='archived'`. `legacy_archived` items are unchanged — they were already excluded from retrieval by B.

## 10. Retrieval filter

Every atom search path adds `WHERE status = 'active'` by default. Direct fetch by id (`store.getAtom(id)`) ignores status — archived atoms are still fetchable for audit. The workbench passes a `?includeArchived=true` flag when rendering the "Archived" tab.

## 11. Observability

Without this, we cannot tell if the gate is working.

### 11.1 Telemetry table

```sql
-- migrations/007_atom_gate_events.sql
CREATE TABLE IF NOT EXISTS atom_gate_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  atom_id         uuid REFERENCES knowledge_atoms(id) ON DELETE SET NULL,
  candidate_claim text NOT NULL,
  candidate_type  text NOT NULL,
  stage           text NOT NULL CHECK (stage IN ('triviality','floor','dedup','llm_critic')),
  outcome         text NOT NULL CHECK (outcome IN ('accepted','rejected','pending','queue_legacy_migration')),
  reasons         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atom_gate_events_project_outcome
  ON atom_gate_events (project_id, outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_atom_gate_events_stage
  ON atom_gate_events (stage, created_at DESC);
```

Every critic decision writes one row. `AtomCritic.evaluate` returns the row id so the caller can correlate the candidate with downstream actions (atom creation, knowledge gap, legacy migration).

### 11.2 Stats endpoint

```
GET /operations/atom-gate/stats?project=tuberosa&window=7d
```

Returns:

```jsonc
{
  "windowDays":        7,
  "totalCandidates":   142,
  "accepted":          68,
  "acceptedPct":       0.479,
  "rejected": {
    "triviality":  41,
    "floor":       19,
    "dedup":        9,
    "llm_critic":   5
  },
  "queuedLegacyMigration": 4,
  "topTrivialityPatterns": [
    { "pattern": "test_result",    "count": 23 },
    { "pattern": "commit_status",  "count": 12 },
    { "pattern": "sparse_claim",    "count":  6 }
  ],
  "pendingLlmCritic": 7,
  "alertHints": [
    { "level": "info", "text": "Acceptance rate within healthy range (30–80%)." }
  ]
}
```

**Health bands:**

| Acceptance rate (7-day) | Hint |
|---|---|
| < 30% | "Critic may be too strict — review top rejection reasons." |
| 30–80% | "Healthy." |
| > 80% | "Critic may be too permissive — consider adding triviality patterns." |

### 11.3 Workbench panel

A new "Gate Health" card on the workbench dashboard renders the stats above plus a 30-day acceptance chart. Top rejection reasons link to a filtered `atom_gate_events` browser so a reviewer can spot-check.

### 11.4 MCP tool

`tuberosa_atom_gate_stats(project?, windowDays?)` returns the same payload. Agents can self-audit and propose adjustments to the triviality rules through normal feedback channels.

## 12. Configuration

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_LLM_CRITIC_ENABLED` | `true` for openai/ollama, `false` for hash | Force-disable per env. |
| `TUBEROSA_LLM_CRITIC_TTL_SECONDS` | `604800` (7d) | Redis cache TTL for verdicts. |
| `TUBEROSA_ARCHIVAL_ENABLED` | `true` | Disable to freeze the corpus. |
| `TUBEROSA_ARCHIVAL_INTERVAL_HOURS` | `24` | Scheduled sweep cadence. |
| `TUBEROSA_ARCHIVAL_TIME_DAYS` | `365` | Time-based threshold. |
| `TUBEROSA_ARCHIVAL_SIGNAL_THRESHOLD` | `3` | Negative signals before archival. |
| `TUBEROSA_ARCHIVAL_CANONICAL_SIGNAL_THRESHOLD` | `5` | Higher bar for canonical atoms. |
| `TUBEROSA_TRIVIALITY_RULES_FILE` | unset | Optional JSON path overriding the default rule list per project. |

All thresholds are policy values — they live in `src/retrieval/policy.ts`'s `retrieval-policy.json` extension or alongside it, so they can be tuned via `calibrate-fusion` style runs in future evals.

## 13. Acceptance criteria

- ✅ Triviality rules reject all atoms whose claim matches the default patterns. Fixture cases in `eval/retrieval-fixtures.json` assert each rule fires on its target shape.
- ✅ Cross-type dedup rejects an atom that is a near-duplicate of an unmigrated legacy `memory`/`bugfix`/`rule` item. The legacy item is queued for migration in the same call.
- ✅ Archival sweep flips `tier='draft' && lastReusedAt > 365d ago` atoms to `status='archived'`. Verified/canonical atoms are not time-archived.
- ✅ Archived atoms are excluded from default retrieval but fetchable by id and visible in the workbench Archived tab.
- ✅ A resurrected atom returns to `status='active'` and immediately competes in retrieval again.
- ✅ `atom_gate_events` row count after a typical agent session equals the number of candidate atoms × number of stages reached, with no missing rows.
- ✅ `/operations/atom-gate/stats` returns plausible numbers on the existing dev corpus.
- ✅ `pnpm run eval:retrieval` stays green: hitRate=1, staleRejectionRate=1.
- ✅ With LLM critic on (openai/ollama), repeated extractions of the same claim hit the Redis cache from the second call onward.

## 14. Risks and open questions

| Risk | Mitigation |
|---|---|
| Triviality rules reject a legitimate short lesson (e.g. a one-line tip with a sharp claim). | Rules are extensible per project; every rejection is logged and visible in the gate-stats panel, so over-aggressive patterns surface fast. Stage 4 LLM critic can also rescue borderline cases when extracted by a session with a configured provider. |
| LLM critic disagrees with rules and creates churn. | Stages are gated — rules reject before the LLM ever sees the candidate. The LLM only sees borderline atoms the rules let through. No path lets the LLM revive a rule-rejected atom unless the user explicitly overrides via workbench. |
| 0.88 legacy-dedup threshold misfires across long prose. | Lives in policy; calibrated via sandbox + ablation. Borderline matches surface as `queue_legacy_migration` outcomes rather than hard rejections, so the worst-case is a redundant migration scan. |
| Archival job races a live retrieval. | Archival flips status; retrieval reads status. Postgres MVCC handles isolation. Workers run on the same advisory-lock pattern used by `runMigrations`. |
| LLM critic cost balloons on a busy day. | Verdict cache (Redis, 7d TTL) keyed by claim hash. Stage 4 only sees borderline atoms, so the hit count is bounded. Per-project monthly cap configurable later. |
| Stats endpoint becomes the primary tuning surface and gets gamed. | Acceptance rate is informational, not enforced. No automatic threshold adjustments — only hints. |

## 15. Next steps

1. User reviews this spec.
2. After approval, write the D implementation plan (`docs/superpowers/plans/2026-05-26-write-gate-dedup-decay.md`) following the pattern from B.
3. Continue to concern A — long-prompt preprocessing.
