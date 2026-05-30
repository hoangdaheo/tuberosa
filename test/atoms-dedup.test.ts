import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { AtomCritic } from '../src/atoms/critic.js';
import { AtomExtractor } from '../src/atoms/extractor.js';

// Drives through the extractor so atoms get a real stored embedding, then uses
// the DEFAULT critic threshold (0.92). This fails if dedup is a no-op (the old
// all-cosine-1.0 stub) because distinct atoms would be wrongly rejected, and a
// near-duplicate would be accepted if embeddings were never stored.

function makeExtractor(store: MemoryKnowledgeStore, models: HashModelProvider) {
  return new AtomExtractor(store, models, new AtomCritic(store, models));
}

test('near-duplicate atom is rejected at default threshold', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const extractor = makeExtractor(store, models);

  models.setFixtureAtoms([{
    claim: 'EMBEDDING_DIMENSIONS must equal the vector(N) column dim.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'migrations/001_init.sql', lineStart: 14 }],
    trigger: { errors: ['vector dimension mismatch'] },
  }]);
  const first = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'sess-1',
    sessionPrompt: 'fix the dim mismatch',
  });
  assert.equal(first.stored.length, 1);

  // Near-identical claim + identical trigger error → same canonical text.
  models.setFixtureAtoms([{
    claim: 'EMBEDDING_DIMENSIONS must equal the vector(N) column dim.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'migrations/001_init.sql', lineStart: 14 }],
    trigger: { errors: ['vector dimension mismatch'] },
  }]);
  const second = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'sess-2',
    sessionPrompt: 'fix the dim mismatch again',
  });
  assert.equal(second.stored.length, 0);
  assert.equal(second.rejected.length, 1);
  assert.ok(second.rejected[0]!.reasons!.some((r) => r.includes('duplicate')));

  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 1);
});

test('distinct atoms both survive at default threshold', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const extractor = makeExtractor(store, models);

  // Measured hash-embedding cosine between these two canonical texts is ~0.075,
  // well below the 0.92 default threshold, so both must survive.
  models.setFixtureAtoms([{
    claim: 'EMBEDDING_DIMENSIONS must equal the vector(N) column dim.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'migrations/001_init.sql', lineStart: 14 }],
    trigger: { errors: ['vector dimension mismatch'] },
  }]);
  const first = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'sess-a',
    sessionPrompt: 'a',
  });
  assert.equal(first.stored.length, 1);
  assert.equal(first.rejected.length, 0);

  models.setFixtureAtoms([{
    claim: 'MCP stdout must only contain JSON-RPC frames, never console.log.',
    type: 'convention',
    evidence: [{ kind: 'file', path: 'src/mcp-stdio.ts' }],
    trigger: { errors: ['protocol corruption on stdout'] },
  }]);
  const second = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'sess-b',
    sessionPrompt: 'b',
  });
  assert.equal(second.stored.length, 1, JSON.stringify(second.rejected));
  assert.equal(second.rejected.length, 0);

  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 2);
});
