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
  errorLogDir: ".tuberosa/test-error-logs",
  errorLogMaxBytes: 256 * 1024,
  errorLogAutoCapture: true,
  errorLogCaptureClientErrors: false,
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
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

test('agent session finish auto-approves grounded learning when quality gates pass', async () => {
  const { agentSessions, ingestion, store } = createTestServices();

  await ingestion.ingestKnowledge({
    project: 'auto-learning',
    sourceType: 'file',
    sourceUri: 'src/widget.ts',
    itemType: 'code_ref',
    title: 'WidgetService persistence code reference',
    summary: 'Current WidgetService persistence implementation.',
    content: 'WidgetService writes persistence changes in src/widget.ts and should keep verification close to the service.',
    trustLevel: 90,
    labels: [
      { type: 'file', value: 'src/widget.ts', weight: 1 },
      { type: 'symbol', value: 'WidgetService', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'src/widget.ts' }],
  });

  const started = await agentSessions.startSession({
    project: 'auto-learning',
    cwd: '/repo',
    prompt: 'Update src/widget.ts for WidgetService persistence',
    files: ['src/widget.ts'],
    symbols: ['WidgetService'],
    taskType: 'implementation',
  });

  await agentSessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'selected',
    reason: 'The code reference matches the implementation task.',
  });

  const finished = await agentSessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    summary: 'WidgetService persistence work should stay scoped to src/widget.ts and use the service reference as the verification anchor.',
  });

  equal(finished.learningDecision?.status, 'auto_approved');
  equal(finished.autoApprovedMemory?.status, 'approved');
  equal(finished.reflectionDraft?.status, 'approved');
  equal(finished.session.reflectionDraftIds[0], finished.autoApprovedMemory?.id);

  const autoMemories = await store.listKnowledge({ project: 'auto-learning', review: 'auto_memory', limit: 10 });
  const riskyAutoMemories = await store.listKnowledge({ project: 'auto-learning', review: 'risky_auto_memory', limit: 10 });
  equal(autoMemories.length, 1);
  equal(riskyAutoMemories.length, 0);
});

test('agent session finish learns from captured learning signals and agent output summary', async () => {
  const { agentSessions, ingestion, retrieval, store } = createTestServices();

  await ingestion.ingestKnowledge({
    project: 'signal-learning',
    sourceType: 'file',
    sourceUri: 'src/prompt-guide.ts',
    itemType: 'code_ref',
    title: 'PromptGuide plain prompt wrapper',
    summary: 'PromptGuide routes plain prompts through guided sessions.',
    content: 'PromptGuide keeps plain prompt UX simple while preserving context decisions and verification anchors in src/prompt-guide.ts.',
    trustLevel: 90,
    labels: [
      { type: 'file', value: 'src/prompt-guide.ts', weight: 1 },
      { type: 'symbol', value: 'PromptGuide', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'src/prompt-guide.ts' }],
  });

  const started = await agentSessions.startSession({
    project: 'signal-learning',
    cwd: '/repo',
    prompt: 'Update src/prompt-guide.ts for PromptGuide plain prompt sessions',
    files: ['src/prompt-guide.ts'],
    symbols: ['PromptGuide'],
    taskType: 'implementation',
  });

  await agentSessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'selected',
    reason: 'The code reference matches the guided prompt wrapper.',
  });

  const captured = await agentSessions.captureLearningSignal({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    kind: 'tip',
    source: 'agent',
    text: 'Plain prompt users need captured tips tied to concrete files so future agents can retrieve the useful part without storing raw transcripts.',
    files: ['src/prompt-guide.ts'],
    symbols: ['PromptGuide'],
    references: [{ type: 'file', uri: 'src/prompt-guide.ts' }],
    confidence: 0.92,
  });

  equal(captured.signal.kind, 'tip');

  const finished = await agentSessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    agentOutputSummary: 'PromptGuide plain prompt sessions should capture durable tips with file and symbol evidence instead of storing raw transcripts.',
    changedFiles: ['src/prompt-guide.ts'],
    verificationCommands: ['pnpm test'],
  });

  equal(finished.learningDecision?.status, 'auto_approved');
  ok(finished.autoApprovedMemory?.content.includes('Learning signals:'));
  ok(finished.autoApprovedMemory?.content.includes('captured tips tied to concrete files'));

  const memories = await store.listKnowledge({ project: 'signal-learning', review: 'auto_memory', limit: 10 });
  equal(memories.length, 1);
  ok(memories[0]?.labels.some((label) => label.type === 'file' && label.value === 'src/prompt-guide.ts'));

  const pack = await retrieval.searchContext({
    project: 'signal-learning',
    prompt: 'What tip should PromptGuide follow for src/prompt-guide.ts captured tips?',
    files: ['src/prompt-guide.ts'],
    symbols: ['PromptGuide'],
    noiseTolerance: 'strict',
  });
  const retrieved = pack.sections.flatMap((section) => section.items);
  ok(retrieved.some((item) => item.summary.includes('capture durable tips')));
  ok(retrieved.filter((item) => item.evidenceCategory === 'adjacentContext').length <= 1);
});

test('low-confidence learning signals stay reviewable instead of auto-approving', async () => {
  const { agentSessions, ingestion } = createTestServices();

  await ingestion.ingestKnowledge({
    project: 'signal-learning',
    sourceType: 'file',
    sourceUri: 'src/low-confidence.ts',
    itemType: 'code_ref',
    title: 'LowConfidenceService implementation reference',
    summary: 'Current LowConfidenceService implementation.',
    content: 'LowConfidenceService changes are anchored to src/low-confidence.ts.',
    trustLevel: 90,
    labels: [
      { type: 'file', value: 'src/low-confidence.ts', weight: 1 },
      { type: 'symbol', value: 'LowConfidenceService', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'src/low-confidence.ts' }],
  });

  const started = await agentSessions.startSession({
    project: 'signal-learning',
    prompt: 'Update src/low-confidence.ts for LowConfidenceService',
    files: ['src/low-confidence.ts'],
    symbols: ['LowConfidenceService'],
    taskType: 'implementation',
  });

  await agentSessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'selected',
  });

  const finished = await agentSessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    summary: 'LowConfidenceService learning should remain reviewable when its captured signal is low confidence.',
    learningSignals: [{
      kind: 'tip',
      text: 'Maybe LowConfidenceService should use this path, but the agent was unsure.',
      files: ['src/low-confidence.ts'],
      symbols: ['LowConfidenceService'],
      confidence: 0.4,
    }],
  });

  equal(finished.learningDecision?.status, 'drafted');
  equal(finished.reflectionDraft?.status, 'needs_changes');
  ok(finished.learningDecision?.reasons.some((reason) => reason.includes('low-confidence')));
});

test('agent session auto-learning keeps negative-feedback lessons reviewable', async () => {
  const { agentSessions, ingestion } = createTestServices();

  const stale = await ingestion.ingestKnowledge({
    project: 'review-learning',
    sourceType: 'file',
    sourceUri: 'docs/cache-old.md',
    itemType: 'workflow',
    title: 'Old CacheService workflow',
    summary: 'Legacy CacheService workflow.',
    content: 'CacheService should use the old cache path.',
    trustLevel: 70,
    labels: [
      { type: 'file', value: 'src/cache.ts', weight: 1 },
      { type: 'symbol', value: 'CacheService', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'docs/cache-old.md' }],
  });
  await ingestion.ingestKnowledge({
    project: 'review-learning',
    sourceType: 'file',
    sourceUri: 'docs/cache-new.md',
    itemType: 'code_ref',
    title: 'Current CacheService workflow',
    summary: 'Current CacheService workflow.',
    content: 'CacheService should use the current cache path in src/cache.ts.',
    trustLevel: 90,
    labels: [
      { type: 'file', value: 'src/cache.ts', weight: 1 },
      { type: 'symbol', value: 'CacheService', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'src/cache.ts' }],
  });

  const started = await agentSessions.startSession({
    project: 'review-learning',
    cwd: '/repo',
    prompt: 'Update src/cache.ts for CacheService',
    files: ['src/cache.ts'],
    symbols: ['CacheService'],
    taskType: 'implementation',
  });

  await agentSessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'rejected',
    reason: 'The first pack included legacy cache guidance.',
    rejectedKnowledgeIds: [stale.id],
  });

  const finished = await agentSessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    summary: 'CacheService work should avoid the legacy cache workflow and keep the current src/cache.ts reference for future agents.',
  });

  equal(finished.learningDecision?.status, 'drafted');
  equal(finished.reflectionDraft?.status, 'needs_changes');
  ok(finished.learningDecision?.reasons.some((reason) => reason.includes('negative')));
});

test('reflection draft labels and references can be reviewed before approval', async () => {
  const { reflection, store } = createTestServices();

  const created = await reflection.createDraft({
    project: 'agent-memory',
    title: 'Continue retrieval hardening',
    summary: 'Tighten context-pack usefulness and signal hygiene.',
    content: 'Continue retrieval hardening: cap prior lessons, classify usefulness, and apply signal hygiene before presenting context.',
    triggerType: 'non_trivial_workflow',
    references: [{ type: 'file', uri: 'src/retrieval/context-pack.ts' }],
  });

  const cleaned = await reflection.updateDraft(created.id, {
    suggestedLabels: [
      { type: 'business_area', value: 'retrieval', weight: 1 },
      { type: 'symbol', value: 'Continuation', weight: 1 },
      { type: 'technology', value: 'go', weight: 0.5 },
    ],
    references: [
      { type: 'file', uri: 'src/retrieval/context-pack.ts' },
      { type: 'file', uri: 'docs/AGENT_CONTEXT_ROADMAP.md' },
    ],
  });

  ok(cleaned);
  ok(!cleaned.suggestedLabels.some((label) => label.type === 'symbol' && label.value === 'Continuation'));
  ok(!cleaned.suggestedLabels.some((label) => label.type === 'technology' && label.value === 'go'));
  ok(cleaned.references.some((reference) => reference.uri === 'docs/AGENT_CONTEXT_ROADMAP.md'));

  const stored = await store.getReflectionDraft(created.id);
  ok(stored?.references.some((reference) => reference.uri === 'docs/AGENT_CONTEXT_ROADMAP.md'));
});

test('selected_but_noisy context decisions satisfy session compliance', async () => {
  const { agentSessions, ingestion } = createTestServices();

  await ingestion.ingestKnowledge({
    project: 'agent-memory',
    sourceType: 'wiki',
    sourceUri: 'docs/current.md',
    itemType: 'wiki',
    title: 'Current startup context',
    summary: 'Current startup context.',
    content: 'Current startup context for agent sessions and context-quality feedback.',
    trustLevel: 90,
  });

  const started = await agentSessions.startSession({
    project: 'agent-memory',
    prompt: 'Review startup context usefulness',
    cwd: '/repo',
  });
  await agentSessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'selected_but_noisy',
    reason: 'Useful context, but adjacent memories made the pack noisy.',
  });

  const finished = await agentSessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    summary: 'Reviewed startup context usefulness with noisy-but-selected context.',
    learningMode: 'off',
  });

  equal(finished.compliance.status, 'compliant');
  equal((finished.session.metadata.contextCompliance as { status?: string } | undefined)?.status, 'compliant');
});

test('selected_but_noisy context decisions prevent session learning auto-approval', async () => {
  const { agentSessions, ingestion } = createTestServices();

  await ingestion.ingestKnowledge({
    project: 'noisy-learning',
    sourceType: 'file',
    sourceUri: 'src/noisy.ts',
    itemType: 'code_ref',
    title: 'NoisyService implementation reference',
    summary: 'Current NoisyService implementation.',
    content: 'NoisyService changes should stay anchored to src/noisy.ts and avoid broad adjacent memories.',
    trustLevel: 90,
    labels: [
      { type: 'file', value: 'src/noisy.ts', weight: 1 },
      { type: 'symbol', value: 'NoisyService', weight: 1 },
    ],
    references: [{ type: 'file', uri: 'src/noisy.ts' }],
  });

  const started = await agentSessions.startSession({
    project: 'noisy-learning',
    prompt: 'Update src/noisy.ts for NoisyService',
    files: ['src/noisy.ts'],
    symbols: ['NoisyService'],
    taskType: 'implementation',
  });

  await agentSessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'selected_but_noisy',
    reason: 'Direct reference was useful but adjacent context was too noisy.',
  });

  const finished = await agentSessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    summary: 'NoisyService work should use src/noisy.ts as the anchor but should not auto-approve when the selected context was noisy.',
  });

  equal(finished.compliance.status, 'compliant');
  equal(finished.learningDecision?.status, 'drafted');
  equal(finished.reflectionDraft?.status, 'needs_changes');
  ok(finished.learningDecision?.reasons.some((reason) => reason.includes('noisy context')));
});

test('missing context-quality decisions satisfy missing-context compliance', async () => {
  const { agentSessions, ingestion } = createTestServices();

  await ingestion.ingestKnowledge({
    project: 'agent-memory',
    sourceType: 'wiki',
    sourceUri: 'docs/current.md',
    itemType: 'wiki',
    title: 'Current startup context',
    summary: 'Current startup context.',
    content: 'Current startup context for agent sessions and context-quality feedback.',
    trustLevel: 90,
  });

  const started = await agentSessions.startSession({
    project: 'agent-memory',
    prompt: 'Review startup context usefulness',
    cwd: '/repo',
  });
  await agentSessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'missing_verification_commands',
    reason: 'The pack did not say which verification commands to run.',
  });

  const finished = await agentSessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    summary: 'Reviewed startup context usefulness and reported missing verification guidance.',
    learningMode: 'off',
  });

  equal(finished.compliance.status, 'missing_context_recorded');
  equal(
    (finished.session.metadata.contextCompliance as { status?: string } | undefined)?.status,
    'missing_context_recorded',
  );
});

test('post-finish session note appends notes and optionally records feedback', async () => {
  const { agentSessions, ingestion, store } = createTestServices();

  await ingestion.ingestKnowledge({
    project: 'agent-memory',
    sourceType: 'wiki',
    sourceUri: 'docs/handoff.md',
    itemType: 'wiki',
    title: 'Current handoff anchor',
    summary: 'Current handoff anchor.',
    content: 'Continuation handoff anchor for agent sessions and roadmap progress.',
    trustLevel: 90,
  });

  const started = await agentSessions.startSession({
    project: 'agent-memory',
    prompt: 'Continue retrieval hardening',
    cwd: '/repo',
  });
  await agentSessions.recordContextDecision({
    sessionId: started.session.id,
    contextPackId: started.contextPack.id,
    feedbackType: 'selected',
  });
  await agentSessions.finishSession({
    sessionId: started.session.id,
    outcome: 'completed',
    summary: 'Wrapped retrieval hardening continuation tasks.',
  });

  const appended = await agentSessions.appendSessionNote({
    sessionId: started.session.id,
    note: 'Pack was selected but supporting section was noisy with backup memories.',
    feedbackType: 'selected_but_noisy',
    contextPackId: started.contextPack.id,
    author: 'reviewer',
  });

  equal(appended.note.feedbackType, 'selected_but_noisy');
  ok(appended.feedback);
  const stored = await store.getAgentSession(started.session.id);
  const notes = stored?.metadata.notes as Array<{ note: string }> | undefined;
  ok(notes?.some((entry) => entry.note.includes('noisy with backup memories')));
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
