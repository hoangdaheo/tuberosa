# Graph Relations and Impact Propagation — Design (Concern C)

**Status:** Draft for review
**Date:** 2026-05-26
**Concern:** C in the six-concern decomposition (B → D → A → C → E → F)
**Depends on:** [B — Knowledge Atom Schema](2026-05-26-knowledge-atom-schema-design.md)
**Author:** Brainstorming session with user

---

## 1. Problem

B introduced `AtomLink { kind, toAtomId, confidence }` and four link kinds (`supersedes | refines | depends_on | co_changes_with | related_to`), but said nothing about how links get created, how retrieval uses them, or how the graph predicts blast radius for an upcoming edit. Without that, atoms are isolated points: an atom about `PaywallSelectionModal` and an atom about its sibling component never relate to each other, the agent can't see "if you change X you'll likely touch Y," and the graph is too sparse for project export (concern E) to be valuable.

Three concrete gaps to close:

1. **Sparse graph** — manual linking is too high-friction; the graph never reaches the density needed to power retrieval or export.
2. **No impact propagation** — when the agent classifies a task that touches files/symbols, Tuberosa says nothing about *related* atoms that might be affected.
3. **Per-atom JSONB only** — `AtomLink` lives in atom JSONB, which is fast for "this atom's outbound links" but slow for graph traversal, multi-hop walks, or inbound queries.

## 2. Goal

Two sequential phases:

- **C1 — Write-side:** automatic, low-friction link inference (co-change from git, semantic neighbors, `refines` detector) plus storage that supports graph walks.
- **C2 — Read-side:** retrieval uses the graph for multi-hop expansion and proactive impact-propagation alerts (`tuberosa_predict_impact` and an `impactPrediction` block on the context pack).

C1 lands first because read-side over a sparse graph yields nothing. C2 ships once an active project accumulates ≥ ~50 inferred edges (verified via the C1 telemetry endpoint).

## 3. Non-goals (deferred)

| Out of scope here | Belongs in |
|---|---|
| Cross-project graph linking (atom in project A relates to atom in B) | F or future |
| Graph visualization UI | Workbench follow-up; backend ships in C2 |
| LLM-curated link kind correction (e.g. "this should be `depends_on`") | Maintenance loop; off the critical path |
| Calibrating edge weights via fixture sweeps | Run `calibrate-fusion`-style sweep once C2 has telemetry |
| Re-inferring all edges when atom embeddings change | One-shot CLI ships with C1; periodic re-inference is a follow-up |

## 4. Storage: reuse `knowledge_relations`

Atom edges from B's per-atom JSONB are also mirrored into the existing `knowledge_relations` table so the graph walker can use indexed multi-hop queries. The table already powers `searchGraphRelations` — adding atom support keeps one walker, one set of indexes.

```sql
-- migrations/008_atom_relation_kinds.sql
ALTER TABLE knowledge_relations
  ADD COLUMN IF NOT EXISTS from_atom_id   uuid REFERENCES knowledge_atoms(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS target_atom_id uuid REFERENCES knowledge_atoms(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS inference_source text
    CHECK (inference_source IN ('migration','semantic','co_change','refines_detector','manual'));

CREATE INDEX IF NOT EXISTS idx_relations_from_atom   ON knowledge_relations(from_atom_id);
CREATE INDEX IF NOT EXISTS idx_relations_target_atom ON knowledge_relations(target_atom_id);
CREATE INDEX IF NOT EXISTS idx_relations_inference   ON knowledge_relations(inference_source);
```

Invariant per row: exactly one of `from_knowledge_id` / `from_atom_id` is set, and exactly one of `target_knowledge_id` / `target_atom_id` / `target_value` is set. The relation walker unions both sides with one extra `OR` per query. Atom JSONB `links` remains the per-atom convenience view; `knowledge_relations` is the canonical graph view. Both are written through a single helper to keep them in sync.

## 5. Phase C1 — Write-side inference

### 5.a — Co-change inference (git log scan)

```typescript
async function inferCoChangeLinks(opts: {
  project: string;
  cwd: string;
  lookbackCommits?: number;  // default 500
  minCoChanges?: number;     // default 3
  minConfidence?: number;    // default 0.5
}): Promise<InferenceReport>;
```

Algorithm:

1. Run `git log --name-only -n <lookbackCommits>` and parse into per-commit file lists.
2. For each ordered pair of files appearing in ≥ `minCoChanges` commits together, compute Jaccard confidence: `coOccurrences / (changesA + changesB − coOccurrences)`.
3. For each pair clearing `minConfidence`, find atoms whose `evidence` contains a `kind='file'` entry referencing either file.
4. Emit `AtomLink { kind: 'co_changes_with', toAtomId, confidence }` between the matching atoms, plus the mirror row in `knowledge_relations` with `inference_source='co_change'`.
5. Idempotent: re-running skips pairs already present with `inference_source='co_change'` unless `--rebuild` is passed (which deletes and re-emits).

Runs as a scheduled worker job (every 24h) and as a CLI: `pnpm run infer-co-change -- --project <p>`. Per-project so a monorepo can target one slice at a time.

### 5.b — Semantic-neighbor inference (inline)

Fires inline in `AtomCritic.evaluate` immediately after the cross-type dedup stage from D, **only when the candidate atom passes the gate**. The same embedding used for dedup is reused for neighbor search.

```typescript
async function inferSemanticNeighbors(atom: KnowledgeAtom, store: KnowledgeStore, models: ModelProvider): Promise<AtomLink[]> {
  const embedding = atom.embedding ?? await models.embed(`${atom.claim}\n${(atom.trigger.errors ?? []).join(' ')}`);
  const matches = await store.searchAtomsByEmbedding(embedding, {
    project: atom.project, limit: 8, threshold: 0.78,
  });
  // Exclude duplicate-threshold neighbors (≥ 0.92) — those are caught by dedup.
  const neighbors = matches
    .filter((m) => m.atom.id !== atom.id && m.cosine < 0.92)
    .slice(0, 5);

  return neighbors.map((n) => ({
    toAtomId: n.atom.id,
    kind: shouldRefine(atom, n.atom) ? 'refines' : 'related_to',
    confidence: n.cosine,
  }));
}

function shouldRefine(candidate: KnowledgeAtom, neighbor: KnowledgeAtom): boolean {
  if (neighbor.tier !== 'verified' && neighbor.tier !== 'canonical') return false;
  const shared = (a: string[] = [], b: string[] = []) => a.some((x) => b.includes(x));
  return shared(candidate.trigger.errors,  neighbor.trigger.errors)
      || shared(candidate.trigger.files,   neighbor.trigger.files)
      || shared(candidate.trigger.symbols, neighbor.trigger.symbols);
}
```

Cap at 5 outbound `related_to`/`refines` links per atom to prevent hub explosion. If more than 5 neighbors clear the threshold, keep top-5 by cosine.

### 5.c — `refines` detector

The `shouldRefine` rule in §5.b is the only `refines` source. The semantic distance band 0.78 ≤ cosine < 0.92 + at least one shared trigger token is the boundary between "duplicate" (rejected by D) and "related sibling" (linked via `refines` when the neighbor is verified/canonical, else `related_to`).

The 0.78 floor and 0.92 ceiling live in `retrieval-policy.json` under `graphInference.thresholds`. They are calibration parameters — the values shipped are starting points, tuned via the sandbox/ablation runs after C1 ships.

### 5.d — `supersedes` already covered

Already emitted at migration time per spec B (§7 of B). C1 only ensures the mirror row lands in `knowledge_relations` with `inference_source='migration'`. The relation walker honors `supersedes` as a strong signal (existing behavior — no change).

### 5.e — Sync helper

```typescript
// Called whenever atom.links is updated or new edges are inferred.
async function syncAtomLinks(atomId: string, links: AtomLink[], store: KnowledgeStore, source: InferenceSource): Promise<void> {
  await store.replaceAtomRelations(atomId, links, source);
  await store.updateAtom(atomId, { links });
}
```

`replaceAtomRelations` is a new store method that upserts rows in `knowledge_relations` keyed by `(from_atom_id, target_atom_id, relation_type, inference_source)` and deletes rows that were present but absent from the new set with the same source. Bulk inference jobs (co-change) use `source='co_change'` so they don't disturb manual or semantic edges.

### 5.f — Telemetry

A simple endpoint reports graph density per project — concern C2 reads this to decide whether the graph is dense enough to enable read-side features.

```
GET /operations/atom-graph/density?project=<p>
  → { atoms: 142, edges: 38, edgesPerAtom: 0.27, byKind: { related_to: 22, co_changes_with: 11, refines: 5 } }
```

## 6. Phase C2 — Read-side

### 6.a — Multi-hop graph walk

Today `searchGraphRelations` walks 1 hop from seed knowledge ids. Extend depth to 2 for atoms with kind-specific edge weights:

```jsonc
// retrieval-policy.json → graph
{
  "walkDepth": 2,
  "edgeWeights": {
    "supersedes":      0.0,
    "refines":         0.7,
    "depends_on":      0.6,
    "co_changes_with": 0.5,
    "related_to":      0.4
  },
  "decayPerHop": 0.6
}
```

`supersedes` weight is 0 — at hop 1 we surface the *newer* side and suppress the older one (already a behavior in the rank-adjustment phase). The walker returns candidates with `graphPath: [{ atomId, edgeKind }, ...]` so fusion and pack assembly can show **why** an item appeared. This lights up the existing `matchReasons` field with entries like `graph: refines → related_to`.

### 6.b — Impact-propagation alert at session start

Every `ContextPack` for `taskType ∈ ('implementation', 'refactor', 'debugging')` gains an `impactPrediction` block:

```typescript
interface ImpactPrediction {
  triggeredBy: { files?: string[]; symbols?: string[] };
  predictedAffected: Array<{
    target: { kind: 'file' | 'symbol' | 'atom'; value: string };
    confidence: number;
    via: Array<{ atomId: string; edgeKind: AtomLinkKind }>;
    why: string;
  }>;
  truncated: boolean;
}
```

Algorithm:

1. Take `classified.files ∪ classified.symbols` as seeds.
2. Find atoms whose evidence/trigger references those seeds.
3. Walk outbound edges from those atoms, depth ≤ 2, using §6.a weights.
4. Aggregate predictions per target. Confidence = sum of decayed edge weights across all paths.
5. Keep top `TUBEROSA_IMPACT_PREDICTION_LIMIT` (default 10). Set `truncated=true` if the unfiltered count was higher.

Surfaced in three places:

- `ContextPack.impactPrediction` — HTTP response.
- MCP `tuberosa_search_context` result — appended to `instruction` as a one-line summary when predictions exist (e.g. "Likely affected: src/components/paywall-form.tsx, fooBar() — call tuberosa_predict_impact for details.").
- Workbench session view — a "May affect" sidebar.

### 6.c — On-demand impact tool

```
tuberosa_predict_impact({
  project: string;
  files?: string[];
  symbols?: string[];
  depth?: number;          // default 2
}) → ImpactPrediction
```

Same algorithm as §6.b, agent-triggered. Useful for "before I edit X, what's the blast radius?" mid-session. Also available as `POST /operations/atom-graph/impact`.

### 6.d — Workbench export hook for E

A new endpoint streams the graph as JSONL — the input for concern E's export bundle:

```
GET /operations/organization/atom-graph.jsonl?project=<p>
  → one record per atom:
     { atom: { id, claim, type, tier, ... },
       outboundEdges: [{ toAtomId, kind, confidence, inferenceSource }, ...] }
```

The existing `exportKnowledgeGraphJsonl` is extended to include atom rows. E will consume both this and the legacy knowledge graph in one bundle.

## 7. Edge maintenance

Edges go stale as code moves. Rules:

| Trigger | Action |
|---|---|
| Atom archived (concern D §9) | Edges to/from it stay in DB but filtered from graph walks (`WHERE atom.status='active'`). |
| Atom superseded | Outbound edges from the superseded atom are filtered. Inbound `supersedes` edges are kept (audit trail). |
| Underlying file deleted | Background job `pnpm run prune-stale-edges` (weekly) drops file-evidence-based edges whose target path no longer exists in `cwd`. |
| Edge confidence falls below `pruneFloor=0.25` after recomputation | Soft-deleted (`status='stale'` on the relation row — column already exists in `knowledge_relations`). |

## 8. Configuration

| Variable | Default | Notes |
|---|---|---|
| `TUBEROSA_GRAPH_INFERENCE_ENABLED` | `true` | Master switch for C1. |
| `TUBEROSA_COCHANGE_LOOKBACK_COMMITS` | `500` | Git log scan window. |
| `TUBEROSA_COCHANGE_MIN_COMMITS` | `3` | Pair threshold. |
| `TUBEROSA_COCHANGE_MIN_CONFIDENCE` | `0.5` | Jaccard floor. |
| `TUBEROSA_SEMANTIC_NEIGHBOR_THRESHOLD` | `0.78` | Cosine floor for `related_to`. |
| `TUBEROSA_REFINES_THRESHOLD_LOW` | `0.78` | Lower bound for `refines` (upper = dedup 0.92 from B/D). |
| `TUBEROSA_SEMANTIC_NEIGHBOR_MAX_OUT` | `5` | Cap on outbound `related_to`/`refines` per atom. |
| `TUBEROSA_GRAPH_WALK_DEPTH` | `2` | Multi-hop depth for C2. |
| `TUBEROSA_IMPACT_PREDICTION_LIMIT` | `10` | Top-K per pack. |
| `TUBEROSA_GRAPH_EDGE_PRUNE_FLOOR` | `0.25` | Confidence floor below which edges are soft-deleted. |

All thresholds are calibration values — they live in `retrieval-policy.json` so they can be tuned via sandbox/ablation runs.

## 9. Acceptance criteria

**C1:**

- ✅ `pnpm run infer-co-change -- --project tuberosa` produces ≥ 1 `co_changes_with` link on the real repo and is idempotent on re-run.
- ✅ Creating a new atom whose embedding has 0.78 ≤ cosine < 0.92 against an existing verified atom with a shared trigger token emits a `refines` link; without the shared trigger emits `related_to`. No human action.
- ✅ Atom JSONB `links` and `knowledge_relations` rows stay in sync after creation, after inference jobs, and after `replaceAtomRelations`.
- ✅ `GET /operations/atom-graph/density?project=<p>` returns valid counts.
- ✅ Archived atoms' edges are filtered from graph walks (verified by fixture).
- ✅ `pnpm run eval:retrieval` stays green.

**C2:**

- ✅ A context pack for `taskType='implementation'` with classified files/symbols and ≥ 1 atom referencing those signals returns a non-empty `impactPrediction.predictedAffected`.
- ✅ `tuberosa_predict_impact({ files: ['src/retrieval/fusion.ts'] })` returns at least the atom whose evidence points to that file, plus depth-2 neighbors when present.
- ✅ The graph walker includes `graphPath` on each candidate that came from a graph walk, and `matchReasons` includes a `graph:` entry naming the edge kinds traversed.
- ✅ Setting `TUBEROSA_GRAPH_INFERENCE_ENABLED=false` disables auto-inference without breaking retrieval.
- ✅ `pnpm run eval:retrieval` stays green; new fixtures assert impact predictions for hand-constructed graphs.

## 10. Risks and open questions

| Risk | Mitigation |
|---|---|
| Semantic neighbors create hub atoms with hundreds of inbound edges. | 5-outbound cap per atom plus the 0.78 threshold; periodic pruning by confidence. |
| Co-change inference picks up coincidental cross-cutting refactors. | Jaccard normalizes for popularity; min 3 commits + min 0.5 confidence. Lookback bounded at 500 commits. Per-commit message clustering is a follow-up. |
| Impact prediction is wrong; agent acts on a phantom warning. | Predictions ship with `confidence`, `via`, and `why`. The MCP `instruction` says "may affect," not "will affect." Agents can ignore; feedback channels for "useful but noisy" already exist (concern B). |
| Multi-hop walks slow retrieval on dense graphs. | Depth capped at 2; decay applied. Indexed lookups on `knowledge_relations`. Expected < 10ms on the current Tuberosa corpus; profiled in eval before C2 ships. |
| `from_atom_id` / `from_knowledge_id` polymorphism in `knowledge_relations` makes queries awkward. | One extra `OR` per query in the union view; alternative (separate `atom_links` table) duplicates indexing for no gain. |
| Inline semantic-neighbor inference adds latency to `AtomCritic.evaluate`. | One vector query per accepted atom, same embedding reused from dedup. Profiled in fixtures; if budget tightens, can move to a deferred queue. |
| Edge weights are uncalibrated guesses. | Live in `retrieval-policy.json`; tuned via the existing calibration workflow after C2 has live telemetry. |

## 11. Next steps

1. User reviews this spec.
2. After approval, write **C1** (write-side) and **C2** (read-side) implementation plans separately.
3. Continue to E (project export, depends on C) and F (user-style layer).
