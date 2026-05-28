import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { preprocessLongPrompt } from '../src/retrieval/preprocessor.js';
import { DEFAULT_POLICY, resetRetrievalPolicyCache, setRetrievalPolicy } from '../src/retrieval/policy.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type { ModelProvider } from '../src/model/provider.js';
import type { AppConfig } from '../src/config.js';

const testConfig: AppConfig = {
  env: 'test',
  port: 3027,
  databaseUrl: '',
  redisUrl: '',
  httpHost: '127.0.0.1',
  requireApiKeyForNonLoopback: false,
  store: 'memory',
  cache: 'memory',
  autoMigrate: false,
  modelProvider: 'hash',
  embeddingDimensions: 1536,
  openAiEmbeddingModel: 'text-embedding-3-small',
  contextCacheTtlSeconds: 60,
  maxRequestBytes: 10 * 1024 * 1024,
  maxIngestContentBytes: 2 * 1024 * 1024,
  backupDir: '.tuberosa/test-backups',
  backupIntervalSeconds: 0,
  backupStartupDelaySeconds: 0,
  backupRetentionCount: 24,
  backupRetentionMaxAgeDays: 30,
  backupWriteThrough: false,
  backupWriteThroughThrottleSeconds: 600,
  physicalMirrorDebounceMs: 500,
  errorLogDir: '.tuberosa/test-error-logs',
  errorLogMaxBytes: 256 * 1024,
  errorLogAutoCapture: true,
  errorLogCaptureClientErrors: false,
  persistReplay: false,
  worktreeEnabled: false,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
  llmCriticEnabled: false,
  archivalEnabled: false,
  archivalIntervalHours: 24,
};

function withPolicy(work: () => Promise<void>): Promise<void> {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  return work();
}

test('preprocessLongPrompt: short prompts pass through with lengthClass=short and no preprocessing changes', () => withPolicy(async () => {
  const out = await preprocessLongPrompt({ prompt: 'fix the bug' }, new HashModelProvider(), new MemoryCache());
  assert.equal(out.promptPreprocessing?.lengthClass, 'short');
  assert.equal(out.promptPreprocessing?.embeddingSource, 'original');
  assert.equal(out.prompt, 'fix the bug');
}));

test('preprocessLongPrompt: medium prompts get structural sweep, no LLM, original prompt for embedding', () => withPolicy(async () => {
  const body = 'update src/retrieval/fusion.ts and fix src/retrieval/policy.ts'.repeat(60);
  const out = await preprocessLongPrompt({ prompt: body }, new HashModelProvider(), new MemoryCache());
  assert.equal(out.promptPreprocessing?.lengthClass, 'medium');
  assert.equal(out.promptPreprocessing?.embeddingSource, 'original');
  assert.ok((out.promptPreprocessing?.structuralSignals.files.length ?? 0) > 0);
  assert.equal(out.promptPreprocessing?.subTasks, undefined);
}));

test('preprocessLongPrompt: long prompts with no LLM provider use anchor_window fallback', () => withPolicy(async () => {
  const body = 'update src/retrieval/fusion.ts. '.repeat(2000);
  const out = await preprocessLongPrompt({ prompt: body }, new HashModelProvider(), new MemoryCache());
  assert.equal(out.promptPreprocessing?.lengthClass, 'long');
  assert.equal(out.promptPreprocessing?.embeddingSource, 'anchor_window');
  assert.ok(out.prompt.length < body.length, 'prompt must be truncated to anchor window');
}));

test('searchContext: long prompts get promptPreprocessing in classified', () => withPolicy(async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, testConfig);
  const body = 'update src/retrieval/fusion.ts. '.repeat(2000);
  const pack = await service.searchContext({ project: 'tuberosa', prompt: body });
  assert.equal(pack.classified.preprocessing?.lengthClass, 'long');
  assert.equal(pack.classified.preprocessing?.embeddingSource, 'anchor_window');
}));

test('pack: taskBrief.followUpSearches mirrors subTasks for long prompts', () => withPolicy(async () => {
  const base = new HashModelProvider();
  const intentProvider: ModelProvider = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    extractPromptIntent: async () => ({
      primary: 'Refactor fusion.',
      subTasks: ['Add tests.', 'Update docs/foo.md.'],
      confidence: 0.85,
    }),
  });
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const service = new RetrievalService(store, cache, intentProvider, testConfig);
  const body = 'update src/retrieval/fusion.ts. '.repeat(2000);
  const pack = await service.searchContext({ project: 'tuberosa', prompt: body });
  assert.deepEqual(pack.taskBrief?.followUpSearches, ['Add tests.', 'Update docs/foo.md.']);
}));

test('classifier: when preprocessing.structuralSignals are present, classified.symbols is capped to swept top-K', () => withPolicy(async () => {
  // Construct a prompt with 200 distinct backticked symbols (so they earn the
  // code_block anchor and survive the sweep's score floor).
  const symbols = Array.from({ length: 200 }, (_, i) => `MyClass${i.toString().padStart(3, '0')}`);
  const body = `update src/x.ts. ` + symbols.map((s) => `Mention of \`${s}\`.`).join(' ').repeat(20);
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, testConfig);
  const pack = await service.searchContext({ project: 'tuberosa', prompt: body });
  assert.ok(
    pack.classified.symbols.length <= 12,
    `expected <=12, got ${pack.classified.symbols.length}`,
  );
}));

test('searchContext: continuation walker is gated for long prompts even with continuation phrase', () => withPolicy(async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider();
  const service = new RetrievalService(store, cache, models, testConfig);
  const body = 'continue where we left off. ' + 'update src/retrieval/fusion.ts. '.repeat(2000);
  const pack = await service.searchContext({ project: 'tuberosa', prompt: body });
  assert.equal(pack.classified.preprocessing?.continuationGated, true);
}));

test('preprocessLongPrompt: long prompts with an intent-capable provider use primary_intent', () => withPolicy(async () => {
  const body = 'update src/retrieval/fusion.ts. '.repeat(2000);
  const intentProvider: ModelProvider = ({
    extractPromptIntent: async () => ({
      primary: 'Refactor fusion weights.',
      subTasks: ['Run retrieval eval.'],
      confidence: 0.9,
    }),
  } as unknown) as ModelProvider;
  const out = await preprocessLongPrompt({ prompt: body }, intentProvider, new MemoryCache());
  assert.equal(out.promptPreprocessing?.lengthClass, 'long');
  assert.equal(out.promptPreprocessing?.embeddingSource, 'primary_intent');
  assert.equal(out.prompt, 'Refactor fusion weights.');
  assert.deepEqual(out.promptPreprocessing?.subTasks, ['Run retrieval eval.']);
}));
