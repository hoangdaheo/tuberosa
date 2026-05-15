import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { RankedCandidate } from '../types.js';
import { clamp } from '../util/text.js';

export interface ModelProvider {
  embed(text: string): Promise<number[]>;
  rerank(prompt: string, candidates: RankedCandidate[]): Promise<RankedCandidate[]>;
}

export function createModelProvider(config: AppConfig): ModelProvider {
  if (config.modelProvider === 'openai' && config.openAiApiKey) {
    return new OpenAiModelProvider(config);
  }

  return new HashModelProvider(config.embeddingDimensions);
}

export class HashModelProvider implements ModelProvider {
  constructor(private readonly dimensions: number) {}

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? [];

    for (const token of tokens) {
      const digest = createHash('sha256').update(token).digest();
      const index = digest.readUInt32BE(0) % this.dimensions;
      const sign = digest[4] % 2 === 0 ? 1 : -1;
      vector[index] += sign;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  }

  async rerank(prompt: string, candidates: RankedCandidate[]): Promise<RankedCandidate[]> {
    const promptTerms = new Set(prompt.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? []);

    return candidates
      .map((candidate) => {
        const candidateTerms = new Set(
          `${candidate.title} ${candidate.summary} ${candidate.contextualContent}`
            .toLowerCase()
            .match(/[a-z0-9_./:-]+/g) ?? [],
        );
        const overlap = [...promptTerms].filter((term) => candidateTerms.has(term)).length;
        const overlapScore = promptTerms.size ? overlap / promptTerms.size : 0;
        const trustScore = clamp(candidate.trustLevel / 100, 0, 1);
        const rerankScore = clamp(candidate.fusedScore * 0.62 + overlapScore * 0.28 + trustScore * 0.1, 0, 1);

        return {
          ...candidate,
          rerankScore,
          finalScore: rerankScore,
        };
      })
      .sort((left, right) => right.finalScore - left.finalScore);
  }
}

class OpenAiModelProvider implements ModelProvider {
  private readonly fallback: HashModelProvider;

  constructor(private readonly config: AppConfig) {
    this.fallback = new HashModelProvider(config.embeddingDimensions);
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.openAiEmbeddingModel,
        input: text,
        dimensions: this.config.embeddingDimensions,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI embedding request failed: ${response.status} ${detail}`);
    }

    const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = body.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error('OpenAI embedding response did not include an embedding.');
    }

    return embedding;
  }

  async rerank(prompt: string, candidates: RankedCandidate[]): Promise<RankedCandidate[]> {
    return this.fallback.rerank(prompt, candidates);
  }
}
