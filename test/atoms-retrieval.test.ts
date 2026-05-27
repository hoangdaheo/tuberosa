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
