import test from 'node:test';
import { equal } from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('config enables startup migrations by default and supports opt out', () => {
  const defaultConfig = withEnv({ TUBEROSA_AUTO_MIGRATE: undefined }, () => loadConfig());
  equal(defaultConfig.autoMigrate, true);

  const disabledConfig = withEnv({ TUBEROSA_AUTO_MIGRATE: 'false' }, () => loadConfig());
  equal(disabledConfig.autoMigrate, false);
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
