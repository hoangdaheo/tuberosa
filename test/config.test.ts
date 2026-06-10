import test, { describe, it } from 'node:test';
import { equal } from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('config enables startup migrations by default and supports opt out', () => {
  const defaultConfig = withEnv({ TUBEROSA_AUTO_MIGRATE: undefined }, () => loadConfig());
  equal(defaultConfig.storage.autoMigrate, true);

  const disabledConfig = withEnv({ TUBEROSA_AUTO_MIGRATE: 'false' }, () => loadConfig());
  equal(disabledConfig.storage.autoMigrate, false);
});

test('config reads physical mirror debounce with default', () => {
  const defaultConfig = withEnv({ TUBEROSA_PHYSICAL_MIRROR_DEBOUNCE_MS: undefined }, () => loadConfig());
  equal(defaultConfig.mirror.debounceMs, 500);

  const configured = withEnv({ TUBEROSA_PHYSICAL_MIRROR_DEBOUNCE_MS: '250' }, () => loadConfig());
  equal(configured.mirror.debounceMs, 250);
});

test('config reads OpenAI fetch timeout with default', () => {
  const defaultConfig = withEnv({ TUBEROSA_OPENAI_TIMEOUT_MS: undefined }, () => loadConfig());
  equal(defaultConfig.model.openAiTimeoutMs, 30000);

  const configured = withEnv({ TUBEROSA_OPENAI_TIMEOUT_MS: '5000' }, () => loadConfig());
  equal(configured.model.openAiTimeoutMs, 5000);
});

test('config byte caps fall back to defaults on missing or invalid env', () => {
  const defaults = withEnv(
    { TUBEROSA_MAX_REQUEST_BYTES: undefined, TUBEROSA_MAX_INGEST_CONTENT_BYTES: undefined },
    () => loadConfig(),
  );
  equal(defaults.http.maxRequestBytes, 10 * 1024 * 1024);
  equal(defaults.ingest.maxContentBytes, 2 * 1024 * 1024);

  const invalid = withEnv(
    { TUBEROSA_MAX_REQUEST_BYTES: 'not-a-number', TUBEROSA_MAX_INGEST_CONTENT_BYTES: '0' },
    () => loadConfig(),
  );
  equal(invalid.http.maxRequestBytes, 10 * 1024 * 1024);
  equal(invalid.ingest.maxContentBytes, 2 * 1024 * 1024);

  const configured = withEnv(
    { TUBEROSA_MAX_REQUEST_BYTES: '1024', TUBEROSA_MAX_INGEST_CONTENT_BYTES: '512' },
    () => loadConfig(),
  );
  equal(configured.http.maxRequestBytes, 1024);
  equal(configured.ingest.maxContentBytes, 512);
});

describe('full-featured defaults (Spec A)', () => {
  it('defaults the model provider to local when no OpenAI key is set', () => {
    const config = withEnv({ TUBEROSA_MODEL_PROVIDER: undefined, OPENAI_API_KEY: undefined }, () => loadConfig());
    equal(config.model.provider, 'local');
  });

  it('still prefers openai when an API key is present', () => {
    const config = withEnv({ TUBEROSA_MODEL_PROVIDER: undefined, OPENAI_API_KEY: 'sk-test' }, () => loadConfig());
    equal(config.model.provider, 'openai');
  });

  it('defaults embedding dimensions to 384 and the model to bge-small', () => {
    const config = withEnv({ EMBEDDING_DIMENSIONS: undefined, TUBEROSA_EMBEDDING_MODEL: undefined }, () => loadConfig());
    equal(config.model.embeddingDimensions, 384);
    equal(config.model.embeddingModel, 'Xenova/bge-small-en-v1.5');
  });

  it('honors TUBEROSA_EMBEDDING_MODEL', () => {
    const config = withEnv({ TUBEROSA_EMBEDDING_MODEL: 'Xenova/other-model' }, () => loadConfig());
    equal(config.model.embeddingModel, 'Xenova/other-model');
  });
});

function withEnv<T>(patch: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
