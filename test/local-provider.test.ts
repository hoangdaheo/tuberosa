import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalCrossEncoderProvider, toVector, type LocalCrossEncoderScorer, type LocalEmbedder } from '../src/model/local-provider.js';
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
    assert.equal(result.candidates[0]!.knowledgeId, 'k2', 'high local score should win even with low fused score');
    assert.ok(result.candidates[0]!.rerankScore > result.candidates[1]!.rerankScore);
    assert.ok(result.candidates[0]!.matchReasons!.some((reason) => reason.startsWith('local-rerank:')));
    assert.equal(result.model, 'onnx-community/bge-reranker-v2-m3-ONNX');
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
    assert.equal(result.candidates[0]!.knowledgeId, 'k1');
    assert.ok(result.candidates[0]!.rerankScore > 0);
  });

  it('falls back to hash rerank when no transformers package is available', async () => {
    const provider = new LocalCrossEncoderProvider({});
    const candidates = [
      buildCandidate({ knowledgeId: 'k1', fusedScore: 0.2 }),
      buildCandidate({ knowledgeId: 'k2', fusedScore: 0.6 }),
    ];
    const result = await provider.rerank(buildInput(candidates));
    assert.equal(result.candidates[0]!.knowledgeId, 'k2', 'hash rerank preserves fused-score ordering when no overlap');
  });

  it('embed and rewriteQuery delegate to the fallback', async () => {
    const provider = new LocalCrossEncoderProvider({});
    const embedding = await provider.embed('hello world');
    assert.ok(Array.isArray(embedding) && embedding.length === 384);
    assert.equal(await provider.rewriteQuery({ prompt: 'x', classified: {} as never }), undefined);
  });
});

describe('local embeddings', () => {
  it('uses the injected embedder for embed()', async () => {
    const embedder: LocalEmbedder = {
      async embed() {
        return [0.1, 0.2, 0.3];
      },
    };
    const provider = new LocalCrossEncoderProvider({ embedder, embeddingDimensions: 3 });
    const vector = await provider.embed('hello');
    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  });

  it('falls back to hash when the embedder throws', async () => {
    const embedder: LocalEmbedder = {
      async embed() {
        throw new Error('boom');
      },
    };
    const provider = new LocalCrossEncoderProvider({ embedder, embeddingDimensions: 384 });
    const vector = await provider.embed('hello');
    assert.equal(vector.length, 384); // hash fallback respects configured dims
  });

  it('falls back to hash when the embedder returns wrong dimensions', async () => {
    const embedder: LocalEmbedder = {
      async embed() {
        return [1, 2]; // 2 dims, expected 384
      },
    };
    const provider = new LocalCrossEncoderProvider({ embedder, embeddingDimensions: 384 });
    const vector = await provider.embed('hello');
    assert.equal(vector.length, 384);
  });

  it('falls back to hash when local models are disabled via env', async () => {
    const prev = process.env.TUBEROSA_DISABLE_LOCAL_MODELS;
    process.env.TUBEROSA_DISABLE_LOCAL_MODELS = 'true';
    try {
      const provider = new LocalCrossEncoderProvider({ embeddingDimensions: 384 });
      assert.equal(await provider.hasLocalEmbedder(), false);
      const vector = await provider.embed('hello');
      assert.equal(vector.length, 384);
    } finally {
      if (prev === undefined) delete process.env.TUBEROSA_DISABLE_LOCAL_MODELS;
      else process.env.TUBEROSA_DISABLE_LOCAL_MODELS = prev;
    }
  });

  it('reports hasLocalEmbedder() = true with an injected embedder', async () => {
    const embedder: LocalEmbedder = {
      async embed() {
        return [0.5];
      },
    };
    const provider = new LocalCrossEncoderProvider({ embedder });
    assert.equal(await provider.hasLocalEmbedder(), true);
  });

  it('toVector handles Tensor-style { data } output', () => {
    assert.deepEqual(toVector({ data: new Float32Array([0.5, 0.25]) }), [0.5, 0.25]);
  });

  it('toVector flattens one level of nested arrays', () => {
    assert.deepEqual(toVector([[0.1, 0.2]]), [0.1, 0.2]);
  });

  it('toVector throws on unknown shapes', () => {
    assert.throws(() => toVector('garbage'));
  });

  it('probeEmbeddingDimensions returns raw dims even when they mismatch the config', async () => {
    const embedder: LocalEmbedder = { async embed() { return [1, 2]; } };
    const provider = new LocalCrossEncoderProvider({ embedder, embeddingDimensions: 384 });
    assert.equal(await provider.probeEmbeddingDimensions(), 2);
  });

  it('probeEmbeddingDimensions returns null when the embedder is unavailable', async () => {
    const prev = process.env.TUBEROSA_DISABLE_LOCAL_MODELS;
    process.env.TUBEROSA_DISABLE_LOCAL_MODELS = 'true';
    try {
      const provider = new LocalCrossEncoderProvider({ embeddingDimensions: 384 });
      assert.equal(await provider.probeEmbeddingDimensions(), null);
    } finally {
      if (prev === undefined) delete process.env.TUBEROSA_DISABLE_LOCAL_MODELS;
      else process.env.TUBEROSA_DISABLE_LOCAL_MODELS = prev;
    }
  });

  it('latches after dimension mismatch: injected embedder called EXACTLY ONCE across two embed() calls', async () => {
    let callCount = 0;
    const embedder: LocalEmbedder = {
      async embed() {
        callCount += 1;
        return [1, 2]; // 2 dims, expected 384 → mismatch
      },
    };
    const provider = new LocalCrossEncoderProvider({ embedder, embeddingDimensions: 384 });
    const v1 = await provider.embed('first call');
    const v2 = await provider.embed('second call');
    // Both calls must still return valid hash fallback vectors
    assert.equal(v1.length, 384);
    assert.equal(v2.length, 384);
    // The real (wrong-dim) embedder must have been called exactly once
    assert.equal(callCount, 1, 'embedder should be latched after first dimension mismatch');
  });
});
