import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalCrossEncoderProvider } from '../src/model/local-provider.js';
import { ModelProviderError } from '../src/errors.js';

test('strict mode throws instead of hashing when the embedder is unavailable', async () => {
  // No embedder injected + local models disabled => embedder is null.
  process.env.TUBEROSA_DISABLE_LOCAL_MODELS = 'true';
  const provider = new LocalCrossEncoderProvider({ strict: true, embeddingDimensions: 384 });
  await assert.rejects(() => provider.embed('hello'), ModelProviderError);
});

test('non-strict mode still falls back to hash embeddings', async () => {
  process.env.TUBEROSA_DISABLE_LOCAL_MODELS = 'true';
  const provider = new LocalCrossEncoderProvider({ strict: false, embeddingDimensions: 384 });
  const vector = await provider.embed('hello');
  assert.equal(vector.length, 384);
});

test('verifyReady reports both models false when disabled', async () => {
  process.env.TUBEROSA_DISABLE_LOCAL_MODELS = 'true';
  const provider = new LocalCrossEncoderProvider({ embeddingDimensions: 384 });
  const report = await provider.verifyReady();
  assert.deepEqual(report, { embedder: false, reranker: false, dims: null });
});

test('verifyReady reports true when scorer + embedder are injected', async () => {
  const provider = new LocalCrossEncoderProvider({
    embeddingDimensions: 3,
    embedder: { embed: async () => [0.1, 0.2, 0.3] },
    scorer: { score: async (_p, items) => items.map(() => 0.5) },
  });
  const report = await provider.verifyReady();
  assert.deepEqual(report, { embedder: true, reranker: true, dims: 3 });
});

test('strict rerank throws when the scorer is unavailable', async () => {
  process.env.TUBEROSA_DISABLE_LOCAL_MODELS = 'true';
  const provider = new LocalCrossEncoderProvider({ strict: true, embeddingDimensions: 384 });
  await assert.rejects(() => provider.rerank({
    prompt: 'q',
    classified: { project: 'p', taskType: 'unknown', confidence: 1, files: [], symbols: [], errors: [], technologies: [], businessAreas: [], exactTerms: [], lexicalQuery: 'q', intent: 'find' } as any,
    candidates: [{ knowledgeId: 'A', title: 'A', summary: 'A', content: 'A', contextualContent: 'A', fusedScore: 0.5, trustLevel: 50, rank: 1, finalScore: 0.5, rerankScore: 0.5, matchReasons: [], references: [], labels: [], itemType: 'wiki', project: 'p' } as any],
  }), ModelProviderError);
});

test('strict rerank with a working scorer still blends normally', async () => {
  const provider = new LocalCrossEncoderProvider({ strict: true, embeddingDimensions: 3, scorer: { score: async (_p, items) => items.map(() => 0.9) } });
  const result = await provider.rerank({
    prompt: 'q',
    classified: { project: 'p', taskType: 'unknown', confidence: 1, files: [], symbols: [], errors: [], technologies: [], businessAreas: [], exactTerms: [], lexicalQuery: 'q', intent: 'find' } as any,
    candidates: [{ knowledgeId: 'A', title: 'A', summary: 'A', content: 'A', contextualContent: 'A', fusedScore: 0.5, trustLevel: 50, rank: 1, finalScore: 0.5, rerankScore: 0.5, matchReasons: [], references: [], labels: [], itemType: 'wiki', project: 'p' } as any],
  });
  assert.equal(result.candidates.length, 1);
});
