import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { loadConfig } from '../src/config.js';
import { createUserStyleAtom } from '../src/user-style/store-helpers.js';

async function setup(priority: 'personal_workflow' | 'coding_preference'): Promise<RetrievalService> {
  const store = new MemoryKnowledgeStore();
  // Project convention surfaces through the memory source — encode it as a
  // knowledge item so the conflict resolver compares it against the user-style
  // atom title.
  await store.upsertKnowledge(
    {
      project: 'tuberosa',
      sourceType: 'manual',
      sourceUri: 'project-convention-default-exports',
      itemType: 'memory',
      title: 'Use default exports.',
      summary: 'Use default exports.',
      content: 'Use default exports for module entry points.',
      labels: [{ type: 'symbol', value: 'export' }],
      references: [],
      metadata: {},
    },
    [
      {
        index: 0,
        content: 'Use default exports for module entry points.',
        contextualContent: 'Use default exports for module entry points.',
        tokenEstimate: 10,
        embedding: [],
        metadata: {},
      },
    ],
  );
  await createUserStyleAtom(store, {
    userId: 'alice@example.com',
    claim: 'Never use default exports.',
    type: 'convention',
    priority,
    trigger: { intentTags: ['style'], symbols: ['export'] },
  });
  const config = {
    ...loadConfig(),
    userId: 'alice@example.com',
    userStyleEnabled: true,
    store: 'memory' as const,
    cache: 'memory' as const,
  };
  return new RetrievalService(store, new MemoryCache(), new HashModelProvider(), config);
}

test('conflict: personal_workflow user style wins; pack.instruction mentions personal workflow', async () => {
  const service = await setup('personal_workflow');
  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'how should I export this module',
    symbols: ['export'],
  });
  const items = pack.sections.flatMap((s) => s.items);
  const projectHit = items.find((i) => i.title?.includes('Use default exports'));
  assert.equal(projectHit, undefined, 'project convention should be suppressed');
  assert.ok(
    pack.instruction?.toLowerCase().includes('personal workflow'),
    `expected pack.instruction to mention personal workflow; got ${pack.instruction}`,
  );
});

test('conflict: coding_preference user style yields; pack.instruction parks the preference', async () => {
  const service = await setup('coding_preference');
  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'how should I export this module',
    symbols: ['export'],
  });
  const items = pack.sections.flatMap((s) => s.items);
  const userHit = items.find((i) => i.matchReasons?.some((r) => r.startsWith('userStyle:coding_preference:')));
  assert.equal(userHit, undefined, 'user-style atom should be suppressed when coding_preference yields');
  assert.ok(
    pack.instruction?.toLowerCase().includes('project convention'),
    `expected pack.instruction to mention project convention; got ${pack.instruction}`,
  );
});
