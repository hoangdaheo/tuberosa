import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('updateAtom: applies content fields (claim/type/evidence/trigger)', async () => {
  const store = new MemoryKnowledgeStore();
  const created = await store.createAtom({
    project: 'p', claim: 'old claim', type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }], trigger: { files: ['a.ts'] }, producedBy: 'user',
  });

  const updated = await store.updateAtom(created.id, {
    claim: 'new claim',
    type: 'gotcha',
    evidence: [{ kind: 'file', path: 'b.ts' }],
    trigger: { files: ['b.ts'] },
  });

  assert.equal(updated?.claim, 'new claim');
  assert.equal(updated?.type, 'gotcha');
  assert.equal(updated?.evidence[0]?.kind === 'file' && updated.evidence[0].path, 'b.ts');
  assert.deepEqual(updated?.trigger.files, ['b.ts']);
});
