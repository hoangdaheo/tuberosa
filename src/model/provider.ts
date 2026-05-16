import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { ModelProviderError } from '../errors.js';
import type { QueryRewriteInput, QueryRewriteResult, RankedCandidate } from '../types.js';
import { clamp, truncate } from '../util/text.js';

export interface ModelProvider {
  embed(text: string): Promise<number[]>;
  rewriteQuery(input: QueryRewriteInput): Promise<QueryRewriteResult | undefined>;
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

  async rewriteQuery(_input: QueryRewriteInput): Promise<QueryRewriteResult | undefined> {
    return undefined;
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
    const response = await fetchOpenAiEmbedding(this.config, text);

    if (!response.ok) {
      const detail = await response.text();
      throw new ModelProviderError(`OpenAI embedding request failed: ${response.status} ${detail}`);
    }

    const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = body.data?.[0]?.embedding;
    if (!embedding) {
      throw new ModelProviderError('OpenAI embedding response did not include an embedding.');
    }

    return embedding;
  }

  async rewriteQuery(input: QueryRewriteInput): Promise<QueryRewriteResult | undefined> {
    if (!this.config.openAiRewriteModel) {
      return undefined;
    }

    const response = await fetchOpenAiJson(this.config, this.config.openAiRewriteModel, {
      prompt: input.prompt,
      classified: {
        taskType: input.classified.taskType,
        files: input.classified.files,
        symbols: input.classified.symbols,
        errors: input.classified.errors,
        technologies: input.classified.technologies,
        businessAreas: input.classified.businessAreas,
        exactTerms: input.classified.exactTerms,
        lexicalQuery: input.classified.lexicalQuery,
      },
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new ModelProviderError(`OpenAI query rewrite request failed: ${response.status} ${detail}`);
    }

    return parseQueryRewriteResponse(await response.json(), this.config.openAiRewriteModel);
  }

  async rerank(prompt: string, candidates: RankedCandidate[]): Promise<RankedCandidate[]> {
    return this.fallback.rerank(prompt, candidates);
  }
}

async function fetchOpenAiEmbedding(config: AppConfig, text: string): Promise<Response> {
  try {
    return await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openAiEmbeddingModel,
        input: text,
        dimensions: config.embeddingDimensions,
      }),
    });
  } catch (error) {
    throw new ModelProviderError('OpenAI embedding request failed.', error);
  }
}

async function fetchOpenAiJson(config: AppConfig, model: string, input: unknown): Promise<Response> {
  try {
    return await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'system',
            content: [
              'Rewrite retrieval queries for a local project knowledge broker.',
              'Return compact JSON only.',
              'Preserve exact file paths, symbols, errors, technologies, and domain terms.',
              'Do not add facts that are not supported by the prompt or existing classification.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify(input),
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'query_rewrite',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                lexicalQuery: { type: 'string' },
                exactTerms: {
                  type: 'array',
                  items: { type: 'string' },
                  maxItems: 16,
                },
                reasons: {
                  type: 'array',
                  items: { type: 'string' },
                  maxItems: 6,
                },
              },
              required: ['lexicalQuery', 'exactTerms', 'reasons'],
            },
          },
        },
      }),
    });
  } catch (error) {
    throw new ModelProviderError('OpenAI query rewrite request failed.', error);
  }
}

function parseQueryRewriteResponse(body: unknown, model: string): QueryRewriteResult | undefined {
  const outputText = extractOutputText(body);
  if (!outputText) {
    throw new ModelProviderError('OpenAI query rewrite response did not include output text.');
  }

  const parsed = parseJsonObject(outputText);
  const lexicalQuery = typeof parsed.lexicalQuery === 'string' ? truncate(parsed.lexicalQuery, 600) : '';
  if (!lexicalQuery.trim()) {
    return undefined;
  }

  return {
    lexicalQuery,
    exactTerms: stringArray(parsed.exactTerms, 16),
    reasons: stringArray(parsed.reasons, 6),
    model,
  };
}

function extractOutputText(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  if (typeof body.output_text === 'string') {
    return body.output_text;
  }

  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === 'string') {
        return content.text;
      }
    }
  }

  return undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to the typed provider error below.
  }

  throw new ModelProviderError('OpenAI query rewrite response was not a JSON object.');
}

function stringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => truncate(item, 120).trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
