import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalCrossEncoderProvider } from '../src/model/local-provider.js';
import type { RankedCandidate } from '../src/types.js';

function candidate(id: string, fusedScore: number, trustLevel: number, rank: number): RankedCandidate {
  return {
    knowledgeId: id, title: id, summary: id, content: id, contextualContent: id,
    fusedScore, trustLevel, rank, finalScore: fusedScore, rerankScore: fusedScore,
    matchReasons: [], references: [], labels: [], itemType: 'wiki', project: 'p',
  } as unknown as RankedCandidate;
}

test('blend = 0.70*model + 0.22*fused + 0.08*trust controls the order', async () => {
  // A has weak fused/trust but strong model score; B is the reverse.
  const scorer = {
    score: async (_p: string, items: Array<{ knowledgeId: string }>) =>
      items.map((it) => (it.knowledgeId === 'A' ? 1 : 0)),
  };
  const provider = new LocalCrossEncoderProvider({ scorer, embeddingDimensions: 384 });
  const result = await provider.rerank({
    prompt: 'q',
    classified: { project: 'p', taskType: 'unknown', confidence: 1, files: [], symbols: [], errors: [], technologies: [], businessAreas: [], exactTerms: [], lexicalQuery: 'q', intent: { taskGoal: '', workflowStage: 'unknown', impliedFiles: [], impliedSymbols: [], impliedDomains: [], recentSessionReferences: [], requiredEvidenceTypes: [], uncertaintyReasons: [] } },
    candidates: [candidate('B', 0.6, 50, 1), candidate('A', 0.2, 10, 2)],
  });
  // A: 0.70*1 + 0.22*0.2 + 0.08*0.1 = 0.752 ; B: 0.70*0 + 0.22*0.6 + 0.08*0.5 = 0.172
  assert.equal(result.candidates[0]!.knowledgeId, 'A');
  assert.ok(Math.abs(result.candidates[0]!.finalScore - 0.752) < 1e-9);
});

test('a model-blind blend (degenerate weights) would reorder — guards the recipe', async () => {
  // Same inputs, but if the model score were ignored, B (higher fused) would win.
  // This documents that the model term is load-bearing for the ordering above.
  const scorer = { score: async (_p: string, items: Array<{ knowledgeId: string }>) => items.map(() => 0) };
  const provider = new LocalCrossEncoderProvider({ scorer, embeddingDimensions: 384 });
  const result = await provider.rerank({
    prompt: 'q',
    classified: { project: 'p', taskType: 'unknown', confidence: 1, files: [], symbols: [], errors: [], technologies: [], businessAreas: [], exactTerms: [], lexicalQuery: 'q', intent: { taskGoal: '', workflowStage: 'unknown', impliedFiles: [], impliedSymbols: [], impliedDomains: [], recentSessionReferences: [], requiredEvidenceTypes: [], uncertaintyReasons: [] } },
    candidates: [candidate('B', 0.6, 50, 1), candidate('A', 0.2, 10, 2)],
  });
  assert.equal(result.candidates[0]!.knowledgeId, 'B');
});
