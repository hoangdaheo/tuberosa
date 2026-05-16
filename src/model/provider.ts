import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { ModelProviderError } from '../errors.js';
import type {
  QueryRewriteInput,
  QueryRewriteResult,
  RankedCandidate,
  RerankDecision,
  RerankInput,
  RerankResult,
} from '../types.js';
import { clamp, truncate } from '../util/text.js';

export interface ModelProvider {
  embed(text: string): Promise<number[]>;
  rewriteQuery(input: QueryRewriteInput): Promise<QueryRewriteResult | undefined>;
  rerank(input: RerankInput): Promise<RerankResult>;
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

  async rerank(input: RerankInput): Promise<RerankResult> {
    const promptTerms = new Set(input.prompt.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? []);

    const candidates = input.candidates
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

    return { candidates };
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

    const response = await fetchOpenAiJson(
      this.config,
      this.config.openAiRewriteModel,
      [
        'Rewrite retrieval queries for a local project knowledge broker.',
        'Return compact JSON only.',
        'Preserve exact file paths, symbols, errors, technologies, and domain terms.',
        'Do not add facts that are not supported by the prompt or existing classification.',
      ].join(' '),
      'query_rewrite',
      queryRewriteSchema(),
      {
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
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new ModelProviderError(`OpenAI query rewrite request failed: ${response.status} ${detail}`);
    }

    return parseQueryRewriteResponse(await response.json(), this.config.openAiRewriteModel);
  }

  async rerank(input: RerankInput): Promise<RerankResult> {
    if (!this.config.openAiRerankModel || input.candidates.length === 0) {
      return this.fallback.rerank(input);
    }

    const response = await fetchOpenAiJson(
      this.config,
      this.config.openAiRerankModel,
      [
        'Rerank candidate knowledge for a coding agent.',
        'Prefer candidates with concrete evidence for the task files, symbols, errors, workflow stage, and project.',
        'Penalize generic semantic matches, stale-looking context, and candidates that do not answer the user task.',
        'Return JSON only with one score from 0 to 1 for each useful candidate.',
      ].join(' '),
      'candidate_rerank',
      rerankSchema(input.candidates.length),
      {
        prompt: input.prompt,
        classified: {
          taskType: input.classified.taskType,
          project: input.classified.project,
          files: input.classified.files,
          symbols: input.classified.symbols,
          errors: input.classified.errors,
          technologies: input.classified.technologies,
          businessAreas: input.classified.businessAreas,
          exactTerms: input.classified.exactTerms,
        },
        candidates: input.candidates.map(toRerankPayload),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new ModelProviderError(`OpenAI rerank request failed: ${response.status} ${detail}`);
    }

    const decisions = parseRerankResponse(await response.json());
    return applyProviderRerank(input, decisions, this.config.openAiRerankModel, this.fallback);
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

async function fetchOpenAiJson(
  config: AppConfig,
  model: string,
  systemPrompt: string,
  schemaName: string,
  schema: Record<string, unknown>,
  input: unknown,
): Promise<Response> {
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
            content: systemPrompt,
          },
          {
            role: 'user',
            content: JSON.stringify(input),
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: schemaName,
            strict: true,
            schema,
          },
        },
      }),
    });
  } catch (error) {
    throw new ModelProviderError('OpenAI Responses request failed.', error);
  }
}

function queryRewriteSchema(): Record<string, unknown> {
  return {
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
  };
}

function rerankSchema(candidateCount: number): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      rankings: {
        type: 'array',
        maxItems: Math.min(candidateCount, 24),
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            knowledgeId: { type: 'string' },
            score: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' },
          },
          required: ['knowledgeId', 'score', 'reason'],
        },
      },
    },
    required: ['rankings'],
  };
}

function parseQueryRewriteResponse(body: unknown, model: string): QueryRewriteResult | undefined {
  const outputText = extractOutputText(body);
  if (!outputText) {
    throw new ModelProviderError('OpenAI query rewrite response did not include output text.');
  }

  const parsed = parseJsonObject(outputText, 'OpenAI query rewrite response');
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

function parseRerankResponse(body: unknown): RerankDecision[] {
  const outputText = extractOutputText(body);
  if (!outputText) {
    throw new ModelProviderError('OpenAI rerank response did not include output text.');
  }

  const parsed = parseJsonObject(outputText, 'OpenAI rerank response');
  const rankings = Array.isArray(parsed.rankings) ? parsed.rankings : [];

  return rankings
    .filter(isRecord)
    .map((item) => ({
      knowledgeId: typeof item.knowledgeId === 'string' ? item.knowledgeId : '',
      score: typeof item.score === 'number' ? clamp(item.score, 0, 1) : Number.NaN,
      reason: typeof item.reason === 'string' ? truncate(item.reason, 160).trim() : undefined,
    }))
    .filter((item) => item.knowledgeId && Number.isFinite(item.score));
}

async function applyProviderRerank(
  input: RerankInput,
  decisions: RerankDecision[],
  model: string,
  fallback: HashModelProvider,
): Promise<RerankResult> {
  if (decisions.length === 0) {
    return fallback.rerank(input);
  }

  const fallbackResult = await fallback.rerank(input);
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.knowledgeId, candidate]));
  const usedIds = new Set<string>();
  const providerRanked = decisions.flatMap((decision) => {
    const candidate = candidateById.get(decision.knowledgeId);
    if (!candidate || usedIds.has(candidate.knowledgeId)) {
      return [];
    }

    usedIds.add(candidate.knowledgeId);
    const trustScore = clamp(candidate.trustLevel / 100, 0, 1);
    const rerankScore = clamp(decision.score * 0.74 + candidate.fusedScore * 0.18 + trustScore * 0.08, 0, 1);
    const reason = decision.reason ? `provider rerank: ${decision.reason}` : 'provider rerank';

    return [{
      ...candidate,
      rerankScore,
      finalScore: rerankScore,
      matchReasons: [...candidate.matchReasons, reason],
      metadata: {
        ...(candidate.metadata ?? {}),
        providerRerank: {
          model,
          score: decision.score,
          reason: decision.reason,
        },
      },
    }];
  });

  const fallbackOnly = fallbackResult.candidates
    .filter((candidate) => !usedIds.has(candidate.knowledgeId))
    .map((candidate) => ({
      ...candidate,
      rerankScore: clamp(candidate.rerankScore * 0.78, 0, 1),
      finalScore: clamp(candidate.finalScore * 0.78, 0, 1),
    }));

  const candidates = [...providerRanked, ...fallbackOnly]
    .sort((left, right) => right.finalScore - left.finalScore || left.rank - right.rank)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  return {
    candidates,
    decisions: decisions.filter((decision) => candidateById.has(decision.knowledgeId)),
    model,
  };
}

function toRerankPayload(candidate: RankedCandidate): Record<string, unknown> {
  return {
    knowledgeId: candidate.knowledgeId,
    title: truncate(candidate.title, 160),
    summary: truncate(candidate.summary, 320),
    itemType: candidate.itemType,
    project: candidate.project,
    source: candidate.source,
    fusedScore: roundScore(candidate.fusedScore),
    trustLevel: candidate.trustLevel,
    matchReasons: candidate.matchReasons.slice(0, 10),
    labels: candidate.labels.slice(0, 16).map((label) => `${label.type}:${label.value}`),
    references: candidate.references.slice(0, 10).map((reference) => reference.uri),
    content: truncate(candidate.contextualContent || candidate.content, 900),
  };
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
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

function parseJsonObject(value: string, description: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to the typed provider error below.
  }

  throw new ModelProviderError(`${description} was not a JSON object.`);
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
