import test from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import {
  formatContextQualityWorkbench,
  parseContextQualityArgs,
  runContextQualityWorkbench,
} from '../src/operations/context-quality-cli.js';
import type { ContextQualityReport } from '../src/types.js';

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
  });

  deepEqual(parseContextQualityArgs(['--', '--json']), {
    limit: 25,
    json: true,
    help: false,
  });

  throws(() => parseContextQualityArgs(['--feedback-type', 'selected']), /Unknown feedback type/);
  throws(() => parseContextQualityArgs(['--limit', '0']), /positive integer/);
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
  });

  equal(result, report);
});

test('context-quality workbench formats linked review actions', () => {
  const text = formatContextQualityWorkbench(sampleContextQualityReport(), {
    apiBase: 'http://localhost:3027',
  });

  ok(text.includes('# Context Quality Workbench'));
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
