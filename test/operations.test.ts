import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { AgentSessionService } from '../src/agent-session/service.js';
import type { AppServices } from '../src/app.js';
import { MemoryCache } from '../src/cache.js';
import type { AppConfig } from '../src/config.js';
import { ErrorLogInsightService } from '../src/error-log/insights.js';
import { ErrorLogService } from '../src/error-log/service.js';
import { handleHttpRequest } from '../src/http/server.js';
import { IngestionService } from '../src/ingest/service.js';
import { MaintenanceService } from '../src/maintenance/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { BackupService } from '../src/operations/backup-service.js';
import { OperationsService } from '../src/operations/service.js';
import { SessionReplayService } from '../src/operations/session-replay.js';
import { ReflectionService } from '../src/reflection/service.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import type { ContextPack, RankedCandidate, StoredKnowledge } from '../src/types.js';

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
  openAiTimeoutMs: 30_000,
  embeddingDimensions: 1536,
  openAiEmbeddingModel: 'text-embedding-3-small',
  contextCacheTtlSeconds: 60,
  maxRequestBytes: 10 * 1024 * 1024,
  maxIngestContentBytes: 2 * 1024 * 1024,
  backupDir: '.tuberosa/test-backups',
  exportBaseDir: '.tuberosa/test-exports',
  importBaseDir: '.tuberosa/test-imports',
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
  persistReplay: false,
  worktreeEnabled: true,
  worktreeMaxFiles: 50,
  worktreeMaxMtimeAgeHours: 72,
  llmCriticEnabled: false,
  archivalEnabled: false,
  graphInferenceEnabled: false,
  archivalIntervalHours: 24,
};

test('operations API reviews, updates, imports, and lists audit records', async () => {
  const services = createTestServices();
  const project = 'operations-review';

  try {
    const health = await get(services, '/health') as Record<string, unknown>;
    equal(health.durability, 'ephemeral');

    const imported = await post(services, '/operations/import-files', {
      project,
      mode: 'atomic',
      files: [{
        project,
        path: 'docs/ops.md',
        content: [
          '# Operations',
          '',
          'Review APIs expose questionable knowledge.',
          '',
          '## Cleanup',
          '',
          'Cleanup removes old proposed context packs and orphaned audit rows.',
        ].join('\n'),
      }],
    }) as { results: Array<Record<string, unknown>>; errors: Array<Record<string, unknown>> };

    ok(imported.results.length >= 2);
    equal(imported.errors.length, 0);

    const lowTrust = await post(services, '/knowledge', {
      project,
      sourceType: 'manual',
      sourceUri: 'manual://ops/low-trust',
      itemType: 'wiki',
      title: 'Questionable ops note',
      summary: 'Low trust review note.',
      content: 'This operations note should be listed for review.',
      trustLevel: 20,
      labels: [{ type: 'business_area', value: 'operations', weight: 1 }],
    }) as Record<string, unknown>;

    const patched = await patch(services, `/knowledge/${lowTrust.id}`, {
      status: 'needs_review',
      metadata: { reviewer: 'node-test' },
      labels: [{ type: 'severity', value: 'review', weight: 1 }],
    }) as Record<string, unknown>;
    equal(patched.status, 'needs_review');
    equal((patched.metadata as Record<string, unknown>).reviewer, 'node-test');

    const questionable = await get(services, `/knowledge?project=${project}&review=questionable`) as Array<Record<string, unknown>>;
    ok(questionable.some((item) => item.id === lowTrust.id));

    const labels = await get(services, `/labels?project=${project}`) as Array<Record<string, unknown>>;
    ok(labels.some((label) => label.type === 'severity' && label.value === 'review'));

    const inferredRelations = await get(services, `/operations/relations?project=${project}&inferred=true`) as Array<Record<string, unknown>>;
    ok(inferredRelations.some((relation) => relation.relationType === 'mentions_file'));

    const manualRelation = await post(services, '/operations/relations', {
      project,
      fromKnowledgeId: imported.results[0]!.id,
      relationType: 'related_to',
      targetKind: 'knowledge',
      targetKnowledgeId: lowTrust.id,
      confidence: 0.6,
    }) as Record<string, unknown>;
    equal(manualRelation.inferred, false);

    const patchedRelation = await patch(services, `/operations/relations/${manualRelation.id}`, {
      confidence: 0.8,
      metadata: { reviewer: 'node-test' },
    }) as Record<string, unknown>;
    equal(patchedRelation.confidence, 0.8);
    equal((patchedRelation.metadata as Record<string, unknown>).reviewer, 'node-test');

    const oldWorkflow = await post(services, '/knowledge', {
      project,
      sourceType: 'manual',
      sourceUri: 'manual://ops/conflict-old',
      itemType: 'workflow',
      title: 'Legacy operations cleanup',
      summary: 'Use legacy cleanup for operations imports.',
      content: 'Legacy cleanup should run before importing operations docs. This old guidance is stale.',
      freshnessAt: '2024-01-01T00:00:00.000Z',
      labels: [{ type: 'file', value: 'docs/ops.md', weight: 1 }],
      references: [{ type: 'file', uri: 'docs/ops.md' }],
    }) as Record<string, unknown>;
    const currentWorkflow = await post(services, '/knowledge', {
      project,
      sourceType: 'manual',
      sourceUri: 'manual://ops/conflict-current',
      itemType: 'workflow',
      title: 'Current operations cleanup',
      summary: 'Do not use legacy cleanup for operations imports.',
      content: 'Current cleanup runs after importing operations docs and should be preferred now.',
      freshnessAt: '2026-05-18T00:00:00.000Z',
      labels: [{ type: 'file', value: 'docs/ops.md', weight: 1 }],
      references: [{ type: 'file', uri: 'docs/ops.md' }],
    }) as Record<string, unknown>;

    const detectedConflicts = await post(services, `/operations/conflicts/detect?project=${project}`, {}) as Array<Record<string, unknown>>;
    ok(detectedConflicts.some((conflict) => (
      conflict.conflictType === 'summary_contradiction' &&
      [conflict.leftKnowledgeId, conflict.rightKnowledgeId].includes(oldWorkflow.id) &&
      [conflict.leftKnowledgeId, conflict.rightKnowledgeId].includes(currentWorkflow.id)
    )));
    ok(detectedConflicts.some((conflict) => conflict.conflictType === 'freshness_conflict'));

    const openConflicts = await get(services, `/operations/conflicts?project=${project}&status=open`) as Array<Record<string, unknown>>;
    const conflict = openConflicts.find((item) => item.conflictType === 'summary_contradiction') as Record<string, unknown> | undefined;
    ok(conflict);
    ok((conflict.sharedEvidence as string[]).includes('file:docs/ops.md'));

    const resolvedConflict = await patch(services, `/operations/conflicts/${conflict.id}`, {
      status: 'resolved',
      metadata: { reviewer: 'node-test' },
    }) as Record<string, unknown>;
    equal(resolvedConflict.status, 'resolved');
    equal((resolvedConflict.metadata as Record<string, unknown>).reviewer, 'node-test');

    const projectMap = await get(services, `/operations/organization/project-map?project=${project}`) as Record<string, unknown>;
    ok((projectMap.relationCount as number) >= 1);

    const graphJsonl = await get(services, `/operations/organization/knowledge-graph.jsonl?project=${project}`) as Record<string, unknown>;
    ok(String(graphJsonl.content).includes('"kind":"relation"'));

    const readableSummary = await get(services, `/operations/organization/readable-summary?project=${project}`) as Record<string, unknown>;
    ok(String(readableSummary.content).includes('Knowledge Summary'));

    const search = await post(services, '/context/search', {
      project,
      prompt: 'How should operations cleanup work?',
      bypassCache: true,
    }) as Record<string, unknown>;
    ok(search.id);

    const staleFeedback = await post(services, '/context/feedback', {
      contextPackId: search.id,
      project,
      feedbackType: 'stale',
      rejectedKnowledgeIds: [lowTrust.id],
      reason: 'Needs review before reuse.',
    }) as Record<string, unknown>;
    equal((staleFeedback.feedback as Record<string, unknown>).feedbackType, 'stale');

    const stale = await get(services, `/knowledge?project=${project}&review=stale`) as Array<Record<string, unknown>>;
    ok(stale.some((item) => item.id === lowTrust.id));

    const packs = await get(services, `/context/packs?project=${project}`) as Array<Record<string, unknown>>;
    ok(packs.some((pack) => pack.id === search.id));

    const feedback = await get(services, `/feedback-events?project=${project}`) as Array<Record<string, unknown>>;
    ok(feedback.some((event) => event.feedbackType === 'stale'));

    const proposals = await get(services, `/operations/learning-proposals?project=${project}&status=open&type=supersedes`) as Array<Record<string, unknown>>;
    const staleProposal = proposals.find((proposal) => proposal.affectedKnowledgeId === lowTrust.id);
    ok(staleProposal);
    equal(staleProposal.proposalType, 'supersedes');

    const updatedProposal = await patch(services, `/operations/learning-proposals/${staleProposal.id}`, {
      status: 'needs_changes',
      metadata: { reviewer: 'operations-test' },
    }) as Record<string, unknown>;
    equal(updatedProposal.status, 'needs_changes');
    equal((updatedProposal.metadata as Record<string, unknown>).reviewer, 'operations-test');

    await post(services, '/context/feedback', {
      contextPackId: search.id,
      project,
      feedbackType: 'missing_context',
      reason: 'Need current cleanup runbook context.',
      metadata: { missingSignals: ['file:docs/cleanup-runbook.md'] },
    });

    const gaps = await get(services, `/operations/knowledge-gaps?project=${project}&status=open&contextPackId=${search.id}`) as Array<Record<string, unknown>>;
    equal(gaps.length, 1);
    equal(gaps[0]!.contextPackId, search.id);
    ok((gaps[0]!.missingSignals as string[]).includes('file:docs/cleanup-runbook.md'));

    const updatedGap = await patch(services, `/operations/knowledge-gaps/${gaps[0]!.id}`, {
      status: 'dismissed',
      metadata: { reviewer: 'operations-test' },
    }) as Record<string, unknown>;
    equal(updatedGap.status, 'dismissed');

    const draft = await post(services, '/reflection-drafts', {
      project,
      title: 'Review operations notes',
      summary: 'Operations notes should remain reviewable.',
      content: 'When adding operations APIs, list reflection drafts and let reviewers reject stale drafts before approval.',
      triggerType: 'manual',
    }) as Record<string, unknown>;
    const rejectedDraft = await post(services, `/reflection-drafts/${draft.id}/review`, {
      decision: 'reject',
      reviewer: 'operations-test',
      reviewerNote: 'Superseded by newer operations notes.',
    }) as Record<string, unknown>;
    equal(rejectedDraft.status, 'rejected');

    const drafts = await get(services, `/reflection-drafts?project=${project}&status=rejected`) as Array<Record<string, unknown>>;
    ok(drafts.some((item) => item.id === draft.id));

    const revisionDraft = await post(services, '/reflection-drafts', {
      project,
      title: 'Revise operations rubric',
      summary: 'Operations review rubric should be narrower before approval.',
      content: 'Use needs_changes when a reflection draft has a useful lesson but lacks references or has too much scope.',
      triggerType: 'manual',
    }) as Record<string, unknown>;
    const needsChangesDraft = await post(services, `/reflection-drafts/${revisionDraft.id}/review`, {
      decision: 'needs_changes',
      reviewer: 'operations-test',
      reviewerNote: 'Add concrete references before approval.',
      evaluation: {
        accuracy: 'pass',
        usefulness: 'concern',
        duplicateRisk: 'low',
      },
    }) as Record<string, unknown>;
    equal(needsChangesDraft.status, 'needs_changes');
    const reviewMetadata = (needsChangesDraft.metadata as Record<string, unknown>).review as Record<string, unknown>;
    equal(reviewMetadata.reviewerNote, 'Add concrete references before approval.');

    const approvalDraft = await post(services, '/reflection-drafts', {
      project,
      title: 'Approve operations memory',
      summary: 'Approved reflection drafts become searchable knowledge.',
      content: 'After reviewer approval, a reflection draft is ingested as trusted reflection knowledge.',
      triggerType: 'manual',
    }) as Record<string, unknown>;
    const approvedDraft = await post(services, `/reflection-drafts/${approvalDraft.id}/review`, {
      decision: 'approve',
      reviewer: 'operations-test',
      evaluation: {
        accuracy: 'pass',
        usefulness: 'pass',
        scope: 'pass',
        privacySafety: 'pass',
      },
    }) as Record<string, unknown>;
    equal(approvedDraft.status, 'approved');
    const approvedKnowledge = await get(services, `/knowledge?project=${project}&limit=50`) as Array<Record<string, unknown>>;
    ok(approvedKnowledge.some((item) => item.sourceUri === `reflection://draft/${approvalDraft.id}`));

    const sessionStart = await post(services, '/agent-sessions', {
      project,
      prompt: 'Review operations API coverage',
      bypassCache: true,
    }) as Record<string, unknown>;
    const session = sessionStart.session as Record<string, unknown>;
    await post(services, `/agent-sessions/${session.id}/context-decision`, {
      feedbackType: 'selected',
      contextPackId: (sessionStart.contextPack as Record<string, unknown>).id,
    });
    const decisions = await get(services, `/agent-sessions/${session.id}/context-decisions`) as Array<Record<string, unknown>>;
    equal(decisions[0]!.decision, 'selected');
    const finished = await post(services, `/agent-sessions/${session.id}/finish`, {
      outcome: 'completed',
      summary: 'Reviewed operations coverage.',
    }) as Record<string, unknown>;
    equal((finished.compliance as Record<string, unknown>).status, 'compliant');
    equal(((finished.session as Record<string, unknown>).metadata as Record<string, unknown>).contextCompliance !== undefined, true);

    const cleanup = await post(services, '/operations/cleanup', {
      dryRun: true,
      olderThanDays: 1,
    }) as Record<string, unknown>;
    equal(cleanup.dryRun, true);
    ok(cleanup.deleted);

    const deleteRelation = await dispatchHttp(services, {
      method: 'DELETE',
      url: `/operations/relations/${manualRelation.id}`,
    });
    equal(deleteRelation.status, 200);
    equal((deleteRelation.body as Record<string, unknown>).deleted, true);
  } finally {
    await services.close();
  }
});

test('operations context-quality report links feedback to review actions', async () => {
  const services = createTestServices();
  const project = 'context-quality-review';

  try {
    const direct = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://context-quality/direct',
      itemType: 'workflow',
      title: 'Current context-quality workflow',
      summary: 'Direct workflow for context-quality review.',
      content: 'Review context-quality feedback from the operations report before changing retrieval ranking.',
      trustLevel: 90,
      labels: [{ type: 'file', value: 'docs/context-quality.md', weight: 1 }],
      references: [{ type: 'file', uri: 'docs/context-quality.md' }],
    }, []);
    const adjacent = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://context-quality/adjacent',
      itemType: 'workflow',
      title: 'Adjacent scheduler workflow',
      summary: 'Noisy adjacent scheduler context.',
      content: 'Scheduler backup pruning is adjacent context for context-quality review.',
      trustLevel: 70,
      labels: [{ type: 'business_area', value: 'backup', weight: 1 }],
    }, []);
    const pack = contextQualityPack(project, direct, adjacent);
    await services.store.saveContextPack(pack);
    const session = await services.store.createAgentSession({
      project,
      prompt: 'Audit context-quality feedback loops',
      initialContextPackId: pack.id,
    });

    await post(services, '/context/feedback', {
      contextPackId: pack.id,
      project,
      feedbackType: 'selected_but_noisy',
      reason: 'Useful direct workflow, but the scheduler item was noisy.',
      metadata: {
        agentSessionId: session.id,
        missingSignals: ['symbol:ContextQualityWorkbench'],
      },
    });
    await post(services, '/context/feedback', {
      contextPackId: pack.id,
      project,
      feedbackType: 'too_much_adjacent_context',
      rejectedKnowledgeIds: [adjacent.id],
      reason: 'Adjacent scheduler context dominated the report workflow.',
      metadata: { agentSessionId: session.id },
    });
    await post(services, '/context/feedback', {
      contextPackId: pack.id,
      project,
      feedbackType: 'missing_orientation',
      reason: 'The pack did not say which review queue to open first.',
      metadata: {
        agentSessionId: session.id,
        missingSignals: ['file:docs/context-quality-review.md'],
      },
    });

    const report = await get(services, `/operations/context-quality?project=${project}&limit=10`) as Record<string, unknown>;
    const records = report.records as Array<Record<string, unknown>>;
    equal(report.totalMatched, 3);

    const noisy = records.find((record) => (record.feedback as Record<string, unknown>).feedbackType === 'selected_but_noisy');
    ok(noisy);
    equal((noisy.contextPack as Record<string, unknown>).id, pack.id);
    equal((noisy.session as Record<string, unknown>).id, session.id);
    ok((noisy.adjacentItems as Array<Record<string, unknown>>).some((item) => item.title === 'Adjacent scheduler workflow'));
    ok((noisy.missingSignals as string[]).includes('symbol:ContextQualityWorkbench'));

    const adjacentRecord = records.find((record) => (record.feedback as Record<string, unknown>).feedbackType === 'too_much_adjacent_context');
    ok(adjacentRecord);
    ok((adjacentRecord.openLearningProposals as Array<Record<string, unknown>>).some((proposal) => (
      proposal.proposalType === 'missing_relation' &&
      proposal.affectedKnowledgeId === adjacent.id
    )));
    ok((adjacentRecord.suggestedReviewActions as string[]).some((action) => action.includes('missing_relation')));

    const missingOrientation = records.find((record) => (record.feedback as Record<string, unknown>).feedbackType === 'missing_orientation');
    ok(missingOrientation);
    ok((missingOrientation.openKnowledgeGaps as Array<Record<string, unknown>>).length >= 1);
    ok((missingOrientation.missingSignals as string[]).includes('orientation'));

    const rollups = report.rollups as Record<string, Array<Record<string, unknown>>>;
    ok(rollups.adjacentItems!.some((item) => item.knowledgeId === adjacent.id));
    ok(rollups.feedbackTypes!.some((item) => item.value === 'selected_but_noisy' && item.count === 1));

    const filtered = await get(
      services,
      `/operations/context-quality?project=${project}&feedbackType=too_much_adjacent_context&limit=5`,
    ) as Record<string, unknown>;
    equal(filtered.totalMatched, 1);

    const invalid = await dispatchHttp(services, {
      method: 'GET',
      url: `/operations/context-quality?project=${project}&feedbackType=selected`,
    });
    equal(invalid.status, 400);
  } finally {
    await services.close();
  }
});

test('operations context-quality report falls back to concrete pack items for noisy feedback', async () => {
  const services = createTestServices();
  const project = 'context-quality-fallback';

  try {
    const direct = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://context-quality/fallback',
      itemType: 'workflow',
      title: 'Moderate startup workflow',
      summary: 'Startup workflow that was useful but noisy.',
      content: 'Use the current handoff and verification commands when continuing Tuberosa work.',
      trustLevel: 85,
      labels: [{ type: 'file', value: 'handoff.md', weight: 1 }],
      references: [{ type: 'file', uri: 'handoff.md' }],
    }, []);
    const pack = contextQualityPack(project, direct, direct);
    const fallbackItem = {
      ...contextQualityCandidate(direct, 'directTaskEvidence', 0.72),
      evidenceStrength: 'moderate' as const,
      fitMissingSignals: ['missing verification commands'],
    };
    await services.store.saveContextPack({
      ...pack,
      sections: [
        { name: 'essential', tokenEstimate: 20, items: [fallbackItem] },
        { name: 'supporting', tokenEstimate: 0, items: [] },
        { name: 'optional', tokenEstimate: 0, items: [] },
      ],
    });

    await post(services, '/context/feedback', {
      contextPackId: pack.id,
      project,
      feedbackType: 'selected_but_noisy',
      reason: 'The pack was useful but lacked enough review detail.',
    });

    const report = await get(services, `/operations/context-quality?project=${project}&limit=5`) as Record<string, unknown>;
    const records = report.records as Array<Record<string, unknown>>;
    equal(records.length, 1);

    const reviewItems = records[0]!.adjacentItems as Array<Record<string, unknown>>;
    equal(reviewItems.length, 1);
    equal(reviewItems[0]!.knowledgeId, direct.id);
    equal(reviewItems[0]!.evidenceCategory, 'directTaskEvidence');
    equal(reviewItems[0]!.evidenceStrength, 'moderate');
    ok((reviewItems[0]!.missingSignals as string[]).includes('missing verification commands'));

    const rollups = report.rollups as Record<string, Array<Record<string, unknown>>>;
    ok(rollups.adjacentItems!.some((item) => item.knowledgeId === direct.id));
  } finally {
    await services.close();
  }
});

test('learning proposal approval actions execute concrete mutations and record results', async () => {
  const services = createTestServices();
  const project = 'proposal-approval';

  try {
    const olderKnowledge = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://proposal/older',
      itemType: 'memory',
      title: 'Old cached approach',
      summary: 'An older workflow approach.',
      content: 'Use the old approach for cache invalidation.',
      trustLevel: 70,
      labels: [{ type: 'project', value: project, weight: 1 }],
      references: [],
    }, []);

    const newerKnowledge = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://proposal/newer',
      itemType: 'memory',
      title: 'New cache approach',
      summary: 'Updated workflow approach that supersedes the old one.',
      content: 'Use the new approach for cache invalidation.',
      trustLevel: 90,
      labels: [{ type: 'project', value: project, weight: 1 }],
      references: [],
    }, []);

    // supersedes proposal with both candidate and affected — creates relation + marks needs_review
    const supersedesProposal = await services.store.createLearningProposal({
      project,
      proposalType: 'supersedes',
      affectedKnowledgeId: olderKnowledge.id,
      candidateKnowledgeId: newerKnowledge.id,
      reason: 'Newer knowledge supersedes the old cached approach.',
      evidence: [`knowledge:${olderKnowledge.id}`, `knowledge:${newerKnowledge.id}`],
      metadata: { source: 'test' },
    });

    equal(supersedesProposal.status, 'open');

    // Client-supplied approvalAction is ignored; the server owns the idempotency marker.
    const approvedProposal = await patch(
      services,
      `/operations/learning-proposals/${supersedesProposal.id}`,
      { status: 'approved', metadata: { approvalAction: { action: 'client_bypass_attempt' } } },
    ) as Record<string, unknown>;

    equal(approvedProposal.status, 'approved');
    const action = (approvedProposal.metadata as Record<string, unknown>).approvalAction as Record<string, unknown>;
    ok(action);
    equal(action.action, 'supersedes_relation_created');
    ok(action.relationId);
    equal(action.markedNeedsReview, olderKnowledge.id);

    // Verify supersedes relation was created
    const relations = await services.store.listKnowledgeRelations({
      fromKnowledgeId: newerKnowledge.id,
      relationType: 'supersedes',
      limit: 10,
    });
    ok(relations.some((r) => r.targetKnowledgeId === olderKnowledge.id));
    equal(relations.filter((r) => r.targetKnowledgeId === olderKnowledge.id).length, 1);

    // Verify affected knowledge is now needs_review
    const affected = await services.store.getKnowledge(olderKnowledge.id);
    equal(affected?.status, 'needs_review');

    // Approving again must NOT re-run the action (idempotent via metadata guard)
    const reapproved = await patch(
      services,
      `/operations/learning-proposals/${supersedesProposal.id}`,
      { status: 'approved', metadata: { reviewer: 'ops' } },
    ) as Record<string, unknown>;
    // approvalAction metadata from first run must still be present and not changed
    const reapprovedAction = (reapproved.metadata as Record<string, unknown>).approvalAction as Record<string, unknown>;
    equal(reapprovedAction.action, 'supersedes_relation_created');

    // auto_memory_cleanup proposal — marks knowledge as needs_review
    const cleanupKnowledge = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://proposal/auto-memory',
      itemType: 'memory',
      title: 'Auto-approved memory',
      summary: 'Memory auto-approved by session.',
      content: 'Some session context.',
      trustLevel: 60,
      labels: [{ type: 'project', value: project, weight: 1 }],
      references: [],
      metadata: { source: 'agent_session_finish', learningMode: 'auto' },
    }, []);

    const cleanupProposal = await services.store.createLearningProposal({
      project,
      proposalType: 'auto_memory_cleanup',
      affectedKnowledgeId: cleanupKnowledge.id,
      reason: 'Auto-approved memory received stale feedback.',
      evidence: [`knowledge:${cleanupKnowledge.id}`],
      metadata: { source: 'test' },
    });

    const approvedCleanup = await patch(
      services,
      `/operations/learning-proposals/${cleanupProposal.id}`,
      { status: 'approved' },
    ) as Record<string, unknown>;

    equal(approvedCleanup.status, 'approved');
    const cleanupAction = (approvedCleanup.metadata as Record<string, unknown>).approvalAction as Record<string, unknown>;
    equal(cleanupAction.action, 'knowledge_marked_needs_review');
    equal(cleanupAction.knowledgeId, cleanupKnowledge.id);

    const cleanupKnowledgeAfter = await services.store.getKnowledge(cleanupKnowledge.id);
    equal(cleanupKnowledgeAfter?.status, 'needs_review');

    const archiveKnowledge = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://proposal/auto-memory-archive',
      itemType: 'memory',
      title: 'Noisy auto-approved memory',
      summary: 'Memory should be archived after review.',
      content: 'Noisy session context.',
      trustLevel: 55,
      labels: [{ type: 'project', value: project, weight: 1 }],
      references: [],
      metadata: { source: 'agent_session_finish', learningMode: 'auto' },
    }, []);

    const archiveProposal = await services.store.createLearningProposal({
      project,
      proposalType: 'auto_memory_cleanup',
      affectedKnowledgeId: archiveKnowledge.id,
      reason: 'Reviewer confirmed this auto-memory should be archived.',
      evidence: [`knowledge:${archiveKnowledge.id}`],
      metadata: { source: 'test' },
    });

    const approvedArchive = await patch(
      services,
      `/operations/learning-proposals/${archiveProposal.id}`,
      { status: 'approved', metadata: { cleanupAction: 'archive' } },
    ) as Record<string, unknown>;

    const archiveAction = (approvedArchive.metadata as Record<string, unknown>).approvalAction as Record<string, unknown>;
    equal(archiveAction.action, 'knowledge_archived');
    equal(archiveAction.knowledgeId, archiveKnowledge.id);
    const archiveKnowledgeAfter = await services.store.getKnowledge(archiveKnowledge.id);
    equal(archiveKnowledgeAfter?.status, 'archived');

    const replacementMemory = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://proposal/auto-memory-replacement',
      itemType: 'memory',
      title: 'Reviewed replacement memory',
      summary: 'Reviewed memory supersedes the noisy auto-memory.',
      content: 'Use this reviewed session lesson instead.',
      trustLevel: 90,
      labels: [{ type: 'project', value: project, weight: 1 }],
      references: [],
    }, []);
    const supersededAutoMemory = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://proposal/auto-memory-superseded',
      itemType: 'memory',
      title: 'Superseded auto-approved memory',
      summary: 'Auto-memory should point to a reviewed replacement.',
      content: 'Old session context.',
      trustLevel: 60,
      labels: [{ type: 'project', value: project, weight: 1 }],
      references: [],
      metadata: { source: 'agent_session_finish', learningMode: 'auto' },
    }, []);

    const supersedeCleanupProposal = await services.store.createLearningProposal({
      project,
      proposalType: 'auto_memory_cleanup',
      affectedKnowledgeId: supersededAutoMemory.id,
      reason: 'Reviewer confirmed a reviewed memory supersedes this auto-memory.',
      evidence: [`knowledge:${supersededAutoMemory.id}`, `knowledge:${replacementMemory.id}`],
      metadata: { source: 'test' },
    });

    const approvedSupersedeCleanup = await patch(
      services,
      `/operations/learning-proposals/${supersedeCleanupProposal.id}`,
      {
        status: 'approved',
        metadata: {
          cleanupAction: 'supersede',
          supersedingKnowledgeId: replacementMemory.id,
        },
      },
    ) as Record<string, unknown>;

    const supersedeCleanupAction = (approvedSupersedeCleanup.metadata as Record<string, unknown>).approvalAction as Record<string, unknown>;
    equal(supersedeCleanupAction.action, 'auto_memory_superseded');
    equal(supersedeCleanupAction.supersedingKnowledgeId, replacementMemory.id);
    equal(supersedeCleanupAction.markedNeedsReview, supersededAutoMemory.id);
    const supersededAutoMemoryAfter = await services.store.getKnowledge(supersededAutoMemory.id);
    equal(supersededAutoMemoryAfter?.status, 'needs_review');
    const cleanupRelations = await services.store.listKnowledgeRelations({
      fromKnowledgeId: replacementMemory.id,
      relationType: 'supersedes',
      limit: 10,
    });
    equal(cleanupRelations.filter((relation) => relation.targetKnowledgeId === supersededAutoMemory.id).length, 1);

    const enrichmentKnowledge = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://proposal/enrichment',
      itemType: 'memory',
      title: 'Cache enrichment note',
      summary: 'Cache note missing labels and references.',
      content: 'Cache invalidation context should include the runbook label and file reference.',
      trustLevel: 75,
      labels: [{ type: 'project', value: project, weight: 1 }],
      references: [{ type: 'file', uri: 'docs/original-cache.md' }],
    }, []);

    const missingLabelProposal = await services.store.createLearningProposal({
      project,
      proposalType: 'missing_label',
      affectedKnowledgeId: enrichmentKnowledge.id,
      reason: 'Reviewer confirmed the cache runbook label is missing.',
      evidence: [`knowledge:${enrichmentKnowledge.id}`],
      metadata: { source: 'test' },
    });

    const approvedLabelProposal = await patch(
      services,
      `/operations/learning-proposals/${missingLabelProposal.id}`,
      {
        status: 'approved',
        metadata: {
          suggestedLabels: [
            { type: 'file', value: 'docs/cache-runbook.md', weight: 0.9 },
            { type: 'project', value: project, weight: 0.5 },
          ],
        },
      },
    ) as Record<string, unknown>;

    const labelAction = (approvedLabelProposal.metadata as Record<string, unknown>).approvalAction as Record<string, unknown>;
    equal(labelAction.action, 'labels_applied');
    equal(labelAction.knowledgeId, enrichmentKnowledge.id);

    const labeledKnowledge = await services.store.getKnowledge(enrichmentKnowledge.id);
    equal(labeledKnowledge?.status, 'approved');
    ok(labeledKnowledge?.labels.some((label) => label.type === 'file' && label.value === 'docs/cache-runbook.md'));
    equal(labeledKnowledge?.labels.filter((label) => label.type === 'project' && label.value === project).length, 1);

    const missingReferenceProposal = await services.store.createLearningProposal({
      project,
      proposalType: 'missing_reference',
      affectedKnowledgeId: enrichmentKnowledge.id,
      reason: 'Reviewer confirmed the cache runbook reference is missing.',
      evidence: [`knowledge:${enrichmentKnowledge.id}`],
      metadata: { source: 'test' },
    });

    const approvedReferenceProposal = await patch(
      services,
      `/operations/learning-proposals/${missingReferenceProposal.id}`,
      {
        status: 'approved',
        metadata: {
          suggestedReferences: [
            { type: 'file', uri: 'docs/cache-runbook.md', lineStart: 3, lineEnd: 12 },
            { type: 'file', uri: 'docs/original-cache.md' },
          ],
        },
      },
    ) as Record<string, unknown>;

    const referenceAction = (approvedReferenceProposal.metadata as Record<string, unknown>).approvalAction as Record<string, unknown>;
    equal(referenceAction.action, 'references_applied');
    equal(referenceAction.knowledgeId, enrichmentKnowledge.id);

    const referencedKnowledge = await services.store.getKnowledge(enrichmentKnowledge.id);
    equal(referencedKnowledge?.status, 'approved');
    ok(referencedKnowledge?.references.some((reference) => (
      reference.type === 'file' &&
      reference.uri === 'docs/cache-runbook.md' &&
      reference.lineStart === 3 &&
      reference.lineEnd === 12
    )));
    equal(referencedKnowledge?.references.filter((reference) => reference.type === 'file' && reference.uri === 'docs/original-cache.md').length, 1);

    // supersedes proposal without candidateKnowledgeId — falls back to mark_needs_review
    const noopProposal = await services.store.createLearningProposal({
      project,
      proposalType: 'supersedes',
      affectedKnowledgeId: olderKnowledge.id,
      reason: 'Stale context without known replacement.',
      evidence: [],
      metadata: { source: 'test' },
    });

    const approvedNoop = await patch(
      services,
      `/operations/learning-proposals/${noopProposal.id}`,
      { status: 'approved' },
    ) as Record<string, unknown>;

    const noopAction = (approvedNoop.metadata as Record<string, unknown>).approvalAction as Record<string, unknown>;
    equal(noopAction.action, 'knowledge_marked_needs_review');

  } finally {
    await services.close();
  }
});

test('learning proposal approval failures stay retryable', async () => {
  const store = new FailingKnowledgeUpdateStore();
  const services = createTestServices(
    '.tuberosa/test-backups',
    '.tuberosa/test-error-logs',
    undefined,
    store,
  );
  const project = 'proposal-retry';

  try {
    const olderKnowledge = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://proposal-retry/older',
      itemType: 'memory',
      title: 'Old retry approach',
      summary: 'An older workflow approach.',
      content: 'Use the old retry approach.',
      trustLevel: 70,
      labels: [{ type: 'project', value: project, weight: 1 }],
      references: [],
    }, []);

    const newerKnowledge = await services.store.upsertKnowledge({
      project,
      sourceType: 'manual',
      sourceUri: 'manual://proposal-retry/newer',
      itemType: 'memory',
      title: 'New retry approach',
      summary: 'Updated workflow approach.',
      content: 'Use the new retry approach.',
      trustLevel: 90,
      labels: [{ type: 'project', value: project, weight: 1 }],
      references: [],
    }, []);

    const proposal = await services.store.createLearningProposal({
      project,
      proposalType: 'supersedes',
      affectedKnowledgeId: olderKnowledge.id,
      candidateKnowledgeId: newerKnowledge.id,
      reason: 'Newer knowledge supersedes old retry approach.',
      evidence: [],
      metadata: { source: 'test' },
    });

    store.failNextKnowledgeUpdate = true;
    const failed = await dispatchHttp(services, {
      method: 'PATCH',
      url: `/operations/learning-proposals/${proposal.id}`,
      body: { status: 'approved' },
    });
    equal(failed.status, 500);

    const afterFailure = (await services.store.listLearningProposals({
      project,
      status: 'approved',
      limit: 10,
    })).find((item) => item.id === proposal.id);
    ok(afterFailure);
    equal(afterFailure.metadata.approvalAction, undefined);

    const retry = await patch(
      services,
      `/operations/learning-proposals/${proposal.id}`,
      { status: 'approved' },
    ) as Record<string, unknown>;
    const retryAction = (retry.metadata as Record<string, unknown>).approvalAction as Record<string, unknown>;
    equal(retryAction.action, 'supersedes_relation_created');

    const relations = await services.store.listKnowledgeRelations({
      fromKnowledgeId: newerKnowledge.id,
      relationType: 'supersedes',
      limit: 10,
    });
    equal(relations.filter((r) => r.targetKnowledgeId === olderKnowledge.id).length, 1);

    const affected = await services.store.getKnowledge(olderKnowledge.id);
    equal(affected?.status, 'needs_review');
  } finally {
    await services.close();
  }
});

test('review queue feedback creates proposals and gaps without immediately mutating knowledge', async () => {
  const services = createTestServices();
  const project = 'review-queue-guard';

  try {
    const staleKnowledge = await post(services, '/knowledge', {
      project,
      sourceType: 'manual',
      sourceUri: 'manual://review-queue/stale',
      itemType: 'wiki',
      title: 'Stale auth note',
      summary: 'Old auth approach using session cookies.',
      content: 'Use session cookies for auth in the newsletter app. This approach is outdated and should not surface.',
      trustLevel: 70,
      labels: [{ type: 'business_area', value: 'auth', weight: 1 }],
    }) as Record<string, unknown>;

    const rejectedKnowledge = await post(services, '/knowledge', {
      project,
      sourceType: 'manual',
      sourceUri: 'manual://review-queue/rejected',
      itemType: 'wiki',
      title: 'Irrelevant auth note',
      summary: 'Auth note that was rejected as irrelevant.',
      content: 'This auth pattern is irrelevant to the newsletter app workflow and should not surface in retrieval.',
      trustLevel: 65,
      labels: [{ type: 'business_area', value: 'auth', weight: 1 }],
    }) as Record<string, unknown>;

    // Simulate auto-approved memory from a completed session
    const autoMemory = await post(services, '/knowledge', {
      project,
      sourceType: 'manual',
      sourceUri: 'manual://review-queue/auto-memory',
      itemType: 'memory',
      title: 'Auto-approved session memory',
      summary: 'Session lesson auto-approved after a completed newsletter auth task.',
      content: 'When finishing newsletter auth tasks, record the session outcome and let Tuberosa auto-approve the lesson when all gates pass.',
      trustLevel: 80,
      labels: [
        { type: 'business_area', value: 'auth', weight: 1 },
        { type: 'task_type', value: 'implementation', weight: 0.9 },
      ],
      metadata: { source: 'agent_session_finish', learningMode: 'auto' },
    }) as Record<string, unknown>;

    const search = await post(services, '/context/search', {
      project,
      prompt: 'How does newsletter app auth work?',
      bypassCache: true,
    }) as Record<string, unknown>;

    // stale feedback — creates a supersedes proposal, does NOT mark knowledge needs_review
    await post(services, '/context/feedback', {
      contextPackId: search.id,
      project,
      feedbackType: 'stale',
      rejectedKnowledgeIds: [staleKnowledge.id],
      reason: 'Session cookie auth is stale; current flow uses bearer tokens.',
    });

    const staleKnowledgeAfter = await services.store.getKnowledge(String(staleKnowledge.id));
    equal(staleKnowledgeAfter?.status, 'approved', 'stale feedback must not immediately set needs_review');

    const staleProposals = await services.store.listLearningProposals({
      project,
      status: 'open',
      affectedKnowledgeId: String(staleKnowledge.id),
      limit: 10,
    });
    ok(staleProposals.length >= 1, 'stale feedback must create a learning proposal');
    ok(staleProposals.some((p) => p.proposalType === 'supersedes'), 'stale feedback must create a supersedes proposal');

    // rejected feedback — creates a proposal, does NOT mark knowledge needs_review
    await post(services, '/context/feedback', {
      contextPackId: search.id,
      project,
      feedbackType: 'rejected',
      rejectedKnowledgeIds: [rejectedKnowledge.id],
      reason: 'This auth pattern is not relevant to the newsletter app.',
    });

    const rejectedKnowledgeAfter = await services.store.getKnowledge(String(rejectedKnowledge.id));
    equal(rejectedKnowledgeAfter?.status, 'approved', 'rejected feedback must not immediately set needs_review');

    const rejectedProposals = await services.store.listLearningProposals({
      project,
      status: 'open',
      affectedKnowledgeId: String(rejectedKnowledge.id),
      limit: 10,
    });
    ok(rejectedProposals.length >= 1, 'rejected feedback must create a learning proposal');

    // missing_context feedback — creates a knowledge gap, not a learning proposal
    await post(services, '/context/feedback', {
      contextPackId: search.id,
      project,
      feedbackType: 'missing_context',
      reason: 'Need bearer token rotation documentation.',
      metadata: { missingSignals: ['file:docs/auth/bearer-tokens.md'] },
    });

    const gaps = await services.store.listKnowledgeGaps({ project, status: 'open', limit: 10 });
    ok(gaps.length >= 1, 'missing_context feedback must create a knowledge gap');
    ok(gaps.some((g) => g.contextPackId === String(search.id)), 'gap must reference the context pack');

    const missingContextProposals = await services.store.listLearningProposals({
      project,
      status: 'open',
      affectedKnowledgeId: undefined,
      limit: 10,
    });
    ok(
      !missingContextProposals.some((p) => p.sourceFeedbackId && !p.affectedKnowledgeId && p.contextPackId === String(search.id) && p.proposalType !== 'supersedes' && p.proposalType !== 'auto_memory_cleanup'),
      'missing_context feedback must not create extraneous learning proposals',
    );

    // stale feedback on auto-approved memory — creates auto_memory_cleanup proposal, does NOT demote memory
    await post(services, '/context/feedback', {
      contextPackId: search.id,
      project,
      feedbackType: 'stale',
      rejectedKnowledgeIds: [autoMemory.id],
      reason: 'This session lesson is no longer accurate.',
    });

    const autoMemoryAfter = await services.store.getKnowledge(String(autoMemory.id));
    equal(autoMemoryAfter?.status, 'approved', 'stale feedback on auto-memory must not immediately set needs_review');

    const autoCleanupProposals = await services.store.listLearningProposals({
      project,
      status: 'open',
      affectedKnowledgeId: String(autoMemory.id),
      limit: 10,
    });
    ok(
      autoCleanupProposals.some((p) => p.proposalType === 'auto_memory_cleanup'),
      'stale feedback on auto-approved memory must create an auto_memory_cleanup proposal',
    );

    // Approving a proposal runs the mutation: knowledge transitions to needs_review
    const proposalToApprove = staleProposals.find((p) => p.proposalType === 'supersedes');
    ok(proposalToApprove);
    await patch(services, `/operations/learning-proposals/${proposalToApprove.id}`, { status: 'approved' });

    const staleKnowledgeFinal = await services.store.getKnowledge(String(staleKnowledge.id));
    equal(staleKnowledgeFinal?.status, 'needs_review', 'approving the proposal must mark knowledge as needs_review');

  } finally {
    await services.close();
  }
});

test('operations API records, lists, reads, and updates physical error logs', async () => {
  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-backups-'));
  const errorLogDir = await mkdtemp(join(tmpdir(), 'tuberosa-error-logs-'));
  const services = createTestServices(backupDir, errorLogDir);

  try {
    const created = await post(services, '/operations/error-logs', {
      project: 'operations-review',
      category: 'agent_tool',
      severity: 'error',
      title: 'Test command failed',
      message: 'node --test failed with token=super-secret-token-value-12345',
      command: 'pnpm test',
      tags: ['tests'],
      references: [{ type: 'file', uri: 'test/operations.test.ts' }],
    }) as Record<string, unknown>;

    ok(created.id);
    equal(String(created.message).includes('super-secret-token-value-12345'), false);

    const listed = await get(services, '/operations/error-logs?project=operations-review&status=open&limit=5') as Array<Record<string, unknown>>;
    equal(listed.length, 1);
    equal(listed[0]!.id, created.id);

    const collection = await get(services, '/operations/error-logs/collection?project=operations-review&status=open&limit=5') as Record<string, unknown>;
    equal(collection.totalMatched, 1);
    equal((collection.logs as Array<Record<string, unknown>>)[0]!.id, created.id);
    ok(String(collection.agentBrief).includes('Error Log Brief'));

    const draft = await post(services, '/operations/error-logs/reflection-drafts', {
      errorLogIds: [created.id],
    }) as Record<string, unknown>;
    equal((draft.draft as Record<string, unknown>).status, 'pending');
    equal((draft.linkedErrorLogIds as string[])[0], created.id);

    const fetched = await get(services, `/operations/error-logs/${created.id}`) as Record<string, unknown>;
    equal(fetched.title, 'Test command failed');
    ok(fetched.reflectionDraftId);

    const resolved = await post(services, `/operations/error-logs/${created.id}/resolve`, {
      rootCause: 'The test command fixture was incomplete.',
      resolutionSummary: 'Created the reflection draft and verified the operations boundary.',
      changedFiles: ['test/operations.test.ts'],
      verificationCommands: ['pnpm test'],
    }) as Record<string, unknown>;
    equal((resolved.log as Record<string, unknown>).status, 'fixed');
    equal(((resolved.log as Record<string, unknown>).metadata as { resolution?: { rootCause?: string } }).resolution?.rootCause, 'The test command fixture was incomplete.');

    const patched = await patch(services, `/operations/error-logs/${created.id}`, {
      status: 'fixed',
      reflectionDraftId: 'draft-1',
      notes: 'Fixed in the operations boundary.',
    }) as Record<string, unknown>;
    equal(patched.status, 'fixed');
    equal(patched.reflectionDraftId, 'draft-1');
  } finally {
    await services.close();
    await rm(backupDir, { recursive: true, force: true });
    await rm(errorLogDir, { recursive: true, force: true });
  }
});

test('operations API creates and restores portable JSONL backups', async () => {
  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-backups-'));
  const services = createTestServices(backupDir);
  const project = 'backup-review';

  try {
    const stored = await post(services, '/knowledge', {
      project,
      sourceType: 'manual',
      sourceUri: 'manual://backup/original',
      itemType: 'wiki',
      title: 'Backup original',
      summary: 'Original backup note.',
      content: 'Backup restore should keep durable knowledge available for retrieval.',
      labels: [{ type: 'business_area', value: 'operations', weight: 1 }],
      references: [{ type: 'file', uri: 'docs/backup.md' }],
    }) as Record<string, unknown>;

    const backup = await post(services, '/operations/backups', { id: 'unit-backup' }) as Record<string, unknown>;
    equal(backup.id, 'unit-backup');
    ok(String(backup.path).startsWith(backupDir));

    const backups = await get(services, '/operations/backups') as Array<Record<string, unknown>>;
    ok(backups.some((item) => item.id === 'unit-backup'));
    const listedBackup = backups.find((item) => item.id === 'unit-backup') as Record<string, unknown>;
    ok((listedBackup.totalRows as number) > 0);
    ok(Array.isArray(listedBackup.tables));

    const status = await get(services, '/operations/backups/status') as Record<string, unknown>;
    equal(status.health, 'healthy');
    equal((status.latestBackup as Record<string, unknown>).id, 'unit-backup');
    const scheduler = status.scheduler as Record<string, unknown>;
    equal(scheduler.lastBackupId, 'unit-backup');
    equal(typeof scheduler.lastSuccessAt, 'string');
    equal(scheduler.lastError, undefined);

    const verification = await post(services, '/operations/backups/unit-backup/verify', {}) as Record<string, unknown>;
    equal(verification.ok, true);
    equal(verification.health, 'healthy');

    await post(services, '/knowledge', {
      project,
      sourceType: 'manual',
      sourceUri: 'manual://backup/extra',
      itemType: 'wiki',
      title: 'Backup extra',
      summary: 'Extra note after backup.',
      content: 'This note should disappear after replace restore.',
    });

    const dryRun = await post(services, '/operations/backups/unit-backup/restore', { dryRun: true }) as Record<string, unknown>;
    equal(dryRun.dryRun, true);
    ok((dryRun.restored as Record<string, number>).knowledge_items! >= 1);

    const restored = await post(services, '/operations/backups/unit-backup/restore', { replace: true }) as Record<string, unknown>;
    equal(restored.replace, true);

    const items = await get(services, `/knowledge?project=${project}&limit=10`) as Array<Record<string, unknown>>;
    ok(items.some((item) => item.id === stored.id));
    equal(items.some((item) => item.title === 'Backup extra'), false);
  } finally {
    await services.close();
    await rm(backupDir, { recursive: true, force: true });
  }
});

test('backup verification blocks corrupt restore and retention keeps latest valid backup', async () => {
  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-backups-'));
  const services = createTestServices(backupDir);

  try {
    await post(services, '/knowledge', {
      project: 'backup-integrity',
      sourceType: 'manual',
      sourceUri: 'manual://backup/integrity',
      itemType: 'wiki',
      title: 'Backup integrity',
      summary: 'Integrity note.',
      content: 'Verification should catch modified backup table files.',
    });

    await post(services, '/operations/backups', { id: 'backup-a' });
    await post(services, '/operations/backups', { id: 'backup-b' });
    const latest = await post(services, '/operations/backups', { id: 'backup-c' }) as Record<string, unknown>;
    const chunkFile = join(String(latest.path), 'knowledge_chunks.jsonl');
    const rawChunks = await readFile(chunkFile, 'utf8');
    await writeFile(chunkFile, `${rawChunks}\n`, 'utf8');

    const verification = await post(services, '/operations/backups/backup-c/verify', {}) as Record<string, unknown>;
    equal(verification.ok, false);
    equal(verification.health, 'unhealthy');

    const restoreResponse = await dispatchHttp(services, {
      method: 'POST',
      url: '/operations/backups/backup-c/restore',
      body: { replace: true },
    });
    equal(restoreResponse.status, 400);

    const pruneDryRun = await post(services, '/operations/backups/prune', {
      dryRun: true,
      keepCount: 1,
      maxAgeDays: 1,
    }) as Record<string, unknown>;
    equal((pruneDryRun.pruned as Array<unknown>).length, 1);
    equal((pruneDryRun.kept as Array<Record<string, unknown>>).some((backup) => backup.id === 'backup-c'), true);
    equal((pruneDryRun.kept as Array<Record<string, unknown>>).some((backup) => backup.id === 'backup-b'), true);

    const prune = await post(services, '/operations/backups/prune', {
      keepCount: 1,
      maxAgeDays: 1,
    }) as Record<string, unknown>;
    equal((prune.pruned as Array<unknown>).length, 1);

    const backups = await get(services, '/operations/backups') as Array<Record<string, unknown>>;
    equal(backups.length, 2);
    equal(backups[0]!.id, 'backup-c');
    equal(backups[1]!.id, 'backup-b');
  } finally {
    await services.close();
    await rm(backupDir, { recursive: true, force: true });
  }
});

test('physical mirror writes current readable context and session state from live store', async () => {
  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-backups-'));
  const mirrorDir = await mkdtemp(join(tmpdir(), 'tuberosa-current-'));
  const services = createTestServices(backupDir, '.tuberosa/test-error-logs', mirrorDir);

  try {
    await post(services, '/knowledge', {
      project: 'mirror-project',
      sourceType: 'manual',
      sourceUri: 'manual://mirror',
      itemType: 'workflow',
      title: 'Mirror workflow',
      summary: 'Physical mirror should show current knowledge.',
      content: 'The physical mirror sync writes readable knowledge from the live store.',
      labels: [{ type: 'project', value: 'mirror-project', weight: 1 }],
      references: [{ type: 'file', uri: 'docs/mirror.md' }],
    });

    const manifest = await waitForMirrorContent(join(mirrorDir, 'manifest.json'), (content) => content.includes('"id": "current"'));
    const knowledge = await waitForMirrorContent(join(mirrorDir, 'knowledge.md'), (content) => content.includes('Mirror workflow'));

    ok(manifest.includes('"id": "current"'));
    ok(knowledge.includes('Mirror workflow'));
    ok(knowledge.includes('Physical mirror should show current knowledge.'));

    const pack = await post(services, '/context/search', {
      project: 'mirror-project',
      prompt: 'Use MirrorContextSymbol for the physical mirror test',
      symbols: ['MirrorContextSymbol'],
      bypassCache: true,
    }) as Record<string, unknown>;
    await waitForMirrorContent(
      join(mirrorDir, 'context-packs.md'),
      (content) => content.includes('Use MirrorContextSymbol for the physical mirror test'),
    );

    await post(services, '/context/feedback', {
      contextPackId: pack.id,
      project: 'mirror-project',
      feedbackType: 'selected',
      reason: 'Mirror feedback should be visible.',
    });
    await waitForMirrorContent(
      join(mirrorDir, 'feedback_events.jsonl'),
      (content) => content.includes('"feedbackType":"selected"') || content.includes('"feedback_type":"selected"'),
    );

    const started = await post(services, '/agent-sessions', {
      project: 'mirror-project',
      prompt: 'Start MirrorSessionSymbol work',
      symbols: ['MirrorContextSymbol'],
      bypassCache: true,
    }) as Record<string, unknown>;
    const session = started.session as Record<string, unknown>;
    const context = started.contextPack as Record<string, unknown>;

    await waitForMirrorContent(
      join(mirrorDir, 'agent-sessions.md'),
      (content) => content.includes('Start MirrorSessionSymbol work'),
    );

    await post(services, `/agent-sessions/${String(session.id)}/context-decision`, {
      contextPackId: context.id,
      feedbackType: 'selected',
      reason: 'Session selected context.',
    });
    await waitForMirrorContent(
      join(mirrorDir, 'agent_context_decisions.jsonl'),
      (content) => content.includes('"decision":"selected"'),
    );
  } finally {
    await services.close();
    await rm(backupDir, { recursive: true, force: true });
    await rm(mirrorDir, { recursive: true, force: true });
  }
});

test('physical mirror coalesces overlapping sync requests into latest state', async () => {
  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-backups-'));
  const mirrorDir = await mkdtemp(join(tmpdir(), 'tuberosa-current-'));
  const store = new DelayedExportStore();
  const backups = new BackupService(store, {
    backupDir,
    storeKind: 'memory',
    physicalMirror: {
      enabled: true,
      dir: mirrorDir,
    },
  });

  try {
    const first = backups.syncPhysicalMirror('first');
    const second = backups.syncPhysicalMirror('second');

    equal(store.exportCallCount, 1);
    store.releaseFirstExport();

    await Promise.all([first, second]);
    equal(store.exportCallCount, 2);

    const manifest = await waitForMirrorContent(
      join(mirrorDir, 'manifest.json'),
      (content) => content.includes('"reason": "second"'),
    );
    ok(manifest.includes('"mirror": true'));
  } finally {
    await backups.close();
    await store.close();
    await rm(backupDir, { recursive: true, force: true });
    await rm(mirrorDir, { recursive: true, force: true });
  }
});

test('physical mirror debounces rapid request calls into one export', async () => {
  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-backups-'));
  const mirrorDir = await mkdtemp(join(tmpdir(), 'tuberosa-current-'));
  const store = new CountingExportStore();
  const backups = new BackupService(store, {
    backupDir,
    storeKind: 'memory',
    physicalMirror: {
      enabled: true,
      dir: mirrorDir,
      debounceMs: 25,
    },
  });

  try {
    backups.requestPhysicalMirror('first');
    backups.requestPhysicalMirror('second');
    backups.requestPhysicalMirror('third');

    equal(store.exportCallCount, 0);

    const manifest = await waitForMirrorContent(
      join(mirrorDir, 'manifest.json'),
      (content) => content.includes('"reason": "third"'),
    );
    equal(store.exportCallCount, 1);
    ok(manifest.includes('"mirror": true'));
  } finally {
    await backups.close();
    await store.close();
    await rm(backupDir, { recursive: true, force: true });
    await rm(mirrorDir, { recursive: true, force: true });
  }
});

test('physical mirror writes latest state when a request arrives during active sync', async () => {
  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-backups-'));
  const mirrorDir = await mkdtemp(join(tmpdir(), 'tuberosa-current-'));
  const store = new DelayedExportStore();
  const backups = new BackupService(store, {
    backupDir,
    storeKind: 'memory',
    physicalMirror: {
      enabled: true,
      dir: mirrorDir,
      debounceMs: 5,
    },
  });

  try {
    backups.requestPhysicalMirror('first');
    await waitFor(() => store.exportCallCount === 1);

    backups.requestPhysicalMirror('second');
    store.releaseFirstExport();

    const manifest = await waitForMirrorContent(
      join(mirrorDir, 'manifest.json'),
      (content) => content.includes('"reason": "second"'),
    );
    equal(store.exportCallCount, 2);
    ok(manifest.includes('"mirror": true'));
  } finally {
    await backups.close();
    await store.close();
    await rm(backupDir, { recursive: true, force: true });
    await rm(mirrorDir, { recursive: true, force: true });
  }
});

test('manual physical mirror sync bypasses debounce and clears pending timer', async () => {
  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-backups-'));
  const mirrorDir = await mkdtemp(join(tmpdir(), 'tuberosa-current-'));
  const store = new CountingExportStore();
  const backups = new BackupService(store, {
    backupDir,
    storeKind: 'memory',
    physicalMirror: {
      enabled: true,
      dir: mirrorDir,
      debounceMs: 50,
    },
  });

  try {
    backups.requestPhysicalMirror('queued');
    const summary = await backups.syncPhysicalMirror('manual');

    equal(summary?.id, 'current');
    equal(store.exportCallCount, 1);

    const manifest = await waitForMirrorContent(
      join(mirrorDir, 'manifest.json'),
      (content) => content.includes('"reason": "manual"'),
    );
    ok(manifest.includes('"mirror": true'));

    await delay(75);
    equal(store.exportCallCount, 1);
  } finally {
    await backups.close();
    await store.close();
    await rm(backupDir, { recursive: true, force: true });
    await rm(mirrorDir, { recursive: true, force: true });
  }
});

test('physical mirror close flushes a pending debounced request', async () => {
  const backupDir = await mkdtemp(join(tmpdir(), 'tuberosa-backups-'));
  const mirrorDir = await mkdtemp(join(tmpdir(), 'tuberosa-current-'));
  const store = new CountingExportStore();
  const backups = new BackupService(store, {
    backupDir,
    storeKind: 'memory',
    physicalMirror: {
      enabled: true,
      dir: mirrorDir,
      debounceMs: 1_000,
    },
  });

  try {
    backups.requestPhysicalMirror('closing');
    await backups.close();

    equal(store.exportCallCount, 1);
    const manifest = await waitForMirrorContent(
      join(mirrorDir, 'manifest.json'),
      (content) => content.includes('"reason": "closing"'),
    );
    ok(manifest.includes('"mirror": true'));
  } finally {
    await store.close();
    await rm(backupDir, { recursive: true, force: true });
    await rm(mirrorDir, { recursive: true, force: true });
  }
});

function contextQualityPack(
  project: string,
  direct: StoredKnowledge,
  adjacent: StoredKnowledge,
): ContextPack {
  const now = new Date().toISOString();
  return {
    id: 'context-quality-pack',
    queryId: 'context-quality-query',
    project,
    prompt: 'Audit context-quality feedback loops',
    confidence: 0.84,
    status: 'proposed',
    classified: {
      project,
      taskType: 'review',
      confidence: 0.8,
      files: ['docs/context-quality.md'],
      symbols: [],
      errors: [],
      technologies: [],
      businessAreas: ['operations'],
      exactTerms: ['docs/context-quality.md', 'operations'],
      lexicalQuery: 'docs/context-quality.md operations context quality',
      intent: {
        taskGoal: 'review existing implementation',
        workflowStage: 'review',
        impliedFiles: ['docs/context-quality.md'],
        impliedSymbols: [],
        impliedDomains: ['operations'],
        recentSessionReferences: [],
        requiredEvidenceTypes: ['workflow', 'docs'],
        uncertaintyReasons: [],
      },
    },
    contextFit: {
      fitStatus: 'ready',
      fitScore: 0.86,
      fitReasons: ['covered file:1/1'],
      missingSignals: ['missing symbol:ContextQualityWorkbench'],
    },
    actionableMissingSignals: {
      files: [],
      symbols: ['ContextQualityWorkbench'],
      errors: [],
      docs: [],
      intent: [],
      other: [],
    },
    sections: [
      {
        name: 'essential',
        tokenEstimate: 40,
        items: [
          contextQualityCandidate(direct, 'directTaskEvidence', 0.9),
          contextQualityCandidate(adjacent, 'adjacentContext', 0.62),
        ],
      },
      { name: 'supporting', tokenEstimate: 0, items: [] },
      { name: 'optional', tokenEstimate: 0, items: [] },
    ],
    rejectedKnowledgeIds: [],
    createdAt: now,
  };
}

function contextQualityCandidate(
  item: StoredKnowledge,
  evidenceCategory: RankedCandidate['evidenceCategory'],
  finalScore: number,
): RankedCandidate {
  return {
    knowledgeId: item.id,
    title: item.title,
    summary: item.summary,
    content: item.content,
    contextualContent: item.content,
    itemType: item.itemType,
    project: item.project,
    labels: item.labels,
    references: item.references,
    tokenEstimate: 20,
    trustLevel: item.trustLevel,
    source: evidenceCategory === 'adjacentContext' ? 'graph' : 'metadata',
    rawScore: finalScore,
    rank: evidenceCategory === 'adjacentContext' ? 2 : 1,
    fusedScore: finalScore,
    rerankScore: finalScore,
    finalScore,
    matchReasons: evidenceCategory === 'adjacentContext'
      ? ['graph match', 'vector match']
      : ['file:docs/context-quality.md'],
    fitScore: evidenceCategory === 'adjacentContext' ? 0.34 : 0.9,
    fitReasons: evidenceCategory === 'adjacentContext' ? ['graph connection'] : ['matched file:docs/context-quality.md'],
    fitMissingSignals: evidenceCategory === 'adjacentContext' ? ['missing file:docs/context-quality.md'] : [],
    evidenceCategory,
    evidenceStrength: evidenceCategory === 'adjacentContext' ? 'weak' : 'strong',
    usefulnessReason: evidenceCategory === 'adjacentContext'
      ? 'Adjacent related context; inspect only if direct evidence is not enough.'
      : 'Direct task evidence from file:docs/context-quality.md.',
  };
}

function createTestServices(
  backupDir = '.tuberosa/test-backups',
  errorLogDir = '.tuberosa/test-error-logs',
  physicalMirrorDir?: string,
  store = new MemoryKnowledgeStore(),
): AppServices {
  const cache = new MemoryCache();
  const models = new HashModelProvider(1536);
  const ingestion = new IngestionService(store, models);
  const retrieval = new RetrievalService(store, cache, models, config);
  const reflection = new ReflectionService(store, ingestion);
  const sessionReplay = new SessionReplayService(store);
  const agentSessions = new AgentSessionService(store, retrieval, reflection, models, sessionReplay, config);
  const operations = new OperationsService(store, ingestion, {
    backupDir,
    storeKind: 'memory',
    physicalMirror: {
      enabled: Boolean(physicalMirrorDir),
      dir: physicalMirrorDir,
      debounceMs: 10,
    },
  });
  const errorLogs = new ErrorLogService({ rootDir: errorLogDir });
  const errorLogInsights = new ErrorLogInsightService(errorLogs, reflection);
  const maintenance = new MaintenanceService(store);

  return {
    config: { ...config, backupDir, physicalMirrorDir, physicalMirrorEnabled: Boolean(physicalMirrorDir) },
    store,
    cache,
    models,
    ingestion,
    retrieval,
    reflection,
    agentSessions,
    sessionReplay,
    operations,
    errorLogs,
    errorLogInsights,
    maintenance,
    safety: {} as AppServices['safety'],
    async close() {
      await Promise.allSettled([operations.close(), cache.close(), store.close()]);
    },
  };
}

class FailingKnowledgeUpdateStore extends MemoryKnowledgeStore {
  failNextKnowledgeUpdate = false;

  override async updateKnowledge(
    id: Parameters<MemoryKnowledgeStore['updateKnowledge']>[0],
    patch: Parameters<MemoryKnowledgeStore['updateKnowledge']>[1],
  ) {
    if (this.failNextKnowledgeUpdate) {
      this.failNextKnowledgeUpdate = false;
      throw new Error('Simulated knowledge update failure.');
    }

    return super.updateKnowledge(id, patch);
  }
}

class CountingExportStore extends MemoryKnowledgeStore {
  exportCallCount = 0;

  override async exportBackup() {
    this.exportCallCount += 1;
    return super.exportBackup();
  }
}

class DelayedExportStore extends MemoryKnowledgeStore {
  exportCallCount = 0;
  private firstExportRelease: (() => void) | undefined;
  private readonly firstExportBlock = new Promise<void>((resolve) => {
    this.firstExportRelease = resolve;
  });

  override async exportBackup() {
    this.exportCallCount += 1;
    if (this.exportCallCount === 1) {
      await this.firstExportBlock;
    }

    return super.exportBackup();
  }

  releaseFirstExport(): void {
    this.firstExportRelease?.();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) {
      return;
    }
    lastError = new Error('Condition was not met before timeout.');
    await delay(25);
  }

  throw lastError instanceof Error ? lastError : new Error('Condition was not met before timeout.');
}

async function waitForMirrorContent(path: string, predicate: (content: string) => boolean): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const content = await readFile(path, 'utf8');
      if (predicate(content)) {
        return content;
      }
      lastError = new Error(`Mirror file did not contain expected content: ${path}`);
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }

  throw lastError instanceof Error ? lastError : new Error(`Mirror file not found: ${path}`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(services: AppServices, url: string, body: unknown): Promise<unknown> {
  const response = await dispatchHttp(services, { method: 'POST', url, body });
  equal(response.status, 200);
  return response.body;
}

async function patch(services: AppServices, url: string, body: unknown): Promise<unknown> {
  const response = await dispatchHttp(services, { method: 'PATCH', url, body });
  equal(response.status, 200);
  return response.body;
}

async function get(services: AppServices, url: string): Promise<unknown> {
  const response = await dispatchHttp(services, { method: 'GET', url });
  equal(response.status, 200);
  return response.body;
}

async function dispatchHttp(
  services: AppServices,
  input: { method: string; url: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: unknown }> {
  const encoded = input.body === undefined ? '' : JSON.stringify(input.body);
  const request = Readable.from(encoded ? [Buffer.from(encoded)] : []) as IncomingMessage;
  request.method = input.method;
  request.url = input.url;
  request.headers = {
    'content-length': String(Buffer.byteLength(encoded)),
    'content-type': 'application/json',
    ...input.headers,
  };

  let status = 0;
  let rawBody = '';
  const response = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    end(chunk?: unknown) {
      rawBody = typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk ?? '');
      return this;
    },
  } as unknown as ServerResponse;

  await handleHttpRequest(services, request, response);
  return { status, body: JSON.parse(rawBody) };
}
