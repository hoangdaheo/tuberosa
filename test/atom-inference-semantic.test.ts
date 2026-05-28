import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { inferSemanticNeighbors } from '../src/atoms/inference/semantic-neighbor.js';
import { atomEmbeddingText } from '../src/atoms/critic.js';
import type { KnowledgeAtomInput } from '../src/types/atoms.js';

const models = new HashModelProvider();

async function seedAtom(
  store: MemoryKnowledgeStore,
  input: KnowledgeAtomInput,
) {
  const embedding = await models.embed(atomEmbeddingText(input));
  return store.createAtom({ ...input, embedding });
}

test('inferSemanticNeighbors: emits related_to when neighbor has no shared trigger token', async () => {
  const store = new MemoryKnowledgeStore();
  const neighbor = await seedAtom(store, {
    project: 'tuberosa',
    claim: 'pgvector HNSW indexes deliver high recall on cosine ops.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'm.sql' }],
    trigger: { errors: ['hnsw recall low'] },
    producedBy: 'agent_session',
  });
  await store.updateAtom(neighbor.id, { tier: 'verified' });

  const candidate = await seedAtom(store, {
    project: 'tuberosa',
    claim: 'pgvector HNSW indexes deliver high recall on cosine ops.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'q.ts' }],
    // Different trigger token so refines should NOT fire even though neighbor is verified.
    trigger: { errors: ['unrelated boot error'] },
    producedBy: 'agent_session',
  });

  const links = await inferSemanticNeighbors(candidate, store, models);
  assert.ok(links.length > 0, 'expected at least one neighbor');
  assert.equal(links[0].toAtomId, neighbor.id);
  assert.equal(links[0].kind, 'related_to');
});

test('inferSemanticNeighbors: emits refines when neighbor is verified AND shares a trigger token', async () => {
  const store = new MemoryKnowledgeStore();
  // Claims are similar but not identical so cosine lands between threshold and
  // duplicateCeiling. The shared `hnsw` symbol triggers the refine branch.
  // Same claim text, different trigger.errors → atomEmbeddingText differs by
  // one token, putting cosine in the (threshold, duplicateCeiling) band.
  const baseClaim = 'pgvector HNSW recall is sufficient for approximate nearest neighbor search.';
  const neighbor = await seedAtom(store, {
    project: 'tuberosa',
    claim: baseClaim,
    type: 'fact',
    evidence: [{ kind: 'file', path: 'm.sql' }],
    trigger: { errors: ['recall-low-neighbor'], symbols: ['hnsw'] },
    producedBy: 'agent_session',
  });
  await store.updateAtom(neighbor.id, { tier: 'verified' });

  const candidate = await seedAtom(store, {
    project: 'tuberosa',
    claim: baseClaim,
    type: 'fact',
    evidence: [{ kind: 'file', path: 'q.ts' }],
    trigger: { errors: ['recall-low-candidate'], symbols: ['hnsw'] },
    producedBy: 'agent_session',
  });

  const links = await inferSemanticNeighbors(candidate, store, models);
  assert.ok(
    links.some((l) => l.toAtomId === neighbor.id && l.kind === 'refines'),
    `expected a refines link to ${neighbor.id}, got ${JSON.stringify(links)}`,
  );
});

test('inferSemanticNeighbors: caps outbound at policy.maxOutbound', async () => {
  const store = new MemoryKnowledgeStore();
  for (let i = 0; i < 12; i += 1) {
    await seedAtom(store, {
      project: 'tuberosa',
      claim: 'pgvector HNSW indexes are useful for vector search.',
      type: 'fact',
      evidence: [{ kind: 'file', path: 'm.sql' }],
      trigger: { errors: [`bucket-${i}`] },
      producedBy: 'agent_session',
    });
  }
  const candidate = await seedAtom(store, {
    project: 'tuberosa',
    claim: 'pgvector HNSW indexes are useful for vector search.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'q.ts' }],
    trigger: { errors: ['candidate-bucket'] },
    producedBy: 'agent_session',
  });
  const links = await inferSemanticNeighbors(candidate, store, models);
  assert.ok(links.length <= 5, `expected ≤ 5 links, got ${links.length}`);
});

test('inferSemanticNeighbors: drops candidates above duplicateCeiling', async () => {
  const store = new MemoryKnowledgeStore();
  // Identical claim + trigger → cosine should equal 1, above duplicateCeiling 0.92.
  const dup = await seedAtom(store, {
    project: 'tuberosa',
    claim: 'Identical claim text for dup detection.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }],
    trigger: { errors: ['shared'] },
    producedBy: 'agent_session',
  });
  const candidate = await seedAtom(store, {
    project: 'tuberosa',
    claim: 'Identical claim text for dup detection.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'b.ts' }],
    trigger: { errors: ['shared'] },
    producedBy: 'agent_session',
  });
  const links = await inferSemanticNeighbors(candidate, store, models);
  assert.ok(!links.some((l) => l.toAtomId === dup.id), 'duplicate must not surface as a neighbor');
});
