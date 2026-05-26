import test from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { presentReviewQueue } from '../src/workbench/presenters/reviewQueuePresenter.js';
import type { WorkbenchSummary } from '../src/types.js';

test('review queue combines workbench summary queues by priority', () => {
  const queue = presentReviewQueue(makeSummary());

  deepEqual(queue.filters.map((filter) => filter.key), ['all', 'drafts', 'quality', 'gaps', 'proposals', 'conflicts', 'risky', 'errors', 'maintenance']);
  equal(queue.items[0].type, 'quality');
  equal(queue.items[0].priority, 1);
  equal(queue.items.some((item) => item.type === 'draft' && item.primaryAction === 'Review draft'), true);
  equal(queue.items.some((item) => item.type === 'conflict' && item.tone === 'bad'), true);
});

test('review queue filters by item type', () => {
  const queue = presentReviewQueue(makeSummary(), 'gaps');

  equal(queue.activeFilter, 'gaps');
  equal(queue.items.length, 1);
  equal(queue.items[0].type, 'gap');
});

function makeSummary(): WorkbenchSummary {
  const now = '2026-05-26T00:00:00.000Z';
  return {
    generatedAt: now,
    filters: { project: 'tuberosa', limit: 10 },
    health: {
      ok: true,
      service: 'tuberosa',
      store: 'memory',
      durability: 'ephemeral',
      cache: 'memory',
      modelProvider: 'hash',
      backupDir: '.tuberosa/backups',
      backupStatus: {
        backupDir: '.tuberosa/backups',
        store: 'memory',
        health: 'no_backups',
        backupCount: 0,
        totalRows: 0,
        scheduler: { enabled: false, running: false, writeThroughEnabled: false },
      },
    },
    counts: {
      recentSessions: 0,
      activeSessions: 0,
      pendingDrafts: 1,
      contextQualityRecords: 1,
      contextQualityMatched: 1,
      openGaps: 1,
      openProposals: 1,
      openConflicts: 1,
      autoMemories: 0,
      riskyAutoMemories: 1,
      openErrorLogs: 1,
      backupCount: 0,
      pendingMaintenance: 1,
    },
    countMetadata: { scanLimit: 100, capped: {} },
    recentSessions: [],
    contextQuality: {
      generatedAt: now,
      filters: { project: 'tuberosa', limit: 10 },
      totalMatched: 1,
      records: [{
        feedback: {
          id: 'feedback-1',
          project: 'tuberosa',
          contextPackId: 'pack-1',
          feedbackType: 'selected_but_noisy',
          reason: 'Too much adjacent context',
          rejectedKnowledgeCount: 0,
          createdAt: now,
        },
        adjacentItems: [],
        missingSignals: ['file:docs/runbook.md'],
        openKnowledgeGaps: [],
        openLearningProposals: [],
        suggestedReviewActions: ['Add runbook knowledge'],
      }],
      rollups: { feedbackTypes: [], projects: [], suggestedReviewActions: [], missingSignals: [], adjacentItems: [] },
    },
    pendingDrafts: [{ id: 'draft-1', title: 'Draft', summary: 'Draft summary', itemType: 'memory', triggerType: 'manual', status: 'pending', labelCount: 1, referenceCount: 1, duplicateCandidateCount: 0, createdAt: now }],
    openGaps: [{ id: 'gap-1', status: 'open', prompt: 'Need docs', missingSignals: ['file:docs/runbook.md'], missingSignalCount: 1, reason: 'Missing runbook', createdAt: now }],
    openProposals: [{ id: 'proposal-1', status: 'open', proposalType: 'missing_label', reason: 'Add label', evidence: ['file:src/app.ts'], evidenceCount: 1, createdAt: now }],
    openConflicts: [{ id: 'conflict-1', status: 'open', conflictType: 'summary_contradiction', leftKnowledgeId: 'left', rightKnowledgeId: 'right', sharedEvidence: ['symbol:X'], sharedEvidenceCount: 1, reason: 'Conflicting lessons', createdAt: now }],
    riskyAutoMemories: [{ id: 'memory-1', project: 'tuberosa', status: 'approved', itemType: 'memory', title: 'Risky', summary: 'Weak references', trustLevel: 62, labelCount: 0, referenceCount: 0, createdAt: now }],
    openErrorLogs: {
      generatedAt: now,
      project: 'tuberosa',
      totalMatched: 1,
      returned: 1,
      filters: { project: 'tuberosa', statuses: ['open'], limit: 10, offset: 0 },
      rollups: { categories: [], severities: [], statuses: [], files: [], symbols: [], errors: [], tags: [] },
      clusters: [],
      logs: [{
        id: 'error-1',
        project: 'tuberosa',
        fingerprint: 'fp-error-1',
        category: 'test',
        severity: 'error',
        status: 'open',
        title: 'Browser test failed',
        summary: 'Graph did not render',
        occurrenceCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        files: ['src/workbench/app.tsx'],
        symbols: [],
        errors: ['AssertionError'],
        tags: [],
        references: [],
      }],
    },
    pendingMaintenance: {
      batchId: 'batch-1',
      generatedAt: now,
      counts: { duplicate_memory: 1, stale_relation: 0, superseded_reflection: 0, weak_label: 0 },
      totalDetected: 1,
      truncated: false,
      items: [{ id: 'maintenance-1', kind: 'duplicate_memory', risk: 'low', reason: 'Duplicate memory detected' }],
    },
    recommendedActions: [
      { priority: 1, target: 'context_quality', label: 'Review context-quality feedback', count: 1, reason: 'Noisy context affects startup trust.' },
    ],
  };
}
