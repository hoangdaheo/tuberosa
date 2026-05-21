import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { DuplicateDetector, jaccardSimilarity, sevenGramTokens } from '../src/ingest/duplicate-detector.js';
import { DEFAULT_POLICY, resetRetrievalPolicyCache, setRetrievalPolicy } from '../src/retrieval/policy.js';
import { DuplicateIngestionError } from '../src/errors.js';
import type { KnowledgeInput } from '../src/types.js';

const BASE_INPUT: KnowledgeInput = {
  project: 'sandbox',
  sourceType: 'memory',
  sourceUri: 'tuberosa://sandbox/dup-test-1',
  itemType: 'memory',
  title: 'Postgres pgvector index strategy',
  summary: 'How to tune pgvector ivfflat lists for retrieval relevance.',
  content: 'When tuning the pgvector ivfflat index, the lists parameter controls partitioning. Use lists = rowcount / 1000 for a reasonable starting point and adjust based on recall measurements over the gold-prompt corpus.',
  trustLevel: 70,
  labels: [],
  references: [],
  metadata: {},
};

const NEAR_DUPLICATE: KnowledgeInput = {
  ...BASE_INPUT,
  sourceUri: 'tuberosa://sandbox/dup-test-2',
  title: 'Postgres pgvector ivfflat index tuning',
  content: 'When tuning the pgvector ivfflat index, the lists parameter controls partitioning. Use lists = rowcount / 1000 for a reasonable starting point and adjust based on recall measurements over the gold-prompt corpus.',
};

const DIFFERENT_CONTENT: KnowledgeInput = {
  ...BASE_INPUT,
  sourceUri: 'tuberosa://sandbox/dup-test-3',
  title: 'Redis cache eviction policy',
  content: 'Use Redis allkeys-lru for the context cache when memory pressure rises. Pair this with TTL on transient pack entries so cold keys are evicted predictably during long-running test loops.',
};

async function withFreshStore(work: (detector: DuplicateDetector, store: MemoryKnowledgeStore) => Promise<void>) {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  const store = new MemoryKnowledgeStore();
  const provider = new HashModelProvider(1536);
  const detector = new DuplicateDetector(store, provider);
  try {
    await work(detector, store);
  } finally {
    resetRetrievalPolicyCache();
  }
}

test('sevenGramTokens produces overlapping shingles', () => {
  const tokens = sevenGramTokens('the quick brown fox');
  assert.ok(tokens.size > 0);
  assert.ok([...tokens][0].length === 7);
});

test('jaccardSimilarity returns 1 for identical token sets and 0 for disjoint', () => {
  const a = sevenGramTokens('the quick brown fox jumps over');
  const b = sevenGramTokens('the quick brown fox jumps over');
  assert.equal(jaccardSimilarity(a, b), 1);
  const c = sevenGramTokens('zzz aaa bbb ccc ddd eee');
  const d = sevenGramTokens('111 222 333 444 555 666 777');
  assert.equal(jaccardSimilarity(c, d), 0);
});

test('detector returns allow for an empty store', async () => {
  await withFreshStore(async (detector) => {
    const decision = await detector.assess(BASE_INPUT);
    assert.equal(decision.decision, 'allow');
  });
});

test('detector flags or rejects an identical re-ingestion', async () => {
  await withFreshStore(async (detector, store) => {
    const stored = await store.upsertKnowledge(BASE_INPUT, []);
    assert.ok(stored.id);
    const decision = await detector.assess(NEAR_DUPLICATE);
    assert.ok(decision.decision === 'block' || decision.decision === 'reject', `expected block/reject, got ${decision.decision}`);
    assert.ok(decision.jaccard >= 0.85, `jaccard too low: ${decision.jaccard}`);
    assert.equal(decision.match?.id, stored.id);
  });
});

test('detector allows obviously different content even with the same project', async () => {
  await withFreshStore(async (detector, store) => {
    await store.upsertKnowledge(BASE_INPUT, []);
    const decision = await detector.assess(DIFFERENT_CONTENT);
    assert.equal(decision.decision, 'allow');
    assert.ok(decision.jaccard < 0.85);
  });
});

test('detector skipped when duplicateDetector is off in policy', async () => {
  await withFreshStore(async (detector, store) => {
    await store.upsertKnowledge(BASE_INPUT, []);
    setRetrievalPolicy({ ...DEFAULT_POLICY, duplicateDetector: 'off' });
    const decision = await detector.assess(NEAR_DUPLICATE);
    assert.equal(decision.decision, 'allow');
  });
});

test('assertNotDuplicate throws DuplicateIngestionError on block/reject', async () => {
  await withFreshStore(async (detector, store) => {
    await store.upsertKnowledge(BASE_INPUT, []);
    await assert.rejects(() => detector.assertNotDuplicate(NEAR_DUPLICATE), (error: unknown) => {
      assert.ok(error instanceof DuplicateIngestionError);
      return true;
    });
  });
});
