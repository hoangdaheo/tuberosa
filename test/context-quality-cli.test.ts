import test from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import {
  formatContextQualityWorkbench,
  parseContextQualityArgs,
  runContextQualityReviewAction,
  runContextQualityWorkbench,
} from '../src/operations/context-quality-cli.js';
import type { ContextQualityReport, LearningProposal } from '../src/types.js';

test('context-quality CLI parser accepts filters and output options', () => {
  deepEqual(parseContextQualityArgs([
    '--project',
    'tuberosa',
    '--feedback-type',
    'too_much_adjacent_context',
    '--limit',
    '5',
    '--api-base',
    'http://localhost:3027/',
    '--out',
    'exports/context-quality.md',
  ]), {
    project: 'tuberosa',
    feedbackType: 'too_much_adjacent_context',
    limit: 5,
    apiBase: 'http://localhost:3027/',
    out: 'exports/context-quality.md',
    json: false,
    help: false,
    applyReview: false,
  });

  deepEqual(parseContextQualityArgs(['--', '--json']), {
    limit: 25,
    json: true,
    help: false,
    applyReview: false,
  });

  throws(() => parseContextQualityArgs(['--feedback-type', 'selected']), /Unknown feedback type/);
  throws(() => parseContextQualityArgs(['--limit', '0']), /positive integer/);
});

test('context-quality CLI parser requires explicit review action intent', () => {
  deepEqual(parseContextQualityArgs([
    '--apply-review',
    '--review-target',
    'learning-proposal',
    '--review-id',
    'proposal-1',
    '--review-status',
    'approved',
    '--review-metadata-json',
    '{"reviewer":"ops"}',
  ]), {
    limit: 25,
    json: false,
    help: false,
    applyReview: true,
    reviewTarget: 'learning-proposal',
    reviewId: 'proposal-1',
    reviewStatus: 'approved',
    reviewMetadata: { reviewer: 'ops' },
  });

  throws(() => parseContextQualityArgs([
    '--review-target',
    'knowledge-gap',
    '--review-id',
    'gap-1',
    '--review-status',
    'dismissed',
  ]), /--apply-review/);
  throws(() => parseContextQualityArgs(['--apply-review', '--review-target', 'knowledge']), /Unknown review target/);
  throws(() => parseContextQualityArgs(['--apply-review', '--review-target', 'knowledge-gap', '--review-id', 'gap-1', '--review-status', 'open']), /Unknown review status/);
  throws(() => parseContextQualityArgs(['--apply-review', '--review-metadata-json', '[]']), /JSON object/);
});

test('context-quality workbench dispatches to operations report', async () => {
  const report = sampleContextQualityReport();
  const result = await runContextQualityWorkbench({
    collectContextQualityFeedback: async (input) => {
      deepEqual(input, {
        project: 'tuberosa',
        feedbackType: 'selected_but_noisy',
        limit: 3,
      });
      return report;
    },
  }, {
    project: 'tuberosa',
    feedbackType: 'selected_but_noisy',
    limit: 3,
    json: false,
    help: false,
    applyReview: false,
  });

  equal(result, report);
});

test('context-quality review action updates learning proposal through operations', async () => {
  const report = sampleContextQualityReport();
  const updatedProposal: LearningProposal = {
    id: 'proposal-1',
    project: 'tuberosa',
    proposalType: 'missing_relation',
    sourceFeedbackId: 'feedback-1',
    sourceSessionId: 'session-1',
    contextPackId: 'pack-1',
    affectedKnowledgeId: 'knowledge-adjacent',
    reason: 'Adjacent item needs a weaker relation.',
    evidence: ['feedback:too_much_adjacent_context'],
    status: 'approved',
    metadata: {
      reviewer: 'ops',
      approvalAction: { action: 'knowledge_marked_needs_review' },
    },
    createdAt: '2026-05-19T00:01:00.000Z',
    updatedAt: '2026-05-19T00:02:00.000Z',
    reviewedAt: '2026-05-19T00:02:00.000Z',
  };

  const result = await runContextQualityReviewAction({
    collectContextQualityFeedback: async () => report,
    updateLearningProposal: async (id, patch) => {
      equal(id, 'proposal-1');
      deepEqual(patch, { status: 'approved', metadata: { reviewer: 'ops' } });
      return updatedProposal;
    },
  }, {
    limit: 25,
    json: false,
    help: false,
    applyReview: true,
    reviewTarget: 'learning-proposal',
    reviewId: 'proposal-1',
    reviewStatus: 'approved',
    reviewMetadata: { reviewer: 'ops' },
  });

  equal(result?.target, 'learning-proposal');
  equal(result?.status, 'approved');
  equal(result?.updated, updatedProposal);
});

test('context-quality workbench formats linked review actions', () => {
  const updatedProposal: LearningProposal = {
    id: 'proposal-1',
    project: 'tuberosa',
    proposalType: 'missing_relation',
    sourceFeedbackId: 'feedback-1',
    sourceSessionId: 'session-1',
    contextPackId: 'pack-1',
    affectedKnowledgeId: 'knowledge-adjacent',
    reason: 'Adjacent item needs a weaker relation.',
    evidence: ['feedback:too_much_adjacent_context'],
    status: 'approved',
    metadata: { approvalAction: { action: 'knowledge_marked_needs_review' } },
    createdAt: '2026-05-19T00:01:00.000Z',
    updatedAt: '2026-05-19T00:02:00.000Z',
    reviewedAt: '2026-05-19T00:02:00.000Z',
  };
  const text = formatContextQualityWorkbench(sampleContextQualityReport(), {
    apiBase: 'http://localhost:3027',
    reviewAction: {
      target: 'learning-proposal',
      id: 'proposal-1',
      status: 'approved',
      updated: updatedProposal,
    },
  });

  ok(text.includes('# Context Quality Workbench'));
  ok(text.includes('## Applied Review Action'));
  ok(text.includes('http://localhost:3027/operations/learning-proposals/proposal-1'));
  ok(text.includes('"action":"knowledge_marked_needs_review"'));
  ok(text.includes('http://localhost:3027/operations/context-quality?project=tuberosa&feedbackType=too_much_adjacent_context&limit=10'));
  ok(text.includes('Context pack: pack-1'));
  ok(text.includes('Session: session-1'));
  ok(text.includes('Noisy or adjacent items:'));
  ok(text.includes('http://localhost:3027/knowledge/knowledge-adjacent'));
  ok(text.includes('PATCH http://localhost:3027/operations/knowledge-gaps/gap-1'));
  ok(text.includes('PATCH http://localhost:3027/operations/learning-proposals/proposal-1'));
});

function sampleContextQualityReport(): ContextQualityReport {
  return {
    generatedAt: '2026-05-19T00:00:00.000Z',
    filters: {
      project: 'tuberosa',
      feedbackType: 'too_much_adjacent_context',
      limit: 10,
    },
    totalMatched: 1,
    records: [{
      feedback: {
        id: 'feedback-1',
        contextPackId: 'pack-1',
        project: 'tuberosa',
        feedbackType: 'too_much_adjacent_context',
        reason: 'Adjacent backup workflow distracted from context-quality review.',
        rejectedKnowledgeIds: ['knowledge-adjacent'],
        metadata: { agentSessionId: 'session-1' },
        createdAt: '2026-05-19T00:01:00.000Z',
      },
      contextPack: {
        id: 'pack-1',
        project: 'tuberosa',
        status: 'selected',
        prompt: 'Review context quality feedback',
        confidence: 0.84,
        fitStatus: 'ready',
        fitScore: 0.91,
        missingSignals: ['symbol:ContextQualityWorkbench'],
      },
      session: {
        id: 'session-1',
        status: 'finished',
        outcome: 'completed',
        prompt: 'Review context quality feedback',
        summary: 'Reviewed noisy adjacent context.',
      },
      adjacentItems: [{
        knowledgeId: 'knowledge-adjacent',
        title: 'Adjacent backup workflow',
        evidenceCategory: 'adjacentContext',
        evidenceStrength: 'weak',
        score: 0.31,
        reasons: ['graph match', 'business area:backup'],
        missingSignals: ['missing file:docs/context-quality.md'],
      }],
      missingSignals: ['adjacent context noise', 'symbol:ContextQualityWorkbench'],
      openKnowledgeGaps: [{
        id: 'gap-1',
        status: 'open',
        missingSignals: ['symbol:ContextQualityWorkbench'],
        reason: 'The review workbench surface was missing.',
      }],
      openLearningProposals: [{
        id: 'proposal-1',
        status: 'open',
        proposalType: 'missing_relation',
        affectedKnowledgeId: 'knowledge-adjacent',
        reason: 'Adjacent item needs a weaker relation.',
        evidence: ['feedback:too_much_adjacent_context'],
      }],
      suggestedReviewActions: [
        'Review open missing_relation proposals and demote or relabel adjacent context.',
      ],
    }],
    rollups: {
      feedbackTypes: [{ value: 'too_much_adjacent_context', count: 1 }],
      projects: [{ value: 'tuberosa', count: 1 }],
      suggestedReviewActions: [{
        value: 'Review open missing_relation proposals and demote or relabel adjacent context.',
        count: 1,
      }],
      missingSignals: [{ value: 'adjacent context noise', count: 1 }],
      adjacentItems: [{ knowledgeId: 'knowledge-adjacent', title: 'Adjacent backup workflow', count: 1 }],
    },
  };
}
