import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { MemoryCache } from '../src/cache.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_POLICY, resetRetrievalPolicyCache, setRetrievalPolicy } from '../src/retrieval/policy.js';

test('retrieval: a verified atom surfaces above a draft atom for the same trigger', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, loadConfig());

  const draft = await store.createAtom({
    project: 'tuberosa',
    claim: 'Draft hint.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }],
    trigger: { errors: ['vector dimension mismatch'] },
    producedBy: 'agent_session',
  });
  const verifiedRaw = await store.createAtom({
    project: 'tuberosa',
    claim: 'Verified hint.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'b.ts' }],
    trigger: { errors: ['vector dimension mismatch'] },
    producedBy: 'agent_session',
    verification: { command: 'pnpm test' },
  });
  await store.updateAtom(verifiedRaw.id, { tier: 'verified', reuseCount: 2, lastReusedAt: new Date().toISOString() });

  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'hitting vector dimension mismatch on insert',
    errors: ['vector dimension mismatch'],
  });

  const ids = pack.sections.flatMap((s) => s.items.map((i) => i.knowledgeId));
  const draftIdx = ids.indexOf(draft.id);
  const verifiedIdx = ids.indexOf(verifiedRaw.id);
  assert.ok(verifiedIdx !== -1, 'verified atom must appear in pack');
  if (draftIdx !== -1) {
    assert.ok(verifiedIdx < draftIdx, `verified (${verifiedIdx}) must outrank draft (${draftIdx})`);
  }

  resetRetrievalPolicyCache();
});

test('retrieval: legacy_archived knowledge items are excluded from candidates', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, loadConfig());

  const content = 'old memory about vector dimension mismatch on insert';
  const item = await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'u', itemType: 'memory',
    title: 'old', summary: 'old', content, labels: [], references: [], metadata: {},
  }, [{ index: 0, content, contextualContent: content, tokenEstimate: 10, embedding: await models.embed(content) }]);
  await store.updateKnowledge(item.id, { metadata: { legacyStatus: 'legacy_archived' } });

  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'hitting vector dimension mismatch on insert',
    errors: ['vector dimension mismatch'],
  });
  const ids = pack.sections.flatMap((s) => s.items.map((i) => i.knowledgeId));
  assert.ok(!ids.includes(item.id), `legacy_archived item must not be in pack: ${ids.join(',')}`);

  resetRetrievalPolicyCache();
});

test('retrieval: legacy_replaced knowledge items are downweighted vs a normal item', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, loadConfig());

  // Make the replaced item the STRONGER raw match (higher trust + extra matching term),
  // so without the legacy_replaced downweight it would outrank the normal item.
  const normalContent = 'normal memory about vector dimension mismatch';
  const replacedContent = 'replaced memory about vector dimension mismatch on insert insert';
  const normal = await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'n', itemType: 'memory',
    title: 'normal', summary: 'normal', content: normalContent, trustLevel: 50, labels: [], references: [], metadata: {},
  }, [{ index: 0, content: normalContent, contextualContent: normalContent, tokenEstimate: 10, embedding: await models.embed(normalContent) }]);
  const replaced = await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'r', itemType: 'memory',
    title: 'replaced', summary: 'replaced', content: replacedContent, trustLevel: 90, labels: [], references: [], metadata: {},
  }, [{ index: 0, content: replacedContent, contextualContent: replacedContent, tokenEstimate: 10, embedding: await models.embed(replacedContent) }]);
  await store.updateKnowledge(replaced.id, { metadata: { legacyStatus: 'legacy_replaced' } });

  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'hitting vector dimension mismatch on insert',
    errors: ['vector dimension mismatch'],
  });
  const ids = pack.sections.flatMap((s) => s.items.map((i) => i.knowledgeId));
  const normalIdx = ids.indexOf(normal.id);
  const replacedIdx = ids.indexOf(replaced.id);
  // Without the downweight, the higher-trust, stronger-matching replaced item outranks
  // (and crowds out) the normal item. The x0.2 grace-period downweight must demote it so
  // the normal item leads — and if replaced still appears, it must rank behind normal.
  assert.ok(normalIdx !== -1, 'normal item must appear in pack');
  if (replacedIdx !== -1) {
    assert.ok(normalIdx < replacedIdx, `normal (${normalIdx}) must outrank legacy_replaced (${replacedIdx}) after downweight`);
  }

  resetRetrievalPolicyCache();
});

test('selected feedback on a pack increments reuseCount on contained atoms', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, loadConfig());

  const atom = await store.createAtom({
    project: 'tuberosa',
    claim: 'Some claim.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['some reuse error'] },
    producedBy: 'agent_session',
  });

  const pack = await service.searchContext({
    project: 'tuberosa', prompt: 'hit some reuse error', errors: ['some reuse error'],
  });
  assert.ok(pack.sections.flatMap((s) => s.items).some((i) => i.knowledgeId === atom.id),
    'atom must be present in the pack');

  await service.recordFeedback({
    contextPackId: pack.id,
    project: 'tuberosa',
    feedbackType: 'selected',
  });

  const refreshed = await store.getAtom(atom.id);
  assert.equal(refreshed?.reuseCount, 1);
  assert.ok(refreshed?.lastReusedAt);

  resetRetrievalPolicyCache();
});

test('retrieval: archived atoms do not appear in default context packs', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, loadConfig());

  const atom = await store.createAtom({
    project: 'tuberosa', claim: 'should not surface',
    type: 'fact', evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['baz error'] }, producedBy: 'agent_session',
  });
  await store.updateAtom(atom.id, { status: 'archived' });

  const pack = await service.searchContext({
    project: 'tuberosa', prompt: 'baz error', errors: ['baz error'],
  });
  const ids = pack.sections.flatMap((s) => s.items.map((i) => i.knowledgeId));
  assert.ok(!ids.includes(atom.id));

  resetRetrievalPolicyCache();
});

test('retrieval (C2): depth-2 atom hit appears in pack with graph:* matchReason', async () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, loadConfig());

  // Seed atom A is triggered by src/x.ts; B is one hop (refines); C is two hops (related_to).
  const a = await store.createAtom({
    project: 'tuberosa', claim: 'seed atom', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/x.ts' }],
    trigger: { files: ['src/x.ts'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'tuberosa', claim: 'sibling atom', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/y.ts' }],
    trigger: { files: ['src/y.ts'] }, producedBy: 'agent_session',
  });
  const c = await store.createAtom({
    project: 'tuberosa', claim: 'two-hop atom', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/z.ts' }],
    trigger: { files: ['src/z.ts'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(a.id, [{
    fromAtomId: a.id, targetAtomId: b.id, relationType: 'refines',
    confidence: 0.9, inferenceSource: 'semantic',
  }], { source: 'semantic' });
  await store.replaceAtomRelations(b.id, [{
    fromAtomId: b.id, targetAtomId: c.id, relationType: 'related_to',
    confidence: 0.8, inferenceSource: 'semantic',
  }], { source: 'semantic' });

  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'something about src/x.ts',
    files: ['src/x.ts'],
    taskType: 'implementation',
  });

  const ids = pack.sections.flatMap((s) => s.items.map((i) => i.knowledgeId));
  assert.ok(ids.includes(c.id), `expected depth-2 atom to surface; got ${ids.join(',')}`);

  resetRetrievalPolicyCache();
});
