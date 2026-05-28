import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { AtomCritic, atomEmbeddingText } from '../src/atoms/critic.js';
import { AtomExtractor } from '../src/atoms/extractor.js';

/**
 * Concern C1 — replacement for the eval/retrieval-fixtures.json scenarios
 * "graph: semantic neighbor creates related_to link at atom creation" and
 * "graph: archived atom edges are filtered from graph walks".
 *
 * The first scenario is fully covered here as an extractor integration test
 * (the JSON eval runner doesn't speak atoms today; retrofitting it is C2's
 * read-side scope). The "graphWalkExcludes" assertion is intentionally
 * deferred to C2 — graph walks over atoms don't exist yet at retrieval, so
 * there's no surface to assert against.
 */
test('extractor fixture: semantic-neighbor inference creates a refines link at atom creation', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();

  // Seed neighbor atom with the same canonical text as the candidate (so the
  // hash embedding lands inside the policy band) and mark it verified so the
  // refine branch fires when triggers overlap.
  const seedInput = {
    project: 'tuberosa',
    claim: 'pgvector HNSW indexes deliver high recall for ANN.',
    type: 'fact' as const,
    evidence: [{ kind: 'file' as const, path: 'seed.ts' }],
    trigger: { errors: ['neighbor-error'], symbols: ['hnsw'] },
    producedBy: 'agent_session' as const,
  };
  const seedEmbedding = await models.embed(atomEmbeddingText(seedInput));
  const neighbor = await store.createAtom({ ...seedInput, embedding: seedEmbedding });
  await store.updateAtom(neighbor.id, { tier: 'verified' });

  // Inject a candidate via the hash provider's extract seam. The extractor
  // wraps inference + sync; we then verify the JSONB + relations mirror.
  models.setFixtureAtoms([{
    claim: seedInput.claim,
    type: 'fact',
    evidence: [{ kind: 'file', path: 'candidate.ts' }],
    trigger: { errors: ['candidate-error'], symbols: ['hnsw'] },
  }]);

  const extractor = new AtomExtractor(store, models, new AtomCritic(store, models));
  const result = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'fixture-session',
    sessionPrompt: 'see neighbor',
  });

  assert.equal(result.stored.length, 1);
  const candidate = result.stored[0];
  // Inline inference must have produced at least one outbound link to the neighbor.
  const links = candidate.links ?? [];
  assert.ok(
    links.some((l) => l.toAtomId === neighbor.id && l.kind === 'refines'),
    `expected a refines edge to neighbor, got ${JSON.stringify(links)}`,
  );
  // Mirror row must exist and carry the correct provenance.
  const rels = await store.listAtomRelations({ fromAtomId: candidate.id, inferenceSource: 'semantic', limit: 10 });
  assert.ok(rels.some((r) => r.targetAtomId === neighbor.id && r.relationType === 'refines'));
});
