import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { inferCoChangeLinks, computeCoChangePairs } from '../src/atoms/inference/co-change.js';

test('computeCoChangePairs: emits pairs whose Jaccard clears threshold', () => {
  const commits = [
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/c.ts'],
  ];
  const pairs = computeCoChangePairs(commits, { minCoChanges: 3, minConfidence: 0.5 });
  assert.ok(pairs.some((p) => p.left === 'src/a.ts' && p.right === 'src/b.ts'));
  assert.ok(
    !pairs.some((p) => p.left === 'src/a.ts' && p.right === 'src/c.ts'),
    'pair below minCoChanges must be excluded',
  );
});

test('inferCoChangeLinks: links atoms whose evidence references co-changing files', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'tuberosa',
    claim: 'A',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'src/a.ts' }],
    trigger: { files: ['src/a.ts'] },
    producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'tuberosa',
    claim: 'B',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'src/b.ts' }],
    trigger: { files: ['src/b.ts'] },
    producedBy: 'agent_session',
  });
  const commits = [
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/b.ts'],
  ];
  const report = await inferCoChangeLinks(store, {
    project: 'tuberosa',
    commitsOverride: commits,
    minCoChanges: 3,
    minConfidence: 0.5,
  });
  // Symmetric pair → 2 directed edges.
  assert.equal(report.edgesEmitted, 2);
  assert.equal(report.scannedCommits, 3);
  assert.equal(report.pairsConsidered, 1);

  const aRels = await store.listAtomRelations({ fromAtomId: a.id, limit: 10 });
  assert.equal(aRels.length, 1);
  assert.equal(aRels[0].relationType, 'co_changes_with');
  assert.equal(aRels[0].targetAtomId, b.id);
  assert.equal(aRels[0].inferenceSource, 'co_change');

  const bRels = await store.listAtomRelations({ fromAtomId: b.id, limit: 10 });
  assert.equal(bRels[0].targetAtomId, a.id);
});

test('inferCoChangeLinks: re-running does not duplicate co_change edges', async () => {
  const store = new MemoryKnowledgeStore();
  await store.createAtom({
    project: 'tuberosa', claim: 'A', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/a.ts' }],
    trigger: { files: ['src/a.ts'] }, producedBy: 'agent_session',
  });
  await store.createAtom({
    project: 'tuberosa', claim: 'B', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/b.ts' }],
    trigger: { files: ['src/b.ts'] }, producedBy: 'agent_session',
  });
  const commits = [
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/b.ts'],
    ['src/a.ts', 'src/b.ts'],
  ];
  await inferCoChangeLinks(store, { project: 'tuberosa', commitsOverride: commits, minCoChanges: 3, minConfidence: 0.5 });
  await inferCoChangeLinks(store, { project: 'tuberosa', commitsOverride: commits, minCoChanges: 3, minConfidence: 0.5 });
  const rels = await store.listAtomRelations({ inferenceSource: 'co_change', limit: 50 });
  assert.equal(rels.length, 2);
});
