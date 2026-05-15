import type { Cache } from '../cache.js';
import type { AppConfig } from '../config.js';
import type { ModelProvider } from '../model/provider.js';
import type { ContextPack, ContextSearchInput, FeedbackInput, KnowledgeSearchResult } from '../types.js';
import { sha256, stableJson } from '../util/hash.js';
import type { KnowledgeStore } from '../storage/store.js';
import { assembleContextPack } from './context-pack.js';
import { classifyQuery } from './classifier.js';
import { fuseCandidates } from './fusion.js';

export class RetrievalService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly cache: Cache,
    private readonly models: ModelProvider,
    private readonly config: AppConfig,
  ) {}

  async searchContext(input: ContextSearchInput): Promise<ContextPack> {
    const normalized: ContextSearchInput = {
      ...input,
      tokenBudget: input.tokenBudget ?? 4000,
      rejectedKnowledgeIds: input.rejectedKnowledgeIds ?? [],
    };
    const fingerprint = sha256(stableJson({
      prompt: normalized.prompt,
      project: normalized.project,
      repoHint: normalized.repoHint,
      cwd: normalized.cwd,
      taskType: normalized.taskType,
      files: normalized.files ?? [],
      symbols: normalized.symbols ?? [],
      errors: normalized.errors ?? [],
      tokenBudget: normalized.tokenBudget,
      rejectedKnowledgeIds: normalized.rejectedKnowledgeIds,
    }));
    const cacheKey = `context:${fingerprint}`;

    if (!normalized.bypassCache) {
      const cached = await this.cache.getJson<ContextPack>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const classified = classifyQuery(normalized);
    const project = normalized.project ?? classified.project;
    const queryId = await this.store.createContextQuery({
      project,
      prompt: normalized.prompt,
      fingerprint,
      classified,
      tokenBudget: normalized.tokenBudget ?? 4000,
    });

    const embedding = await this.models.embed(`${classified.lexicalQuery}\n\n${normalized.prompt}`);
    const options = {
      project,
      limit: 18,
      rejectedKnowledgeIds: normalized.rejectedKnowledgeIds,
    };
    const candidates: KnowledgeSearchResult = {
      metadata: await this.store.searchMetadata(classified, options),
      lexical: await this.store.searchLexical(classified, options),
      vector: await this.store.searchVector(embedding, options),
      memory: await this.store.searchMemories(classified, options),
    };

    const fused = fuseCandidates(
      [candidates.metadata, candidates.lexical, candidates.memory, candidates.vector],
      classified,
    ).slice(0, 24);
    const reranked = await this.models.rerank(normalized.prompt, fused);
    const pack = assembleContextPack({
      queryId,
      project,
      prompt: normalized.prompt,
      classified,
      candidates: reranked,
      tokenBudget: normalized.tokenBudget ?? 4000,
      rejectedKnowledgeIds: normalized.rejectedKnowledgeIds,
    });

    await this.store.saveContextPack(pack);
    await this.cache.setJson(cacheKey, pack, this.config.contextCacheTtlSeconds);
    return pack;
  }

  async getContextPack(id: string): Promise<ContextPack | undefined> {
    return this.store.getContextPack(id);
  }

  async recordFeedback(input: FeedbackInput): Promise<{ retry?: ContextPack }> {
    await this.store.recordFeedback(input);

    if (input.feedbackType === 'rejected' || input.feedbackType === 'irrelevant' || input.feedbackType === 'stale') {
      const pack = input.contextPackId ? await this.store.getContextPack(input.contextPackId) : undefined;
      if (pack) {
        const rejectedKnowledgeIds = [
          ...new Set([
            ...pack.sections.flatMap((section) => section.items.map((item) => item.knowledgeId)),
            ...(input.rejectedKnowledgeIds ?? []),
          ]),
        ];
        const retry = await this.searchContext({
          prompt: pack.prompt,
          project: input.project ?? pack.project,
          tokenBudget: pack.sections.reduce((sum, section) => sum + section.tokenEstimate, 0) || 4000,
          rejectedKnowledgeIds,
          bypassCache: true,
        });
        return { retry };
      }
    }

    return {};
  }
}
