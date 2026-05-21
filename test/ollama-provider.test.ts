import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaRerankProvider } from '../src/model/ollama-provider.js';
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

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : String(input));
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OllamaRerankProvider', () => {
  it('ranks by the ollama score blend on the happy path', async () => {
    const fetchFn = mockFetch(() => jsonResponse({
      results: [
        { index: 0, relevance_score: 0.1 },
        { index: 1, relevance_score: 0.9 },
      ],
    }));
    const provider = new OllamaRerankProvider({ fetchFn, modelId: 'test-model' });
    const candidates = [
      buildCandidate({ knowledgeId: 'k1', fusedScore: 0.9, trustLevel: 50 }),
      buildCandidate({ knowledgeId: 'k2', fusedScore: 0.2, trustLevel: 60 }),
    ];
    const result = await provider.rerank(buildInput(candidates, 'context broker'));
    assert.equal(result.candidates[0].knowledgeId, 'k2', 'high ollama score should win even with low fused score');
    assert.ok(result.candidates[0].rerankScore > result.candidates[1].rerankScore);
    assert.ok(result.candidates[0].matchReasons.some((reason) => reason.startsWith('ollama-rerank:')));
    assert.equal(result.model, 'test-model');
  });

  it('reorders candidates by blended score when index order is reversed', async () => {
    const fetchFn = mockFetch(() => jsonResponse({
      results: [
        { index: 1, relevance_score: 0.95 },
        { index: 0, relevance_score: 0.05 },
      ],
    }));
    const provider = new OllamaRerankProvider({ fetchFn });
    const candidates = [
      buildCandidate({ knowledgeId: 'first', fusedScore: 0.5 }),
      buildCandidate({ knowledgeId: 'second', fusedScore: 0.5 }),
    ];
    const result = await provider.rerank(buildInput(candidates));
    assert.equal(result.candidates[0].knowledgeId, 'second');
    assert.equal(result.candidates[1].knowledgeId, 'first');
    assert.ok(result.candidates[0].finalScore >= result.candidates[1].finalScore);
  });

  it('falls back to hash rerank when the fetch throws', async () => {
    const fetchFn = mockFetch(() => {
      throw new Error('network down');
    });
    const provider = new OllamaRerankProvider({ fetchFn });
    const candidates = [
      buildCandidate({ knowledgeId: 'k1', fusedScore: 0.2 }),
      buildCandidate({ knowledgeId: 'k2', fusedScore: 0.6 }),
    ];
    const result = await provider.rerank(buildInput(candidates));
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].knowledgeId, 'k2', 'hash rerank preserves fused-score ordering when no overlap');
    assert.ok(!result.candidates[0].matchReasons.some((reason) => reason.startsWith('ollama-rerank:')));
  });

  it('falls back to hash rerank on a non-200 response', async () => {
    const fetchFn = mockFetch(() => new Response('service unavailable', { status: 503 }));
    const provider = new OllamaRerankProvider({ fetchFn });
    const candidates = [
      buildCandidate({ knowledgeId: 'k1', fusedScore: 0.3 }),
      buildCandidate({ knowledgeId: 'k2', fusedScore: 0.7 }),
    ];
    const result = await provider.rerank(buildInput(candidates));
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].knowledgeId, 'k2');
    assert.ok(!result.candidates[0].matchReasons.some((reason) => reason.startsWith('ollama-rerank:')));
  });

  it('delegates embed and rewriteQuery to the fallback', async () => {
    const provider = new OllamaRerankProvider({});
    const embedding = await provider.embed('hello world');
    assert.ok(Array.isArray(embedding) && embedding.length === 1536);
    assert.equal(await provider.rewriteQuery({ prompt: 'x', classified: {} as never }), undefined);
  });
});
