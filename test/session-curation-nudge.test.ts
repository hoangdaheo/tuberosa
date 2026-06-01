import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { ReflectionService } from '../src/reflection/service.js';
import { IngestionService } from '../src/ingest/service.js';
import { AgentSessionService } from '../src/agent-session/service.js';
import { loadConfig } from '../src/config.js';

function buildService(store: MemoryKnowledgeStore, models: HashModelProvider) {
  const cache = new MemoryCache();
  const config = loadConfig();
  const retrieval = new RetrievalService(store, cache, models, config);
  const ingestion = new IngestionService(store, models);
  const reflection = new ReflectionService(store, ingestion);
  return new AgentSessionService(store, retrieval, reflection, models, undefined, config);
}

async function seedUncuratedAtom(store: MemoryKnowledgeStore, project: string, n: number) {
  return store.createAtom({
    project,
    type: 'gotcha',
    claim: `Un-curated gotcha number ${n} for ${project}.`,
    evidence: [{ kind: 'file', path: `src/file-${n}.ts` }],
    trigger: { taskTypes: ['debugging'], files: [`src/file-${n}.ts`] },
    producedBy: 'agent_session',
    scope: 'project',
  });
}

test('finishSession: emits curationNudge when un-curated atoms exceed threshold', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const project = 'nudge-above';

  // Seed 5 un-curated active atoms (>= threshold).
  for (let i = 0; i < 5; i += 1) {
    await seedUncuratedAtom(store, project, i);
  }

  const session = await store.createAgentSession({ prompt: 'fix a bug', project });
  const service = buildService(store, models);

  const result = await service.finishSession({
    sessionId: session.id,
    outcome: 'completed',
    summary: 'fixed the bug',
  });

  assert.ok(result.curationNudge, 'expected curationNudge to be defined');
  assert.ok(result.curationNudge!.count >= 5, 'expected count >= threshold');
  assert.equal(typeof result.curationNudge!.prompt, 'string');
  assert.ok(result.curationNudge!.prompt.length > 0, 'expected non-empty prompt');
  assert.equal(result.curationNudge!.toolCall, 'tuberosa_propose_curation');
});

test('finishSession: no curationNudge when below threshold', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const project = 'nudge-below';

  // Seed 2 un-curated atoms (< threshold of 5).
  await seedUncuratedAtom(store, project, 0);
  await seedUncuratedAtom(store, project, 1);

  const session = await store.createAgentSession({ prompt: 'fix a bug', project });
  const service = buildService(store, models);

  const result = await service.finishSession({
    sessionId: session.id,
    outcome: 'completed',
    summary: 'fixed the bug',
  });

  assert.equal(result.curationNudge, undefined);
});

test('finishSession: convention and already-distilled atoms are excluded from the firing count', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const project = 'nudge-excluded-firing';

  // 5 genuinely un-curated atoms (>= threshold on their own).
  for (let i = 0; i < 5; i += 1) {
    await seedUncuratedAtom(store, project, i);
  }

  // A convention atom — should NOT count.
  await store.createAtom({
    project,
    type: 'convention',
    claim: 'A curated convention.',
    evidence: [{ kind: 'file', path: 'src/convention.ts' }],
    trigger: { taskTypes: ['refactor'] },
    producedBy: 'agent_session',
    scope: 'project',
  });

  // An atom already distilled into a convention — should NOT count.
  await store.createAtom({
    project,
    type: 'gotcha',
    claim: 'Already distilled gotcha.',
    evidence: [{ kind: 'file', path: 'src/distilled.ts' }],
    trigger: { taskTypes: ['debugging'] },
    producedBy: 'agent_session',
    scope: 'project',
    metadata: { distilledIntoAtomId: 'some-convention-id' },
  });

  const session = await store.createAgentSession({ prompt: 'fix a bug', project });
  const service = buildService(store, models);

  const result = await service.finishSession({
    sessionId: session.id,
    outcome: 'completed',
    summary: 'fixed the bug',
  });

  // The nudge fires on the 5 genuine un-curated atoms, but the convention and
  // already-distilled atoms must NOT inflate the count beyond 5.
  assert.ok(result.curationNudge, 'expected curationNudge to be defined');
  assert.equal(result.curationNudge!.count, 5, 'convention + distilled atoms must be excluded from the count');
});

test('finishSession: convention and already-distilled atoms do not push a below-threshold project over', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const project = 'nudge-excluded-below';

  // 4 genuinely un-curated atoms (< threshold on their own).
  for (let i = 0; i < 4; i += 1) {
    await seedUncuratedAtom(store, project, i);
  }

  // A convention atom — should NOT count.
  await store.createAtom({
    project,
    type: 'convention',
    claim: 'A curated convention.',
    evidence: [{ kind: 'file', path: 'src/convention.ts' }],
    trigger: { taskTypes: ['refactor'] },
    producedBy: 'agent_session',
    scope: 'project',
  });

  // An atom already distilled into a convention — should NOT count.
  await store.createAtom({
    project,
    type: 'gotcha',
    claim: 'Already distilled gotcha.',
    evidence: [{ kind: 'file', path: 'src/distilled.ts' }],
    trigger: { taskTypes: ['debugging'] },
    producedBy: 'agent_session',
    scope: 'project',
    metadata: { distilledIntoAtomId: 'some-convention-id' },
  });

  const session = await store.createAgentSession({ prompt: 'fix a bug', project });
  const service = buildService(store, models);

  const result = await service.finishSession({
    sessionId: session.id,
    outcome: 'completed',
    summary: 'fixed the bug',
  });

  // Only 4 genuine un-curated atoms remain; convention + distilled excluded → below threshold.
  assert.equal(result.curationNudge, undefined);
});
