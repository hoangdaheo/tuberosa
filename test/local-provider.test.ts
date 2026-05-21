import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalCrossEncoderProvider, type LocalCrossEncoderScorer } from '../src/model/local-provider.js';
import type { RankedCandidate, RerankInput } from '../src/types.js';

function buildCandidate(overrides: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    knowledgeId: overrides.knowledgeId ?? 'k1',
    chunkId: overrides.chunkId ?? 'c1',
    project: 'tuberosa',
    title: overrides.title ?? 'sample',
    summary: overrides.summary ?? 'summary',
    content: overrides.content ?? 'content body',
    contextualContent: overrides.contextualContent ?? 'context',
    itemType: 'code_ref',
    source: 'lexical',
    rank: overrides.rank ?? 1,
    rawScore: overrides.rawScore ?? 0.5,
    fusedScore: overrides.fusedScore ?? 0.5,
    rerankScore: 0,
    finalScore: 0,
    trustLevel: overrides.trustLevel ?? 70,
    matchReasons: overrides.matchReasons ?? [],
    labels: overrides.labels ?? [],
    references: overrides.references ?? [],
    metadata: overrides.metadata ?? {},
    tokenEstimate: 0,
    freshnessAt: overrides.freshnessAt,
    ...overrides,
  } as RankedCandidate;
}

function buildInput(candidates: RankedCandidate[], prompt = 'rerank me'): RerankInput {
  return {
    prompt,
    candidates,
    classified: {
      project: 'tuberosa',
      taskType: 'implementation',
      files: [],
      symbols: [],
      errors: [],
      technologies: [],
      businessAreas: [],
      exactTerms: [],
      confidence: 0.6,
      lexicalQuery: prompt,
      intent: {
        taskGoal: 'sample',
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
    },
  } as RerankInput;
}

describe('LocalCrossEncoderProvider', () => {
  it('uses an injected scorer and ranks by the local score blend', async () => {
    const scorer: LocalCrossEncoderScorer = {
      async score(_prompt, candidates) {
        return candidates.map((candidate) => (candidate.knowledgeId === 'k2' ? 0.9 : 0.1));
      },
    };
    const provider = new LocalCrossEncoderProvider({ scorer });
    const candidates = [
      buildCandidate({ knowledgeId: 'k1', fusedScore: 0.9, trustLevel: 50 }),
      buildCandidate({ knowledgeId: 'k2', fusedScore: 0.2, trustLevel: 60 }),
    ];
    const result = await provider.rerank(buildInput(candidates, 'context broker'));
    assert.equal(result.candidates[0].knowledgeId, 'k2', 'high local score should win even with low fused score');
    assert.ok(result.candidates[0].rerankScore > result.candidates[1].rerankScore);
    assert.ok(result.candidates[0].matchReasons.some((reason) => reason.startsWith('local-rerank:')));
    assert.equal(result.model, 'Xenova/bge-reranker-base');
  });

  it('falls back to the hash provider when the scorer throws', async () => {
    const provider = new LocalCrossEncoderProvider({
      scorer: {
        async score() {
          throw new Error('boom');
        },
      },
    });
    const candidates = [buildCandidate({ knowledgeId: 'k1', fusedScore: 0.4 })];
    const result = await provider.rerank(buildInput(candidates));
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].knowledgeId, 'k1');
    assert.ok(result.candidates[0].rerankScore > 0);
  });

  it('falls back to hash rerank when no transformers package is available', async () => {
    const provider = new LocalCrossEncoderProvider({});
    const candidates = [
      buildCandidate({ knowledgeId: 'k1', fusedScore: 0.2 }),
      buildCandidate({ knowledgeId: 'k2', fusedScore: 0.6 }),
    ];
    const result = await provider.rerank(buildInput(candidates));
    assert.equal(result.candidates[0].knowledgeId, 'k2', 'hash rerank preserves fused-score ordering when no overlap');
  });

  it('embed and rewriteQuery delegate to the fallback', async () => {
    const provider = new LocalCrossEncoderProvider({});
    const embedding = await provider.embed('hello world');
    assert.ok(Array.isArray(embedding) && embedding.length === 1536);
    assert.equal(await provider.rewriteQuery({ prompt: 'x', classified: {} as never }), undefined);
  });
});
