import test from 'node:test';
import { deepEqual, ok, throws } from 'node:assert/strict';
import {
  formatWorkbenchSummary,
  parseWorkbenchArgs,
  workbenchUsage,
} from '../src/operations/workbench-cli.js';
import type { WorkbenchSummary } from '../src/types.js';

test('workbench CLI parser accepts read-only summary filters', () => {
  deepEqual(parseWorkbenchArgs([
    '--project',
    'tuberosa',
    '--limit',
    '12',
    '--api-base',
    'http://localhost:3027',
    '--json',
  ]), {
    project: 'tuberosa',
    limit: 12,
    apiBase: 'http://localhost:3027',
    json: true,
    help: false,
  });

  deepEqual(parseWorkbenchArgs(['--help']), {
    limit: 10,
    json: false,
    help: true,
  });

  throws(() => parseWorkbenchArgs(['--limit', '0']), /positive integer/);
  ok(workbenchUsage().includes('pnpm run workbench'));
});

test('workbench CLI formatter prints summary queues and workbench links', () => {
  const summary = sampleWorkbenchSummary();
  const text = formatWorkbenchSummary(summary, { apiBase: 'http://localhost:3027' });

  ok(text.includes('# Tuberosa Workbench'));
  ok(text.includes('http://localhost:3027/workbench'));
  ok(text.includes('Review context-quality feedback'));
  ok(text.includes('Auto memories: 1; risky=1'));
});

function sampleWorkbenchSummary(): WorkbenchSummary {
  const now = new Date().toISOString();
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
      backupDir: '.tuberosa/test-backups',
      backupStatus: {
        backupDir: '.tuberosa/test-backups',
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
      activeSessions: 1,
      pendingDrafts: 1,
      contextQualityRecords: 1,
      contextQualityMatched: 1,
      openGaps: 0,
      openProposals: 0,
      openConflicts: 0,
      autoMemories: 1,
      riskyAutoMemories: 1,
      openErrorLogs: 0,
      backupCount: 0,
      pendingMaintenance: 0,
    },
    countMetadata: {
      scanLimit: 100,
      capped: {},
    },
    recentSessions: [{
      id: 'session-1',
      project: 'tuberosa',
      prompt: 'Implement the workbench.',
      status: 'active',
      reflectionDraftCount: 0,
      createdAt: now,
    }],
    contextQuality: {
      generatedAt: now,
      filters: { project: 'tuberosa', limit: 10 },
      totalMatched: 1,
      records: [{
        feedback: {
          id: 'feedback-1',
          project: 'tuberosa',
          feedbackType: 'selected_but_noisy',
          rejectedKnowledgeCount: 0,
          createdAt: now,
        },
        adjacentItems: [],
        missingSignals: ['selected but noisy'],
        openKnowledgeGaps: [],
        openLearningProposals: [],
        suggestedReviewActions: ['Review adjacent context.'],
      }],
      rollups: {
        feedbackTypes: [{ value: 'selected_but_noisy', count: 1 }],
        projects: [{ value: 'tuberosa', count: 1 }],
        suggestedReviewActions: [{ value: 'Review adjacent context.', count: 1 }],
        missingSignals: [{ value: 'selected but noisy', count: 1 }],
        adjacentItems: [],
      },
    },
    pendingDrafts: [{
      id: 'draft-1',
      project: 'tuberosa',
      title: 'Pending workbench draft',
      summary: 'Pending draft.',
      itemType: 'memory',
      triggerType: 'manual',
      status: 'pending',
      labelCount: 0,
      referenceCount: 0,
      duplicateCandidateCount: 0,
      createdAt: now,
    }],
    openGaps: [],
    openProposals: [],
    openConflicts: [],
    riskyAutoMemories: [{
      id: 'knowledge-1',
      project: 'tuberosa',
      sourceType: 'agent_session_finish',
      sourceUri: 'agent-session://1',
      status: 'approved',
      itemType: 'memory',
      title: 'Risky auto memory',
      summary: 'Needs audit.',
      trustLevel: 80,
      labelCount: 0,
      referenceCount: 0,
      createdAt: now,
    }],
    openErrorLogs: {
      project: 'tuberosa',
      generatedAt: now,
      totalMatched: 0,
      returned: 0,
      filters: {
        project: 'tuberosa',
        statuses: ['open', 'triaged'],
        limit: 10,
        offset: 0,
      },
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
      logs: [],
    },
    pendingMaintenance: {
      batchId: '',
      generatedAt: now,
      counts: { duplicate_memory: 0, stale_relation: 0, superseded_reflection: 0, weak_label: 0 },
      totalDetected: 0,
      truncated: false,
      items: [],
    },
    recommendedActions: [{
      priority: 1,
      target: 'context_quality',
      label: 'Review context-quality feedback',
      count: 1,
      href: '/operations/context-quality?project=tuberosa&limit=10',
      reason: 'Noisy context affects startup trust.',
    }],
  };
}
