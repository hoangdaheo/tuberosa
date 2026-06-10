import type { AppConfig } from '../../src/config.js';

/**
 * Minimal but complete AppConfig used across unit tests.
 * Avoid postgres, redis, and any external API calls.
 * Override only the fields that matter to a specific test.
 */
const DEFAULTS: AppConfig = {
  env: 'test',
  http: {
    port: 3027,
    host: '127.0.0.1',
    requireApiKeyForNonLoopback: false,
    maxRequestBytes: 10 * 1024 * 1024,
  },
  storage: {
    store: 'memory',
    cache: 'memory',
    databaseUrl: '',
    redisUrl: '',
    autoMigrate: false,
  },
  model: {
    provider: 'hash',
    embeddingDimensions: 384,
    embeddingModel: 'Xenova/bge-small-en-v1.5',
    openAiEmbeddingModel: 'text-embedding-3-small',
    openAiTimeoutMs: 30_000,
    llmCriticEnabled: false,
  },
  context: {
    cacheTtlSeconds: 60,
  },
  ingest: {
    maxContentBytes: 2 * 1024 * 1024,
  },
  backup: {
    dir: '.tuberosa/test-backups',
    exportBaseDir: '.tuberosa/test-exports',
    importBaseDir: '.tuberosa/test-imports',
    intervalSeconds: 0,
    startupDelaySeconds: 0,
    retentionCount: 24,
    retentionMaxAgeDays: 30,
    writeThrough: false,
    writeThroughThrottleSeconds: 600,
  },
  mirror: {
    debounceMs: 500,
  },
  atlas: {},
  errorLog: {
    dir: '.tuberosa/test-error-logs',
    maxBytes: 256 * 1024,
    autoCapture: true,
    captureClientErrors: false,
  },
  worktree: {
    enabled: true,
    maxFiles: 50,
    maxMtimeAgeHours: 72,
  },
  archival: {
    enabled: false,
    intervalHours: 24,
  },
  graphInference: {
    enabled: false,
  },
  userStyle: {},
  persistReplay: false,
};

export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULTS, ...overrides };
}
