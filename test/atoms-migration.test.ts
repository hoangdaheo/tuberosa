import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { AtomCritic } from '../src/atoms/critic.js';
import { migrateLegacyKnowledge } from '../src/atoms/migration.js';

test('migrateLegacyKnowledge: re-extracts memory items into atoms and marks originals legacy_replaced', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: 'pgvector ivfflat lists should be rowcount / 1000.',
    type: 'convention',
    evidence: [{ kind: 'file', path: 'docs/pgvector.md' }],
    trigger: { taskTypes: ['refactor'], symbols: ['ivfflat'] },
  }]);
  await store.upsertKnowledge({
    project: 'tuberosa',
    sourceType: 'manual',
    sourceUri: 'tuberosa://m1',
    itemType: 'memory',
    title: 'pgvector tuning notes',
    summary: '',
    content: 'When tuning pgvector ivfflat, use lists = rowcount / 1000.',
    labels: [],
    references: [],
    metadata: {},
  }, []);

  const report = await migrateLegacyKnowledge(store, models, new AtomCritic(store, models), { project: 'tuberosa', dryRun: false });

  assert.equal(report.atomsCreated, 1);
  assert.equal(report.legacyReplaced, 1);
  assert.equal(report.legacyArchived, 0);
  const items = await store.listKnowledge({ project: 'tuberosa', limit: 10 });
  assert.equal(items[0].metadata.legacyStatus ?? items[0].status, 'legacy_replaced');
});

test('migrateLegacyKnowledge: writes a supersedes mirror row in knowledge_relations', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: 'pgvector ivfflat lists should be rowcount / 1000.',
    type: 'convention',
    evidence: [{ kind: 'file', path: 'docs/pgvector.md' }],
    trigger: { symbols: ['ivfflat'] },
  }]);
  const legacy = await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'tuberosa://m3', itemType: 'memory',
    title: 't', summary: '', content: 'old prose', labels: [], references: [], metadata: {},
  }, []);

  await migrateLegacyKnowledge(store, models, new AtomCritic(store, models), { project: 'tuberosa' });

  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 1);
  const atomId = atoms[0].id;
  const rels = await store.listAtomRelations({ fromAtomId: atomId, inferenceSource: 'migration', limit: 10 });
  assert.equal(rels.length, 1);
  assert.equal(rels[0].relationType, 'supersedes');
  assert.equal(rels[0].targetAtomId, legacy.id);
  assert.equal(rels[0].targetKind, 'knowledge');

  const refreshed = await store.getAtom(atomId);
  assert.ok(refreshed?.links?.some((l) => l.kind === 'supersedes' && l.toAtomId === legacy.id));
});

test('migrateLegacyKnowledge dryRun: produces a report without writing atoms', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: 'Use the freshness-policy module for stale checks.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'src/retrieval/policy.ts' }],
    trigger: { symbols: ['freshnessWindowFor'] },
  }]);
  await store.upsertKnowledge({
    project: 'tuberosa', sourceType: 'manual', sourceUri: 'tuberosa://m2', itemType: 'memory',
    title: 'freshness', summary: '', content: 'freshness check uses freshnessWindowFor', labels: [], references: [], metadata: {},
  }, []);

  const report = await migrateLegacyKnowledge(store, models, new AtomCritic(store, models), { project: 'tuberosa', dryRun: true });

  assert.equal(report.atomsCreated, 1);
  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 0, 'dry-run must not write atoms');
});
