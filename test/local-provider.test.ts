import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalCrossEncoderProvider,
  TransformersScorer,
  toVector,
  type LocalCrossEncoderScorer,
  type LocalEmbedder,
  type RerankPipeline,
} from '../src/model/local-provider.js';
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

describe('TransformersScorer.score', () => {
  // Mirrors the real @xenova/transformers contract: the tokenizer accepts a
  // string[] as `text` and a string[] as `options.text_pair`. If any element of
  // `text` is not a string it explodes with "text.split is not a function" —
  // the exact failure the cross-encoder hit in production when fed pair-objects.
  function fakePipeline(logitsData: number[], dims: number[]): RerankPipeline & { tokenizerCalls: unknown[] } {
    const calls: unknown[] = [];
    return {
      tokenizerCalls: calls,
      tokenizer(text: unknown, options?: { text_pair?: unknown }) {
        calls.push({ text, options });
        const texts = Array.isArray(text) ? text : [text];
        for (const entry of texts) {
          if (typeof entry !== 'string') {
            throw new Error('text.split is not a function');
          }
        }
        const pairs = options?.text_pair;
        if (pairs !== undefined) {
          const pairArr = Array.isArray(pairs) ? pairs : [pairs];
          for (const entry of pairArr) {
            if (typeof entry !== 'string') throw new Error('text.split is not a function');
          }
        }
        return { input_ids: texts };
      },
      async model() {
        return { logits: { data: logitsData, dims } };
      },
    };
  }

  it('tokenizes query/passage pairs and maps logits to [0,1] scores via sigmoid', async () => {
    // bge-reranker-v2-m3 emits one logit per pair, shape [n, 1].
    const pipeline = fakePipeline([2.7016971, -11.024072], [2, 1]);
    const scorer = new TransformersScorer(pipeline);
    const scores = await scorer.score('how does the reranker work', [
      { knowledgeId: 'a', text: 'The reranker scores query-passage pairs.' },
      { knowledgeId: 'b', text: 'Unrelated text about cooking pasta.' },
    ]);

    assert.equal(scores.length, 2);
    assert.ok(scores[0]! > 0.9, `relevant pair should score high, got ${scores[0]}`);
    assert.ok(scores[1]! < 0.01, `irrelevant pair should score low, got ${scores[1]}`);

    // Regression: must NOT pass pair-objects ({text, text_pair}) as the first
    // tokenizer arg — that is what threw "text.split is not a function".
    const firstCall = pipeline.tokenizerCalls[0] as { text: unknown; options?: { text_pair?: unknown } };
    assert.ok(Array.isArray(firstCall.text), 'query should be passed as a string array');
    assert.ok((firstCall.text as unknown[]).every((t) => typeof t === 'string'), 'every query element must be a string');
    assert.ok(Array.isArray(firstCall.options?.text_pair), 'passages must be passed via options.text_pair');
  });

  it('returns an empty array for no candidates', async () => {
    const scorer = new TransformersScorer(fakePipeline([], [0, 1]));
    assert.deepEqual(await scorer.score('q', []), []);
  });

  it('handles two-logit (binary) classifier heads via softmax of the positive class', async () => {
    // Some rerankers emit [neg, pos] per pair, shape [n, 2].
    const pipeline = fakePipeline([0, 5, 5, 0], [2, 2]);
    const scorer = new TransformersScorer(pipeline);
    const scores = await scorer.score('q', [
      { knowledgeId: 'a', text: 'pos wins' },
      { knowledgeId: 'b', text: 'neg wins' },
    ]);
    assert.ok(scores[0]! > 0.9, `positive-class pair should score high, got ${scores[0]}`);
    assert.ok(scores[1]! < 0.1, `negative-class pair should score low, got ${scores[1]}`);
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
