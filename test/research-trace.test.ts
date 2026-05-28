import test from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { AgentSessionService } from '../src/agent-session/service.js';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { ReflectionService } from '../src/reflection/service.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { validateFinishAgentSessionInput } from '../src/validation.js';

const config: AppConfig = {
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
  physicalMirrorDebounceMs: 500,
  errorLogDir: '.tuberosa/test-error-logs',
  errorLogMaxBytes: 256 * 1024,
  errorLogAutoCapture: true,
  errorLogCaptureClientErrors: false,
  persistReplay: false,
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
  llmCriticEnabled: false,
  archivalEnabled: false,
  graphInferenceEnabled: false,
  archivalIntervalHours: 24,
};

test('finish-session validation rejects oversized research traces', () => {
  throws(() => validateFinishAgentSessionInput({
    sessionId: '11111111-1111-1111-1111-111111111111',
    outcome: 'completed',
    researchTrace: {
      outcome: 'Verified the change.',
      steps: Array.from({ length: 13 }, (_, index) => ({
        kind: 'action',
        text: `step ${index}`,
      })),
    },
  }));

  throws(() => validateFinishAgentSessionInput({
    sessionId: '11111111-1111-1111-1111-111111111111',
    outcome: 'completed',
    researchTrace: {
      outcome: 'Verified the change.',
      steps: [{ kind: 'observation', text: 'x'.repeat(281) }],
    },
  }));
});

test('explicit research trace is stored on session metadata and draft provenance', async () => {
  const { agentSessions, ingestion } = createTestServices();
  await seedWidgetKnowledge(ingestion, 'trace-explicit');

  const started = await agentSessions.startSession({
    project: 'trace-explicit',
    prompt: 'Update src/widget.ts for WidgetService',
    files: ['src/widget.ts'],
    symbols: ['WidgetService'],
    taskType: 'implementation',
    bypassCache: true,
  });
  await agentSessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'selected',
  });

  const finished = await agentSessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    summary: 'WidgetService update completed with explicit research trace.',
    researchTrace: {
      outcome: 'Verified with pnpm test.',
      steps: [{
        kind: 'decision',
        text: 'Used the selected WidgetService context pack before editing.',
        references: [{ file: 'src/widget.ts', symbol: 'WidgetService' }],
      }],
    },
    reflectionDraft: {
      title: 'WidgetService trace lesson',
      summary: 'Keep WidgetService trace evidence compact.',
      content: 'When WidgetService work finishes, store a compact research trace with file and symbol references.',
      triggerType: 'complex_task_success',
    },
  } as any);

  const sessionTrace = finished.session.metadata.researchTrace as { derived?: boolean; bytes?: number; steps?: Array<{ text: string }> } | undefined;
  const draftTrace = finished.reflectionDraft?.metadata.researchTrace as typeof sessionTrace;
  equal(sessionTrace?.derived, false);
  ok((sessionTrace?.bytes ?? 0) > 0);
  equal(sessionTrace?.steps?.[0]?.text, 'Used the selected WidgetService context pack before editing.');
  equal(draftTrace?.derived, false);
  equal(draftTrace?.steps?.[0]?.text, sessionTrace?.steps?.[0]?.text);
});

test('omitted research trace is auto-derived without raw prompt transcript text', async () => {
  const { agentSessions, ingestion } = createTestServices();
  await seedWidgetKnowledge(ingestion, 'trace-derived');
  const privatePromptToken = 'RAW_PRIVATE_TRANSCRIPT_TOKEN';

  const started = await agentSessions.startSession({
    project: 'trace-derived',
    prompt: `Update src/widget.ts for WidgetService ${privatePromptToken}`,
    files: ['src/widget.ts'],
    symbols: ['WidgetService'],
    taskType: 'implementation',
    bypassCache: true,
  });
  await agentSessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'selected',
    reason: 'The selected pack matched the WidgetService file.',
  });

  const finished = await agentSessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    summary: 'WidgetService work should record compact trace evidence from structured signals only.',
    changedFiles: ['src/widget.ts'],
    verificationCommands: ['pnpm test'],
    learningSignals: [{
      kind: 'verification',
      text: 'pnpm test passed for WidgetService behavior.',
      files: ['src/widget.ts'],
    }],
    learningMode: 'draft_only',
  });

  const trace = finished.session.metadata.researchTrace as { derived?: boolean; steps?: Array<{ text: string }> } | undefined;
  const serialized = JSON.stringify(trace);
  equal(trace?.derived, true);
  ok(serialized.includes('pnpm test'));
  ok(serialized.includes('src/widget.ts'));
  ok(!serialized.includes(privatePromptToken), 'auto-derived trace must not store raw prompt transcript text');
  equal((finished.reflectionDraft?.metadata.researchTrace as { derived?: boolean } | undefined)?.derived, true);
});

async function seedWidgetKnowledge(ingestion: IngestionService, project: string): Promise<void> {
  await ingestion.ingestKnowledge({
    project,
    sourceType: 'file',
    sourceUri: 'src/widget.ts',
    itemType: 'code_ref',
    title: 'WidgetService code reference',
    summary: 'WidgetService implementation reference.',
    content: 'WidgetService changes live in src/widget.ts and should be verified with focused tests.',
    trustLevel: 90,
    labels: [
      { type: 'file', value: 'src/widget.ts', weight: 1 },
      { type: 'symbol', value: 'WidgetService', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'src/widget.ts' }],
  });
}

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
