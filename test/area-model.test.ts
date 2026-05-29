import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { buildAreaModel, deriveAreaKey, areaLabel } from '../src/knowledge-areas/area-model.js';

test('deriveAreaKey: src files key on the second segment', () => {
  assert.equal(deriveAreaKey('src/retrieval/service.ts'), 'src/retrieval');
  assert.equal(deriveAreaKey('src/storage/postgres-store.ts'), 'src/storage');
});

test('deriveAreaKey: non-src files key on the top segment', () => {
  assert.equal(deriveAreaKey('migrations/011_source_files.sql'), 'migrations');
  assert.equal(deriveAreaKey('docs/superpowers/specs/x.md'), 'docs');
});

test('deriveAreaKey: repo-root files collect under _root', () => {
  assert.equal(deriveAreaKey('README.md'), '_root');
  assert.equal(deriveAreaKey('./package.json'), '_root');
});

test('deriveAreaKey: bare src/ file keys on src', () => {
  assert.equal(deriveAreaKey('src/index.ts'), 'src');
});

test('areaLabel: humanizes the last segment', () => {
  assert.equal(areaLabel('src/retrieval'), 'Retrieval');
  assert.equal(areaLabel('migrations'), 'Migrations');
  assert.equal(areaLabel('_root'), 'Root');
  assert.equal(areaLabel('_unassigned'), 'Unassigned');
});

test('buildAreaModel: spine groups ledger paths into areas', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/service.ts', contentHash: 'h1', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/fusion.ts', contentHash: 'h2', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'src/storage/store.ts', contentHash: 'h3', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'migrations/001_init.sql', contentHash: 'h4', status: 'tracked' });

  const areas = await buildAreaModel(store, 'p');
  const byKey = Object.fromEntries(areas.map((a) => [a.key, a]));

  assert.deepEqual(Object.keys(byKey).sort(), ['migrations', 'src/retrieval', 'src/storage']);
  assert.equal(byKey['src/retrieval'].label, 'Retrieval');
  assert.equal(byKey['src/retrieval'].counts.files, 2);
  assert.deepEqual(byKey['src/retrieval'].paths, ['src/retrieval/fusion.ts', 'src/retrieval/service.ts']);
});

test('buildAreaModel: archived ledger rows are excluded from the spine', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/dead/gone.ts', contentHash: 'h', status: 'archived' });
  await store.upsertSourceFile({ project: 'p', path: 'src/live/here.ts', contentHash: 'h', status: 'tracked' });

  const areas = await buildAreaModel(store, 'p');
  assert.deepEqual(areas.map((a) => a.key), ['src/live']);
});

test('buildAreaModel: assigns knowledge by metadata.sourcePath and atoms by trigger/evidence', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/service.ts', contentHash: 'h', status: 'tracked' });

  await store.upsertKnowledge({
    project: 'p', sourceType: 'manual', sourceUri: 'u', itemType: 'code_ref',
    title: 'svc', summary: '', content: 'c', labels: [], references: [],
    metadata: { sourcePath: 'src/retrieval/service.ts' },
  }, []);

  await store.createAtom({
    project: 'p', claim: 'A', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/retrieval/service.ts' }],
    trigger: { files: ['src/retrieval/service.ts'] }, producedBy: 'agent_session',
  });

  const areas = await buildAreaModel(store, 'p');
  const retrieval = areas.find((a) => a.key === 'src/retrieval')!;
  assert.equal(retrieval.counts.knowledge, 1);
  assert.equal(retrieval.counts.atoms, 1);
  assert.equal(retrieval.knowledgeIds.length, 1);
  assert.equal(retrieval.atomIds.length, 1);
});

test('buildAreaModel: pathless knowledge and atoms fall under _unassigned', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertKnowledge({
    project: 'p', sourceType: 'manual', sourceUri: 'u', itemType: 'wiki',
    title: 'floating', summary: '', content: 'c', labels: [], references: [], metadata: {},
  }, []);
  await store.createAtom({
    project: 'p', claim: 'B', type: 'fact', evidence: [], trigger: { errors: ['e'] }, producedBy: 'agent_session',
  });

  const areas = await buildAreaModel(store, 'p');
  const un = areas.find((a) => a.key === '_unassigned')!;
  assert.equal(un.counts.knowledge, 1);
  assert.equal(un.counts.atoms, 1);
});

test('buildAreaModel: overlays domain/business_area labels and counts crossing relations', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/service.ts', contentHash: 'h', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'src/storage/store.ts', contentHash: 'h', status: 'tracked' });

  await store.upsertKnowledge({
    project: 'p', sourceType: 'manual', sourceUri: 'u', itemType: 'code_ref',
    title: 'svc', summary: '', content: 'c',
    labels: [
      { type: 'domain', value: 'retrieval' },
      { type: 'business_area', value: 'search' },
      { type: 'technology', value: 'typescript' }, // must NOT appear as an overlay
    ],
    references: [], metadata: { sourcePath: 'src/retrieval/service.ts' },
  }, []);

  const a = await store.createAtom({
    project: 'p', claim: 'A', type: 'fact', evidence: [{ kind: 'file', path: 'src/retrieval/service.ts' }],
    trigger: { files: ['src/retrieval/service.ts'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'p', claim: 'B', type: 'fact', evidence: [{ kind: 'file', path: 'src/storage/store.ts' }],
    trigger: { files: ['src/storage/store.ts'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(
    a.id,
    [{ fromAtomId: a.id, targetAtomId: b.id, relationType: 'depends_on', confidence: 0.7, inferenceSource: 'semantic' }],
    { source: 'semantic' },
  );

  const areas = await buildAreaModel(store, 'p');
  const retrieval = areas.find((x) => x.key === 'src/retrieval')!;
  const storage = areas.find((x) => x.key === 'src/storage')!;

  assert.deepEqual(retrieval.labels, [
    { type: 'business_area', value: 'search' },
    { type: 'domain', value: 'retrieval' },
  ]);
  assert.equal(retrieval.crossingRelations, 1);
  assert.equal(storage.crossingRelations, 1);
});

test('buildAreaModel: relations within one area do not count as crossing', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'p', claim: 'A', type: 'fact', evidence: [{ kind: 'file', path: 'src/x/a.ts' }],
    trigger: { files: ['src/x/a.ts'] }, producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'p', claim: 'B', type: 'fact', evidence: [{ kind: 'file', path: 'src/x/b.ts' }],
    trigger: { files: ['src/x/b.ts'] }, producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(
    a.id,
    [{ fromAtomId: a.id, targetAtomId: b.id, relationType: 'related_to', confidence: 0.5, inferenceSource: 'semantic' }],
    { source: 'semantic' },
  );

  const areas = await buildAreaModel(store, 'p');
  assert.equal(areas.find((x) => x.key === 'src/x')!.crossingRelations, 0);
});

test('buildAreaModel: output is deterministic across runs (stable sort)', async () => {
  const store = new MemoryKnowledgeStore();
  // Insert in deliberately non-sorted order.
  await store.upsertSourceFile({ project: 'p', path: 'src/storage/z.ts', contentHash: 'h', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/b.ts', contentHash: 'h', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/a.ts', contentHash: 'h', status: 'tracked' });
  await store.upsertSourceFile({ project: 'p', path: 'migrations/x.sql', contentHash: 'h', status: 'tracked' });

  const first = JSON.stringify(await buildAreaModel(store, 'p'));
  const second = JSON.stringify(await buildAreaModel(store, 'p'));
  assert.equal(first, second);

  const areas = await buildAreaModel(store, 'p');
  assert.deepEqual(areas.map((a) => a.key), ['migrations', 'src/retrieval', 'src/storage']);
  assert.deepEqual(areas.find((a) => a.key === 'src/retrieval')!.paths, ['src/retrieval/a.ts', 'src/retrieval/b.ts']);
});
