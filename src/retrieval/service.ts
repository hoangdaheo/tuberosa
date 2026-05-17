import type { Cache } from '../cache.js';
import type { AppConfig } from '../config.js';
import type { ModelProvider } from '../model/provider.js';
import type {
  ClassifiedQuery,
  ContextFit,
  ContextPack,
  ContextSearchInput,
  FeedbackInput,
  KnowledgeFeedbackSummary,
  KnowledgeSearchResult,
  QueryRewriteResult,
  RankedCandidate,
  SearchOptions,
} from '../types.js';
import { sha256, stableJson } from '../util/hash.js';
import { uniqueStrings } from '../util/text.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import type { KnowledgeStore } from '../storage/store.js';
import { assembleContextPack } from './context-pack.js';
import { classifyQuery } from './classifier.js';
import { RetrievalDebugBuilder, stripDebugTrace, timed } from './debug.js';
import { ContextFitEvaluator } from './context-fit.js';
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
    private readonly fitEvaluator: ContextFitEvaluator = new ContextFitEvaluator(),
  ) {}

  async searchContext(input: ContextSearchInput): Promise<ContextPack> {
    const normalized = normalizeSearchInput(redactSearchInput(input, this.safety));
    const totalStartedAt = Date.now();
    const classificationStartedAt = Date.now();
    const classified = classifyQuery(normalized);
    const classificationElapsedMs = Date.now() - classificationStartedAt;
    const rewriteStartedAt = Date.now();
    const rewrite = await this.models.rewriteQuery({ prompt: normalized.prompt, classified });
    const rewriteElapsedMs = Date.now() - rewriteStartedAt;
    const rewriteResult = applyQueryRewrite(classified, rewrite, this.safety);
    const fingerprint = fingerprintSearch(normalized, rewriteResult.classified, this.config, rewrite);
    const cacheKey = `context:${fingerprint}`;
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
    debug?.recordElapsed('classification', classificationElapsedMs);
    debug?.recordElapsed('rewrite', rewriteElapsedMs);
    debug?.recordQueryRewrite({
      originalLexicalQuery: classified.lexicalQuery,
      rewrite: rewriteResult.rewrite,
      addedExactTerms: rewriteResult.addedExactTerms,
    });

    const cached = await this.getCachedContextPack(cacheKey, normalized);
    if (cached) {
      return this.safety.sanitizeContextPack(cached);
    }

    const project = normalized.project ?? rewriteResult.classified.project;
    const queryId = await timed(
      'contextQuery',
      this.createContextQuery(normalized, rewriteResult.classified, fingerprint, project),
      debug,
    );
    const candidates = await this.findCandidates(normalized, rewriteResult.classified, project, debug);
    const rankedCandidates = await this.rankCandidates(normalized.prompt, candidates, rewriteResult.classified, project, debug);
    const fitStartedAt = Date.now();
    const fitEvaluation = this.fitEvaluator.evaluate({
      project,
      classified: rewriteResult.classified,
      candidates: rankedCandidates,
      rejectedKnowledgeIds: normalized.rejectedKnowledgeIds,
    });
    debug?.recordTiming('fit', fitStartedAt);
    debug?.recordStage('fit', fitEvaluation.candidates);
    const assemblyStartedAt = Date.now();
    const pack = this.buildContextPack({
      queryId,
      project,
      classified: rewriteResult.classified,
      candidates: fitEvaluation.candidates,
      contextFit: fitEvaluation.contextFit,
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
      graph: [] as KnowledgeSearchResult['graph'],
    };
    const seedKnowledgeIds = uniqueStrings([
      ...safeResults.metadata,
      ...safeResults.lexical,
      ...safeResults.memory,
      ...safeResults.vector,
    ].map((candidate) => candidate.knowledgeId));
    const graph = await timed(
      'graph',
      this.store.searchGraphRelations(classified, { ...options, seedKnowledgeIds }),
      debug,
    );
    safeResults.graph = this.safety.sanitizeSearchCandidates(graph);
    debug?.recordStage('metadata', safeResults.metadata);
    debug?.recordStage('lexical', safeResults.lexical);
    debug?.recordStage('memory', safeResults.memory);
    debug?.recordStage('vector', safeResults.vector);
    debug?.recordStage('graph', safeResults.graph);

    return safeResults;
  }

  private async rankCandidates(
    prompt: string,
    candidates: KnowledgeSearchResult,
    classified: ClassifiedQuery,
    project?: string,
    debug?: RetrievalDebugBuilder,
  ): Promise<RankedCandidate[]> {
    const fusionStartedAt = Date.now();
    const fused = fuseCandidates(
      [candidates.metadata, candidates.lexical, candidates.memory, candidates.vector, candidates.graph],
      classified,
    ).slice(0, RERANK_LIMIT);
    debug?.recordTiming('fusion', fusionStartedAt);
    debug?.recordStage('fusion', fused);

    const rerankResult = await timed(
      'rerank',
      this.models.rerank({ prompt, classified, candidates: fused }),
      debug,
    );
    debug?.recordProviderRerank({
      model: rerankResult.model,
      inputKnowledgeIds: fused.map((candidate) => candidate.knowledgeId),
      decisions: rerankResult.decisions,
    });
    const reranked = this.safety.sanitizeSearchCandidates(rerankResult.candidates);
    const feedbackAdjusted = await this.applyFeedbackSummaries(reranked, project ?? classified.project);
    debug?.recordStage('rerank', feedbackAdjusted);
    return feedbackAdjusted;
  }

  private async applyFeedbackSummaries(candidates: RankedCandidate[], project?: string): Promise<RankedCandidate[]> {
    const summaries = await this.store.getFeedbackSummaries(
      [...new Set(candidates.map((candidate) => candidate.knowledgeId))],
      { project },
    );

    return candidates
      .map((candidate) => applyFeedbackSummary(candidate, summaries.get(candidate.knowledgeId)))
      .sort((left, right) => right.finalScore - left.finalScore || left.rank - right.rank)
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }

  private buildContextPack(input: {
    queryId: string;
    project?: string;
    classified: ClassifiedQuery;
    candidates: RankedCandidate[];
    contextFit: ContextFit;
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
      contextFit: input.contextFit,
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

function fingerprintSearch(
  input: NormalizedContextSearchInput,
  classified: ClassifiedQuery,
  config: AppConfig,
  rewrite?: QueryRewriteResult,
): string {
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
    lexicalQuery: classified.lexicalQuery,
    exactTerms: classified.exactTerms,
    queryRewriteModel: rewrite?.model,
    rerankModel: config.openAiRerankModel,
  }));
}

function applyQueryRewrite(
  classified: ClassifiedQuery,
  rewrite: QueryRewriteResult | undefined,
  safety: KnowledgeSafetyService,
): { classified: ClassifiedQuery; addedExactTerms: string[]; rewrite?: QueryRewriteResult } {
  if (!rewrite?.lexicalQuery.trim()) {
    return { classified, addedExactTerms: [] };
  }

  const sanitizedRewriteQuery = safety.redactSecrets(rewrite.lexicalQuery);
  const sanitizedRewriteTerms = uniqueStrings((rewrite.exactTerms ?? [])
    .map((term) => safety.redactSecrets(term))
    .filter((term) => term.length <= 120));
  const exactTerms = uniqueStrings([...classified.exactTerms, ...sanitizedRewriteTerms]).slice(0, 48);
  const lexicalQuery = uniqueStrings([
    ...exactTerms,
    ...(sanitizedRewriteQuery.match(/[a-zA-Z0-9_./:-]{3,}/g) ?? []),
    ...(classified.lexicalQuery.match(/[a-zA-Z0-9_./:-]{3,}/g) ?? []),
  ]).slice(0, 64).join(' ');
  const addedExactTerms = exactTerms.filter((term) => !classified.exactTerms.includes(term));
  const sanitizedRewrite: QueryRewriteResult = {
    lexicalQuery,
    exactTerms: sanitizedRewriteTerms,
    reasons: (rewrite.reasons ?? []).map((reason) => safety.redactSecrets(reason)),
    model: rewrite.model,
  };

  return {
    classified: {
      ...classified,
      exactTerms,
      lexicalQuery,
      confidence: Math.min(0.98, classified.confidence + (addedExactTerms.length > 0 ? 0.06 : 0.03)),
    },
    addedExactTerms,
    rewrite: sanitizedRewrite,
  };
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

function applyFeedbackSummary(
  candidate: RankedCandidate,
  summary: KnowledgeFeedbackSummary | undefined,
): RankedCandidate {
  if (!summary) {
    return candidate;
  }

  const adjustment = feedbackScoreAdjustment(summary);
  const status = feedbackStatus(summary);
  const feedbackMetadata = {
    status,
    selectedCount: summary.selectedCount,
    rejectedCount: summary.rejectedCount,
    irrelevantCount: summary.irrelevantCount,
    staleCount: summary.staleCount,
    latestFeedbackType: summary.latestFeedbackType,
    latestFeedbackAt: summary.latestFeedbackAt,
    scoreAdjustment: adjustment,
  };

  return {
    ...candidate,
    finalScore: clampScore(candidate.finalScore + adjustment),
    matchReasons: [
      ...candidate.matchReasons,
      ...feedbackMatchReasons(summary, adjustment),
    ],
    metadata: {
      ...(candidate.metadata ?? {}),
      feedback: feedbackMetadata,
    },
  };
}

function feedbackScoreAdjustment(summary: KnowledgeFeedbackSummary): number {
  const selectedBoost = Math.min(0.1, summary.selectedCount * 0.04);
  const stalePenalty = Math.min(0.24, summary.staleCount * 0.2);
  const rejectionPenalty = Math.min(0.18, (summary.rejectedCount + summary.irrelevantCount) * 0.09);

  return roundFeedbackAdjustment(selectedBoost - stalePenalty - rejectionPenalty);
}

function feedbackStatus(summary: KnowledgeFeedbackSummary): string {
  if (summary.latestFeedbackType && summary.latestFeedbackType !== 'missing_context') {
    return summary.latestFeedbackType;
  }

  if (summary.staleCount > 0) {
    return 'stale';
  }

  if (summary.rejectedCount > 0) {
    return 'rejected';
  }

  if (summary.irrelevantCount > 0) {
    return 'irrelevant';
  }

  return 'selected';
}

function feedbackMatchReasons(summary: KnowledgeFeedbackSummary, adjustment: number): string[] {
  const reasons: string[] = [];

  if (summary.selectedCount > 0) {
    reasons.push(`feedback:selected:${summary.selectedCount}`);
  }
  if (summary.rejectedCount > 0) {
    reasons.push(`feedback:rejected:${summary.rejectedCount}`);
  }
  if (summary.irrelevantCount > 0) {
    reasons.push(`feedback:irrelevant:${summary.irrelevantCount}`);
  }
  if (summary.staleCount > 0) {
    reasons.push(`feedback:stale:${summary.staleCount}`);
  }
  if (adjustment !== 0) {
    reasons.push(`feedback adjustment:${adjustment > 0 ? '+' : ''}${adjustment.toFixed(3)}`);
  }

  return reasons;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundFeedbackAdjustment(value: number): number {
  return Math.round(value * 1000) / 1000;
}
