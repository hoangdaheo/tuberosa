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
