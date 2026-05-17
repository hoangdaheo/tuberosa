import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { AgentSessionService } from '../src/agent-session/service.js';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { ReflectionService } from '../src/reflection/service.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

const config: AppConfig = {
  env: 'test',
  port: 3027,
  databaseUrl: '',
  redisUrl: '',
  store: 'memory',
  cache: 'memory',
  autoMigrate: false,
  modelProvider: 'hash',
  embeddingDimensions: 1536,
  openAiEmbeddingModel: 'text-embedding-3-small',
  contextCacheTtlSeconds: 0,
  maxRequestBytes: 10 * 1024 * 1024,
  maxIngestContentBytes: 2 * 1024 * 1024,
  backupDir: '.tuberosa/test-backups',
  backupIntervalSeconds: 0,
  backupStartupDelaySeconds: 0,
  backupRetentionCount: 24,
  backupRetentionMaxAgeDays: 30,
  backupWriteThrough: false,
  backupWriteThroughThrottleSeconds: 600,
};

test('agent sessions start with context, record decisions, retry rejected context, and finish with a reflection draft', async () => {
  const { agentSessions, ingestion } = createTestServices();

  const authFix = await ingestion.ingestKnowledge({
    project: 'agent-memory',
    sourceType: 'file',
    sourceUri: 'src/auth.ts',
    itemType: 'bugfix',
    title: 'AuthService TS-999 fix',
    summary: 'Current AuthService fix guidance.',
    content: 'Fix TS-999 in src/auth.ts by preserving refresh token rotation inside AuthService.',
    trustLevel: 90,
    labels: [
      { type: 'file', value: 'src/auth.ts', weight: 1 },
      { type: 'symbol', value: 'AuthService', weight: 1 },
      { type: 'error', value: 'TS-999', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'src/auth.ts' }],
  });
  await ingestion.ingestKnowledge({
    project: 'agent-memory',
    sourceType: 'file',
    sourceUri: 'docs/auth-retry.md',
    itemType: 'workflow',
    title: 'Auth retry workflow',
    summary: 'Fallback AuthService workflow guidance.',
    content: 'When AuthService context is stale, retry with workflow guidance before continuing from fresh context.',
    trustLevel: 80,
    labels: [
      { type: 'symbol', value: 'AuthService', weight: 1 },
      { type: 'business_area', value: 'auth', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'docs/auth-retry.md' }],
  });

  const started = await agentSessions.startSession({
    project: 'agent-memory',
    cwd: '/repo',
    prompt: 'Fix TS-999 in src/auth.ts for AuthService',
    files: ['src/auth.ts'],
    symbols: ['AuthService'],
    errors: ['TS-999'],
    taskType: 'debugging',
    agentName: 'Codex',
    agentTool: 'mcp',
  });

  equal(started.session.status, 'active');
  equal(started.session.initialContextPackId, started.contextPack.id);
  equal(started.policy.action, 'proceed');

  const rejected = await agentSessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'rejected',
    reason: 'Need fallback context.',
    rejectedKnowledgeIds: [authFix.id],
  });
  const retryIds = rejected.retry?.sections.flatMap((section) => section.items.map((item) => item.knowledgeId)) ?? [];

  equal(rejected.decision.decision, 'rejected');
  ok(rejected.retry);
  ok(!retryIds.includes(authFix.id));

  const finished = await agentSessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    summary: 'Finished the AuthService fix.',
    reflectionDraft: {
      title: 'Record agent session lessons',
      summary: 'Agent sessions should link useful work to reflection drafts.',
      content: 'When an agent completes a context-driven task, finish the session and draft the durable lesson for later approval.',
      triggerType: 'complex_task_success',
    },
  });

  equal(finished.session.status, 'finished');
  equal(finished.session.outcome, 'completed');
  equal(finished.reflectionDraft?.status, 'pending');
  equal(finished.session.reflectionDraftIds[0], finished.reflectionDraft?.id);
});

function createTestServices() {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, config);
  const reflection = new ReflectionService(store, ingestion);
  const agentSessions = new AgentSessionService(store, retrieval, reflection);

  return { store, cache, models, ingestion, retrieval, reflection, agentSessions };
}
