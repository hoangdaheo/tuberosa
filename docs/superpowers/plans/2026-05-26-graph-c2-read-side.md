# Graph C2 — Read-Side Impact Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the atom graph built in C1 to power two read-side features: depth-2 graph expansion during retrieval (so atoms 1–2 hops from a classified signal can surface), and an `impactPrediction` block plus `tuberosa_predict_impact` MCP tool that warn the agent which atoms/files/symbols are *likely* affected by an upcoming edit.

**Architecture:** Extend the existing `searchGraphRelations` walker to traverse atom edges with kind-specific weights and a hop-decay factor (all in `retrieval-policy.json`). Add a new `ImpactPredictor` module that runs after classification: it seeds from `classified.files ∪ classified.symbols`, finds atoms whose evidence/trigger references those seeds, walks outbound edges depth ≤ 2, aggregates predictions, and attaches the result to `ContextPack.impactPrediction`. Expose the same algorithm via HTTP and MCP for mid-session blast-radius queries. Graph paths are surfaced on candidates via `matchReasons` so the agent sees *why* an item was pulled.

**Tech Stack:** TypeScript (Node 22), Postgres + pgvector, `node:test` runner with `tsx`.

**Spec:** [`docs/superpowers/specs/2026-05-26-graph-relations-impact-propagation-design.md`](../specs/2026-05-26-graph-relations-impact-propagation-design.md)

**Depends on:** C1 plan must be merged first (atoms need edges before walking yields anything). B and D plans are prerequisites of C1.

---

## File Structure

**Create:**
- `src/retrieval/atom-graph-walker.ts` — multi-hop walk with kind weights + decay
- `src/retrieval/impact-predictor.ts` — `predictImpact` function
- `src/operations/atom-graph-export.ts` — JSONL streamer for concern E
- `test/atom-graph-walker.test.ts`
- `test/impact-predictor.test.ts`
- `test/atom-graph-export.test.ts`

**Modify:**
- `src/retrieval/policy.ts` — `graph.walkDepth`, `edgeWeights`, `decayPerHop`, `impactPredictionLimit`
- `src/types.ts` — `ImpactPrediction`, extended `MatchReason` for graph paths
- `src/types/atoms.ts` — already has `AtomLink`; no changes needed here
- `src/storage/store.ts` — add `walkAtomGraph(seeds, options)` method (memory + postgres)
- `src/storage/memory-store.ts` — impl
- `src/storage/postgres-store.ts` — impl with recursive CTE
- `src/retrieval/service.ts` — call `predictImpact` after classification when `taskType` qualifies; attach `impactPrediction` to pack; pass graph-walk results through to fusion as a separate source so they're ranked alongside other candidates
- `src/retrieval/context-pack.ts` — surface `impactPrediction` and `graphPath`/`matchReasons` on items
- `src/mcp/server.ts` — register `tuberosa_predict_impact`; append impact summary to `tuberosa_search_context` `instruction` when predictions exist
- `src/http/server.ts` — `POST /operations/atom-graph/impact`; `GET /operations/organization/atom-graph.jsonl`
- `eval/retrieval-fixtures.json` — impact prediction fixtures, graph-walk depth-2 fixtures

---

## Task 1: Policy block for graph walking

**Files:**
- Modify: `src/retrieval/policy.ts`

- [ ] **Step 1: Add `graph` policy keys**

Edit `src/retrieval/policy.ts`. Add to `DEFAULT_POLICY`:

```typescript
  graph: {
    walkDepth: 2,
    edgeWeights: {
      supersedes:      0.0,
      refines:         0.7,
      depends_on:      0.6,
      co_changes_with: 0.5,
      related_to:      0.4,
    },
    decayPerHop: 0.6,
    impactPredictionLimit: 10,
  },
```

Extend `RetrievalPolicy` TS type.

- [ ] **Step 2: Commit**

```bash
git add src/retrieval/policy.ts
git commit -m "feat(graph): policy defaults for walkDepth, edgeWeights, decayPerHop"
```

---

## Task 2: `walkAtomGraph` on `KnowledgeStore`

**Files:**
- Modify: `src/storage/store.ts`
- Modify: `src/storage/memory-store.ts`
- Modify: `src/storage/postgres-store.ts`
- Test: `test/atom-graph-walker.test.ts`

- [ ] **Step 1: Add interface signature**

Edit `src/storage/store.ts`:

```typescript
export interface AtomGraphPathStep {
  atomId: string;
  edgeKind: 'supersedes' | 'refines' | 'depends_on' | 'co_changes_with' | 'related_to';
  edgeConfidence: number;
}

export interface AtomGraphHit {
  atomId: string;
  path: AtomGraphPathStep[];          // ordered hops from seed to this atom
  pathScore: number;                   // ∏ edgeWeight × decayPerHop^(hop-1), clamped 0..1
}

export interface WalkAtomGraphOptions {
  project: string;
  seedAtomIds: string[];
  depth: number;                       // ≥ 1
  edgeWeights: Record<AtomGraphPathStep['edgeKind'], number>;
  decayPerHop: number;
  limit: number;
  excludeArchived?: boolean;           // default true
}

// inside KnowledgeStore:
  walkAtomGraph(options: WalkAtomGraphOptions): Promise<AtomGraphHit[]>;
```

- [ ] **Step 2: Write the failing test**

Create `test/atom-graph-walker.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { DEFAULT_POLICY } from '../src/retrieval/policy.js';

async function atom(store: MemoryKnowledgeStore, claim: string) {
  return store.createAtom({
    project: 'tuberosa', claim, type: 'fact',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });
}

async function edge(store: MemoryKnowledgeStore, from: string, to: string, kind: 'related_to'|'refines'|'co_changes_with'|'depends_on'|'supersedes', confidence = 0.9) {
  await store.replaceAtomRelations(from, [{
    fromAtomId: from, targetAtomId: to, relationType: kind, confidence, inferenceSource: 'manual',
  }], { source: 'manual' });
}

test('walkAtomGraph: returns 1-hop neighbors for depth=1', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await atom(store, 'A');
  const b = await atom(store, 'B');
  const c = await atom(store, 'C');
  await edge(store, a.id, b.id, 'related_to');
  await edge(store, b.id, c.id, 'related_to');
  const hits = await store.walkAtomGraph({
    project: 'tuberosa', seedAtomIds: [a.id], depth: 1, limit: 10,
    edgeWeights: DEFAULT_POLICY.graph.edgeWeights, decayPerHop: 0.6,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].atomId, b.id);
});

test('walkAtomGraph: returns depth-2 hits with decayed pathScore', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await atom(store, 'A');
  const b = await atom(store, 'B');
  const c = await atom(store, 'C');
  await edge(store, a.id, b.id, 'related_to', 0.9);
  await edge(store, b.id, c.id, 'related_to', 0.9);
  const hits = await store.walkAtomGraph({
    project: 'tuberosa', seedAtomIds: [a.id], depth: 2, limit: 10,
    edgeWeights: { ...DEFAULT_POLICY.graph.edgeWeights, related_to: 0.4 },
    decayPerHop: 0.6,
  });
  const hopC = hits.find((h) => h.atomId === c.id);
  assert.ok(hopC);
  // path: A→B (0.4) then B→C (0.4 × 0.6) → pathScore = 0.4 * 0.4 * 0.6 ≈ 0.096
  assert.ok(hopC!.pathScore > 0 && hopC!.pathScore < 0.2);
  assert.equal(hopC!.path.length, 2);
});

test('walkAtomGraph: excludes archived atoms by default', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await atom(store, 'A');
  const b = await atom(store, 'B');
  await store.updateAtom(b.id, { status: 'archived' });
  await edge(store, a.id, b.id, 'related_to');
  const hits = await store.walkAtomGraph({
    project: 'tuberosa', seedAtomIds: [a.id], depth: 1, limit: 10,
    edgeWeights: DEFAULT_POLICY.graph.edgeWeights, decayPerHop: 0.6,
  });
  assert.equal(hits.length, 0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --import tsx test/atom-graph-walker.test.ts`
Expected: FAIL — method does not exist.

- [ ] **Step 4: Implement on `MemoryKnowledgeStore`**

```typescript
  async walkAtomGraph(options: WalkAtomGraphOptions): Promise<AtomGraphHit[]> {
    const excludeArchived = options.excludeArchived ?? true;
    const visited = new Set<string>(options.seedAtomIds);
    const results: AtomGraphHit[] = [];
    type Frontier = { atomId: string; path: AtomGraphPathStep[]; score: number };
    let frontier: Frontier[] = options.seedAtomIds.map((id) => ({ atomId: id, path: [], score: 1 }));

    for (let hop = 1; hop <= options.depth && frontier.length; hop += 1) {
      const next: Frontier[] = [];
      for (const node of frontier) {
        const edges = await this.listAtomRelations({ fromAtomId: node.atomId, limit: 50 });
        for (const e of edges) {
          if (visited.has(e.targetAtomId)) continue;
          const target = await this.getAtom(e.targetAtomId);
          if (!target) continue;
          if (excludeArchived && target.status === 'archived') continue;
          const weight = options.edgeWeights[e.relationType] ?? 0;
          if (weight === 0) continue;
          const hopMultiplier = Math.pow(options.decayPerHop, hop - 1);
          const score = node.score * weight * hopMultiplier;
          const path: AtomGraphPathStep[] = [
            ...node.path,
            { atomId: e.targetAtomId, edgeKind: e.relationType, edgeConfidence: e.confidence },
          ];
          visited.add(e.targetAtomId);
          results.push({ atomId: e.targetAtomId, path, pathScore: Math.min(1, score) });
          next.push({ atomId: e.targetAtomId, path, score });
        }
      }
      frontier = next;
    }

    // Sort by pathScore desc and truncate to limit
    return results
      .sort((a, b) => b.pathScore - a.pathScore)
      .slice(0, options.limit);
  }
```

- [ ] **Step 5: Implement on `PostgresKnowledgeStore`**

Use a recursive CTE; cap depth via parameter; filter archived in the join:

```typescript
  async walkAtomGraph(options: WalkAtomGraphOptions): Promise<AtomGraphHit[]> {
    const excludeArchived = options.excludeArchived ?? true;
    const result = await this.pool.query(
      `WITH RECURSIVE walk AS (
         SELECT
           kr.target_atom_id AS atom_id,
           ARRAY[ROW(kr.target_atom_id, kr.relation_type, kr.confidence)] AS path,
           1 AS hop,
           ($3::jsonb->>kr.relation_type)::float AS score
         FROM knowledge_relations kr
         WHERE kr.from_atom_id = ANY($1::uuid[])
           AND kr.target_atom_id IS NOT NULL
           AND ($3::jsonb->>kr.relation_type) IS NOT NULL
           AND ($3::jsonb->>kr.relation_type)::float > 0
         UNION ALL
         SELECT
           kr2.target_atom_id,
           w.path || ROW(kr2.target_atom_id, kr2.relation_type, kr2.confidence),
           w.hop + 1,
           w.score * ($3::jsonb->>kr2.relation_type)::float * power($4::float, w.hop)
         FROM walk w
         JOIN knowledge_relations kr2 ON kr2.from_atom_id = w.atom_id
         WHERE w.hop < $2
           AND kr2.target_atom_id IS NOT NULL
           AND ($3::jsonb->>kr2.relation_type) IS NOT NULL
           AND ($3::jsonb->>kr2.relation_type)::float > 0
           AND kr2.target_atom_id != ALL(ARRAY(SELECT (s).f1 FROM unnest(w.path) AS s))
       )
       SELECT DISTINCT ON (w.atom_id)
              w.atom_id, w.path, w.score
       FROM walk w
       JOIN knowledge_atoms a ON a.id = w.atom_id
       WHERE ($5::boolean = false OR a.status != 'archived')
       ORDER BY w.atom_id, w.score DESC
       LIMIT $6`,
      [
        options.seedAtomIds,
        options.depth,
        JSON.stringify(options.edgeWeights),
        options.decayPerHop,
        excludeArchived,
        options.limit,
      ],
    );

    return result.rows.map((row) => ({
      atomId: String(row.atom_id),
      pathScore: Math.min(1, Number(row.score)),
      path: parsePathArray(row.path),
    }));
  }
```

(Add a small `parsePathArray` helper that converts the Postgres composite-type array into `AtomGraphPathStep[]`.)

- [ ] **Step 6: Run the test**

Run: `node --test --import tsx test/atom-graph-walker.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage/store.ts src/storage/memory-store.ts src/storage/postgres-store.ts test/atom-graph-walker.test.ts
git commit -m "feat(graph): walkAtomGraph (multi-hop with kind weights + decay)"
```

---

## Task 3: `ImpactPredictor`

**Files:**
- Create: `src/retrieval/impact-predictor.ts`
- Modify: `src/types.ts` (add `ImpactPrediction`)
- Test: `test/impact-predictor.test.ts`

- [ ] **Step 1: Add the type**

Edit `src/types.ts`:

```typescript
export interface ImpactPrediction {
  triggeredBy: { files?: string[]; symbols?: string[] };
  predictedAffected: Array<{
    target: { kind: 'file' | 'symbol' | 'atom'; value: string };
    confidence: number;
    via: Array<{ atomId: string; edgeKind: 'supersedes' | 'refines' | 'depends_on' | 'co_changes_with' | 'related_to' }>;
    why: string;
  }>;
  truncated: boolean;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/impact-predictor.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { predictImpact } from '../src/retrieval/impact-predictor.js';
import { DEFAULT_POLICY } from '../src/retrieval/policy.js';

test('predictImpact: returns affected atoms 1 hop from a file-evidence seed', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'tuberosa', claim: 'A', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/retrieval/fusion.ts' }],
    trigger: { files: ['src/retrieval/fusion.ts'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'tuberosa', claim: 'B', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/retrieval/policy.ts' }],
    trigger: { files: ['src/retrieval/policy.ts'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(a.id, [{
    fromAtomId: a.id, targetAtomId: b.id, relationType: 'co_changes_with', confidence: 0.8,
    inferenceSource: 'co_change',
  }], { source: 'co_change' });

  const result = await predictImpact(store, {
    project: 'tuberosa',
    files: ['src/retrieval/fusion.ts'],
    symbols: [],
    policy: DEFAULT_POLICY.graph,
  });

  assert.ok(result.predictedAffected.length >= 1);
  assert.equal(result.predictedAffected[0].target.kind, 'atom');
  assert.equal(result.predictedAffected[0].via[0].edgeKind, 'co_changes_with');
});

test('predictImpact: empty seeds return empty prediction', async () => {
  const store = new MemoryKnowledgeStore();
  const result = await predictImpact(store, {
    project: 'tuberosa', files: [], symbols: [], policy: DEFAULT_POLICY.graph,
  });
  assert.equal(result.predictedAffected.length, 0);
});

test('predictImpact: truncates to limit and sets truncated flag', async () => {
  const store = new MemoryKnowledgeStore();
  const seed = await store.createAtom({
    project: 'tuberosa', claim: 'seed', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/x.ts' }],
    trigger: { files: ['src/x.ts'] }, producedBy: 'agent_session',
  });
  const targets: string[] = [];
  for (let i = 0; i < 15; i += 1) {
    const t = await store.createAtom({
      project: 'tuberosa', claim: `t${i}`, type: 'fact',
      evidence: [{ kind: 'file', path: `src/t${i}.ts` }],
      trigger: { files: [`src/t${i}.ts`] }, producedBy: 'agent_session',
    });
    targets.push(t.id);
  }
  const links = targets.map((to) => ({
    fromAtomId: seed.id, targetAtomId: to, relationType: 'related_to' as const,
    confidence: 0.9, inferenceSource: 'manual' as const,
  }));
  await store.replaceAtomRelations(seed.id, links, { source: 'manual' });

  const result = await predictImpact(store, {
    project: 'tuberosa', files: ['src/x.ts'], symbols: [],
    policy: { ...DEFAULT_POLICY.graph, impactPredictionLimit: 10 },
  });
  assert.equal(result.predictedAffected.length, 10);
  assert.equal(result.truncated, true);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test --import tsx test/impact-predictor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `predictImpact`**

Create `src/retrieval/impact-predictor.ts`:

```typescript
import type { KnowledgeStore } from '../storage/store.js';
import type { ImpactPrediction } from '../types.js';

interface GraphPolicy {
  walkDepth: number;
  edgeWeights: Record<'supersedes'|'refines'|'depends_on'|'co_changes_with'|'related_to', number>;
  decayPerHop: number;
  impactPredictionLimit: number;
}

interface PredictImpactInput {
  project: string;
  files: string[];
  symbols: string[];
  policy: GraphPolicy;
  depth?: number;
}

export async function predictImpact(
  store: KnowledgeStore,
  input: PredictImpactInput,
): Promise<ImpactPrediction> {
  const result: ImpactPrediction = {
    triggeredBy: { files: input.files.length ? input.files : undefined, symbols: input.symbols.length ? input.symbols : undefined },
    predictedAffected: [],
    truncated: false,
  };
  if (input.files.length === 0 && input.symbols.length === 0) {
    return result;
  }
  // Step 1: find seed atoms whose evidence/trigger references inputs.
  const candidates = await store.searchAtomsByTrigger(
    { files: input.files, symbols: input.symbols },
    { project: input.project, limit: 50 } as never,
  );
  if (candidates.length === 0) return result;
  const seedAtomIds = candidates.map((a) => a.id);

  // Step 2: walk depth ≤ requested depth
  const depth = input.depth ?? input.policy.walkDepth;
  const hits = await store.walkAtomGraph({
    project: input.project,
    seedAtomIds,
    depth,
    edgeWeights: input.policy.edgeWeights,
    decayPerHop: input.policy.decayPerHop,
    limit: input.policy.impactPredictionLimit + 1,  // probe truncation
  });

  // Step 3: hydrate atoms for `target` field + `why`
  const aggregated = new Map<string, { confidenceSum: number; via: Array<{ atomId: string; edgeKind: string }>; why: string }>();
  for (const hit of hits) {
    const atom = await store.getAtom(hit.atomId);
    if (!atom) continue;
    const key = `atom:${atom.id}`;
    const existing = aggregated.get(key) ?? { confidenceSum: 0, via: [], why: '' };
    existing.confidenceSum += hit.pathScore;
    existing.via.push(...hit.path.map((step) => ({ atomId: step.atomId, edgeKind: step.edgeKind })));
    existing.why = existing.why || `${hit.path.length} hop(s) from a seed atom; path: ${hit.path.map((s) => s.edgeKind).join(' → ')}`;
    aggregated.set(key, existing);
  }

  const sortedKeys = [...aggregated.entries()].sort((a, b) => b[1].confidenceSum - a[1].confidenceSum);
  const limit = input.policy.impactPredictionLimit;
  result.truncated = sortedKeys.length > limit;

  for (const [key, entry] of sortedKeys.slice(0, limit)) {
    const id = key.replace(/^atom:/, '');
    const atom = await store.getAtom(id);
    if (!atom) continue;
    result.predictedAffected.push({
      target: { kind: 'atom', value: atom.claim },
      confidence: Math.min(1, entry.confidenceSum),
      via: entry.via as ImpactPrediction['predictedAffected'][number]['via'],
      why: entry.why,
    });
  }

  return result;
}
```

- [ ] **Step 5: Run the test**

Run: `node --test --import tsx test/impact-predictor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/retrieval/impact-predictor.ts src/types.ts test/impact-predictor.test.ts
git commit -m "feat(graph): ImpactPredictor — depth-bounded impact prediction over the atom graph"
```

---

## Task 4: Wire `predictImpact` into `searchContext`

**Files:**
- Modify: `src/retrieval/service.ts`
- Modify: `src/retrieval/context-pack.ts`
- Test: extend `test/impact-predictor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/impact-predictor.test.ts`:

```typescript
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { defaultConfig } from '../src/config.js';

test('searchContext: pack.impactPrediction populated for implementation taskType when graph exists', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'tuberosa', claim: 'A', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/x.ts' }],
    trigger: { files: ['src/x.ts'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'tuberosa', claim: 'B', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/y.ts' }],
    trigger: { files: ['src/y.ts'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(a.id, [{
    fromAtomId: a.id, targetAtomId: b.id, relationType: 'co_changes_with', confidence: 0.7,
    inferenceSource: 'co_change',
  }], { source: 'co_change' });

  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), defaultConfig());
  const pack = await service.searchContext({
    project: 'tuberosa', prompt: 'refactor src/x.ts',
    files: ['src/x.ts'], taskType: 'implementation',
  });

  assert.ok(pack.impactPrediction);
  assert.ok((pack.impactPrediction?.predictedAffected.length ?? 0) >= 1);
});

test('searchContext: pack.impactPrediction is undefined for exploration taskType', async () => {
  const store = new MemoryKnowledgeStore();
  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), defaultConfig());
  const pack = await service.searchContext({
    project: 'tuberosa', prompt: 'how does X work', files: ['src/x.ts'],
    taskType: 'exploration',
  });
  assert.equal(pack.impactPrediction, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/impact-predictor.test.ts`
Expected: FAIL — `pack.impactPrediction` is undefined.

- [ ] **Step 3: Wire predictor into `searchContext`**

Edit `src/retrieval/service.ts`. After `classifyQuery` and before `findCandidates`, compute impact prediction when the task type qualifies:

```typescript
import { predictImpact } from './impact-predictor.js';

// after fitEvaluation and reviewTargetResolution, before buildContextPack:
const QUALIFYING = new Set(['implementation', 'refactor', 'debugging']);
let impactPrediction: ImpactPrediction | undefined;
if (QUALIFYING.has(rewriteResult.classified.taskType ?? '')) {
  impactPrediction = await predictImpact(this.store, {
    project: project ?? '',
    files: rewriteResult.classified.files,
    symbols: rewriteResult.classified.symbols,
    policy: getRetrievalPolicy().graph,
  });
  if (impactPrediction.predictedAffected.length === 0) impactPrediction = undefined;
}

const pack = this.buildContextPack({
  /* … */
  impactPrediction,
});
```

Edit `src/retrieval/context-pack.ts`. Add `impactPrediction?: ImpactPrediction` to `ContextPack` (already added in types). In `assembleContextPack`, accept and attach:

```typescript
return {
  /* … */
  impactPrediction: input.impactPrediction,
};
```

- [ ] **Step 4: Run the test**

Run: `node --test --import tsx test/impact-predictor.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the retrieval eval to confirm no regression**

Run: `pnpm run eval:retrieval`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/retrieval/service.ts src/retrieval/context-pack.ts test/impact-predictor.test.ts
git commit -m "feat(graph): attach impactPrediction to ContextPack for impl/refactor/debugging"
```

---

## Task 5: Multi-hop walk as a fusion source

**Files:**
- Modify: `src/retrieval/service.ts`
- Modify: `src/retrieval/policy.ts` (optional: add `sourceWeights.graphWalk`)
- Test: extend `test/atoms-retrieval.test.ts`

The existing `searchGraphRelations` already walks 1 hop on `knowledge_relations`. With atoms added, we extend the walker output into the same `graph` candidate group fusion already consumes. No new fusion source — just teach the existing graph search to return atom hits too.

- [ ] **Step 1: Write the failing test**

Append to `test/atoms-retrieval.test.ts`:

```typescript
test('retrieval: depth-2 atom hit appears in pack with graphPath/matchReasons', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'tuberosa', claim: 'seed', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/x.ts' }],
    trigger: { files: ['src/x.ts'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'tuberosa', claim: 'sibling', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/y.ts' }],
    trigger: { files: ['src/y.ts'] }, producedBy: 'agent_session',
  });
  const c = await store.createAtom({
    project: 'tuberosa', claim: 'two-hop', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/z.ts' }],
    trigger: { files: ['src/z.ts'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(a.id, [{
    fromAtomId: a.id, targetAtomId: b.id, relationType: 'refines', confidence: 0.9,
    inferenceSource: 'semantic',
  }], { source: 'semantic' });
  await store.replaceAtomRelations(b.id, [{
    fromAtomId: b.id, targetAtomId: c.id, relationType: 'related_to', confidence: 0.8,
    inferenceSource: 'semantic',
  }], { source: 'semantic' });

  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), defaultConfig());
  const pack = await service.searchContext({
    project: 'tuberosa', prompt: 'something about src/x.ts',
    files: ['src/x.ts'], taskType: 'implementation',
  });
  const ids = pack.sections.flatMap((s) => s.items.map((i) => i.knowledgeId));
  assert.ok(ids.includes(c.id), `expected depth-2 atom to surface, got ${ids.join(',')}`);
});
```

- [ ] **Step 2: Implement**

Edit `src/retrieval/service.ts`. In `findCandidates`, after the existing `searchGraphRelations` call, also call `store.walkAtomGraph` seeded from the **atom ids** present in the metadata/lexical/memory/vector/worktree results. Merge those hits into the `graph` candidate list with `source='graph'` and `matchReasons` listing the edge kinds:

```typescript
const seedAtomIds = uniqueStrings([
  ...safeResults.metadata, ...safeResults.lexical, ...safeResults.memory, ...safeResults.vector, ...safeResults.worktree,
].filter((c) => c.itemType === 'memory' && (c.metadata as { atomTier?: string } | undefined)?.atomTier)
 .map((c) => c.knowledgeId));

if (seedAtomIds.length > 0) {
  const hits = await this.store.walkAtomGraph({
    project: project ?? '',
    seedAtomIds,
    depth: getRetrievalPolicy().graph.walkDepth,
    edgeWeights: getRetrievalPolicy().graph.edgeWeights,
    decayPerHop: getRetrievalPolicy().graph.decayPerHop,
    limit: SEARCH_LIMIT,
  });
  const atomHits = await Promise.all(hits.map(async (h) => {
    const atom = await this.store.getAtom(h.atomId);
    if (!atom) return null;
    return {
      knowledgeId: atom.id,
      source: 'graph' as const,
      rank: 1,
      rawScore: h.pathScore,
      title: atom.claim,
      summary: atom.claim,
      itemType: 'memory' as const,
      project: atom.project,
      labels: [],
      references: [],
      content: atom.claim,
      contextualContent: atom.claim,
      tokenEstimate: Math.ceil(atom.claim.length / 4),
      metadata: { atomTier: atom.tier, graphPath: h.path },
      matchReasons: [`graph:${h.path.map((s) => s.edgeKind).join('→')}`],
    };
  }));
  safeResults.graph = [...safeResults.graph, ...atomHits.filter((x): x is NonNullable<typeof x> => Boolean(x))];
}
```

(`matchReasons` is already a field on candidates; if not, follow the existing place where it's set.)

- [ ] **Step 3: Run the test**

Run: `node --test --import tsx test/atoms-retrieval.test.ts`
Expected: PASS, including all previous cases.

- [ ] **Step 4: Run retrieval eval**

Run: `pnpm run eval:retrieval`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/service.ts test/atoms-retrieval.test.ts
git commit -m "feat(graph): seed atom-graph walk from search results and merge depth-2 hits"
```

---

## Task 6: `tuberosa_predict_impact` MCP tool + HTTP endpoint

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/http/server.ts`
- Test: append to `test/impact-predictor.test.ts`

- [ ] **Step 1: Register MCP tool**

```typescript
  server.registerTool('tuberosa_predict_impact', {
    description: 'Predict which atoms/files are likely affected by edits to the given files or symbols. Walks the atom graph depth ≤ 2.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        symbols: { type: 'array', items: { type: 'string' } },
        depth: { type: 'number', default: 2 },
      },
      required: ['project'],
    },
  }, async ({ project, files = [], symbols = [], depth }) => {
    const prediction = await predictImpact(store, {
      project, files, symbols,
      policy: getRetrievalPolicy().graph,
      depth: depth ?? getRetrievalPolicy().graph.walkDepth,
    });
    return { content: [{ type: 'text', text: JSON.stringify(prediction, null, 2) }] };
  });
```

- [ ] **Step 2: Register HTTP route**

```typescript
  app.post('/operations/atom-graph/impact', requireAuth, async (req, res) => {
    const { project, files = [], symbols = [], depth } = req.body ?? {};
    if (typeof project !== 'string') return res.status(400).json({ error: 'project required' });
    const prediction = await predictImpact(store, {
      project, files, symbols,
      policy: getRetrievalPolicy().graph,
      depth: depth ?? getRetrievalPolicy().graph.walkDepth,
    });
    res.json(prediction);
  });
```

- [ ] **Step 3: Append `instruction` to `tuberosa_search_context` result**

Where `tuberosa_search_context` returns its result, when `pack.impactPrediction?.predictedAffected.length > 0`:

```typescript
const top = pack.impactPrediction.predictedAffected.slice(0, 3).map((p) => p.target.value).join(', ');
result.instruction = (result.instruction ? result.instruction + '\n' : '')
  + `May affect: ${top}${pack.impactPrediction.truncated ? ' …' : ''}. Call tuberosa_predict_impact for full list.`;
```

- [ ] **Step 4: Smoke-test the route**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/http/server.ts test/impact-predictor.test.ts
git commit -m "feat(graph): tuberosa_predict_impact MCP tool + HTTP route + search_context hint"
```

---

## Task 7: Atom-graph JSONL export hook (for concern E)

**Files:**
- Create: `src/operations/atom-graph-export.ts`
- Modify: `src/http/server.ts`
- Test: `test/atom-graph-export.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/atom-graph-export.test.ts`:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { streamAtomGraphJsonl } from '../src/operations/atom-graph-export.js';

test('streamAtomGraphJsonl: emits one JSONL record per atom with outboundEdges', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'tuberosa', claim: 'A', type: 'fact',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'tuberosa', claim: 'B', type: 'fact',
    evidence: [{ kind: 'file', path: 'y.ts' }],
    trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(a.id, [{
    fromAtomId: a.id, targetAtomId: b.id, relationType: 'related_to', confidence: 0.7, inferenceSource: 'semantic',
  }], { source: 'semantic' });
  const records: string[] = [];
  for await (const line of streamAtomGraphJsonl(store, { project: 'tuberosa' })) {
    records.push(line);
  }
  assert.equal(records.length, 2);
  const parsed = records.map((r) => JSON.parse(r));
  const aRecord = parsed.find((r) => r.atom.claim === 'A');
  assert.ok(aRecord);
  assert.equal(aRecord.outboundEdges.length, 1);
  assert.equal(aRecord.outboundEdges[0].kind, 'related_to');
});
```

- [ ] **Step 2: Implement**

Create `src/operations/atom-graph-export.ts`:

```typescript
import type { KnowledgeStore } from '../storage/store.js';

export async function* streamAtomGraphJsonl(
  store: KnowledgeStore,
  options: { project: string },
): AsyncIterable<string> {
  const atoms = await store.listAtoms({ project: options.project, limit: 10000 });
  for (const atom of atoms) {
    const edges = await store.listAtomRelations({ fromAtomId: atom.id, limit: 50 });
    const record = {
      atom: {
        id: atom.id,
        claim: atom.claim,
        type: atom.type,
        tier: atom.tier,
        status: atom.status,
        trigger: atom.trigger,
        evidence: atom.evidence,
      },
      outboundEdges: edges.map((e) => ({
        toAtomId: e.targetAtomId,
        kind: e.relationType,
        confidence: e.confidence,
        inferenceSource: e.inferenceSource,
      })),
    };
    yield JSON.stringify(record);
  }
}
```

- [ ] **Step 3: Register HTTP route**

```typescript
  app.get('/operations/organization/atom-graph.jsonl', requireAuth, async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).send('project required\n');
    res.setHeader('Content-Type', 'application/x-ndjson');
    for await (const line of streamAtomGraphJsonl(store, { project })) {
      res.write(line + '\n');
    }
    res.end();
  });
```

- [ ] **Step 4: Run the test**

Run: `node --test --import tsx test/atom-graph-export.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operations/atom-graph-export.ts src/http/server.ts test/atom-graph-export.test.ts
git commit -m "feat(graph): atom-graph JSONL export endpoint (input for concern E)"
```

---

## Task 8: Eval fixtures

**Files:**
- Modify: `eval/retrieval-fixtures.json`

- [ ] **Step 1: Add fixtures**

```jsonc
{
  "name": "graph: impactPrediction populated for implementation task with linked atoms",
  "ingest": {
    "atoms": [
      { "claim": "fusion atom",   "type": "fact", "evidence": [{"kind":"file","path":"src/retrieval/fusion.ts"}], "trigger": {"files":["src/retrieval/fusion.ts"]}, "tier": "verified" },
      { "claim": "policy atom",   "type": "fact", "evidence": [{"kind":"file","path":"src/retrieval/policy.ts"}], "trigger": {"files":["src/retrieval/policy.ts"]}, "tier": "verified" }
    ],
    "edges": [{ "fromClaim": "fusion atom", "toClaim": "policy atom", "kind": "co_changes_with", "confidence": 0.7 }]
  },
  "query": { "prompt": "refactor src/retrieval/fusion.ts", "files": ["src/retrieval/fusion.ts"], "taskType": "implementation" },
  "expect": { "impactPredictionContains": ["policy atom"] }
},
{
  "name": "graph: depth-2 hit appears in pack with matchReasons graph:refines→related_to",
  "ingest": {
    "atoms": [
      { "claim": "A", "type": "fact", "evidence": [{"kind":"file","path":"x.ts"}], "trigger": {"files":["x.ts"]}, "tier": "verified" },
      { "claim": "B", "type": "fact", "evidence": [{"kind":"file","path":"y.ts"}], "trigger": {"files":["y.ts"]}, "tier": "verified" },
      { "claim": "C", "type": "fact", "evidence": [{"kind":"file","path":"z.ts"}], "trigger": {"files":["z.ts"]}, "tier": "verified" }
    ],
    "edges": [
      { "fromClaim": "A", "toClaim": "B", "kind": "refines",    "confidence": 0.9 },
      { "fromClaim": "B", "toClaim": "C", "kind": "related_to", "confidence": 0.8 }
    ]
  },
  "query": { "prompt": "something about x.ts", "files": ["x.ts"], "taskType": "implementation" },
  "expect": { "matchReasonsContain": "graph:refines→related_to" }
}
```

Extend the runner to support `impactPredictionContains` and `matchReasonsContain`.

- [ ] **Step 2: Run the eval**

Run: `pnpm run eval:retrieval`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add eval/retrieval-fixtures.json eval/retrieval.ts
git commit -m "test(graph): C2 fixtures for impact prediction + depth-2 graph walk"
```

---

## Task 9: Final verification

- [ ] **Step 1: Full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 2: Retrieval eval**

Run: `pnpm run eval:retrieval`
Expected: PASS.

- [ ] **Step 3: Agent-context eval**

Run: `pnpm run eval:agent-context`
Expected: PASS.

- [ ] **Step 4: Integration tests if Docker is up**

Run: `pnpm run test:integration`
Expected: PASS or skipped.

- [ ] **Step 5: Smoke-test the impact endpoint live**

```bash
curl -s -X POST http://localhost:3027/operations/atom-graph/impact \
  -H 'Content-Type: application/json' \
  -d '{"project":"tuberosa","files":["src/retrieval/fusion.ts"]}' | jq
```
Expected: JSON `ImpactPrediction` (may be empty until atoms accumulate; non-empty after C1 + sessions).

- [ ] **Step 6: Smoke-test the JSONL export**

```bash
curl -s 'http://localhost:3027/operations/organization/atom-graph.jsonl?project=tuberosa' | head -5
```
Expected: One JSON-per-line, each with `atom` and `outboundEdges`.

- [ ] **Step 7: Commit any final touch-ups**

```bash
git add -A
git commit -m "test(graph): green eval suite after C2"
```

---

## Follow-up (deferred)

- **Edge-weight calibration** via sandbox/ablation runs once C2 is producing telemetry. Today's values are placeholders.
- **Workbench atom-graph visualization.** Backend ships here; UI is a separate task.
- **Path explanation in `why`.** Currently terse ("2 hop(s) from a seed atom"). An LLM pass that turns `path` into a natural-language reason is a follow-up.
- **Cross-project impact propagation** — F's concern. C2 stays single-project.
- **Per-target deduplication of `via`** (currently we list every step from every path; collapsing to a single best-path per target is a polish item).
