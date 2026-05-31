import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { predictImpact } from '../src/retrieval/impact-predictor.js';
import { DEFAULT_POLICY, resetRetrievalPolicyCache, setRetrievalPolicy } from '../src/retrieval/policy.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { loadConfig } from '../src/config.js';

async function makeAtom(store: MemoryKnowledgeStore, claim: string, file: string) {
  return store.createAtom({
    project: 'tuberosa',
    claim,
    type: 'fact',
    evidence: [{ kind: 'file', path: file }],
    trigger: { files: [file] },
    producedBy: 'agent_session',
  });
}

test('predictImpact: returns affected atoms 1 hop from a file-evidence seed', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await makeAtom(store, 'fusion atom', 'src/retrieval/fusion.ts');
  const b = await makeAtom(store, 'policy atom', 'src/retrieval/policy.ts');
  await store.replaceAtomRelations(
    a.id,
    [{
      fromAtomId: a.id,
      targetAtomId: b.id,
      relationType: 'co_changes_with',
      confidence: 0.8,
      inferenceSource: 'co_change',
    }],
    { source: 'co_change' },
  );

  const result = await predictImpact(store, {
    project: 'tuberosa',
    files: ['src/retrieval/fusion.ts'],
    symbols: [],
    policy: DEFAULT_POLICY.graph,
  });

  assert.ok(result.predictedAffected.length >= 1);
  assert.equal(result.predictedAffected[0]!.target!.kind, 'atom');
  assert.equal(result.predictedAffected[0]!.target!.value, 'policy atom');
  assert.equal(result.predictedAffected[0]!.via[0]!.edgeKind, 'co_changes_with');
  assert.deepEqual(result.triggeredBy.files, ['src/retrieval/fusion.ts']);
});

test('predictImpact: empty seeds return empty prediction', async () => {
  const store = new MemoryKnowledgeStore();
  const result = await predictImpact(store, {
    project: 'tuberosa',
    files: [],
    symbols: [],
    policy: DEFAULT_POLICY.graph,
  });
  assert.equal(result.predictedAffected.length, 0);
  assert.equal(result.truncated, false);
});

test('predictImpact: no matching atoms returns empty prediction', async () => {
  const store = new MemoryKnowledgeStore();
  await makeAtom(store, 'unrelated', 'src/unrelated.ts');
  const result = await predictImpact(store, {
    project: 'tuberosa',
    files: ['src/does-not-exist.ts'],
    symbols: [],
    policy: DEFAULT_POLICY.graph,
  });
  assert.equal(result.predictedAffected.length, 0);
});

test('predictImpact: truncates to limit and sets truncated flag', async () => {
  const store = new MemoryKnowledgeStore();
  const seed = await makeAtom(store, 'seed', 'src/x.ts');
  const targetIds: string[] = [];
  for (let i = 0; i < 15; i += 1) {
    const t = await makeAtom(store, `t${i}`, `src/t${i}.ts`);
    targetIds.push(t.id);
  }
  await store.replaceAtomRelations(
    seed.id,
    targetIds.map((id) => ({
      fromAtomId: seed.id,
      targetAtomId: id,
      relationType: 'related_to' as const,
      confidence: 0.9,
      inferenceSource: 'manual' as const,
    })),
    { source: 'manual' },
  );

  const result = await predictImpact(store, {
    project: 'tuberosa',
    files: ['src/x.ts'],
    symbols: [],
    policy: { ...DEFAULT_POLICY.graph, impactPredictionLimit: 10 },
  });
  assert.equal(result.predictedAffected.length, 10);
  assert.equal(result.truncated, true);
});

test('predictImpact: depth=1 ignores 2-hop targets', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await makeAtom(store, 'A', 'src/x.ts');
  const b = await makeAtom(store, 'B', 'src/y.ts');
  const c = await makeAtom(store, 'C', 'src/z.ts');
  await store.replaceAtomRelations(
    a.id,
    [{
      fromAtomId: a.id,
      targetAtomId: b.id,
      relationType: 'refines',
      confidence: 0.9,
      inferenceSource: 'manual',
    }],
    { source: 'manual' },
  );
  await store.replaceAtomRelations(
    b.id,
    [{
      fromAtomId: b.id,
      targetAtomId: c.id,
      relationType: 'related_to',
      confidence: 0.8,
      inferenceSource: 'manual',
    }],
    { source: 'manual' },
  );

  const result = await predictImpact(store, {
    project: 'tuberosa',
    files: ['src/x.ts'],
    symbols: [],
    policy: DEFAULT_POLICY.graph,
    depth: 1,
  });
  const values = result.predictedAffected.map((p) => p.target.value);
  assert.ok(values.includes('B'));
  assert.ok(!values.includes('C'));
});

test('searchContext: pack.impactPrediction populated for implementation taskType when graph exists', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const a = await makeAtom(store, 'A', 'src/x.ts');
  const b = await makeAtom(store, 'B', 'src/y.ts');
  await store.replaceAtomRelations(
    a.id,
    [{
      fromAtomId: a.id,
      targetAtomId: b.id,
      relationType: 'co_changes_with',
      confidence: 0.7,
      inferenceSource: 'co_change',
    }],
    { source: 'co_change' },
  );

  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), loadConfig());
  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'refactor src/x.ts',
    files: ['src/x.ts'],
    taskType: 'implementation',
  });

  assert.ok(pack.impactPrediction, 'expected impactPrediction to be populated');
  assert.ok((pack.impactPrediction.predictedAffected.length ?? 0) >= 1);
});

test('searchContext: pack.impactPrediction is undefined for exploration taskType', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  await makeAtom(store, 'unrelated', 'src/x.ts');
  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), loadConfig());
  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'how does X work',
    files: ['src/x.ts'],
    taskType: 'exploration',
  });
  assert.equal(pack.impactPrediction, undefined);
});
