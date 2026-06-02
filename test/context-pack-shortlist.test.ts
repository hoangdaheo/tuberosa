import test from 'node:test';
import { equal, ok, deepEqual } from 'node:assert/strict';
import {
  boundDeepContextForResponse,
  projectShortlistItem,
  slimClassified,
} from '../src/mcp/server.js';
import type { DeepContext, RankedCandidate, ClassifiedQuery } from '../src/types.js';

function bigDeepContext(): DeepContext {
  const item = (i: number) => ({
    knowledgeId: `k${i}`,
    title: `Item ${i}`,
    summary: 's',
    itemType: 'wiki' as const,
    project: 'demo',
    labels: [],
    references: [],
    source: 'lexical' as const,
    rank: i,
    finalScore: 1 - i * 0.01,
    matchReasons: ['m'],
    chunkIds: [`c${i}`],
    content: 'x'.repeat(5000),
    contextualContent: 'y'.repeat(5000),
    tokenEstimate: 2500,
  });
  const section = (name: 'essential' | 'supporting' | 'optional') => ({
    name,
    items: [item(1), item(2), item(3), item(4), item(5)],
    tokenEstimate: 12500,
  });
  return {
    mode: 'layered',
    budget: 60000,
    tokenEstimate: 37500,
    sections: [section('essential'), section('supporting'), section('optional')],
  };
}

test('boundDeepContextForResponse caps items per section and truncates content', () => {
  const { deepContext, truncated } = boundDeepContextForResponse(bigDeepContext(), 10_000);
  ok(truncated, 'should report truncation');
  for (const section of deepContext.sections) {
    ok(section.items.length <= 3, 'max 3 items per section');
    for (const item of section.items) {
      ok(item.content.length <= 1200, 'content truncated');
      ok(item.contextualContent.length <= 1200, 'contextualContent truncated');
    }
  }
  ok(deepContext.tokenEstimate <= 10_000, 'within ceiling');
});

test('projectShortlistItem drops diagnostic fields, keeps agent-facing fields', () => {
  const item = {
    knowledgeId: 'k1',
    title: 'T',
    itemType: 'wiki',
    project: 'demo',
    finalScore: 0.9,
    matchReasons: ['file match'],
    fitScore: 0.8,
    fitReasons: ['noise'],
    fitMissingSignals: ['noise'],
    evidenceCategory: 'directTaskEvidence',
    evidenceStrength: 'strong',
    usefulnessReason: 'noise',
    actionableMissingSignals: { foo: 'noise' },
    references: [{ refType: 'file', uri: 'a' }, { refType: 'file', uri: 'b' }, { refType: 'file', uri: 'c' }, { refType: 'file', uri: 'd' }],
  } as unknown as RankedCandidate;
  const projected = projectShortlistItem(item) as Record<string, unknown>;
  equal(projected.score, 0.9);
  deepEqual(projected.reasons, ['file match']);
  equal(projected.evidenceCategory, 'directTaskEvidence');
  ok((projected.references as unknown[]).length <= 3, 'references capped at 3');
  equal('fitReasons' in projected, false);
  equal('actionableMissingSignals' in projected, false);
  equal('usefulnessReason' in projected, false);
});

test('slimClassified keeps signals, drops lexicalQuery/intent/preprocessing', () => {
  const classified = {
    project: 'demo',
    taskType: 'review',
    confidence: 0.6,
    files: ['a.ts'],
    symbols: ['Foo'],
    errors: [],
    technologies: ['node'],
    businessAreas: [],
    exactTerms: ['noise'],
    lexicalQuery: 'noise noise noise',
    preprocessing: { lengthClass: 'short' },
    intent: { taskGoal: 'noise' },
  } as unknown as ClassifiedQuery;
  const slim = slimClassified(classified) as Record<string, unknown>;
  deepEqual(slim.files, ['a.ts']);
  deepEqual(slim.symbols, ['Foo']);
  equal('lexicalQuery' in slim, false);
  equal('intent' in slim, false);
  equal('preprocessing' in slim, false);
});
