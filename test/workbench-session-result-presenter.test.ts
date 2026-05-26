import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { presentSessionResult } from '../src/workbench/presenters/sessionResultPresenter.js';
import type { AgentSessionStartResult } from '../src/workbench/types.js';

test('session result presenter creates verdict, pipeline, graph, stack, and handoff', () => {
  const view = presentSessionResult(makeResult());

  equal(view.sessionId, 'session-1');
  equal(view.verdict.status, 'ready');
  ok(view.verdict.headline.includes('ready'));
  deepEqual(view.pipeline.map((stage) => stage.key), ['prompt', 'classify', 'retrieve', 'rank', 'fit', 'decision', 'memory']);
  equal(view.graph.nodes.some((node) => node.id === 'pack-pack-1'), true);
  equal(view.graph.nodes.some((node) => node.kind === 'file' && node.label === 'src/retrieval/service.ts'), true);
  equal(view.contextStack.essential.length, 1);
  ok(view.handoff.text.includes('Fix retrieval ranking'));
  ok(view.nextActions.some((action) => action.kind === 'record_decision'));
});

test('session result presenter groups missing signals for insufficient context', () => {
  const result = makeResult({
    contextPack: {
      contextFit: {
        fitStatus: 'insufficient',
        fitScore: 0.31,
        fitReasons: ['top candidate weak'],
        missingSignals: ['file:docs/runbook.md', 'symbol:RankingPolicy', 'error:TS999'],
      },
      orientation: {
        inferredTask: 'fix missing docs',
        recommendedFiles: [],
        likelySurfaces: [],
        verificationCommands: [],
        missingSignals: {
          files: ['docs/runbook.md'],
          symbols: ['RankingPolicy'],
          errors: ['TS999'],
          docs: [],
          intent: [],
          other: [],
        },
        notes: ['Need more project knowledge.'],
      },
    },
  });
  const view = presentSessionResult(result);

  equal(view.verdict.status, 'insufficient');
  deepEqual(view.missingSignals.files, ['docs/runbook.md']);
  deepEqual(view.missingSignals.symbols, ['RankingPolicy']);
  deepEqual(view.missingSignals.errors, ['TS999']);
  equal(view.nextActions.some((action) => action.kind === 'ingest_missing_context'), true);
});

interface ResultOverrides {
  contextPack?: {
    contextFit?: Partial<AgentSessionStartResult['contextPack']['contextFit']>;
    orientation?: Partial<AgentSessionStartResult['contextPack']['orientation']>;
  };
}

function makeResult(overrides: ResultOverrides = {}): AgentSessionStartResult {
  const base: AgentSessionStartResult = {
    session: {
      id: 'session-1',
      project: 'tuberosa',
      status: 'active',
      prompt: 'Fix retrieval ranking',
      reflectionDraftIds: [],
      metadata: {},
      createdAt: '2026-05-26T00:00:00.000Z',
    },
    policy: { action: 'proceed', instruction: 'Context is ready.' },
    contextPack: {
      id: 'pack-1',
      prompt: 'Fix retrieval ranking',
      status: 'proposed',
      confidence: 0.82,
      contextFit: {
        fitStatus: 'ready',
        fitScore: 0.82,
        fitReasons: ['covered file', 'covered symbol'],
        missingSignals: [],
      },
      orientation: {
        inferredTask: 'fix retrieval ranking',
        recommendedFiles: [{ path: 'src/retrieval/service.ts', reason: 'Direct file evidence.' }],
        likelySurfaces: ['src/retrieval/service.ts'],
        verificationCommands: ['pnpm test'],
        missingSignals: { files: [], symbols: [], errors: [], docs: [], intent: [], other: [] },
        notes: ['Use direct evidence.'],
      },
      taskBrief: {
        goal: 'Fix retrieval ranking',
        actionItems: [{ priority: 1, action: 'read_file', label: 'Read retrieval service', targetPath: 'src/retrieval/service.ts', reason: 'Direct evidence.' }],
        directEvidenceKnowledgeIds: ['knowledge-1'],
        adjacentKnowledgeIds: [],
      },
      sections: [
        {
          name: 'essential',
          tokenEstimate: 200,
          items: [{
            knowledgeId: 'knowledge-1',
            title: 'Retrieval service',
            summary: 'Ranking logic lives here.',
            itemType: 'code_ref',
            finalScore: 0.91,
            matchReasons: ['file:src/retrieval/service.ts', 'symbol:rank'],
            evidenceCategory: 'directTaskEvidence',
            evidenceStrength: 'strong',
            usefulnessReason: 'Direct file match.',
            references: [{ type: 'file', uri: 'src/retrieval/service.ts' }],
          }],
        },
        { name: 'supporting', tokenEstimate: 0, items: [] },
        { name: 'optional', tokenEstimate: 0, items: [] },
      ],
    },
  };

  return {
    ...base,
    ...overrides,
    contextPack: {
      ...base.contextPack,
      ...overrides.contextPack,
      contextFit: {
        ...base.contextPack.contextFit!,
        ...overrides.contextPack?.contextFit,
      },
      orientation: {
        ...base.contextPack.orientation!,
        ...overrides.contextPack?.orientation,
      },
    },
  };
}
