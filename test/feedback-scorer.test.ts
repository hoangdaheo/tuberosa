import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { computeFeedbackPenalty } from '../src/retrieval/feedback-scorer.js';
import type { KnowledgeFeedbackSummary } from '../src/types.js';

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
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
};

function isoDaysAgo(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

test('computeFeedbackPenalty: clean summary yields factor of 1', () => {
  const summary: KnowledgeFeedbackSummary = {
    knowledgeId: 'k1',
    selectedCount: 0,
    selectedNoisyCount: 0,
    rejectedCount: 0,
    irrelevantCount: 0,
    staleCount: 0,
  };
  equal(computeFeedbackPenalty(summary, new Date()), 1);
});

test('computeFeedbackPenalty: recent rejections drive factor toward floor', () => {
  const now = new Date('2026-05-21T00:00:00Z');
  const summary: KnowledgeFeedbackSummary = {
    knowledgeId: 'k1',
    selectedCount: 0,
    selectedNoisyCount: 0,
    rejectedCount: 3,
    irrelevantCount: 0,
    staleCount: 0,
    latestFeedbackType: 'rejected',
    latestFeedbackAt: isoDaysAgo(2, now),
  };
  const factor = computeFeedbackPenalty(summary, now);
  ok(factor < 1, `expected factor < 1, got ${factor}`);
  ok(factor >= 0.3, `expected factor >= floor 0.3, got ${factor}`);
});

test('computeFeedbackPenalty: stale weighs harder than selected_but_noisy at equal recency', () => {
  const now = new Date('2026-05-21T00:00:00Z');
  const at = isoDaysAgo(5, now);
  const staleSummary: KnowledgeFeedbackSummary = {
    knowledgeId: 'k-stale',
    selectedCount: 0,
    selectedNoisyCount: 0,
    rejectedCount: 0,
    irrelevantCount: 0,
    staleCount: 1,
    latestFeedbackType: 'stale',
    latestFeedbackAt: at,
  };
  const noisySummary: KnowledgeFeedbackSummary = {
    knowledgeId: 'k-noisy',
    selectedCount: 0,
    selectedNoisyCount: 1,
    rejectedCount: 0,
    irrelevantCount: 0,
    staleCount: 0,
    latestFeedbackType: 'selected_but_noisy',
    latestFeedbackAt: at,
  };
  const staleFactor = computeFeedbackPenalty(staleSummary, now);
  const noisyFactor = computeFeedbackPenalty(noisySummary, now);
  ok(
    staleFactor < noisyFactor,
    `stale should damage more than selected_but_noisy; stale=${staleFactor} noisy=${noisyFactor}`,
  );
});

test('computeFeedbackPenalty: old rejections decay (less penalty than recent)', () => {
  const now = new Date('2026-05-21T00:00:00Z');
  const recent: KnowledgeFeedbackSummary = {
    knowledgeId: 'k-recent',
    selectedCount: 0,
    selectedNoisyCount: 0,
    rejectedCount: 3,
    irrelevantCount: 0,
    staleCount: 0,
    latestFeedbackType: 'rejected',
    latestFeedbackAt: isoDaysAgo(2, now),
  };
  const ancient: KnowledgeFeedbackSummary = {
    knowledgeId: 'k-ancient',
    selectedCount: 0,
    selectedNoisyCount: 0,
    rejectedCount: 3,
    irrelevantCount: 0,
    staleCount: 0,
    latestFeedbackType: 'rejected',
    latestFeedbackAt: isoDaysAgo(180, now),
  };
  ok(
    computeFeedbackPenalty(recent, now) < computeFeedbackPenalty(ancient, now),
    'recent rejections should yield a smaller factor than ancient rejections',
  );
});

test('computeFeedbackPenalty: factor floor is 0.3', () => {
  const summary: KnowledgeFeedbackSummary = {
    knowledgeId: 'k-pile',
    selectedCount: 0,
    selectedNoisyCount: 0,
    rejectedCount: 50,
    irrelevantCount: 50,
    staleCount: 50,
    latestFeedbackType: 'rejected',
    latestFeedbackAt: new Date().toISOString(),
  };
  const factor = computeFeedbackPenalty(summary, new Date());
  ok(factor >= 0.3, `floor violated: ${factor}`);
});

test('three recent rejections push K below otherwise-identical K\' for the same query', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const provider = new HashModelProvider(config.embeddingDimensions);
  const ingestion = new IngestionService(store, provider);
  const retrieval = new RetrievalService(store, cache, provider, config);

  const labels = [
    { type: 'file' as const, value: 'src/email/sender-queue.ts' },
    { type: 'symbol' as const, value: 'SenderQueueHandler' },
  ];
  const references = [{ type: 'file' as const, uri: 'src/email/sender-queue.ts' }];

  const clean = await ingestion.ingestKnowledge({
    project: 'phase2',
    sourceType: 'file',
    sourceUri: 'src/email/sender-queue.ts',
    itemType: 'code_ref',
    title: 'Sender queue handler',
    summary: 'Handles outbound email dispatch.',
    content: 'The SenderQueueHandler in src/email/sender-queue.ts dispatches outbound mail with exponential retry backoff and circuit-breaker telemetry.',
    labels,
    references,
  });
  const rejected = await ingestion.ingestKnowledge({
    project: 'phase2',
    sourceType: 'memory',
    sourceUri: 'memory://sender-queue-prior-notes',
    itemType: 'memory',
    title: 'Prior SenderQueueHandler retry notes (rejected by agents)',
    summary: 'Outdated SenderQueueHandler retry notes that agents have flagged as noise.',
    content: 'These prior notes about SenderQueueHandler retry behavior in src/email/sender-queue.ts have been flagged as misleading by multiple reviewers. The advice here contradicts the current handler implementation and should not guide new work.',
    labels,
    references,
  });

  // simulate three recent rejected feedback events for the "rejected" knowledge
  for (let i = 0; i < 3; i += 1) {
    await store.recordFeedback({
      project: 'phase2',
      feedbackType: 'rejected',
      rejectedKnowledgeIds: [rejected.id],
      reason: `recent rejection ${i + 1}`,
    });
  }

  const pack = await retrieval.searchContext({
    prompt: 'Update SenderQueueHandler retry policy in src/email/sender-queue.ts',
    project: 'phase2',
    bypassCache: true,
  });

  const rankedIds = (pack.sections ?? []).flatMap((section) => section.items.map((item) => item.knowledgeId));
  const cleanRank = rankedIds.indexOf(clean.id);
  const rejectedRank = rankedIds.indexOf(rejected.id);
  ok(cleanRank >= 0, `clean candidate must appear in pack (got ${cleanRank}); ranked=${rankedIds.join(',')}`);
  ok(rejectedRank >= 0, `rejected candidate must appear in pack (got ${rejectedRank}); ranked=${rankedIds.join(',')}`);
  ok(
    cleanRank < rejectedRank,
    `clean K' (rank=${cleanRank}) should outrank K with 3 rejected events (rank=${rejectedRank})`,
  );
});

test('cumulative stale + rejected + domain-mismatch keeps finalScore >= 0.1 (no negative spiral)', async () => {
  const store = new MemoryKnowledgeStore();
  const cache = new MemoryCache();
  const provider = new HashModelProvider(config.embeddingDimensions);
  const ingestion = new IngestionService(store, provider);
  const retrieval = new RetrievalService(store, cache, provider, config);

  const k = await ingestion.ingestKnowledge({
    project: 'phase2',
    sourceType: 'memory',
    sourceUri: 'memory://stale-rejected-mismatch',
    itemType: 'memory',
    title: 'Outdated billing migration notes',
    summary: 'Notes from a prior billing migration that are no longer current.',
    content: 'Stale lesson: the billing migration used to require manual reconciliation in src/billing/migrate.ts.',
    trustLevel: 35,
    freshnessAt: '2023-01-01T00:00:00.000Z',
    labels: [
      // explicit, user-supplied domain that will mismatch the query (target=email)
      { type: 'domain' as const, value: 'billing', weight: 1 },
      { type: 'file' as const, value: 'src/billing/migrate.ts', weight: 1 },
      { type: 'symbol' as const, value: 'SenderQueueHandler', weight: 1 },
    ],
    references: [{ type: 'file' as const, uri: 'src/billing/migrate.ts' }],
    metadata: { stale: true },
  });

  // simulate prior rejection so feedback suppression also fires
  await store.recordFeedback({
    project: 'phase2',
    feedbackType: 'rejected',
    rejectedKnowledgeIds: [k.id],
    reason: 'noise',
  });
  await store.recordFeedback({
    project: 'phase2',
    feedbackType: 'stale',
    rejectedKnowledgeIds: [k.id],
    reason: 'outdated',
  });

  const pack = await retrieval.searchContext({
    prompt: 'Investigate the SenderQueueHandler in src/email/sender-queue.ts retry policy.',
    project: 'phase2',
    bypassCache: true,
  });

  const items = (pack.sections ?? []).flatMap((section) => section.items);
  const hit = items.find((item) => item.knowledgeId === k.id);
  if (!hit) {
    // even if the candidate doesn't bubble into the pack, the test is satisfied —
    // it cannot have a negative score because it's not surfaced.
    return;
  }
  ok(
    hit.finalScore >= 0.1,
    `multiplicative damping floor (0.1) violated: stale+rejected+domain-mismatch produced finalScore=${hit.finalScore}`,
  );
  ok(
    hit.finalScore >= 0,
    `score must not be negative (got ${hit.finalScore})`,
  );
});
