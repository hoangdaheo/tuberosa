import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelProvider } from '../src/model/factory.js';
import { HashModelProvider } from '../src/model/provider.js';
import { ModelProviderError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';

function configWith(overrides: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const config = loadConfig();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return config;
}

test('explicit hash provider still returns HashModelProvider', () => {
  const config = configWith({ TUBEROSA_MODEL_PROVIDER: 'hash' });
  assert.ok(createModelProvider(config) instanceof HashModelProvider);
});

test('openai selected without a key throws instead of returning hash', () => {
  const config = configWith({ TUBEROSA_MODEL_PROVIDER: 'openai', OPENAI_API_KEY: undefined, TUBEROSA_ALLOW_HASH_FALLBACK: undefined });
  assert.throws(() => createModelProvider(config), ModelProviderError);
});

test('allowHashFallback=true permits the hash fallback', () => {
  const config = configWith({ TUBEROSA_MODEL_PROVIDER: 'openai', OPENAI_API_KEY: undefined, TUBEROSA_ALLOW_HASH_FALLBACK: 'true' });
  assert.ok(createModelProvider(config) instanceof HashModelProvider);
});

test('local provider exposes verifyReady', () => {
  const config = configWith({ TUBEROSA_MODEL_PROVIDER: 'local' });
  const models = createModelProvider(config) as { verifyReady?: unknown };
  assert.equal(typeof models.verifyReady, 'function');
});
