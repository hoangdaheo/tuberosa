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
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import type { KnowledgeStore } from '../storage/store.js';
import { assembleContextPack } from './context-pack.js';
import { classifyQuery } from './classifier.js';
import { RetrievalDebugBuilder, stripDebugTrace, timed } from './debug.js';
import { fuseCandidates } from './fusion.js';

const DEFAULT_TOKEN_BUDGET = 4000;
const SEARCH_LIMIT = 18;
const RERANK_LIMIT = 24;
const RETRY_FEEDBACK_TYPES = new Set<FeedbackInput['feedbackType']>(['rejected', 'irrelevant', 'stale']);

type NormalizedContextSearchInput = ContextSearchInput & {
  tokenBudget: number;
  rejectedKnowledgeIds: string[];
  debug: boolean;
};

export class RetrievalService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly cache: Cache,
    private readonly models: ModelProvider,
    private readonly config: AppConfig,
    private readonly safety: KnowledgeSafetyService = new KnowledgeSafetyService(),
  ) {}

  async searchContext(input: ContextSearchInput): Promise<ContextPack> {
    const normalized = normalizeSearchInput(redactSearchInput(input, this.safety));
    const fingerprint = fingerprintSearch(normalized);
    const cacheKey = `context:${fingerprint}`;
    const totalStartedAt = Date.now();
    const debug = normalized.debug
      ? new RetrievalDebugBuilder({
        fingerprint,
        cacheKey,
        cacheHit: false,
        cacheBypassed: true,
        searchLimit: SEARCH_LIMIT,
        rerankLimit: RERANK_LIMIT,
        tokenBudget: normalized.tokenBudget,
        rejectedKnowledgeIds: normalized.rejectedKnowledgeIds,
      })
      : undefined;

    const cached = await this.getCachedContextPack(cacheKey, normalized);
    if (cached) {
      return this.safety.sanitizeContextPack(cached);
    }

    const classificationStartedAt = Date.now();
    const classified = classifyQuery(normalized);
    debug?.recordTiming('classification', classificationStartedAt);

    const project = normalized.project ?? classified.project;
    const queryId = await timed(
      'contextQuery',
      this.createContextQuery(normalized, classified, fingerprint, project),
      debug,
    );
    const candidates = await this.findCandidates(normalized, classified, project, debug);
    const rankedCandidates = await this.rankCandidates(normalized.prompt, candidates, classified, debug);
    const assemblyStartedAt = Date.now();
    const pack = this.buildContextPack({
      queryId,
      project,
      classified,
      candidates: rankedCandidates,
      input: normalized,
    });
    debug?.recordTiming('assembly', assemblyStartedAt);
    await this.saveContextPack(cacheKey, pack, debug);
    debug?.recordTiming('total', totalStartedAt);

    if (debug) {
      pack.debug = debug.buildTrace(pack);
    }

    return pack;
  }

  async getContextPack(id: string): Promise<ContextPack | undefined> {
    const pack = await this.store.getContextPack(id);
    return pack ? this.safety.sanitizeContextPack(pack) : undefined;
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
    return input.bypassCache || input.debug ? undefined : this.cache.getJson<ContextPack>(cacheKey);
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
    debug?: RetrievalDebugBuilder,
  ): Promise<KnowledgeSearchResult> {
    const options: SearchOptions = {
      project,
      limit: SEARCH_LIMIT,
      rejectedKnowledgeIds: input.rejectedKnowledgeIds,
    };

    const embedding = timed(
      'embedding',
      this.models.embed(`${classified.lexicalQuery}\n\n${input.prompt}`),
      debug,
    );
    const vectorResults = embedding
      .then((embedding) => timed('vector', this.store.searchVector(embedding, options), debug));

    const [metadata, lexical, memory, vector] = await Promise.all([
      timed('metadata', this.store.searchMetadata(classified, options), debug),
      timed('lexical', this.store.searchLexical(classified, options), debug),
      timed('memory', this.store.searchMemories(classified, options), debug),
      vectorResults,
    ]);
    const safeResults = {
      metadata: this.safety.sanitizeSearchCandidates(metadata),
      lexical: this.safety.sanitizeSearchCandidates(lexical),
      memory: this.safety.sanitizeSearchCandidates(memory),
      vector: this.safety.sanitizeSearchCandidates(vector),
    };
    debug?.recordStage('metadata', safeResults.metadata);
    debug?.recordStage('lexical', safeResults.lexical);
    debug?.recordStage('memory', safeResults.memory);
    debug?.recordStage('vector', safeResults.vector);

    return safeResults;
  }

  private async rankCandidates(
    prompt: string,
    candidates: KnowledgeSearchResult,
    classified: ClassifiedQuery,
    debug?: RetrievalDebugBuilder,
  ): Promise<RankedCandidate[]> {
    const fusionStartedAt = Date.now();
    const fused = fuseCandidates(
      [candidates.metadata, candidates.lexical, candidates.memory, candidates.vector],
      classified,
    ).slice(0, RERANK_LIMIT);
    debug?.recordTiming('fusion', fusionStartedAt);
    debug?.recordStage('fusion', fused);

    const reranked = this.safety.sanitizeSearchCandidates(await timed('rerank', this.models.rerank(prompt, fused), debug));
    debug?.recordStage('rerank', reranked);
    return reranked;
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

  private async saveContextPack(
    cacheKey: string,
    pack: ContextPack,
    debug?: RetrievalDebugBuilder,
  ): Promise<void> {
    const compactPack = stripDebugTrace(pack);
    await timed(
      'save',
      saveCompactContextPack(this.store, this.cache, cacheKey, compactPack, this.config.contextCacheTtlSeconds),
      debug,
    );
  }
}

async function saveCompactContextPack(
  store: KnowledgeStore,
  cache: Cache,
  cacheKey: string,
  pack: ContextPack,
  ttlSeconds: number,
): Promise<void> {
  await store.saveContextPack(pack);
  await cache.setJson(cacheKey, pack, ttlSeconds);
}

function redactSearchInput(input: ContextSearchInput, safety: KnowledgeSafetyService): ContextSearchInput {
  return {
    ...input,
    prompt: safety.redactSecrets(input.prompt),
    errors: input.errors?.map((error) => safety.redactSecrets(error)),
  };
}

function normalizeSearchInput(input: ContextSearchInput): NormalizedContextSearchInput {
  return {
    ...input,
    tokenBudget: input.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    rejectedKnowledgeIds: input.rejectedKnowledgeIds ?? [],
    debug: input.debug ?? false,
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
