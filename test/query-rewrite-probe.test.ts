import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { MemoryCache } from '../src/cache.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import {
  DEFAULT_POLICY,
  resetRetrievalPolicyCache,
  rrfKFor,
  setRetrievalPolicy,
} from '../src/retrieval/policy.js';
import type { RetrievalPolicy } from '../src/retrieval/policy.js';
import { fuseCandidates } from '../src/retrieval/fusion.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { makeTestConfig } from './support/test-config.js';
import type {
  ClassifiedQuery,
  QueryRewriteInput,
  QueryRewriteResult,
  SearchCandidate,
} from '../src/types.js';

const config = makeTestConfig({ worktree: { enabled: false, maxFiles: 50, maxMtimeAgeHours: 72 } });

class RecordingRewriteProvider extends HashModelProvider {
  readonly rewriteInputs: QueryRewriteInput[] = [];

  constructor(dimensions: number, private readonly payload?: QueryRewriteResult) {
    super(dimensions);
  }

  override async rewriteQuery(input: QueryRewriteInput): Promise<QueryRewriteResult | undefined> {
    this.rewriteInputs.push(input);
    return this.payload;
  }
}

function clonePolicy(): RetrievalPolicy {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY)) as RetrievalPolicy;
}

// ---------------------------------------------------------------------------
// Phase 7 — Gated query rewrite
// ---------------------------------------------------------------------------

test('confident probe skips models.rewriteQuery (diverse-angle gate)', async () => {
  setRetrievalPolicy(clonePolicy());
  try {
    const store = new MemoryKnowledgeStore();
    const cache = new MemoryCache();
    const models = new RecordingRewriteProvider(1536, {
      lexicalQuery: 'should not be applied',
      exactTerms: ['should-not-fire'],
      reasons: ['rewrite should be gated out'],
      model: 'phase7-rewrite',
    });
    const ingestion = new IngestionService(store, models);
    const retrieval = new RetrievalService(store, cache, models, config);

    // Seed a knowledge item that lexically matches the prompt strongly so the
    // pre-search probe pass returns a high top1 fused score (>= the default
    // 0.65 threshold), which gates out the rewrite call.
    await ingestion.ingestKnowledge({
      project: 'tuberosa',
      sourceType: 'file',
      sourceUri: 'src/auth/token-refresh.ts',
      itemType: 'code_ref',
      title: 'token-refresh.ts',
      summary: 'Implements the token refresh handler for AuthService.',
      content:
        'export function tokenRefreshHandler() { /* AuthService.tokenRefreshHandler '
        + 'covers refresh token rotation, retry backoff, and bearer rotation. */ }',
      trustLevel: 90,
      labels: [
        { type: 'symbol', value: 'tokenRefreshHandler', weight: 1 },
        { type: 'file', value: 'src/auth/token-refresh.ts', weight: 1 },
      ],
      references: [{ type: 'file', uri: 'src/auth/token-refresh.ts' }],
    });

    const pack = await retrieval.searchContext({
      project: 'tuberosa',
      prompt: 'Where is the tokenRefreshHandler in src/auth/token-refresh.ts implemented?',
      files: ['src/auth/token-refresh.ts'],
      symbols: ['tokenRefreshHandler'],
      debug: true,
    });

    equal(models.rewriteInputs.length, 0, 'gated rewrite must skip the rewriteQuery call when the probe is confident');
    equal(pack.debug?.queryRewrite?.skipped, 'probe_confident');
    equal(pack.debug?.queryRewrite?.gated, true);
    ok((pack.debug?.queryRewrite?.probeConfidence ?? 0) >= 0.65, 'probe top1 fused score should be at or above the threshold');
  } finally {
    resetRetrievalPolicyCache();
  }
});

test('low-confidence probe fires rewriteQuery with mode=diverse_angle', async () => {
  setRetrievalPolicy(clonePolicy());
  try {
    const store = new MemoryKnowledgeStore();
    const cache = new MemoryCache();
    const models = new RecordingRewriteProvider(1536, {
      lexicalQuery: 'how does the payment_intent finalize work where_is_it_used what_depends_on_payment_intent',
      exactTerms: [
        'how does payment_intent finalize work',
        'where is payment_intent used',
        'what depends on payment_intent',
      ],
      reasons: ['Diverse-angle variants framed as how/where/what-depends.'],
      model: 'phase7-diverse-rewrite',
    });
    const ingestion = new IngestionService(store, models);
    const retrieval = new RetrievalService(store, cache, models, config);

    // Seed an item that does NOT lexically overlap the prompt, so the probe
    // top1 fused score stays below the 0.65 threshold and the rewrite fires.
    await ingestion.ingestKnowledge({
      project: 'tuberosa',
      sourceType: 'file',
      sourceUri: 'docs/checkout/payment_intent_flow.md',
      itemType: 'wiki',
      title: 'payment intent finalize flow',
      summary: 'Mechanism, callers, and dependency graph for payment_intent finalize.',
      content:
        'payment_intent finalize routes through CheckoutService and triggers a downstream '
        + 'webhook ack. Callers include OrderSettler and ReceiptDispatcher.',
      trustLevel: 88,
      labels: [{ type: 'business_area', value: 'checkout', weight: 1 }],
      references: [{ type: 'file', uri: 'docs/checkout/payment_intent_flow.md' }],
    });

    // Prompt avoids the indexed tokens so lexical probe stays weak. Vector
    // probe via hash also stays weak because the tokens are disjoint.
    const pack = await retrieval.searchContext({
      project: 'tuberosa',
      prompt: 'I need a generic walkthrough of the platform — nothing specific.',
      debug: true,
    });

    equal(models.rewriteInputs.length, 1, 'low-confidence probe must fire models.rewriteQuery once');
    equal(models.rewriteInputs[0]!.mode, 'diverse_angle', 'gated rewrite must pass mode=diverse_angle to the provider');
    ok(pack.debug?.queryRewrite, 'queryRewrite debug payload must be present after gated rewrite');
    equal(pack.debug?.queryRewrite?.gated, true);
    equal(pack.debug?.queryRewrite?.skipped, undefined);
    ok((pack.debug?.queryRewrite?.probeConfidence ?? 1) < 0.65, 'probe top1 fused score should be under the threshold');
    // exactTerms should carry the task-perspective variants from the provider.
    const exactTerms = pack.classified.exactTerms;
    ok(exactTerms.some((term) => term.includes('how') && term.includes('payment_intent')), 'expected a how-perspective variant');
    ok(exactTerms.some((term) => term.includes('where') && term.includes('payment_intent')), 'expected a where-perspective variant');
    ok(exactTerms.some((term) => term.includes('depends') && term.includes('payment_intent')), 'expected a depends-perspective variant');
  } finally {
    resetRetrievalPolicyCache();
  }
});

// ---------------------------------------------------------------------------
// Phase 7 — Tunable RRF k
// ---------------------------------------------------------------------------

test('rrfKFor honors per-task overrides and falls back to the global k', () => {
  setRetrievalPolicy(clonePolicy());
  try {
    const policy = clonePolicy();
    policy.rrf.k = 60;
    policy.rrf.kByTaskType = { debugging: 30, planning: 80 };
    setRetrievalPolicy(policy);
    equal(rrfKFor(policy, 'debugging'), 30);
    equal(rrfKFor(policy, 'planning'), 80);
    equal(rrfKFor(policy, 'implementation'), 60);
    equal(rrfKFor(policy, 'unknown'), 60);
  } finally {
    resetRetrievalPolicyCache();
  }
});

test('smaller RRF k produces sharper top-rank advantage at the same rank', () => {
  setRetrievalPolicy(clonePolicy());
  try {
    const classified = makeClassified('debugging');
    const groups: SearchCandidate[][] = [
      [makeCandidate('rank-1-hit', 'lexical', 1), makeCandidate('rank-4-hit', 'lexical', 4)],
    ];

    // Run once with the default global k = 60.
    const policyDefault = clonePolicy();
    policyDefault.rrf.kByTaskType = {};
    policyDefault.rrf.k = 60;
    setRetrievalPolicy(policyDefault);
    const fusedAt60 = fuseCandidates(groups, classified);
    const top1At60 = fusedAt60.find((c) => c.knowledgeId === 'rank-1-hit')!;
    const top4At60 = fusedAt60.find((c) => c.knowledgeId === 'rank-4-hit')!;

    // Re-fuse the same candidates with k = 30 (sharper). The ratio
    // top1/top4 should be strictly larger at k=30 than at k=60 because the
    // RRF divisor (k + rank) is more rank-sensitive when k is small.
    const policySharper = clonePolicy();
    policySharper.rrf.kByTaskType = {};
    policySharper.rrf.k = 30;
    setRetrievalPolicy(policySharper);
    const fusedAt30 = fuseCandidates(groups, classified);
    const top1At30 = fusedAt30.find((c) => c.knowledgeId === 'rank-1-hit')!;
    const top4At30 = fusedAt30.find((c) => c.knowledgeId === 'rank-4-hit')!;

    const ratio60 = top1At60.fusedScore / top4At60.fusedScore;
    const ratio30 = top1At30.fusedScore / top4At30.fusedScore;
    ok(ratio30 > ratio60, `expected k=30 to produce a sharper ratio than k=60; got k=30:${ratio30.toFixed(4)} k=60:${ratio60.toFixed(4)}`);
  } finally {
    resetRetrievalPolicyCache();
  }
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeClassified(taskType: ClassifiedQuery['taskType']): ClassifiedQuery {
  return {
    project: 'tuberosa',
    taskType,
    confidence: 0.9,
    files: [],
    symbols: [],
    errors: [],
    technologies: [],
    businessAreas: [],
    exactTerms: [],
    domain: undefined,
    lexicalQuery: '',
    intent: {
      taskGoal: '',
      workflowStage: 'implementation',
      taskBriefMode: 'implementation',
      impliedFiles: [],
      impliedSymbols: [],
      impliedDomains: [],
      objectHints: [],
      recentSessionReferences: [],
      requiredEvidenceTypes: [],
      uncertaintyReasons: [],
    },
  };
}

function makeCandidate(knowledgeId: string, source: SearchCandidate['source'], rank: number): SearchCandidate {
  return {
    knowledgeId,
    title: knowledgeId,
    summary: '',
    content: '',
    contextualContent: '',
    itemType: 'code_ref',
    project: 'tuberosa',
    source,
    rank,
    rawScore: 1 / rank,
    trustLevel: 90,
    tokenEstimate: 100,
    labels: [],
    references: [],
    freshnessAt: new Date().toISOString(),
    metadata: {},
  };
}
