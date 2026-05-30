import test from 'node:test';
import { equal } from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('config enables startup migrations by default and supports opt out', () => {
  const defaultConfig = withEnv({ TUBEROSA_AUTO_MIGRATE: undefined }, () => loadConfig());
  equal(defaultConfig.autoMigrate, true);

  const disabledConfig = withEnv({ TUBEROSA_AUTO_MIGRATE: 'false' }, () => loadConfig());
  equal(disabledConfig.autoMigrate, false);
});

test('config reads physical mirror debounce with default', () => {
  const defaultConfig = withEnv({ TUBEROSA_PHYSICAL_MIRROR_DEBOUNCE_MS: undefined }, () => loadConfig());
  equal(defaultConfig.physicalMirrorDebounceMs, 500);

  const configured = withEnv({ TUBEROSA_PHYSICAL_MIRROR_DEBOUNCE_MS: '250' }, () => loadConfig());
  equal(configured.physicalMirrorDebounceMs, 250);
});

test('config reads OpenAI fetch timeout with default', () => {
  const defaultConfig = withEnv({ TUBEROSA_OPENAI_TIMEOUT_MS: undefined }, () => loadConfig());
  equal(defaultConfig.openAiTimeoutMs, 30000);

  const configured = withEnv({ TUBEROSA_OPENAI_TIMEOUT_MS: '5000' }, () => loadConfig());
  equal(configured.openAiTimeoutMs, 5000);
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
