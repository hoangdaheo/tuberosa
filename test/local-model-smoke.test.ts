import test from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { LocalCrossEncoderProvider } from '../src/model/local-provider.js';
import type { RankedCandidate, RerankInput } from '../src/types.js';

/**
 * Live-model smoke eval for the local cross-encoder reranker.
 *
 * WHY THIS EXISTS: the deterministic eval harness (eval:retrieval, sandbox)
 * runs entirely on the HashModelProvider, so it CANNOT see the real
 * `@xenova/transformers` cross-encoder. That is exactly how the
 * `text.split is not a function` reranker bug (commit 08147db) hid for so long —
 * every hash eval stayed green while the real reranker threw on every query and
 * silently degraded to fused order. This test closes that gap: it drives the
 * REAL model and asserts it ranks a known-relevant passage above a known-
 * irrelevant one.
 *
 * It is OPT-IN by design — like the Docker-gated integration test. When the
 * model cannot load (offline, models not downloaded, or
 * TUBEROSA_DISABLE_LOCAL_MODELS=true as set by `pnpm test`), it SKIPS rather
 * than fails. Run it for real with `pnpm run eval:local-model` after
 * `npx tuberosa setup-models`.
 */

const REAL_MODEL_ID = 'onnx-community/bge-reranker-v2-m3-ONNX';

interface GoldenCase {
  name: string;
  prompt: string;
  relevant: string;
  irrelevant: string;
}

const GOLDEN_CASES: GoldenCase[] = [
  {
    name: 'reranker mechanics',
    prompt: 'How does the local cross-encoder reranker score query and passage pairs?',
    relevant:
      'The TransformersScorer drives the tokenizer with text_pair and runs the model to score each query-passage pair, mapping logits to a relevance score.',
    irrelevant: 'A recipe for cooking spaghetti with tomato sauce, garlic, and fresh basil leaves.',
  },
  {
    name: 'storage backend',
    prompt: 'Which Postgres extension does Tuberosa use for vector similarity search?',
    relevant:
      'Tuberosa stores embeddings in a pgvector column and runs approximate nearest-neighbour similarity search over them inside Postgres.',
    irrelevant: 'The weather forecast predicts light rain on Tuesday with a high of eighteen degrees.',
  },
  {
    name: 'secret redaction',
    prompt: 'How are secrets kept out of stored knowledge and embeddings?',
    relevant:
      'The knowledge-safety layer redacts secrets from content before storage and strips them from search prompts before embedding.',
    irrelevant: 'Mount Everest is the highest mountain above sea level, located in the Himalayas.',
  },
];

function buildCandidate(knowledgeId: string, content: string, fusedScore: number): RankedCandidate {
  return {
    knowledgeId,
    chunkId: `${knowledgeId}-chunk`,
    project: 'tuberosa',
    title: knowledgeId,
    summary: content.slice(0, 40),
    content,
    contextualContent: content,
    itemType: 'code_ref',
    source: 'lexical',
    rank: 1,
    rawScore: fusedScore,
    fusedScore,
    rerankScore: 0,
    finalScore: 0,
    trustLevel: 70,
    matchReasons: [],
    labels: [],
    references: [],
    metadata: {},
    tokenEstimate: 0,
  } as RankedCandidate;
}

function buildInput(prompt: string, candidates: RankedCandidate[]): RerankInput {
  return {
    prompt,
    candidates,
    classified: {
      project: 'tuberosa',
      taskType: 'exploration',
      files: [],
      symbols: [],
      errors: [],
      technologies: [],
      businessAreas: [],
      exactTerms: [],
      confidence: 0.6,
      lexicalQuery: prompt,
      intent: {
        taskGoal: prompt,
        workflowStage: 'exploration',
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

test('real local cross-encoder ranks relevant above irrelevant passages', async (t) => {
  const provider = new LocalCrossEncoderProvider({});
  const available = await provider.hasLocalReranker();
  if (!available) {
    t.skip(
      'local cross-encoder unavailable (offline, models not downloaded, or TUBEROSA_DISABLE_LOCAL_MODELS=true). '
        + 'Run `npx tuberosa setup-models` then `pnpm run eval:local-model`.',
    );
    return;
  }

  for (const golden of GOLDEN_CASES) {
    // Equal fused scores so ONLY the cross-encoder can decide the order. The
    // irrelevant candidate is listed first to prove ordering is not positional.
    const irrelevant = buildCandidate(`${golden.name}:irrelevant`, golden.irrelevant, 0.5);
    const relevant = buildCandidate(`${golden.name}:relevant`, golden.relevant, 0.5);
    const result = await provider.rerank(buildInput(golden.prompt, [irrelevant, relevant]));

    // 1. The REAL path ran — hash fallback returns no `model` field.
    equal(result.model, REAL_MODEL_ID, `[${golden.name}] expected real reranker, got fallback (model=${result.model})`);

    // 2. The cross-encoder discriminated: relevant's raw local score beats irrelevant's.
    const relevantOut = result.candidates.find((c) => c.knowledgeId === relevant.knowledgeId)!;
    const irrelevantOut = result.candidates.find((c) => c.knowledgeId === irrelevant.knowledgeId)!;
    const relevantLocal = (relevantOut.metadata as { localRerank?: { score: number } }).localRerank?.score ?? 0;
    const irrelevantLocal = (irrelevantOut.metadata as { localRerank?: { score: number } }).localRerank?.score ?? 0;
    ok(
      relevantLocal > irrelevantLocal,
      `[${golden.name}] cross-encoder local score should favour relevant: relevant=${relevantLocal} irrelevant=${irrelevantLocal}`,
    );

    // 3. Final order puts the relevant passage first.
    equal(
      result.candidates[0]!.knowledgeId,
      relevant.knowledgeId,
      `[${golden.name}] relevant passage should rank first`,
    );
  }
});
