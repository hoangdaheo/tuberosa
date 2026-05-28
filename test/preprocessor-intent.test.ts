import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryCache } from '../src/cache.js';
import { LlmIntentExtractor } from '../src/retrieval/llm-intent.js';
import type { ModelProvider } from '../src/model/provider.js';

test('LlmIntentExtractor.extract: returns verdict and caches by prompt hash', async () => {
  let calls = 0;
  const cache = new MemoryCache();
  const p = ({
    extractPromptIntent: async () => {
      calls += 1;
      return { primary: 'Do X.', subTasks: ['Do Y.'], confidence: 0.9 };
    },
  } as unknown) as ModelProvider;
  const x = new LlmIntentExtractor(p, cache);
  const a = await x.extract({ prompt: 'big prompt body' });
  const b = await x.extract({ prompt: 'big prompt body' });
  assert.ok(a && b);
  // Verdict fields match; cacheHit intentionally differs (false on miss, true on hit).
  const stripCacheHit = ({ cacheHit, ...rest }: { cacheHit: boolean }) => rest;
  assert.deepEqual(stripCacheHit(a!), stripCacheHit(b!));
  assert.equal(a!.cacheHit, false);
  assert.equal(b!.cacheHit, true);
  assert.equal(calls, 1);
});

test('LlmIntentExtractor.extract: returns undefined when provider lacks the method', async () => {
  const cache = new MemoryCache();
  const x = new LlmIntentExtractor({} as ModelProvider, cache);
  assert.equal(await x.extract({ prompt: 'p' }), undefined);
});

test('LlmIntentExtractor.extract: different prompts produce different cache keys', async () => {
  let calls = 0;
  const cache = new MemoryCache();
  const p = ({
    extractPromptIntent: async () => {
      calls += 1;
      return { primary: 'a', subTasks: [], confidence: 1 };
    },
  } as unknown) as ModelProvider;
  const x = new LlmIntentExtractor(p, cache);
  await x.extract({ prompt: 'p1' });
  await x.extract({ prompt: 'p2' });
  assert.equal(calls, 2);
});
