import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { ReflectionService } from '../src/reflection/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

function createServices() {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const reflection = new ReflectionService(store, ingestion);
  return { store, ingestion, reflection };
}

test('approving a convention draft creates a scoped convention atom and stamps source atoms', async () => {
  const { store, reflection } = createServices();
  const project = 'tuberosa';

  const a1 = await store.createAtom({
    project,
    type: 'gotcha',
    claim: 'Prefer named exports for service modules.',
    evidence: [],
    trigger: { taskTypes: ['implementation'] },
    producedBy: 'agent_session',
    scope: 'project',
  });
  const a2 = await store.createAtom({
    project,
    type: 'fact',
    claim: 'Service files live under src/.',
    evidence: [],
    trigger: { taskTypes: ['implementation'] },
    producedBy: 'agent_session',
    scope: 'project',
  });

  const draft = await store.createReflectionDraft(
    {
      project,
      title: 'Use named exports for service modules',
      summary: 'Team code-style convention distilled from two source atoms.',
      content: 'Always use named exports for service modules; avoid default exports.',
      itemType: 'rule',
      triggerType: 'manual',
      metadata: {
        convention: true,
        scope: 'project',
        category: 'code_style',
        steps: ['do X', 'then Y'],
        trigger: { taskTypes: ['implementation'] },
        evidenceAtomIds: [a1.id, a2.id],
      },
    },
    [],
  );

  await reflection.approveDraft(draft.id);

  const conventions = (await store.listAtoms({ project, limit: 100 })).filter(
    (atom) => atom.type === 'convention',
  );
  equal(conventions.length, 1, 'exactly one convention atom should be created');
  const convention = conventions[0]!;
  equal(convention.scope, 'project');
  equal(convention.tier, 'verified');
  equal(convention.metadata?.curated, true);
  equal(convention.metadata?.category, 'code_style');
  ok(Array.isArray(convention.metadata?.steps), 'steps should be carried into metadata');

  const refetchedA1 = await store.getAtom(a1.id);
  const refetchedA2 = await store.getAtom(a2.id);
  equal(refetchedA1?.metadata?.distilledIntoAtomId, convention.id);
  equal(refetchedA2?.metadata?.distilledIntoAtomId, convention.id);
});

test('approving a normal (non-convention) draft does not create a convention atom', async () => {
  const { store, reflection } = createServices();
  const project = 'tuberosa';

  const draft = await store.createReflectionDraft(
    {
      project,
      title: 'A normal reflection memory',
      summary: 'Just a normal lesson, no convention flag.',
      content: 'Remember to run the eval before merging retrieval changes.',
      itemType: 'memory',
      triggerType: 'manual',
    },
    [],
  );

  const result = await reflection.approveDraft(draft.id);
  ok(result, 'approveDraft should return the draft');
  equal(result?.status, 'approved');

  const conventions = (await store.listAtoms({ project, limit: 100 })).filter(
    (atom) => atom.type === 'convention',
  );
  equal(conventions.length, 0, 'normal draft must not create a convention atom');

  // Normal path goes through ingestKnowledge — a knowledge item should exist.
  const knowledge = await store.listKnowledge({ project, limit: 100 });
  ok(knowledge.length >= 1, 'normal approval should ingest a knowledge item');
});

test('memory store updateAtom persists a metadata patch', async () => {
  const { store } = createServices();
  const atom = await store.createAtom({
    project: 'tuberosa',
    type: 'fact',
    claim: 'seed',
    evidence: [],
    trigger: {},
    producedBy: 'agent_session',
    scope: 'project',
    metadata: { existing: 'keep' },
  });

  const updated = await store.updateAtom(atom.id, {
    metadata: { ...(atom.metadata ?? {}), distilledIntoAtomId: 'atom-123' },
  });

  equal(updated?.metadata?.distilledIntoAtomId, 'atom-123');
  equal(updated?.metadata?.existing, 'keep', 'merged metadata should preserve existing keys');
});
