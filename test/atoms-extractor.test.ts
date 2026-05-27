import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { AtomCritic } from '../src/atoms/critic.js';
import { AtomExtractor } from '../src/atoms/extractor.js';

test('AtomExtractor: passes good candidates through critic and stores them as draft', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: 'EMBEDDING_DIMENSIONS must equal the vector(N) column dim.',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'migrations/001_init.sql', lineStart: 14 }],
    trigger: { errors: ['vector dimension mismatch'] },
  }]);
  const extractor = new AtomExtractor(store, models, new AtomCritic(store, models));
  const result = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'sess-1',
    sessionPrompt: 'fix the dim mismatch',
    summary: 'changed EMBEDDING_DIMENSIONS to match column',
  });
  assert.equal(result.stored.length, 1);
  assert.equal(result.rejected.length, 0);
  const atoms = await store.listAtoms({ project: 'tuberosa', limit: 10 });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].tier, 'draft');
  assert.equal(atoms[0].audit.producedBy, 'agent_session');
  assert.equal(atoms[0].audit.producedAtSessionId, 'sess-1');
});

test('AtomExtractor: rejects candidates that fail the critic and records reasons', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  models.setFixtureAtoms([{
    claim: '',                                              // floor failure
    type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }],
    trigger: { errors: ['e'] },
  }]);
  const extractor = new AtomExtractor(store, models, new AtomCritic(store, models));
  const result = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'sess-2',
    sessionPrompt: 'p',
  });
  assert.equal(result.stored.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.ok(result.rejected[0].reasons.some((r) => r.includes('claim')));
});

test('AtomExtractor: returns empty result when provider has no extractAtoms method', async () => {
  const store = new MemoryKnowledgeStore();
  const models = new HashModelProvider();
  const extractor = new AtomExtractor(store, models, new AtomCritic(store, models));
  const result = await extractor.extractFromSession({
    project: 'tuberosa',
    sessionId: 'sess-3',
    sessionPrompt: 'p',
  });
  assert.equal(result.stored.length, 0);
  assert.equal(result.rejected.length, 0);
});
