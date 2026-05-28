import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { MemoryCache } from '../src/cache.js';
import { AtomCritic } from '../src/atoms/critic.js';
import type { KnowledgeAtomInput } from '../src/types/atoms.js';

function userStyleInput(overrides: Partial<KnowledgeAtomInput> = {}): KnowledgeAtomInput {
  return {
    project: '__user:a',
    claim: 'I prefer named exports for module clarity.',
    type: 'convention',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { intentTags: ['style'], symbols: ['export'] },
    producedBy: 'user',
    scope: 'user',
    userId: 'a',
    priority: 'coding_preference',
    ...overrides,
  };
}

test('critic: scope=user rejects bare-ego claim via personal_pronoun_only rule', async () => {
  const store = new MemoryKnowledgeStore();
  const critic = new AtomCritic(store, new HashModelProvider(), { cache: new MemoryCache() });
  const result = await critic.evaluate(userStyleInput({ claim: "I'm the best" }));
  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((r) => r.includes('personal_pronoun_only')),
    `expected personal_pronoun_only reason, got ${JSON.stringify(result.reasons)}`,
  );
});

test('critic: scope=user accepts "I prefer named exports" (has verb + object)', async () => {
  const store = new MemoryKnowledgeStore();
  const critic = new AtomCritic(store, new HashModelProvider(), { cache: new MemoryCache() });
  const result = await critic.evaluate(userStyleInput());
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
});

test('critic: scope=user skips cross-type legacy dedup', async () => {
  const store = new MemoryKnowledgeStore();
  // Pre-existing legacy memory item with matching content
  await store.upsertKnowledge(
    {
      project: 'tuberosa',
      sourceType: 'manual',
      sourceUri: 'u',
      itemType: 'memory',
      title: 't',
      summary: '',
      content: 'Prefer named exports for clarity in module loading.',
      labels: [],
      references: [],
      metadata: {},
    },
    [],
  );
  const critic = new AtomCritic(store, new HashModelProvider(), {
    cache: new MemoryCache(),
    legacyDedupThreshold: 0.0,
  });
  const result = await critic.evaluate(userStyleInput({ claim: 'Prefer named exports for clarity in module loading.' }));
  // For scope='user', cross-type legacy dedup is skipped — the legacy item should NOT block.
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
});

test('critic: scope=user dedups against same-user atoms only', async () => {
  const store = new MemoryKnowledgeStore();
  const critic = new AtomCritic(store, new HashModelProvider(), {
    cache: new MemoryCache(),
    dedupCosineThreshold: 0.0,
  });
  // Pre-existing user-style atom for user "b"
  await store.createAtom({
    project: '__user:b',
    claim: 'Prefer named exports for clarity in module loading.',
    type: 'convention',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { intentTags: ['style'] },
    producedBy: 'user',
    scope: 'user',
    userId: 'b',
    priority: 'coding_preference',
  });
  const result = await critic.evaluate(userStyleInput({ claim: 'Prefer named exports for clarity in module loading.' }));
  // User "a" should not collide with user "b" — different users keep separate spaces.
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
});
