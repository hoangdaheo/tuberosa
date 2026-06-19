import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertModelsReady } from '../src/model/health.js';
import { ModelProviderError } from '../src/errors.js';
import type { AppConfig } from '../src/config.js';

const baseModel = { embed: async () => [], rewriteQuery: async () => undefined, rerank: async () => ({ candidates: [] }) };
function cfg(provider: string, allowHashFallback = false, env = 'development'): AppConfig {
  return { env, model: { provider, allowHashFallback } } as unknown as AppConfig;
}

test('skips the check for non-local providers', async () => {
  await assertModelsReady(baseModel as any, cfg('hash'));
});

test('skips the check in the test env', async () => {
  await assertModelsReady(baseModel as any, cfg('local', false, 'test'));
});

test('throws when the local embedder is unavailable', async () => {
  const models = { ...baseModel, verifyReady: async () => ({ embedder: false, reranker: true, dims: null }) };
  await assert.rejects(() => assertModelsReady(models as any, cfg('local')), ModelProviderError);
});

test('throws when the reranker is unavailable', async () => {
  const models = { ...baseModel, verifyReady: async () => ({ embedder: true, reranker: false, dims: 384 }) };
  await assert.rejects(() => assertModelsReady(models as any, cfg('local')), ModelProviderError);
});

test('passes when both models are ready', async () => {
  const models = { ...baseModel, verifyReady: async () => ({ embedder: true, reranker: true, dims: 384 }) };
  await assertModelsReady(models as any, cfg('local'));
});

test('skips when allowHashFallback is set', async () => {
  const models = { ...baseModel, verifyReady: async () => ({ embedder: false, reranker: false, dims: null }) };
  await assertModelsReady(models as any, cfg('local', true));
});
