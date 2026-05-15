import type { Cache } from '../cache.js';
import type { AppConfig } from '../config.js';
import type { ModelProvider } from '../model/provider.js';
import type {
  ClassifiedQuery,
  ContextPack,
  ContextSearchInput,
  FeedbackInput,
  KnowledgeSearchResult,
  RankedCandidate,
  SearchOptions,
} from '../types.js';
import { sha256, stableJson } from '../util/hash.js';
import type { KnowledgeStore } from '../storage/store.js';
import { assembleContextPack } from './context-pack.js';
import { classifyQuery } from './classifier.js';
import { fuseCandidates } from './fusion.js';

const DEFAULT_TOKEN_BUDGET = 4000;
const SEARCH_LIMIT = 18;
const RERANK_LIMIT = 24;
const RETRY_FEEDBACK_TYPES = new Set<FeedbackInput['feedbackType']>(['rejected', 'irrelevant', 'stale']);

type NormalizedContextSearchInput = ContextSearchInput & {
  tokenBudget: number;
  rejectedKnowledgeIds: string[];
};

export class RetrievalService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly cache: Cache,
    private readonly models: ModelProvider,
    private readonly config: AppConfig,
  ) {}

  async searchContext(input: ContextSearchInput): Promise<ContextPack> {
    const normalized = normalizeSearchInput(input);
    const fingerprint = fingerprintSearch(normalized);
    const cacheKey = `context:${fingerprint}`;

    const cached = await this.getCachedContextPack(cacheKey, normalized);
    if (cached) {
      return cached;
    }

    const classified = classifyQuery(normalized);
    const project = normalized.project ?? classified.project;
    const queryId = await this.createContextQuery(normalized, classified, fingerprint, project);
    const candidates = await this.findCandidates(normalized, classified, project);
    const rankedCandidates = await this.rankCandidates(normalized.prompt, candidates, classified);
    const pack = this.buildContextPack({
      queryId,
      project,
      classified,
      candidates: rankedCandidates,
      input: normalized,
    });

    await this.saveContextPack(cacheKey, pack);
    return pack;
  }

  async getContextPack(id: string): Promise<ContextPack | undefined> {
    return this.store.getContextPack(id);
  }

  async recordFeedback(input: FeedbackInput): Promise<{ retry?: ContextPack }> {
    await this.store.recordFeedback(input);

    if (!shouldRetry(input.feedbackType) || !input.contextPackId) {
      return {};
    }

    const pack = await this.store.getContextPack(input.contextPackId);
    if (!pack) {
      return {};
    }

    const retry = await this.searchContext(buildRetryInput(pack, input));
    return { retry };
  }

  private async getCachedContextPack(
    cacheKey: string,
    input: NormalizedContextSearchInput,
  ): Promise<ContextPack | undefined> {
    return input.bypassCache ? undefined : this.cache.getJson<ContextPack>(cacheKey);
  }

  private async createContextQuery(
    input: NormalizedContextSearchInput,
    classified: ClassifiedQuery,
    fingerprint: string,
    project?: string,
  ): Promise<string> {
    return this.store.createContextQuery({
      project,
      prompt: input.prompt,
      fingerprint,
      classified,
      tokenBudget: input.tokenBudget,
    });
  }

  private async findCandidates(
    input: NormalizedContextSearchInput,
    classified: ClassifiedQuery,
    project?: string,
  ): Promise<KnowledgeSearchResult> {
    const options: SearchOptions = {
      project,
      limit: SEARCH_LIMIT,
      rejectedKnowledgeIds: input.rejectedKnowledgeIds,
    };

    const vectorResults = this.models
      .embed(`${classified.lexicalQuery}\n\n${input.prompt}`)
      .then((embedding) => this.store.searchVector(embedding, options));

    const [metadata, lexical, memory, vector] = await Promise.all([
      this.store.searchMetadata(classified, options),
      this.store.searchLexical(classified, options),
      this.store.searchMemories(classified, options),
      vectorResults,
    ]);

    return { metadata, lexical, memory, vector };
  }

  private async rankCandidates(
    prompt: string,
    candidates: KnowledgeSearchResult,
    classified: ClassifiedQuery,
  ): Promise<RankedCandidate[]> {
    const fused = fuseCandidates(
      [candidates.metadata, candidates.lexical, candidates.memory, candidates.vector],
      classified,
    ).slice(0, RERANK_LIMIT);

    return this.models.rerank(prompt, fused);
  }

  private buildContextPack(input: {
    queryId: string;
    project?: string;
    classified: ClassifiedQuery;
    candidates: RankedCandidate[];
    input: NormalizedContextSearchInput;
  }): ContextPack {
    return assembleContextPack({
      queryId: input.queryId,
      project: input.project,
      prompt: input.input.prompt,
      classified: input.classified,
      candidates: input.candidates,
      tokenBudget: input.input.tokenBudget,
      rejectedKnowledgeIds: input.input.rejectedKnowledgeIds,
    });
  }

  private async saveContextPack(cacheKey: string, pack: ContextPack): Promise<void> {
    await this.store.saveContextPack(pack);
    await this.cache.setJson(cacheKey, pack, this.config.contextCacheTtlSeconds);
  }
}

function normalizeSearchInput(input: ContextSearchInput): NormalizedContextSearchInput {
  return {
    ...input,
    tokenBudget: input.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    rejectedKnowledgeIds: input.rejectedKnowledgeIds ?? [],
  };
}

function fingerprintSearch(input: NormalizedContextSearchInput): string {
  return sha256(stableJson({
    prompt: input.prompt,
    project: input.project,
    repoHint: input.repoHint,
    cwd: input.cwd,
    taskType: input.taskType,
    files: input.files ?? [],
    symbols: input.symbols ?? [],
    errors: input.errors ?? [],
    tokenBudget: input.tokenBudget,
    rejectedKnowledgeIds: input.rejectedKnowledgeIds,
  }));
}

function shouldRetry(feedbackType: FeedbackInput['feedbackType']): boolean {
  return RETRY_FEEDBACK_TYPES.has(feedbackType);
}

function buildRetryInput(pack: ContextPack, feedback: FeedbackInput): ContextSearchInput {
  return {
    prompt: pack.prompt,
    project: feedback.project ?? pack.project,
    tokenBudget: contextPackTokenBudget(pack),
    rejectedKnowledgeIds: rejectedKnowledgeIds(pack, feedback),
    bypassCache: true,
  };
}

function contextPackTokenBudget(pack: ContextPack): number {
  return pack.sections.reduce((sum, section) => sum + section.tokenEstimate, 0) || DEFAULT_TOKEN_BUDGET;
}

function rejectedKnowledgeIds(pack: ContextPack, feedback: FeedbackInput): string[] {
  return [
    ...new Set([
      ...pack.sections.flatMap((section) => section.items.map((item) => item.knowledgeId)),
      ...(feedback.rejectedKnowledgeIds ?? []),
    ]),
  ];
}
