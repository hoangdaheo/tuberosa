import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import type { AppConfig } from '../src/config.js';
import { HashModelProvider } from '../src/model/provider.js';
import { IngestionService } from '../src/ingest/service.js';
import { MaintenanceService } from '../src/maintenance/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type {
  KnowledgeRelation,
  MaintenanceBatch,
  MaintenanceItem,
  ReflectionDraft,
  ReflectionDraftInput,
} from '../src/types.js';

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
  worktreeEnabled: false,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
};
void config;

interface Phase10Fixture {
  store: MemoryKnowledgeStore;
  maintenance: MaintenanceService;
  duplicateDrafts: ReflectionDraft[];
  staleRelations: KnowledgeRelation[];
  closestKnowledgeId: string;
}

async function buildPhase10Fixture(options: { project?: string } = {}): Promise<Phase10Fixture> {
  const store = new MemoryKnowledgeStore();
  const ingestion = new IngestionService(store, new HashModelProvider(1536));
  const project = options.project ?? 'demo';

  // Seed a single canonical memory the duplicate drafts can point at.
  const canonical = await ingestion.ingestKnowledge({
    project,
    sourceType: 'reflection',
    sourceUri: 'reflection://canonical',
    itemType: 'memory',
    title: 'Canonical paywall retry policy',
    summary: 'Canonical memory that subsequent drafts duplicate.',
    content: 'Use exponential backoff for paywall retries with a 5-minute ceiling and Retry-After respect.',
    labels: [
      { type: 'file', value: 'src/paywall/retry.ts' },
      { type: 'symbol', value: 'PaywallRetry' },
    ],
    references: [{ type: 'file', uri: 'src/paywall/retry.ts' }],
  });

  // Seed 5 pending reflection drafts each tagged as NOOP duplicate of the canonical.
  const duplicateDrafts: ReflectionDraft[] = [];
  for (let i = 0; i < 5; i += 1) {
    const draftInput: ReflectionDraftInput = {
      project,
      title: `Duplicate paywall retry draft ${i}`,
      summary: 'Re-statement of the canonical paywall retry rule (variant text).',
      content: `Variant ${i}: backoff for paywall retries with exponential schedule, same as canonical.`,
      itemType: 'memory',
      triggerType: 'non_trivial_workflow',
      labels: [
        { type: 'file', value: 'src/paywall/retry.ts' },
        { type: 'symbol', value: 'PaywallRetry' },
      ],
      references: [{ type: 'file', uri: 'src/paywall/retry.ts' }],
      metadata: {
        writeGate: {
          decision: 'NOOP',
          reason: 'Existing memory covers this lesson (cosine 0.95, label overlap 1.00).',
          closestKnowledgeId: canonical.id,
          evidenceIds: [canonical.id],
          scores: { cosine: 0.95, labelOverlap: 1.0, referenceOverlap: 1.0, recencyDays: 1 },
        },
      },
    };
    const draft = await store.createReflectionDraft(draftInput, []);
    duplicateDrafts.push(draft);
  }

  // Seed 3 knowledge relations whose validUntil is in the past so they qualify as stale.
  const pastIso = '2024-01-01T00:00:00.000Z';
  const staleRelations: KnowledgeRelation[] = [];
  for (let i = 0; i < 3; i += 1) {
    const relation = await store.createKnowledgeRelation({
      project,
      fromKnowledgeId: canonical.id,
      relationType: 'related_to',
      targetKind: 'reference',
      targetValue: `legacy-target-${i}`,
      confidence: 0.6,
      inferred: true,
      metadata: { validUntil: pastIso },
    });
    staleRelations.push(relation);
  }

  const maintenance = new MaintenanceService(store);
  return { store, maintenance, duplicateDrafts, staleRelations, closestKnowledgeId: canonical.id };
}

test('Phase 10: propose returns exactly 5 duplicate_memory + 3 stale_relation items on the seeded fixture', async () => {
  const fixture = await buildPhase10Fixture();
  const batch: MaintenanceBatch = await fixture.maintenance.propose({ project: 'demo' });

  const duplicates = batch.items.filter((item) => item.kind === 'duplicate_memory');
  const staleRelations = batch.items.filter((item) => item.kind === 'stale_relation');
  const others = batch.items.filter((item) => item.kind !== 'duplicate_memory' && item.kind !== 'stale_relation');

  equal(duplicates.length, 5, 'expected 5 duplicate_memory items');
  equal(staleRelations.length, 3, 'expected 3 stale_relation items');
  equal(others.length, 0, 'fixture should not surface superseded_reflection or weak_label items');

  equal(batch.counts.duplicate_memory, 5);
  equal(batch.counts.stale_relation, 3);
  equal(batch.counts.superseded_reflection, 0);
  equal(batch.counts.weak_label, 0);
  equal(batch.totalDetected, 8);
  equal(batch.truncated, false);

  for (const item of duplicates) {
    ok(item.reflectionDraftId, 'duplicate items must reference the originating draft');
    equal(item.closestKnowledgeId, fixture.closestKnowledgeId, 'closestKnowledgeId should mirror write-gate output');
  }

  for (const item of staleRelations) {
    ok(item.relationId, 'stale_relation items must reference the relation id');
  }
});

test('Phase 10: apply mutates only the records listed in approvedItemIds', async () => {
  const fixture = await buildPhase10Fixture();
  const batch = await fixture.maintenance.propose({ project: 'demo' });

  // Approve only the first duplicate draft and the first stale relation.
  const duplicateItem = batch.items.find((item) => item.kind === 'duplicate_memory');
  const staleItem = batch.items.find((item) => item.kind === 'stale_relation');
  ok(duplicateItem && staleItem);

  const result = await fixture.maintenance.apply({
    batchId: batch.id,
    approvedItemIds: [duplicateItem!.id, staleItem!.id],
    reviewer: 'test-reviewer',
    reviewerNote: 'Phase 10 partial apply',
  });

  equal(result.appliedCount, 2, 'two approved items should apply');
  equal(result.failedCount, 0);
  const applied = result.results.filter((row) => row.status === 'applied').map((row) => row.itemId).sort();
  const skipped = result.results.filter((row) => row.status === 'skipped').map((row) => row.itemId).sort();
  ok(applied.includes(duplicateItem!.id));
  ok(applied.includes(staleItem!.id));
  equal(applied.length, 2);
  equal(skipped.length, batch.items.length - 2, 'the rest should be skipped, not applied');

  // The applied draft is rejected; the other four drafts remain pending.
  const appliedDraft = await fixture.store.getReflectionDraft(duplicateItem!.reflectionDraftId!);
  equal(appliedDraft?.status, 'rejected', 'approved duplicate draft was rejected');
  const remainingPending = await fixture.store.listReflectionDrafts({ project: 'demo', status: 'pending', limit: 50 });
  equal(remainingPending.length, 4, 'four duplicate drafts remain pending');

  // The applied relation is deleted; the other two relations remain.
  const remainingStale = await fixture.store.listKnowledgeRelations({
    project: 'demo',
    relationType: 'related_to',
    limit: 50,
  });
  equal(remainingStale.length, 2, 'two stale relations remain after a single approval');
  ok(!remainingStale.some((relation) => relation.id === staleItem!.relationId));
});

test('Phase 10: apply is idempotent — re-applying the same batch returns expired outcomes', async () => {
  const fixture = await buildPhase10Fixture();
  const batch = await fixture.maintenance.propose({ project: 'demo' });

  const firstRun = await fixture.maintenance.apply({ batchId: batch.id });
  equal(firstRun.appliedCount, batch.items.length, 'first run applies every item');
  equal(firstRun.expiredCount, 0, 'no items are expired on first apply');

  const secondRun = await fixture.maintenance.apply({ batchId: batch.id });
  equal(secondRun.appliedCount, 0, 'second run is fully idempotent');
  equal(secondRun.expiredCount, batch.items.length, 'every per-item outcome is expired on re-apply');
  ok(secondRun.results.every((row) => row.status === 'expired'), 'every per-item outcome is expired on re-apply');
});

test('Phase 10: propose detects superseded_reflection drafts and weak_label provenance', async () => {
  const store = new MemoryKnowledgeStore();
  const ingest = new IngestionService(store, new HashModelProvider(1536));

  // Seed a "legacy" memory that the new draft proposes to supersede.
  const legacy = await ingest.ingestKnowledge({
    project: 'demo',
    sourceType: 'reflection',
    sourceUri: 'reflection://legacy',
    itemType: 'memory',
    title: 'Legacy auth retry policy',
    summary: 'Legacy reset-on-retry behavior; obsolete.',
    content: 'Old retry policy that resets refresh tokens during retry.',
    labels: [{ type: 'file', value: 'src/auth.ts' }],
    references: [{ type: 'file', uri: 'src/auth.ts' }],
  });

  // Seed a knowledge item with a weak inferred label that should surface as weak_label.
  const itemWithWeakLabel = await ingest.ingestKnowledge({
    project: 'demo',
    sourceType: 'code_ref',
    sourceUri: 'code://module-x',
    itemType: 'code_ref',
    title: 'Module X handler',
    summary: 'Handler for module X.',
    content: 'function handle() { return null; }',
    labels: [
      { type: 'file', value: 'src/module-x.ts' },
      // Weak inferred label — confidence below 0.5, classifier-sourced.
      { type: 'technology', value: 'maybe-rust', provenance: { source: 'classifier', confidence: 0.3 } },
    ],
  });

  // Seed a draft proposing to supersede the legacy memory.
  const supersedeDraft = await store.createReflectionDraft({
    project: 'demo',
    title: 'New auth retry policy',
    summary: 'Keep refresh tokens during retry; supersedes legacy.',
    content: 'New policy that keeps refresh tokens stable during retry.',
    itemType: 'memory',
    triggerType: 'non_trivial_workflow',
    labels: [{ type: 'file', value: 'src/auth.ts' }],
    references: [{ type: 'file', uri: 'src/auth.ts' }],
    metadata: {
      writeGate: {
        decision: 'DELETE',
        reason: 'Draft references conflicting evidence; propose superseding the old memory.',
        closestKnowledgeId: legacy.id,
        evidenceIds: [legacy.id],
      },
    },
  }, []);

  const maintenance = new MaintenanceService(store);
  const batch = await maintenance.propose({ project: 'demo' });

  const superseded = batch.items.find((item) => item.kind === 'superseded_reflection');
  ok(superseded, 'expected one superseded_reflection item');
  equal(superseded!.reflectionDraftId, supersedeDraft.id);
  equal(superseded!.closestKnowledgeId, legacy.id);

  const weakLabels = batch.items.filter((item) => item.kind === 'weak_label');
  ok(weakLabels.length >= 1, 'expected at least one weak_label item from inferred classifier label below 0.5');
  ok(weakLabels.some((item) => item.knowledgeId === itemWithWeakLabel.id && item.label?.value === 'maybe-rust'));

  // Apply supersede + weak_label and confirm both downstream mutations.
  const applyResult = await maintenance.apply({
    batchId: batch.id,
    approvedItemIds: [superseded!.id, weakLabels[0]!.id],
    reviewer: 'tester',
  });
  equal(applyResult.appliedCount, 2);

  const archivedLegacy = await store.getKnowledge(legacy.id);
  equal(archivedLegacy?.status, 'archived', 'legacy memory should be archived after supersede applied');

  const updatedDraft = await store.getReflectionDraft(supersedeDraft.id);
  equal(updatedDraft?.status, 'rejected', 'supersede draft should be rejected (reviewer can re-create separately)');

  const updatedItem = await store.getKnowledge(itemWithWeakLabel.id);
  ok(updatedItem);
  ok(!updatedItem!.labels.some((label) => label.value === 'maybe-rust'), 'weak label should be removed after apply');
});

test('Phase 10: propose honors kinds filter — only requested kinds are scanned', async () => {
  const fixture = await buildPhase10Fixture();
  const onlyDuplicates = await fixture.maintenance.propose({ project: 'demo', kinds: ['duplicate_memory'] });
  equal(onlyDuplicates.items.length, 5);
  ok(onlyDuplicates.items.every((item) => item.kind === 'duplicate_memory'));
  equal(onlyDuplicates.counts.stale_relation, 0, 'stale_relation should not be scanned when not requested');

  const onlyRelations = await fixture.maintenance.propose({ project: 'demo', kinds: ['stale_relation'] });
  equal(onlyRelations.items.length, 3);
  ok(onlyRelations.items.every((item) => item.kind === 'stale_relation'));
});

test('Phase 10: apply supports inline items[] payload (no batch id) for forwards compatibility', async () => {
  const fixture = await buildPhase10Fixture();
  const batch = await fixture.maintenance.propose({ project: 'demo' });
  const subset: MaintenanceItem[] = batch.items.filter((item) => item.kind === 'stale_relation');

  // Spin up a fresh service to simulate batch loss after a restart.
  const freshService = new MaintenanceService(fixture.store);
  const result = await freshService.apply({
    items: subset,
    approvedItemIds: subset.map((item) => item.id),
    reviewer: 'tester',
  });

  equal(result.appliedCount, subset.length);
  const remainingStale = await fixture.store.listKnowledgeRelations({
    project: 'demo',
    relationType: 'related_to',
    limit: 50,
  });
  equal(remainingStale.length, 0, 'every stale relation deleted via inline payload path');
});

test('Plan 4.1: every proposed item carries a stable risk class derived from its kind', async () => {
  const fixture = await buildPhase10Fixture();
  const batch = await fixture.maintenance.propose({ project: 'demo' });

  for (const item of batch.items) {
    ok(['low', 'medium', 'high'].includes(item.risk), `${item.kind} risk must be low/medium/high`);
    if (item.kind === 'duplicate_memory') equal(item.risk, 'low');
    if (item.kind === 'stale_relation') equal(item.risk, 'medium');
    if (item.kind === 'weak_label') equal(item.risk, 'low');
    if (item.kind === 'superseded_reflection') equal(item.risk, 'high');
  }
});

test('Plan 4.1 follow-up: proposed items carry structured evidence and a before snapshot', async () => {
  const fixture = await buildPhase10Fixture();
  const batch = await fixture.maintenance.propose({ project: 'demo' });

  for (const item of batch.items) {
    ok(item.evidence && item.evidence.length > 0, `${item.kind} item must carry evidence`);
    for (const entry of item.evidence!) {
      ok(
        ['write_gate', 'relation_expiry', 'label_provenance'].includes(entry.source),
        `evidence source ${entry.source} must come from a known detector`,
      );
      ok(typeof entry.reference === 'string' && entry.reference.length > 0, 'evidence reference must be a non-empty string');
    }
  }

  const dup = batch.items.find((item) => item.kind === 'duplicate_memory');
  ok(dup, 'fixture must include at least one duplicate_memory item');
  ok(dup!.before, 'duplicate_memory must include a before snapshot');
  ok(typeof dup!.before!.title === 'string' && dup!.before!.title!.length > 0, 'before.title must be populated from the draft');

  const weak = batch.items.find((item) => item.kind === 'weak_label');
  if (weak) {
    ok(weak.before?.labels && weak.before.labels.length > 0, 'weak_label before snapshot must include the labels at propose time');
  }
});

test('Plan 4.1: autoApplyLowRisk applies low-risk items and skips higher-risk ones', async () => {
  const fixture = await buildPhase10Fixture();
  const batch = await fixture.maintenance.propose({ project: 'demo' });

  // Fixture seeds 5 duplicate_memory (low) + 3 stale_relation (medium).
  const result = await fixture.maintenance.apply({
    batchId: batch.id,
    autoApplyLowRisk: true,
    reviewer: 'auto',
  });

  equal(result.appliedCount, 5, 'only low-risk duplicate_memory items apply');
  const skippedMessages = result.results
    .filter((row) => row.status === 'skipped')
    .map((row) => row.message);
  ok(
    skippedMessages.every((m) => typeof m === 'string' && m.includes('autoApplyLowRisk')),
    'medium-risk items must be skipped with autoApplyLowRisk reason',
  );
  ok(result.results.every((row) => row.kind !== 'stale_relation' || row.status === 'skipped'));
});

test('Plan 4.1: autoApplyLowRisk is ignored when approvedItemIds is supplied (explicit reviewer wins)', async () => {
  const fixture = await buildPhase10Fixture();
  const batch = await fixture.maintenance.propose({ project: 'demo' });
  const staleItem = batch.items.find((item) => item.kind === 'stale_relation');
  ok(staleItem);

  const result = await fixture.maintenance.apply({
    batchId: batch.id,
    approvedItemIds: [staleItem!.id],
    autoApplyLowRisk: true,
    reviewer: 'tester',
  });

  equal(result.appliedCount, 1, 'explicit approval applies the medium-risk item even with autoApplyLowRisk');
  const applied = result.results.find((row) => row.status === 'applied');
  equal(applied?.itemId, staleItem!.id);
});
