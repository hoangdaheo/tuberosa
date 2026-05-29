import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('resolveAtomImportConflict take_imported: applies imported content', async () => {
  const store = new MemoryKnowledgeStore();
  const local = await store.createAtom({
    project: 'p', claim: 'local claim', type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }], trigger: { files: ['a.ts'] }, producedBy: 'user',
  });

  const conflict = await store.createAtomImportConflict({
    project: 'p', atomId: local.id, localSnapshot: local,
    importedSnapshot: {
      id: local.id, revision: 2, project: 'p', type: 'gotcha', tier: 'verified', status: 'active',
      trigger: { files: ['b.ts'] }, evidence: [{ kind: 'file', path: 'b.ts' }],
      audit: { producedBy: 'user', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      body: 'imported claim',
    },
    bundleSource: '/tmp/pack',
  });

  await store.resolveAtomImportConflict(conflict.id, 'take_imported');
  const after = await store.getAtom(local.id);
  assert.equal(after?.claim, 'imported claim');
  assert.equal(after?.type, 'gotcha');
  assert.deepEqual(after?.trigger.files, ['b.ts']);
  assert.equal(after?.tier, 'verified');
});

test('resolveAtomImportConflict merged: applies merged content fields', async () => {
  const store = new MemoryKnowledgeStore();
  const local = await store.createAtom({
    project: 'p', claim: 'local claim', type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }], trigger: { files: ['a.ts'] }, producedBy: 'user',
  });
  const conflict = await store.createAtomImportConflict({
    project: 'p', atomId: local.id, localSnapshot: local,
    importedSnapshot: {
      id: local.id, revision: 2, project: 'p', type: 'fact', tier: 'draft', status: 'active',
      trigger: { files: ['a.ts'] }, evidence: [{ kind: 'file', path: 'a.ts' }],
      audit: { producedBy: 'user', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      body: 'x',
    },
    bundleSource: '/tmp/pack',
  });
  await store.resolveAtomImportConflict(conflict.id, 'merged', { claim: 'merged claim', tier: 'canonical' });
  const after = await store.getAtom(local.id);
  assert.equal(after?.claim, 'merged claim');
  assert.equal(after?.tier, 'canonical');
});
