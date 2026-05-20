import test from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { actionTarget, presentSummary } from '../src/workbench/presenters/summaryPresenter.js';
import type { WorkbenchSummary } from '../src/types.js';

test('workbench presenter adapts backend-shaped summary queues', () => {
  const summary = makeSummary();
  const view = presentSummary(summary);

  equal(view.queues.errorLogs.length, 1);
  equal(view.queues.errorLogs[0].title, 'Seeded browser failure');
  equal(view.queues.conflicts.length, 1);
  equal(view.queues.risky[0].trustLevel, 62);
});

test('workbench metrics and actions deep-link to direct route targets', () => {
  const view = presentSummary(makeSummary());

  deepEqual(view.metrics.find((metric) => metric.label === 'Knowledge gaps')?.target, { view: 'memory', memoryTab: 'gaps' });
  deepEqual(view.metrics.find((metric) => metric.label === 'Conflicts')?.target, { view: 'memory', memoryTab: 'conflicts' });
  deepEqual(view.metrics.find((metric) => metric.label === 'Error logs')?.target, { view: 'memory', memoryTab: 'errors' });
  deepEqual(actionTarget('context_quality'), 'quality');
});

test('workbench presenter provides beginner-friendly empty states', () => {
  const summary = makeSummary({
    openGaps: [],
    openProposals: [],
    openConflicts: [],
    riskyAutoMemories: [],
    openErrorLogs: {
      ...makeSummary().openErrorLogs,
      logs: [],
      totalMatched: 0,
    },
  });
  const view = presentSummary(summary);

  equal(view.queues.gaps.length, 0);
  equal(view.emptyStates.gaps.includes('Missing-context feedback'), true);
  equal(view.emptyStates.errors.includes('Captured failures'), true);
});

function makeSummary(overrides: Partial<WorkbenchSummary> = {}): WorkbenchSummary {
  const now = '2026-05-20T10:00:00.000Z';
  const base: WorkbenchSummary = {
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
        scheduler: {
          enabled: false,
          running: false,
          writeThroughEnabled: false,
        },
      },
    },
    counts: {
      recentSessions: 1,
      activeSessions: 0,
      pendingDrafts: 1,
      contextQualityRecords: 1,
      contextQualityMatched: 1,
      openGaps: 1,
      openProposals: 1,
      openConflicts: 1,
      autoMemories: 1,
      riskyAutoMemories: 1,
      openErrorLogs: 1,
      backupCount: 0,
    },
    countMetadata: { scanLimit: 100, capped: {} },
    recentSessions: [{ id: 'session-1', prompt: 'Try the workbench', status: 'finished', outcome: 'completed', reflectionDraftCount: 0, createdAt: now }],
    contextQuality: {
      generatedAt: now,
      filters: { project: 'tuberosa', limit: 10 },
      totalMatched: 1,
      records: [],
      rollups: {
        feedbackTypes: [],
        projects: [],
        suggestedReviewActions: [],
        missingSignals: [],
        adjacentItems: [],
      },
    },
    pendingDrafts: [{ id: 'draft-1', title: 'Draft', summary: 'Draft summary', itemType: 'memory', triggerType: 'manual', status: 'pending', labelCount: 0, referenceCount: 0, duplicateCandidateCount: 0, createdAt: now }],
    openGaps: [{ id: 'gap-1', status: 'open', prompt: 'Missing docs', missingSignals: ['file:docs/runbook.md'], missingSignalCount: 1, reason: 'Need a runbook', createdAt: now }],
    openProposals: [{ id: 'proposal-1', status: 'open', proposalType: 'missing_label', reason: 'Add file label', evidence: ['file:src/workbench/app.tsx'], evidenceCount: 1, createdAt: now }],
    openConflicts: [{ id: 'conflict-1', status: 'open', conflictType: 'summary_contradiction', leftKnowledgeId: 'left', rightKnowledgeId: 'right', sharedEvidence: ['symbol:Workbench'], sharedEvidenceCount: 1, reason: 'Two lessons disagree', createdAt: now }],
    riskyAutoMemories: [{ id: 'memory-1', project: 'tuberosa', status: 'approved', itemType: 'memory', title: 'Risky memory', summary: 'No grounded references', trustLevel: 62, labelCount: 0, referenceCount: 0, createdAt: now }],
    openErrorLogs: {
      generatedAt: now,
      project: 'tuberosa',
      totalMatched: 1,
      returned: 1,
      nextOffset: undefined,
      filters: { project: 'tuberosa', statuses: ['open', 'triaged'], limit: 10, offset: 0 },
      rollups: {
        categories: [],
        severities: [],
        statuses: [],
        files: [],
        symbols: [],
        errors: [],
        tags: [],
      },
      clusters: [],
      logs: [{
        id: 'error-1',
        project: 'tuberosa',
        category: 'test',
        severity: 'error',
        status: 'open',
        title: 'Seeded browser failure',
        summary: 'The browser test failed.',
        occurrenceCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        files: ['src/workbench/app.tsx'],
        symbols: ['Workbench'],
        errors: ['AssertionError'],
        tags: ['browser'],
        fingerprint: 'test-browser',
        references: [],
      }],
    },
    recommendedActions: [
      { priority: 1, target: 'context_quality', label: 'Review context-quality feedback', count: 1, reason: 'Noisy context.' },
      { priority: 3, target: 'knowledge_conflicts', label: 'Resolve conflicts', count: 1, reason: 'Conflicts reduce trust.' },
    ],
  };

  return { ...base, ...overrides };
}
