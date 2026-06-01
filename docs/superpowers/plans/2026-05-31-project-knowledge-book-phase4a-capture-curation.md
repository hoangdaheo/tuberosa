# Project Knowledge-Book — Phase 4a (Capture & Curation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Fresh-session note:** Needs only this file + the master spec (`docs/superpowers/specs/2026-05-31-project-knowledge-book-design.md`, §7 lifecycle, §8 gate) + the repo. Phases 1–3 shipped (`scope:'team'`, `teamId`, convention retrieval lane, pinning, `resolveLayeredConflicts`, `start_session.handbook`, `conventions.md` handbook view). Branch off the latest knowledge-book branch or `main`. **Phase 4b (bootstrap) is a separate plan** — do this one first.

**Goal:** Turn accumulated raw atoms into curated, scoped convention atoms via an agent-driven loop: `tuberosa_propose_curation` clusters un-curated atoms and hands them to the calling agent; the agent distills each cluster into a convention via `tuberosa_reflect`; on approval the draft becomes a `type:'convention'` atom; a `distillation_evidence` gate enforces quality; `finish_session` nudges curation when atoms pile up.

**Architecture (key constraint):** Tuberosa's `ModelProvider` has NO text-generation seam (only embed/rewriteQuery/rerank), so ALL distillation/abstraction reasoning is done by the **calling agent**. Tuberosa only: (1) clusters candidates with deterministic write-gate math, (2) gates the resulting drafts, (3) persists the verdict as a convention atom. Reuse the existing reflection-draft → approve → ingest pipeline; add a branch that creates a convention *atom* instead of `StoredKnowledge` when the draft is a convention.

**Tech Stack:** TypeScript (Node 22, ESM, `.js` suffixes; tests import `.js`), `node --test` + `tsx`. Stores: `MemoryKnowledgeStore` (tests) + `PostgresKnowledgeStore`.

> **Before coding:** `npx gitnexus analyze`. After ANY change to `src/reflection/` run `pnpm run eval:retrieval` (the learning-gate eval `eval:agent-context` may also apply — run `pnpm run eval:agent-context` if it exists). Keep `pnpm run build && pnpm test` green at every commit. NEVER lower a gate threshold to pass.

## Convention metadata contract (used across tasks)
A convention atom is `type:'convention'` with `metadata`:
```
scope-derived: stored via the atom's `scope` column (project|team|user) — NOT metadata
category?: string                 // 'code_style' | 'testing' | ... | 'other'
steps?: string[]                  // ordered checklist
author?: string
trigger lives in the atom's `trigger` column (errors/files/symbols/taskTypes)
curated?: true                    // marks a hand/agent-curated convention
curationSource?: 'curation' | 'bootstrap' | 'manual'
evidenceAtomIds?: string[]        // source atoms this was distilled from
```
A SOURCE atom that has been distilled gets `metadata.distilledIntoAtomId = <conventionAtomId>` so it isn't re-clustered. These are free-form `metadata` (jsonb already exists) — **no migration**.

---

### Task 1: Curation clustering module (pure)

**Files:**
- Create: `src/curation/cluster.ts`
- Test: `test/curation-cluster.test.ts`

**Read first:** `src/reflection/write-gate.ts:211-252` — the `cosineSimilarity`, `jaccardLabelOverlap`, `jaccard` helpers and thresholds (`COSINE_NEAR_THRESHOLD=0.8`, `LABEL_NEAR_THRESHOLD=0.5`). `src/types/atoms.ts` for `KnowledgeAtom` (has `embedding`? — check; atoms store an embedding via `createAtom` input but the stored atom may not expose it. If atom embeddings aren't readable, cluster on label/trigger Jaccard alone for v1 and note it).

- [ ] **Step 1:** Write `test/curation-cluster.test.ts` first. Define `clusterUncuratedAtoms(atoms: KnowledgeAtom[], opts?): AtomCluster[]` where a cluster groups atoms with high label/trigger overlap (and cosine if embeddings available). Test: 3 atoms about React memoization (overlapping symbols/files) cluster together; an unrelated atom stays singleton; atoms already carrying `metadata.distilledIntoAtomId` are excluded. Assert cluster membership. FAIL first.

- [ ] **Step 2:** Implement `src/curation/cluster.ts` as PURE functions reusing the write-gate math (import or re-export the helpers; if they're not exported, lift the small `jaccard` helper into a shared `src/curation/similarity.ts` and have BOTH write-gate and curation import it — but only if clean; otherwise duplicate the tiny helper with a comment). Cluster by: same task-type/business-area + Jaccard(label/trigger keys) ≥ 0.5. Exclude atoms with `metadata.distilledIntoAtomId`. Return `AtomCluster { atoms: KnowledgeAtom[]; sharedTrigger: Trigger; suggestedScope: 'project' }` (scope defaults project; agent/human can promote to team later).

- [ ] **Step 3:** Test PASS; `pnpm run build && pnpm test` green. **Commit:** `feat(curation): pure clustering of un-curated atoms`.

---

### Task 2: `distillation_evidence` hard gate

**Files:**
- Modify: `src/reflection/recommendation.ts` (`GateKey` ~14-26, `HARD_GATES` ~73-78, `evaluateGates` ~80-95; add `gateDistillationEvidence`)
- Test: `test/distillation-evidence-gate.test.ts`

**Read first:** `recommendation.ts:289-311` (`gateGroundedReferences`) as the model for a hard gate; the `EvaluateGatesInput` / `ReflectionDraft` shapes (esp. `draft.metadata`, `draft.references`).

The gate passes only when the draft is a convention with: `metadata.steps` non-empty, a non-empty trigger (the draft carries trigger in metadata or labels), AND `metadata.evidenceAtomIds.length >= 2` (a rule generalizes ≥2 atoms). For NON-convention drafts the gate is a no-op `pass` (so existing learning is unaffected).

- [ ] **Step 1:** Write `test/distillation-evidence-gate.test.ts`. Cases: convention draft with 2 evidence atom ids + steps + trigger → `pass`; convention draft with 1 evidence atom → `fail` (hard); convention draft with empty steps → `fail`; a normal (non-convention) draft → `pass` (no-op). Call `evaluateGates(...)` and find the `distillation_evidence` result. FAIL first (key doesn't exist).

- [ ] **Step 2:** Add `'distillation_evidence'` to the `GateKey` union and to `HARD_GATES`. Add `gateDistillationEvidence(input)` to the `evaluateGates` return array, modeled on `gateGroundedReferences`:
```typescript
function gateDistillationEvidence(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'distillation_evidence';
  const severity: GateSeverity = 'hard';
  const meta = (input.draft.metadata ?? {}) as Record<string, unknown>;
  const isConvention = meta.convention === true;
  if (!isConvention) {
    return { key, status: 'pass', severity, label: 'Distillation evidence', message: 'Not a distilled convention — gate not applicable.' };
  }
  const steps = Array.isArray(meta.steps) ? meta.steps : [];
  const evidenceAtomIds = Array.isArray(meta.evidenceAtomIds) ? meta.evidenceAtomIds : [];
  const hasTrigger = !!meta.trigger && Object.values(meta.trigger as Record<string, unknown>).some((v) => Array.isArray(v) && v.length > 0);
  if (steps.length > 0 && evidenceAtomIds.length >= 2 && hasTrigger) {
    return { key, status: 'pass', severity, label: 'Distillation evidence', message: `Convention generalizes ${evidenceAtomIds.length} atoms with ${steps.length} step(s) and a trigger.` };
  }
  return { key, status: 'fail', severity, label: 'Distillation evidence',
    message: `Convention needs ≥2 source atoms (got ${evidenceAtomIds.length}), non-empty steps (got ${steps.length}), and a trigger (${hasTrigger ? 'present' : 'missing'}).` };
}
```

- [ ] **Step 3:** Test PASS. `pnpm run build && pnpm test` green; `pnpm run eval:retrieval` green (gate is a no-op for non-conventions, so existing learning eval unaffected — verify). **Commit:** `feat(reflection): add distillation_evidence hard gate for convention drafts`.

---

### Task 3: Convention-draft → convention-atom approval path

**Files:**
- Modify: `src/reflection/service.ts` (`approveDraft` ~91-118)
- Test: `test/convention-draft-approval.test.ts`

**Read first:** `reflection/service.ts:91-118` (`approveDraft` — currently always calls `ingestion.ingestKnowledge`) and `:172-188` (`reviewDraft`). `src/storage/store.ts` `createAtom` signature.

When an approved draft is a convention (`metadata.convention === true`), create a `type:'convention'` atom instead of (or in addition to) `ingestKnowledge`, and stamp source atoms.

- [ ] **Step 1:** Write `test/convention-draft-approval.test.ts` using `ReflectionService` + `MemoryKnowledgeStore` (copy boilerplate from an existing reflection test). Create a draft with `metadata: { convention: true, scope: 'project', category: 'code_style', steps: ['...'], trigger: { taskTypes:['implementation'] }, evidenceAtomIds: [a1,a2] }`, approve it, then assert: a `type:'convention'` atom now exists (`store.listAtoms({ project, limit })` filtered to type convention) with `scope:'project'`, `metadata.curated===true`, `metadata.category==='code_style'`, `metadata.steps` set; AND the two source atoms `a1`/`a2` now carry `metadata.distilledIntoAtomId === <new atom id>`. FAIL first (no atom created today).

- [ ] **Step 2:** In `approveDraft`, after fetching the approved draft, branch:
```typescript
const meta = (draft.metadata ?? {}) as Record<string, unknown>;
if (meta.convention === true) {
  const scope = (meta.scope as 'project' | 'team' | 'user') ?? 'project';
  const created = await this.store.createAtom({
    project, type: 'convention', claim: draft.title,
    evidence: [], // map draft.references → evidence if helpful
    trigger: (meta.trigger as Trigger) ?? {},
    producedBy: 'reviewer',
    scope,
    teamId: scope === 'team' ? (meta.teamId as string | undefined) : undefined,
    tier: 'verified',
    metadata: { convention: true, curated: true, curationSource: (meta.curationSource as string) ?? 'curation',
      category: meta.category, steps: meta.steps, author: meta.author, evidenceAtomIds: meta.evidenceAtomIds },
  });
  // stamp source atoms so they aren't re-clustered
  for (const srcId of (meta.evidenceAtomIds as string[] | undefined) ?? []) {
    const src = await this.store.getAtom(srcId);
    if (src) await this.store.updateAtom?.(srcId, { metadata: { ...src.metadata, distilledIntoAtomId: created.id } });
  }
  return draft;
}
// else: existing ingestKnowledge path (unchanged)
```
> Verify the store has an atom-metadata update method (`updateAtom`/`patchAtom` — grep `src/storage/store.ts`). If none exists, add a minimal `updateAtomMetadata(id, metadata)` to the `KnowledgeStore` interface + both stores (TDD it as a sub-step). `createAtom` accepts `scope`/`teamId`/`metadata` (Phase 1). Confirm `producedBy:'reviewer'` is a valid `AtomProducer` — if not, use an allowed value.

- [ ] **Step 3:** Test PASS. `pnpm run build && pnpm test` green. **Commit:** `feat(reflection): approve convention drafts into scoped convention atoms`.

---

### Task 4: `tuberosa_propose_curation` tool + curation service

**Files:**
- Create: `src/curation/service.ts` (`CurationService.proposeCuration`)
- Modify: `src/mcp/server.ts` (handler ~register near `tuberosa_reflect` 165-172; schema near 1180-1205); the services wiring (where `services.reflection`/`services.operations` are constructed — grep `new ReflectionService` / the services object)
- Test: `test/curation-service.test.ts` + an MCP dispatch test (mirror an existing one)

**Read first:** `src/mcp/server.ts:165-172` (handler pattern) + `:1180-1205` (schema pattern) for `tuberosa_reflect`; how `services` is built (grep `services.reflection`).

- [ ] **Step 1:** Write `test/curation-service.test.ts`: seed several un-curated atoms (some clustering, some not) for a project; `CurationService.proposeCuration({ project, limit })` returns `{ clusters: AtomCluster[], instruction: string }` where clustered atoms are grouped and already-distilled atoms (`metadata.distilledIntoAtomId`) are excluded. FAIL first.

- [ ] **Step 2:** Implement `src/curation/service.ts`: `proposeCuration` calls `store.listAtoms({ project, status:'active', limit })`, drops atoms with `metadata.distilledIntoAtomId` or `type==='convention'`, runs `clusterUncuratedAtoms` (Task 1), and returns clusters + an `instruction` telling the agent to distill each cluster into a convention via `tuberosa_reflect` with `metadata.convention=true, scope, category, steps, trigger, evidenceAtomIds=[cluster atom ids]`. PURE of model calls (clustering is deterministic).

- [ ] **Step 3:** Register `tuberosa_propose_curation` in `src/mcp/server.ts` (handler + schema), mirroring `tuberosa_reflect`. Wire a `CurationService` into the `services` object. Add an MCP dispatch test mirroring an existing tool-dispatch test.

- [ ] **Step 4:** `pnpm run build && pnpm test` green; `pnpm run eval:retrieval` green. **Commit:** `feat(curation): tuberosa_propose_curation tool + clustering service`.

---

### Task 5: `finish_session` curation nudge

**Files:**
- Modify: `src/types/session.ts` (`AgentSessionFinishResult`), `src/agent-session/service.ts` (`finishSession` ~125-192), `src/mcp/server.ts` (the finish_session handler — confirm it passes the field through)
- Test: `test/session-curation-nudge.test.ts`

**Read first:** `agent-session/service.ts:125-192` (`finishSession` return) and the `AgentSessionFinishResult` type.

- [ ] **Step 1:** Write `test/session-curation-nudge.test.ts`: a project with ≥ threshold (e.g. 3) un-curated atoms → finish result has `curationNudge.count >= 3` and a non-empty `prompt`/`toolCall`. Below threshold → `curationNudge` undefined. FAIL first.

- [ ] **Step 2:** Add `curationNudge?: { count: number; prompt: string; toolCall: string }` to `AgentSessionFinishResult`. In `finishSession`, before returning, count un-curated atoms (`store.listAtoms({ project, status:'active', limit })` minus `metadata.distilledIntoAtomId`/`type==='convention'`); if `>= CURATION_NUDGE_THRESHOLD` (const, e.g. 5), set `curationNudge`. Keep it informational only (never auto-runs). Also surface the same nudge from `start_session` if cheap (optional; the master spec wants both — can defer start_session nudge to a follow-up). Ensure the MCP finish_session handler returns the field.

- [ ] **Step 3:** Test PASS; `pnpm run build && pnpm test` green. **Commit:** `feat(session): nudge curation when un-curated atoms exceed threshold`.

---

## Phase 4a Definition of Done
- `clusterUncuratedAtoms` groups related un-curated atoms deterministically.
- `distillation_evidence` hard gate blocks weak convention drafts (≥2 evidence atoms, steps, trigger); no-op for non-conventions.
- Approving a convention draft creates a scoped `type:'convention'` atom and stamps source atoms `distilledIntoAtomId`.
- `tuberosa_propose_curation` returns clusters + a distillation instruction; the agent writes conventions back via `tuberosa_reflect`.
- `finish_session` emits a `curationNudge` past a threshold.
- `pnpm run build && pnpm test && pnpm run eval:retrieval` green.

## Governance note (confirm against master spec §8)
v1 routes convention approval through the existing reflection review (manual approve). The spec wants **project-scope conventions that pass gates to auto-activate**, **team-scope to require review**. Implement auto-approval-for-project as a refinement: after `createDraft` for a convention, if `scope==='project'` and `evaluateGates` has no hard failures, call `approveDraft` automatically; team scope stays pending. Add this in Task 3 or as a 6th task if it grows.

## Risks
| Risk | Mitigation |
|---|---|
| Atom embeddings not readable for cosine clustering | Cluster on label/trigger Jaccard for v1; note cosine as enhancement. |
| `updateAtom`/metadata-patch method missing | Add a minimal `updateAtomMetadata` to the store interface + both impls (TDD). |
| Gate accidentally blocks normal learning | `distillation_evidence` is a no-op unless `metadata.convention===true`; eval:agent-context must stay green. |
| `producedBy:'reviewer'` not a valid AtomProducer | Check `AtomProducer` union; use an allowed value. |
