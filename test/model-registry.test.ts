import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import type { AppConfig } from '../src/config.js';
import { buildOllamaRegistry, buildProviderRegistry, ProviderRegistry } from '../src/model/registry.js';

function baseConfig(modelOverrides: Partial<AppConfig['model']>): AppConfig {
  return {
    model: {
      provider: 'hash',
      embeddingDimensions: 1536,
      ...modelOverrides,
    },
  } as AppConfig;
}

test('buildProviderRegistry returns null when modelProvider is not local', () => {
  equal(buildProviderRegistry(baseConfig({ provider: 'hash' })), null);
  equal(buildProviderRegistry(baseConfig({ provider: 'openai' })), null);
  equal(buildProviderRegistry(baseConfig({ provider: 'ollama' })), null);
});

test('buildProviderRegistry composes hash + local cross-encoder when modelProvider=local', () => {
  const registry = buildProviderRegistry(baseConfig({ provider: 'local' }));
  ok(registry instanceof ProviderRegistry, 'expected a ProviderRegistry instance');
  const description = (registry as ProviderRegistry).describe();
  const capabilities = new Map(description.map((entry) => [entry.capability, entry.providerName]));
  equal(capabilities.get('embed'), 'hash');
  equal(capabilities.get('rewriteQuery'), 'hash');
  equal(capabilities.get('rerank'), 'local-cross-encoder');
});

test('buildOllamaRegistry returns null when modelProvider is not ollama', () => {
  equal(buildOllamaRegistry(baseConfig({ provider: 'hash' })), null);
  equal(buildOllamaRegistry(baseConfig({ provider: 'local' })), null);
  equal(buildOllamaRegistry(baseConfig({ provider: 'openai' })), null);
});

test('buildOllamaRegistry composes hash + ollama rerank when modelProvider=ollama', () => {
  const registry = buildOllamaRegistry(baseConfig({
    provider: 'ollama',
    ollamaUrl: 'http://localhost:11434',
    ollamaRerankModel: 'qwen2.5:3b',
  }));
  ok(registry instanceof ProviderRegistry);
  const description = (registry as ProviderRegistry).describe();
  const capabilities = new Map(description.map((entry) => [entry.capability, entry.providerName]));
  equal(capabilities.get('embed'), 'hash');
  equal(capabilities.get('rewriteQuery'), 'hash');
  equal(capabilities.get('rerank'), 'ollama-reranker');
});

test('ProviderRegistry.register is first-write-wins per capability', () => {
  const fallback = {
    async embed() { return [0]; },
    async rewriteQuery() { return undefined; },
    async rerank() { return { candidates: [], model: 'fallback' }; },
  };
  const registry = new ProviderRegistry(fallback);
  registry.register({
    name: 'first',
    capabilities: ['embed'],
    embed: async () => [1],
    rewriteQuery: async () => undefined,
    rerank: async () => ({ candidates: [], model: 'first' }),
  });
  registry.register({
    name: 'second',
    capabilities: ['embed'],
    embed: async () => [2],
    rewriteQuery: async () => undefined,
    rerank: async () => ({ candidates: [], model: 'second' }),
  });
  const description = registry.describe();
  const embed = description.find((entry) => entry.capability === 'embed');
  equal(embed?.providerName, 'first', 'second register should not overwrite first');
});

test('ProviderRegistry falls back to fallback provider when capability is missing', async () => {
  const fallback = {
    async embed() { return [42]; },
    async rewriteQuery() { return undefined; },
    async rerank() { return { candidates: [], model: 'fallback' }; },
  };
  const registry = new ProviderRegistry(fallback);
  // No registrations — every capability goes through fallback.
  const embedded = await registry.embed('text');
  equal(embedded[0], 42);
  const reranked = await registry.rerank({ candidates: [], context: { prompt: 'p' } } as never);
  equal(reranked.model, 'fallback');
});

test('registry has NO extractAtoms when extract model is unset (honest capability check)', () => {
  const registry = buildOllamaRegistry(baseConfig({
    provider: 'ollama',
    ollamaUrl: 'http://localhost:11434',
    ollamaRerankModel: 'reranker',
  }));
  ok(registry);
  equal((registry as ProviderRegistry).extractAtoms, undefined);
  equal((registry as ProviderRegistry).judgeAtomUtility, undefined);
});

test('registry passes extractAtoms + judgeAtomUtility through when extract model is set', () => {
  const registry = buildOllamaRegistry(baseConfig({
    provider: 'ollama',
    ollamaUrl: 'http://localhost:11434',
    ollamaRerankModel: 'reranker',
    ollamaExtractModel: 'qwen3.5:latest',
  }));
  ok(registry);
  equal(typeof (registry as ProviderRegistry).extractAtoms, 'function');
  equal(typeof (registry as ProviderRegistry).judgeAtomUtility, 'function');
  const description = (registry as ProviderRegistry).describe();
  const capabilities = new Map(description.map((entry) => [entry.capability, entry.providerName]));
  equal(capabilities.get('extractAtoms'), 'ollama-generation');
  equal(capabilities.get('judgeAtomUtility'), 'ollama-generation');
});
