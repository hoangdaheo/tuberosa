import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryCache } from '../src/cache.js';
import { LlmCritic } from '../src/atoms/llm-critic.js';
import type { ModelProvider } from '../src/model/provider.js';

function makeProvider(verdict: { generalizable: boolean; reason: string; confidence: number }): ModelProvider {
  return ({
    judgeAtomUtility: async () => verdict,
  } as unknown) as ModelProvider;
}

test('LlmCritic.judge: returns the provider verdict and caches it', async () => {
  const cache = new MemoryCache();
  let calls = 0;
  const provider: ModelProvider = ({
    judgeAtomUtility: async () => { calls += 1; return { generalizable: true, reason: 'ok', confidence: 0.8 }; },
  } as unknown) as ModelProvider;
  const critic = new LlmCritic(provider, cache);
  const a = await critic.judge({ claim: 'c', type: 'fact', trigger: { errors: ['e'] } });
  const b = await critic.judge({ claim: 'c', type: 'fact', trigger: { errors: ['e'] } });
  assert.equal(calls, 1, 'second call must hit cache');
  assert.deepEqual(a, b);
});

test('LlmCritic.judge: returns undefined when provider has no judgeAtomUtility', async () => {
  const cache = new MemoryCache();
  const provider: ModelProvider = ({} as unknown) as ModelProvider;
  const critic = new LlmCritic(provider, cache);
  const verdict = await critic.judge({ claim: 'c', type: 'fact', trigger: { errors: ['e'] } });
  assert.equal(verdict, undefined);
});

test('LlmCritic.isBorderline: true when content words just barely above sparse threshold', () => {
  const cache = new MemoryCache();
  const critic = new LlmCritic(makeProvider({ generalizable: true, reason: '', confidence: 1 }), cache);
  const borderlineByMargin = critic.isBorderline({
    project: 'p', claim: 'alpha beta gamma delta epsilon',
    type: 'fact', evidence: [{ kind: 'file', path: 'x' }],
    trigger: { errors: ['e'] }, producedBy: 'agent_session',
  }, { ok: true, matched: [], marginContentWords: 5 });
  assert.equal(borderlineByMargin, true);
});

test('LlmCritic.isBorderline: true when trigger has only taskTypes', () => {
  const cache = new MemoryCache();
  const critic = new LlmCritic(makeProvider({ generalizable: true, reason: '', confidence: 1 }), cache);
  const r = critic.isBorderline({
    project: 'p', claim: 'a long enough claim that is fine here',
    type: 'fact', evidence: [{ kind: 'file', path: 'x' }],
    trigger: { taskTypes: ['refactor'] }, producedBy: 'agent_session',
  }, { ok: true, matched: [], marginContentWords: 8 });
  assert.equal(r, true);
});

test('LlmCritic.isBorderline: false for a well-triggered, content-rich atom', () => {
  const cache = new MemoryCache();
  const critic = new LlmCritic(makeProvider({ generalizable: true, reason: '', confidence: 1 }), cache);
  const r = critic.isBorderline({
    project: 'p', claim: 'pgvector column dim must equal EMBEDDING_DIMENSIONS in config otherwise inserts fail',
    type: 'gotcha', evidence: [{ kind: 'file', path: 'x' }],
    trigger: { errors: ['dimension mismatch'], symbols: ['pgvector'] }, producedBy: 'agent_session',
  }, { ok: true, matched: [], marginContentWords: 10 });
  assert.equal(r, false);
});
