import { strict as assert } from 'node:assert';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { AgentSessionService } from '../src/agent-session/service.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { ReflectionService } from '../src/reflection/service.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

const config: AppConfig = {
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
    embeddingDimensions: 1536,
    embeddingModel: 'Xenova/bge-small-en-v1.5',
    openAiEmbeddingModel: 'text-embedding-3-small',
    openAiTimeoutMs: 30_000,
    llmCriticEnabled: false,
    allowHashFallback: false,
  },
  context: {
    mode: 'layered',
    cacheTtlSeconds: 60,
    deepContextBudget: 60_000,
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
    enabled: false,
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

async function main(): Promise<void> {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, config);
  const reflection = new ReflectionService(store, ingestion);
  const sessions = new AgentSessionService(store, retrieval, reflection);

  await ingestion.ingestKnowledge({
    project: 'agent-context-eval',
    sourceType: 'manual',
    sourceUri: 'manual://agent-context',
    itemType: 'workflow',
    title: 'Agent context eval workflow',
    summary: 'Agents should record context decisions before finishing.',
    content: 'AgentContextEvalSymbol verifies that agent sessions select, miss, or bypass context with explicit compliance metadata.',
    labels: [{ type: 'symbol', value: 'AgentContextEvalSymbol', weight: 1 }],
  });

  await expectSelectedCompliance(sessions);
  await expectNeedsDecision(sessions);
  await expectMissingContextRecorded(sessions);
  await expectBypassed(sessions);

  await Promise.allSettled([cache.close(), store.close()]);
  console.log('Agent context compliance eval passed.');
}

async function expectSelectedCompliance(sessions: AgentSessionService): Promise<void> {
  const started = await sessions.startSession({
    project: 'agent-context-eval',
    prompt: 'Use AgentContextEvalSymbol',
    bypassCache: true,
  });
  await sessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'selected',
  });
  const finished = await sessions.finishSession({ sessionId: started.session.id, outcome: 'completed' });
  assert.equal(finished.compliance.status, 'compliant');
}

async function expectNeedsDecision(sessions: AgentSessionService): Promise<void> {
  const started = await sessions.startSession({
    project: 'agent-context-eval',
    prompt: 'Use AgentContextEvalSymbol without decision',
    bypassCache: true,
  });
  const finished = await sessions.finishSession({ sessionId: started.session.id, outcome: 'completed' });
  assert.equal(finished.compliance.status, 'needs_decision');
}

async function expectMissingContextRecorded(sessions: AgentSessionService): Promise<void> {
  const started = await sessions.startSession({
    project: 'agent-context-eval',
    prompt: 'Use missing context path',
    bypassCache: true,
  });
  await sessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'missing_context',
    reason: 'The pack did not include the required implementation detail.',
  });
  const finished = await sessions.finishSession({ sessionId: started.session.id, outcome: 'blocked' });
  assert.equal(finished.compliance.status, 'missing_context_recorded');
}

async function expectBypassed(sessions: AgentSessionService): Promise<void> {
  const started = await sessions.startSession({
    project: 'agent-context-eval',
    prompt: 'Bypass context with explicit reason',
    bypassCache: true,
  });
  const finished = await sessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    contextBypassReason: 'Trivial command with no project context needed.',
  });
  assert.equal(finished.compliance.status, 'bypassed');
}

await main();
