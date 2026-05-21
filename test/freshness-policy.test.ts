import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_POLICY, freshnessWindowFor, resetRetrievalPolicyCache, setRetrievalPolicy } from '../src/retrieval/policy.js';
import { ContextFitEvaluator } from '../src/retrieval/context-fit.js';
import { classifyQuery } from '../src/retrieval/classifier.js';
import type { ClassifiedQuery, KnowledgeItemType, RankedCandidate } from '../src/types.js';

function buildCandidate(itemType: KnowledgeItemType, freshnessAt: string, overrides: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    knowledgeId: `id-${itemType}`,
    title: `${itemType} candidate`,
    summary: `summary for ${itemType}`,
    content: `content for ${itemType}`,
    contextualContent: `contextual ${itemType}`,
    itemType,
    project: 'sandbox',
    labels: [],
    references: [],
    tokenEstimate: 50,
    trustLevel: 80,
    source: 'lexical',
    rawScore: 0.8,
    rank: 1,
    freshnessAt,
    metadata: {},
    fusedScore: 0.8,
    rerankScore: 0.8,
    finalScore: 0.8,
    matchReasons: [],
    ...overrides,
  };
}

function buildClassified(): ClassifiedQuery {
  return classifyQuery({ prompt: 'review the recent code change in src/retrieval/policy.ts' });
}

test('freshnessWindowFor returns per-itemType windows from DEFAULT_POLICY', () => {
  assert.equal(freshnessWindowFor(DEFAULT_POLICY, 'spec').staleDays > freshnessWindowFor(DEFAULT_POLICY, 'memory').staleDays, true);
  assert.equal(freshnessWindowFor(DEFAULT_POLICY, 'rule').currentDays >= 540, true);
  assert.equal(freshnessWindowFor(DEFAULT_POLICY, 'conversation').staleDays <= 180, true);
});

test('freshnessWindowFor falls back to global window when useFreshnessMap is false', () => {
  const policy = { ...DEFAULT_POLICY, useFreshnessMap: false };
  assert.deepEqual(freshnessWindowFor(policy, 'memory'), policy.freshnessGlobal);
  assert.deepEqual(freshnessWindowFor(policy, 'spec'), policy.freshnessGlobal);
});

test('ContextFitEvaluator marks an old code_ref as current and an old memory as stale', () => {
  resetRetrievalPolicyCache();
  setRetrievalPolicy(DEFAULT_POLICY);
  try {
    const classified = buildClassified();
    const evaluator = new ContextFitEvaluator();
    const now = new Date('2026-05-21T00:00:00Z');
    // 250 days: code_ref window is 270/720 → current; memory window is 120/300 → stale (>300d only at 320+)
    const codeFreshness = new Date(now.getTime() - 250 * 86_400_000).toISOString();
    const memoryFreshness = new Date(now.getTime() - 320 * 86_400_000).toISOString();

    const codeCandidate = buildCandidate('code_ref', codeFreshness);
    const memoryCandidate = buildCandidate('memory', memoryFreshness);

    const codeFit = evaluator.evaluate({ classified, candidates: [codeCandidate], now });
    const memoryFit = evaluator.evaluate({ classified, candidates: [memoryCandidate], now });

    const codeReasons = codeFit.candidates[0].fitReasons ?? [];
    const codeMissing = codeFit.candidates[0].fitMissingSignals ?? [];
    const memoryMissing = memoryFit.candidates[0].fitMissingSignals ?? [];

    assert.ok(codeReasons.includes('freshness:current:code_ref'),
      'code_ref at 250d should be current; reasons=' + codeReasons.join(','));
    assert.ok(!codeMissing.some((signal) => signal.startsWith('freshness:stale')),
      'code_ref at 250d should not be flagged stale; missing=' + codeMissing.join(','));
    assert.ok(memoryMissing.some((signal) => signal.startsWith('freshness:stale')),
      'memory at 320d should be flagged stale; missing=' + memoryMissing.join(','));
  } finally {
    resetRetrievalPolicyCache();
  }
});

test('useFreshnessMap=false makes both candidates use the global 365-day boundary', () => {
  const policy = { ...DEFAULT_POLICY, useFreshnessMap: false };
  setRetrievalPolicy(policy);
  try {
    const classified = buildClassified();
    const evaluator = new ContextFitEvaluator();
    const now = new Date('2026-05-21T00:00:00Z');
    const fourHundredDaysAgo = new Date(now.getTime() - 400 * 86_400_000).toISOString();

    const codeCandidate = buildCandidate('code_ref', fourHundredDaysAgo);
    const memoryCandidate = buildCandidate('memory', fourHundredDaysAgo);
    const codeMissing = evaluator.evaluate({ classified, candidates: [codeCandidate], now }).candidates[0].fitMissingSignals ?? [];
    const memoryMissing = evaluator.evaluate({ classified, candidates: [memoryCandidate], now }).candidates[0].fitMissingSignals ?? [];
    assert.ok(codeMissing.some((signal) => signal.startsWith('freshness:stale')), 'code_ref past 365d global window should be stale');
    assert.ok(memoryMissing.some((signal) => signal.startsWith('freshness:stale')), 'memory past 365d global window should be stale');
  } finally {
    resetRetrievalPolicyCache();
  }
});
