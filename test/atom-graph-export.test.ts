import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { streamAtomGraphJsonl } from '../src/operations/atom-graph-export.js';

test('streamAtomGraphJsonl: emits one JSONL record per atom with outboundEdges', async () => {
  const store = new MemoryKnowledgeStore();
  const a = await store.createAtom({
    project: 'tuberosa',
    claim: 'A',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { errors: ['e'] },
    producedBy: 'agent_session',
  });
  const b = await store.createAtom({
    project: 'tuberosa',
    claim: 'B',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'y.ts' }],
    trigger: { errors: ['e'] },
    producedBy: 'agent_session',
  });
  await store.replaceAtomRelations(
    a.id,
    [{
      fromAtomId: a.id,
      targetAtomId: b.id,
      relationType: 'related_to',
      confidence: 0.7,
      inferenceSource: 'semantic',
    }],
    { source: 'semantic' },
  );

  const records: string[] = [];
  for await (const line of streamAtomGraphJsonl(store, { project: 'tuberosa' })) {
    records.push(line);
  }

  assert.equal(records.length, 2);
  const parsed = records.map((r) => JSON.parse(r) as {
    atom: { claim: string };
    outboundEdges: Array<{ kind: string; confidence: number }>;
  });
  const aRecord = parsed.find((r) => r.atom.claim === 'A');
  assert.ok(aRecord, 'expected atom A in stream');
  assert.equal(aRecord.outboundEdges.length, 1);
  assert.equal(aRecord.outboundEdges[0]!.kind, 'related_to');
  assert.equal(aRecord.outboundEdges[0]!.confidence, 0.7);

  const bRecord = parsed.find((r) => r.atom.claim === 'B');
  assert.ok(bRecord);
  assert.equal(bRecord.outboundEdges.length, 0);
});

test('streamAtomGraphJsonl: empty project yields no records', async () => {
  const store = new MemoryKnowledgeStore();
  const records: string[] = [];
  for await (const line of streamAtomGraphJsonl(store, { project: 'empty' })) {
    records.push(line);
  }
  assert.equal(records.length, 0);
});

test('streamAtomGraphJsonl: respects atomLimit', async () => {
  const store = new MemoryKnowledgeStore();
  for (let i = 0; i < 5; i += 1) {
    await store.createAtom({
      project: 'tuberosa',
      claim: `atom-${i}`,
      type: 'fact',
      evidence: [{ kind: 'file', path: `f${i}.ts` }],
      trigger: { errors: ['e'] },
      producedBy: 'agent_session',
    });
  }
  const records: string[] = [];
  for await (const line of streamAtomGraphJsonl(store, { project: 'tuberosa', atomLimit: 3 })) {
    records.push(line);
  }
  assert.equal(records.length, 3);
});
