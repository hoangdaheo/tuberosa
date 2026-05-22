import type { Cache } from '../cache.js';
import type { AppConfig } from '../config.js';
import type { ModelProvider } from '../model/provider.js';
import type {
  AgentContextDecision,
  AgentSession,
  ClassifiedQuery,
  ContextFit,
  ContextPack,
  ContextReviewTarget,
  ContextSearchInput,
  DeepContext,
  DeepContextItem,
  DeepContextSection,
  FeedbackEvent,
  FeedbackInput,
  KnowledgeChunkRecord,
  KnowledgeFeedbackSummary,
  KnowledgeGap,
  LearningProposalType,
  LearningProposal,
  KnowledgeRelation,
  KnowledgeSearchResult,
  QueryRewriteResult,
  RetrievalEvidenceType,
  ReflectionDraft,
  RankedCandidate,
  CandidateSource,
  SearchCandidate,
  SearchOptions,
  StoredKnowledge,
  SuppressionEvent,
  SuppressionReason,
  TaskBriefMode,
  LabelInput,
} from '../types.js';
import { sha256, stableJson } from '../util/hash.js';
import { clamp, metadataString, normalizeLabel, sameSignals, truncate, uniqueStrings } from '../util/text.js';
import { candidateText } from './candidate-helpers.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import type { KnowledgeStore } from '../storage/store.js';
import {
  assembleContextPack,
  DEFAULT_DEEP_CONTEXT_BUDGET,
  DEFAULT_USEFULNESS_CAPS,
  normalizeDeepContextBudget,
  UNCAPPED_USEFULNESS_CAPS,
  type UsefulnessCaps,
} from './context-pack.js';
import { classifyQuery, hasDomainMismatch } from './classifier.js';
import { RetrievalDebugBuilder, stripDebugTrace, timed } from './debug.js';
import { ContextFitEvaluator, type ContextFitSignal } from './context-fit.js';
import { fuseCandidates } from './fusion.js';
import { freshnessWindowFor, getRetrievalPolicy, getRetrievalPolicyFingerprint } from './policy.js';
import type { QueryRewriteConfig } from './policy.js';
import { WorktreeProvider, type WorktreeSearchResult } from './worktree.js';
import {
  namespaceMatchesFilter,
  readNamespaceFromMetadata,
} from '../storage/knowledge-namespace.js';

const DEFAULT_TOKEN_BUDGET = 4000;
const SEARCH_LIMIT = 18;
const RERANK_LIMIT = 24;
const REVIEW_TARGET_LIMIT = 12;
const REVIEW_QUEUE_STATUS_LIMIT = 24;
const CONTINUATION_SESSION_LIMIT = 6;
const CONTINUATION_FILE_LIMIT = 8;
const CONTINUATION_SYMBOL_LIMIT = 8;
const CONTINUATION_ERROR_LIMIT = 6;
const RETRY_FEEDBACK_TYPES = new Set<FeedbackInput['feedbackType']>(['rejected', 'irrelevant', 'stale']);
const MISSING_CONTEXT_FEEDBACK_TYPES = new Set<FeedbackInput['feedbackType']>([
  'missing_context',
  'missing_orientation',
  'missing_current_handoff',
  'missing_verification_commands',
]);
const PROPOSAL_FEEDBACK_TYPES = new Set<FeedbackInput['feedbackType']>([
  'rejected',
  'irrelevant',
  'stale',
  'too_much_adjacent_context',
]);

type NormalizedContextSearchInput = ContextSearchInput & {
  tokenBudget: number;
  contextMode: 'compact' | 'layered';
  noiseTolerance: 'balanced' | 'strict';
  deepContextBudget: number;
  rejectedKnowledgeIds: string[];
  debug: boolean;
};

export class RetrievalService {
  private readonly worktreeProvider: WorktreeProvider;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly cache: Cache,
    private readonly models: ModelProvider,
    private readonly config: AppConfig,
    private readonly safety: KnowledgeSafetyService = new KnowledgeSafetyService(),
    private readonly fitEvaluator: ContextFitEvaluator = new ContextFitEvaluator(),
    worktreeProvider?: WorktreeProvider,
  ) {
    this.worktreeProvider = worktreeProvider
      ?? new WorktreeProvider(
        {
          enabled: config.worktreeEnabled,
          maxFiles: config.worktreeMaxFiles,
          maxMtimeAgeHours: config.worktreeMaxMtimeAgeHours,
          maxIngestContentBytes: config.maxIngestContentBytes,
        },
        safety,
      );
  }

  async searchContext(input: ContextSearchInput): Promise<ContextPack> {
    const normalized = await this.addContinuationProvenance(
      normalizeSearchInput(redactSearchInput(input, this.safety), this.config),
    );
    const totalStartedAt = Date.now();
    const classificationStartedAt = Date.now();
    const classified = classifyQuery(normalized);
    const classificationElapsedMs = Date.now() - classificationStartedAt;
    // Phase 7 — gated query rewrite. Run a fast lexical+vector probe pass to
    // gauge baseline retrieval confidence; if the strongest rawScore across
    // lexical/vector top-K clears the policy threshold, skip
    // `models.rewriteQuery` entirely. The 2026 Dell production paper showed
    // unconditional rewrite costs latency for near-zero gain post-reranker.
    // When rewrite does fire, request the diverse-angle variant
    // (task-perspective rewrites populate exactTerms for OR-style FTS expansion).
    //
    // Performance: the embedding computed for the probe vector pass is reused
    // by `findCandidates` so gated searches still embed only once. This keeps
    // probe overhead bounded to one extra lexical + vector store lookup with a
    // small `probeSearchLimit` cap.
    const rewriteConfig = getRetrievalPolicy().queryRewrite;
    const probeProject = normalized.project ?? classified.project;
    let probeConfidence: number | undefined;
    let probeElapsedMs = 0;
    let rewriteSkippedReason: 'probe_confident' | undefined;
    let probeEmbedding: number[] | undefined;
    if (rewriteConfig.gated) {
      const probeStartedAt = Date.now();
      const probeResult = await this.computeRewriteProbeConfidence(
        normalized,
        classified,
        probeProject,
        rewriteConfig,
      );
      probeConfidence = probeResult.confidence;
      probeEmbedding = probeResult.embedding;
      probeElapsedMs = Date.now() - probeStartedAt;
      if (probeConfidence >= rewriteConfig.probeConfidenceThreshold) {
        rewriteSkippedReason = 'probe_confident';
      }
    }
    const rewriteStartedAt = Date.now();
    const rewrite = rewriteSkippedReason
      ? undefined
      : await this.models.rewriteQuery({
        prompt: normalized.prompt,
        classified,
        mode: rewriteConfig.gated ? 'diverse_angle' : 'paraphrase',
      });
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
    if (probeElapsedMs > 0) {
      debug?.recordElapsed('rewriteProbe', probeElapsedMs);
    }
    debug?.recordElapsed('rewrite', rewriteElapsedMs);
    debug?.recordQueryRewrite({
      originalLexicalQuery: classified.lexicalQuery,
      rewrite: rewriteResult.rewrite,
      addedExactTerms: rewriteResult.addedExactTerms,
      gated: rewriteConfig.gated,
      probeConfidence,
      probeThreshold: rewriteConfig.gated ? rewriteConfig.probeConfidenceThreshold : undefined,
      skipped: rewriteSkippedReason,
    });

    const shouldResolveReviewTargets = shouldResolveReviewTargetsFor(rewriteResult.classified);
    const cached = shouldResolveReviewTargets
      ? undefined
      : await this.getCachedContextPack(cacheKey, normalized);
    if (cached) {
      return this.safety.sanitizeContextPack(cached);
    }

    const project = normalized.project ?? rewriteResult.classified.project;
    const queryId = await timed(
      'contextQuery',
      this.createContextQuery(normalized, rewriteResult.classified, fingerprint, project),
      debug,
    );
    const { candidates, worktree: worktreeResult } = await this.findCandidates(
      normalized,
      rewriteResult.classified,
      project,
      debug,
      // Phase 7 — Reuse the probe's embedding to avoid a second embed call when
      // the rewrite didn't change the lexicalQuery. If applyQueryRewrite added
      // new exactTerms, the lexicalQuery is different and the embedding must be
      // recomputed; otherwise the probe embedding is identical.
      rewriteResult.addedExactTerms.length === 0 ? probeEmbedding : undefined,
    );
    const rankingResult = await this.rankCandidates(
      normalized.prompt,
      candidates,
      rewriteResult.classified,
      project,
      debug,
      normalized.disabledSources,
    );
    const rankedCandidates = rankingResult.candidates;
    const fitStartedAt = Date.now();
    const fitEvaluation = this.fitEvaluator.evaluate({
      project,
      classified: rewriteResult.classified,
      candidates: rankedCandidates,
      rejectedKnowledgeIds: normalized.rejectedKnowledgeIds,
      signal: { ...rankingResult.signal, worktreeMatchScore: worktreeResult.matchScore },
    });
    const contextFit = applyNoiseTolerance(
      fitEvaluation.contextFit,
      rewriteResult.classified,
      fitEvaluation.candidates,
      normalized.noiseTolerance,
    );
    debug?.recordTiming('fit', fitStartedAt);
    debug?.recordStage('fit', fitEvaluation.candidates);
    debug?.recordFitScores(fitEvaluation.candidates);
    const reviewTargetResolution = shouldResolveReviewTargets
      ? await this.resolveReviewTargets(normalized, rewriteResult.classified, project)
      : { reviewTargets: [] as ContextReviewTarget[], omittedReviewTargetCount: 0 };
    const assemblyStartedAt = Date.now();
    const pack = this.buildContextPack({
      queryId,
      project,
      classified: rewriteResult.classified,
      candidates: fitEvaluation.candidates,
      contextFit,
      input: normalized,
      reviewTargets: reviewTargetResolution.reviewTargets,
      omittedReviewTargetCount: reviewTargetResolution.omittedReviewTargetCount,
    });
    if (normalized.contextMode === 'layered') {
      pack.deepContext = await this.buildDeepContext(pack, normalized.deepContextBudget);
    }
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

  async recordFeedback(input: FeedbackInput): Promise<{ feedback: FeedbackEvent; retry?: ContextPack }> {
    const feedback = await this.store.recordFeedback(input);
    const pack = input.contextPackId ? await this.store.getContextPack(input.contextPackId) : undefined;
    await this.recordFeedbackLearning(input, feedback, pack);

    if (!shouldRetry(input.feedbackType) || !input.contextPackId || !pack) {
      return { feedback };
    }

    const retry = await this.searchContext(buildRetryInput(pack, input));
    return { feedback, retry };
  }

  private async recordFeedbackLearning(
    input: FeedbackInput,
    feedback: FeedbackEvent,
    pack: ContextPack | undefined,
  ): Promise<void> {
    const project = input.project ?? pack?.project;
    const sourceSessionId = metadataUuidString(input.metadata, 'agentSessionId');

    if (MISSING_CONTEXT_FEEDBACK_TYPES.has(input.feedbackType)) {
      await this.store.createKnowledgeGap({
        project,
        sourceFeedbackId: feedback.id,
        sourceSessionId,
        contextPackId: input.contextPackId,
        prompt: pack?.prompt ?? metadataString(input.metadata, 'prompt') ?? input.reason ?? `${input.feedbackType} feedback`,
        classified: pack?.classified,
        missingSignals: feedbackMissingSignals(input, pack),
        reason: input.reason,
        metadata: {
          source: 'feedback',
          feedbackType: input.feedbackType,
        },
      });
      return;
    }

    if (!PROPOSAL_FEEDBACK_TYPES.has(input.feedbackType)) {
      return;
    }

    const affectedKnowledgeIds = feedbackAffectedKnowledgeIds(input, pack);
    for (const affectedKnowledgeId of affectedKnowledgeIds) {
      await this.store.createLearningProposal({
        project,
        proposalType: proposalTypeForFeedback(input.feedbackType),
        sourceFeedbackId: feedback.id,
        sourceSessionId,
        contextPackId: input.contextPackId,
        affectedKnowledgeId,
        reason: proposalReason(input.feedbackType, input.reason),
        evidence: proposalEvidence(input, pack, affectedKnowledgeId),
        metadata: {
          source: 'feedback',
          feedbackType: input.feedbackType,
          suggestedAction: suggestedActionForFeedback(input.feedbackType),
        },
      });

      if (input.feedbackType === 'too_much_adjacent_context') {
        continue;
      }

      const knowledge = await this.store.getKnowledge(affectedKnowledgeId);
      if (knowledge?.metadata.source === 'agent_session_finish' || knowledge?.metadata.learningMode === 'auto') {
        await this.store.createLearningProposal({
          project: project ?? knowledge.project,
          proposalType: 'auto_memory_cleanup',
          sourceFeedbackId: feedback.id,
          sourceSessionId,
          contextPackId: input.contextPackId,
          affectedKnowledgeId,
          reason: `Auto-approved memory received ${input.feedbackType} feedback and needs review.`,
          evidence: proposalEvidence(input, pack, affectedKnowledgeId),
          metadata: {
            source: 'feedback',
            feedbackType: input.feedbackType,
            suggestedAction: 'review auto memory status, archive it, or mark it superseded',
          },
        });
      }
    }
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

  /**
   * Phase 7 — Gated rewrite probe. Runs a fast lexical+vector top-K pass and
   * fuses just those two sources to estimate baseline retrieval confidence.
   * Top1 fused score is returned to the gate decision in `searchContext`.
   *
   * Deliberately scoped: no graph, memory, worktree, or rerank — we want a
   * cheap signal that approximates "do we already have a strong direct hit
   * lexically or semantically?" If yes, the costly `models.rewriteQuery`
   * call is skipped.
   */
  private async computeRewriteProbeConfidence(
    input: NormalizedContextSearchInput,
    classified: ClassifiedQuery,
    project: string | undefined,
    config: QueryRewriteConfig,
  ): Promise<{ confidence: number; embedding?: number[] }> {
    const limit = Math.max(1, Math.floor(config.probeSearchLimit));
    const options: SearchOptions = {
      project,
      limit,
      rejectedKnowledgeIds: input.rejectedKnowledgeIds,
    };
    let lexical: SearchCandidate[] = [];
    let vector: SearchCandidate[] = [];
    let embedding: number[] | undefined;
    try {
      // Embed once; reuse the vector for `searchVector` here AND in
      // `findCandidates` (returned to the caller). This keeps the gated path
      // at one embed call per search rather than two.
      embedding = await this.models.embed(`${classified.lexicalQuery}\n\n${input.prompt}`);
      const [lexicalResult, vectorResult] = await Promise.all([
        this.store.searchLexical(classified, options),
        this.store.searchVector(embedding, options).catch(() => [] as SearchCandidate[]),
      ]);
      lexical = lexicalResult;
      vector = vectorResult;
    } catch {
      // Probe is best-effort: if either lookup throws, treat the probe as
      // unconfident and let the rewrite path run as before.
      return { confidence: 0, embedding };
    }
    const safeLexical = this.safety.sanitizeSearchCandidates(lexical);
    const safeVector = this.safety.sanitizeSearchCandidates(vector);
    if (safeLexical.length === 0 && safeVector.length === 0) {
      return { confidence: 0, embedding };
    }
    // Phase 7 deviation from the literal spec ("top1.fusedScore"):
    // `fuseCandidates` normalizes the top-ranked candidate to 1.0 (relative
    // ranking), so reading the post-fusion top1 score always returns 1.0 when
    // any candidate exists — that would gate every search. Instead, read the
    // strongest raw match across the lexical + vector top-K, which is what the
    // 0.65 threshold actually wants to capture: "is there a direct hit in
    // either source whose rawScore (FTS rank-decay or cosine) clears the bar?"
    let best = 0;
    for (const candidate of safeLexical) {
      if (candidate.rawScore > best) best = candidate.rawScore;
    }
    for (const candidate of safeVector) {
      if (candidate.rawScore > best) best = candidate.rawScore;
    }
    return { confidence: best, embedding };
  }

  private async findCandidates(
    input: NormalizedContextSearchInput,
    classified: ClassifiedQuery,
    project?: string,
    debug?: RetrievalDebugBuilder,
    precomputedEmbedding?: number[],
  ): Promise<{ candidates: KnowledgeSearchResult; worktree: WorktreeSearchResult }> {
    const options: SearchOptions = {
      project,
      limit: SEARCH_LIMIT,
      rejectedKnowledgeIds: input.rejectedKnowledgeIds,
    };

    // Phase 7 — when the gated rewrite probe pre-computed an embedding for the
    // same lexicalQuery, reuse it rather than embedding twice per search.
    const embedding = precomputedEmbedding
      ? Promise.resolve(precomputedEmbedding)
      : timed(
        'embedding',
        this.models.embed(`${classified.lexicalQuery}\n\n${input.prompt}`),
        debug,
      );
    const vectorResults = embedding
      .then((embedding) => timed('vector', this.store.searchVector(embedding, options), debug));
    const worktreeResults = timed(
      'worktree',
      this.worktreeProvider.search({
        cwd: input.cwd,
        prompt: input.prompt,
        classified,
        taskType: classified.taskType,
        project,
        limit: SEARCH_LIMIT,
        rejectedKnowledgeIds: input.rejectedKnowledgeIds,
      }),
      debug,
    );

    const [metadata, lexical, memory, vector, worktree] = await Promise.all([
      timed('metadata', this.store.searchMetadata(classified, options), debug),
      timed('lexical', this.store.searchLexical(classified, options), debug),
      timed('memory', this.store.searchMemories(classified, options), debug),
      vectorResults,
      worktreeResults,
    ]);
    const namespaceFilter = input.namespace;
    const safeResults: KnowledgeSearchResult = {
      metadata: applyNamespaceFilter(this.safety.sanitizeSearchCandidates(metadata), namespaceFilter),
      lexical: applyNamespaceFilter(this.safety.sanitizeSearchCandidates(lexical), namespaceFilter),
      memory: applyNamespaceFilter(this.safety.sanitizeSearchCandidates(memory), namespaceFilter),
      vector: applyNamespaceFilter(this.safety.sanitizeSearchCandidates(vector), namespaceFilter),
      graph: [] as KnowledgeSearchResult['graph'],
      // WorktreeProvider already sanitizes through KnowledgeSafetyService; namespace filter
      // does not apply to worktree (live evidence has no persisted namespace by design).
      worktree: this.safety.sanitizeSearchCandidates(worktree.candidates),
    };
    const seedKnowledgeIds = uniqueStrings([
      ...safeResults.metadata,
      ...safeResults.lexical,
      ...safeResults.memory,
      ...safeResults.vector,
      ...safeResults.worktree,
    ].map((candidate) => candidate.knowledgeId));
    const graph = await timed(
      'graph',
      this.store.searchGraphRelations(classified, { ...options, seedKnowledgeIds }),
      debug,
    );
    safeResults.graph = enrichGraphCandidates(
      applyNamespaceFilter(this.safety.sanitizeSearchCandidates(graph), namespaceFilter),
      classified,
      [
        ...safeResults.metadata,
        ...safeResults.lexical,
        ...safeResults.memory,
        ...safeResults.vector,
      ],
    );
    debug?.recordStage('metadata', safeResults.metadata);
    debug?.recordStage('lexical', safeResults.lexical);
    debug?.recordStage('memory', safeResults.memory);
    debug?.recordStage('vector', safeResults.vector);
    debug?.recordStage('graph', safeResults.graph);
    debug?.recordStage('worktree', safeResults.worktree);

    return { candidates: safeResults, worktree };
  }

  private async rankCandidates(
    prompt: string,
    candidates: KnowledgeSearchResult,
    classified: ClassifiedQuery,
    project?: string,
    debug?: RetrievalDebugBuilder,
    disabledSources?: CandidateSource[],
  ): Promise<{ candidates: RankedCandidate[]; signal: ContextFitSignal }> {
    const fusionStartedAt = Date.now();
    const disabled = new Set<CandidateSource>(disabledSources ?? []);
    const candidateGroups: SearchCandidate[][] = [
      disabled.has('metadata') ? [] : candidates.metadata,
      disabled.has('lexical') ? [] : candidates.lexical,
      disabled.has('memory') ? [] : candidates.memory,
      disabled.has('vector') ? [] : candidates.vector,
      disabled.has('graph') ? [] : candidates.graph,
      disabled.has('worktree') ? [] : candidates.worktree,
    ];

    // Phase 2 — fetch feedback summaries BEFORE fusion so the per-candidate
    // multiplicative penalty is applied to the fused score (and therefore visible to
    // rerank). Bound the set to all candidates fusion will see — duplicates across
    // groups are deduped by the Map+Set below.
    const candidateIdsForFeedback = new Set<string>();
    for (const group of candidateGroups) {
      for (const candidate of group) {
        candidateIdsForFeedback.add(candidate.knowledgeId);
      }
    }
    const feedbackSummaries = candidateIdsForFeedback.size > 0
      ? await this.store.getFeedbackSummaries([...candidateIdsForFeedback], { project })
      : new Map();

    let fused: RankedCandidate[];
    if (debug) {
      const fuseResult = fuseCandidates(candidateGroups, classified, {
        collectBreakdown: true,
        feedbackSummaries,
      });
      fused = fuseResult.ranked.slice(0, RERANK_LIMIT);
      if (fuseResult.breakdown) {
        debug.recordFusionBreakdown(fuseResult.breakdown);
      }
    } else {
      const fuseResult = fuseCandidates(candidateGroups, classified, {
        feedbackSummaries,
        collectBreakdown: true,
      });
      fused = fuseResult.ranked.slice(0, RERANK_LIMIT);
    }
    debug?.recordTiming('fusion', fusionStartedAt);
    debug?.recordStage('fusion', fused);

    // Phase 3 — wrap rerank in try/catch. On failure, fall back to the fused ordering
    // (already RRF-normalized + feedback-multiplied) and propagate a structured signal
    // up to the context-fit evaluator so it can downgrade fitStatus rather than letting
    // trust silently collapse to 0 when the reranker throws.
    let reranked: RankedCandidate[];
    let rerankSignal: ContextFitSignal = { rerankerAvailable: true };
    try {
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
      if (debug) {
        debug.recordRerankScores(rerankResult.candidates);
      }
      reranked = this.safety.sanitizeSearchCandidates(rerankResult.candidates, {
        onFilterEvent: debug ? (event) => debug.recordFilterEvent(event) : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rerankSignal = { rerankerAvailable: false, rerankerError: message };
      const fallbackCandidates = fused.map((candidate) => ({
        ...candidate,
        rerankScore: candidate.fusedScore,
        finalScore: candidate.fusedScore,
      }));
      reranked = this.safety.sanitizeSearchCandidates(fallbackCandidates, {
        onFilterEvent: debug ? (event) => debug.recordFilterEvent(event) : undefined,
      });
      debug?.recordProviderRerank({
        model: 'fallback:fused-order',
        inputKnowledgeIds: fused.map((candidate) => candidate.knowledgeId),
        decisions: [],
      });
    }

    const adjusted = await this.applyRankingAdjustments(reranked, classified, project ?? classified.project, debug);
    debug?.recordStage('rerank', adjusted);
    return { candidates: adjusted, signal: rerankSignal };
  }

  private async applyRankingAdjustments(
    candidates: RankedCandidate[],
    classified: ClassifiedQuery,
    project?: string,
    debug?: RetrievalDebugBuilder,
  ): Promise<RankedCandidate[]> {
    const summaries = await this.store.getFeedbackSummaries(
      [...new Set(candidates.map((candidate) => candidate.knowledgeId))],
      { project },
    );
    const supersededBy = await this.supersededByRelations(candidates, project);
    const onSuppression = debug ? (event: SuppressionEvent) => debug.recordSuppressionEvent(event) : undefined;

    return candidates
      .map((candidate) => applyFeedbackSummary(candidate, summaries.get(candidate.knowledgeId), onSuppression))
      .map((candidate) => applyIntentSuppression(candidate, classified, supersededBy.get(candidate.knowledgeId) ?? [], onSuppression))
      .sort((left, right) => right.finalScore - left.finalScore || left.rank - right.rank)
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }

  private async supersededByRelations(candidates: RankedCandidate[], project?: string): Promise<Map<string, KnowledgeRelation[]>> {
    const knowledgeIds = uniqueStrings(candidates.map((candidate) => candidate.knowledgeId));
    const entries = await Promise.all(knowledgeIds.map(async (knowledgeId) => {
      const relations = await this.store.listKnowledgeRelations({
        project,
        targetKnowledgeId: knowledgeId,
        relationType: 'supersedes',
        limit: 8,
      });
      return [knowledgeId, relations.filter((relation) => relation.fromKnowledgeId !== knowledgeId && relation.confidence >= 0.5)] as const;
    }));

    return new Map(entries.filter(([, relations]) => relations.length > 0));
  }

  private async resolveReviewTargets(
    _input: NormalizedContextSearchInput,
    classified: ClassifiedQuery,
    project?: string,
  ): Promise<{ reviewTargets: ContextReviewTarget[]; omittedReviewTargetCount: number }> {
    const explicitIds = uniqueStrings(classified.intent.objectHints ?? []);
    const explicitTargets = await Promise.all(explicitIds.map((id) => this.resolveExplicitReviewTarget(id)));
    const queueEntries = shouldSurfaceReviewQueues(classified)
      ? await this.listReviewQueueTargets(project)
      : [];
    const explicitTargetIds = new Set(explicitTargets.map((target) => target.id));
    const queuedTargets = queueEntries
      .filter((entry) => !explicitTargetIds.has(entry.target.id))
      .sort(compareReviewQueueEntries)
      .map((entry) => entry.target);
    const availableQueueSlots = Math.max(0, REVIEW_TARGET_LIMIT - explicitTargets.length);
    const selectedQueueTargets = queuedTargets.slice(0, availableQueueSlots);

    return {
      reviewTargets: [...explicitTargets, ...selectedQueueTargets],
      omittedReviewTargetCount: Math.max(0, queuedTargets.length - selectedQueueTargets.length),
    };
  }

  private async resolveExplicitReviewTarget(id: string): Promise<ContextReviewTarget> {
    const [draft, gap, proposal, pack, session, knowledge] = await Promise.all([
      this.store.getReflectionDraft(id),
      this.store.getKnowledgeGap(id),
      this.store.getLearningProposal(id),
      this.store.getContextPack(id),
      this.store.getAgentSession(id),
      this.store.getKnowledge(id),
    ]);

    if (draft) {
      return reflectionDraftTarget(draft, 'Prompt named this reflection draft id.');
    }
    if (gap) {
      return knowledgeGapTarget(gap, 'Prompt named this knowledge gap id.');
    }
    if (proposal) {
      return learningProposalTarget(proposal, 'Prompt named this learning proposal id.');
    }
    if (pack) {
      return contextPackTarget(pack, 'Prompt named this context pack id.');
    }
    if (session) {
      return agentSessionTarget(session, 'Prompt named this agent session id.');
    }
    if (knowledge) {
      return knowledgeTarget(knowledge, 'Prompt named this knowledge item id.');
    }

    return {
      kind: 'unknown',
      id,
      status: 'not_found',
      title: `Unresolved object ${id}`,
      recommendedAction: 'Verify the id or create the missing review record before proceeding.',
      reason: 'Prompt named this UUID, but it did not match a known review object.',
    };
  }

  private async listReviewQueueTargets(project?: string): Promise<ReviewQueueEntry[]> {
    const [
      pendingDrafts,
      needsChangesDrafts,
      openGaps,
      needsChangesGaps,
      openProposals,
      needsChangesProposals,
    ] = await Promise.all([
      this.store.listReflectionDrafts({ project, status: 'pending', limit: REVIEW_QUEUE_STATUS_LIMIT }),
      this.store.listReflectionDrafts({ project, status: 'needs_changes', limit: REVIEW_QUEUE_STATUS_LIMIT }),
      this.store.listKnowledgeGaps({ project, status: 'open', limit: REVIEW_QUEUE_STATUS_LIMIT }),
      this.store.listKnowledgeGaps({ project, status: 'needs_changes', limit: REVIEW_QUEUE_STATUS_LIMIT }),
      this.store.listLearningProposals({ project, status: 'open', limit: REVIEW_QUEUE_STATUS_LIMIT }),
      this.store.listLearningProposals({ project, status: 'needs_changes', limit: REVIEW_QUEUE_STATUS_LIMIT }),
    ]);

    return [
      ...pendingDrafts.map((draft) => reviewQueueEntry(
        reflectionDraftTarget(draft, 'Pending reflection draft in the review queue.'),
        draft.createdAt,
      )),
      ...needsChangesDrafts.map((draft) => reviewQueueEntry(
        reflectionDraftTarget(draft, 'Reflection draft needs changes before approval.'),
        draft.createdAt,
      )),
      ...openGaps.map((gap) => reviewQueueEntry(
        knowledgeGapTarget(gap, 'Open knowledge gap in the review queue.'),
        gap.createdAt,
      )),
      ...needsChangesGaps.map((gap) => reviewQueueEntry(
        knowledgeGapTarget(gap, 'Knowledge gap needs changes before it can be closed.'),
        gap.createdAt,
      )),
      ...openProposals.map((proposal) => reviewQueueEntry(
        learningProposalTarget(proposal, 'Open learning proposal in the review queue.'),
        proposal.createdAt,
      )),
      ...needsChangesProposals.map((proposal) => reviewQueueEntry(
        learningProposalTarget(proposal, 'Learning proposal needs changes before approval or dismissal.'),
        proposal.createdAt,
      )),
    ];
  }

  private buildContextPack(input: {
    queryId: string;
    project?: string;
    classified: ClassifiedQuery;
    candidates: RankedCandidate[];
    contextFit: ContextFit;
    input: NormalizedContextSearchInput;
    reviewTargets: ContextReviewTarget[];
    omittedReviewTargetCount: number;
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
      usefulnessCaps: usefulnessCapsForRequest(input.input),
      reviewTargets: input.reviewTargets,
      omittedReviewTargetCount: input.omittedReviewTargetCount,
    });
  }

  private async buildDeepContext(pack: ContextPack, budget: number): Promise<DeepContext> {
    const selectedItems = pack.sections.flatMap((section) => section.items);
    const knowledgeIds = uniqueStrings(selectedItems.map((item) => item.knowledgeId));
    const chunksByKnowledgeId = groupChunks(await this.store.listKnowledgeChunks(knowledgeIds));
    let remaining = budget;
    const sections: DeepContextSection[] = [];

    for (const section of pack.sections) {
      const deepItems: DeepContextItem[] = [];

      for (const item of section.items) {
        if (remaining <= 0) {
          break;
        }

        const chunks = chunksByKnowledgeId.get(item.knowledgeId) ?? [];
        const selectedChunks = takeChunksWithinBudget(chunks, remaining);
        const deepItem = buildDeepContextItem(item, selectedChunks.length ? selectedChunks : undefined, remaining);
        if (!deepItem) {
          continue;
        }

        deepItems.push(deepItem);
        remaining -= deepItem.tokenEstimate;
      }

      sections.push({
        name: section.name,
        items: deepItems,
        tokenEstimate: deepItems.reduce((sum, item) => sum + item.tokenEstimate, 0),
      });
    }

    return {
      mode: 'layered',
      budget,
      tokenEstimate: sections.reduce((sum, section) => sum + section.tokenEstimate, 0),
      sections,
    };
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

  private async addContinuationProvenance(input: NormalizedContextSearchInput): Promise<NormalizedContextSearchInput> {
    if (!isContinuationPrompt(input.prompt)) {
      return input;
    }

    const project = input.project ?? projectFromInput(input);
    const sessions = await this.store.listAgentSessions({ project, limit: CONTINUATION_SESSION_LIMIT });
    const recentSignals = emptyContinuationSignals();

    for (const session of sessions) {
      const decisions = await this.store.listAgentContextDecisions({ sessionId: session.id, limit: 20 });
      const selectedDecisions = decisions.filter((decision) => decision.decision === 'selected');
      if (selectedDecisions.length === 0) {
        continue;
      }

      mergeSignals(recentSignals, extractPromptSignals(`${session.prompt}\n${session.summary ?? ''}`));
      for (const decision of selectedDecisions) {
        mergeSignals(recentSignals, extractDecisionSignals(decision));
      }

      for (const packId of selectedContextPackIds(selectedDecisions)) {
        const pack = await this.store.getContextPack(packId);
        if (pack) {
          mergeSignals(recentSignals, extractContextPackSignals(pack));
        }
      }
    }

    const enriched = {
      files: mergeExplicitAndInferred(input.files, recentSignals.files, CONTINUATION_FILE_LIMIT),
      symbols: mergeExplicitAndInferred(input.symbols, recentSignals.symbols, CONTINUATION_SYMBOL_LIMIT),
      errors: mergeExplicitAndInferred(input.errors, recentSignals.errors, CONTINUATION_ERROR_LIMIT),
    };
    if (
      sameSignals(input.files, enriched.files)
      && sameSignals(input.symbols, enriched.symbols)
      && sameSignals(input.errors, enriched.errors)
    ) {
      return input;
    }

    return { ...input, ...enriched };
  }
}

interface ReviewQueueEntry {
  target: ContextReviewTarget;
  createdAt?: string;
}

function reviewQueueEntry(target: ContextReviewTarget, createdAt?: string): ReviewQueueEntry {
  return { target, createdAt };
}

function shouldResolveReviewTargetsFor(classified: ClassifiedQuery): boolean {
  return (classified.intent.objectHints ?? []).length > 0 || shouldSurfaceReviewQueues(classified);
}

function shouldSurfaceReviewQueues(classified: ClassifiedQuery): boolean {
  const mode = taskBriefMode(classified);
  return mode === 'reflection_review'
    || mode === 'context_quality_review'
    || mode === 'handoff_cleanup'
    || mode === 'operations_review';
}

function taskBriefMode(classified: ClassifiedQuery): TaskBriefMode {
  return classified.intent.taskBriefMode ?? (
    classified.taskType === 'debugging'
      ? 'debugging'
      : classified.taskType === 'planning'
        ? 'planning'
        : classified.taskType === 'review'
          ? 'review'
          : classified.taskType === 'unknown'
            ? 'unknown'
            : 'implementation'
  );
}

function compareReviewQueueEntries(left: ReviewQueueEntry, right: ReviewQueueEntry): number {
  const urgencyDelta = reviewStatusUrgency(left.target.status) - reviewStatusUrgency(right.target.status);
  if (urgencyDelta !== 0) {
    return urgencyDelta;
  }

  return (right.createdAt ?? '').localeCompare(left.createdAt ?? '');
}

function reviewStatusUrgency(status: string): number {
  switch (status) {
    case 'needs_changes':
      return 0;
    case 'pending':
    case 'open':
      return 1;
    default:
      return 2;
  }
}

function reflectionDraftTarget(draft: ReflectionDraft, reason: string): ContextReviewTarget {
  return {
    kind: 'reflection_draft',
    id: draft.id,
    status: draft.status,
    title: draft.title,
    recommendedAction: draft.status === 'needs_changes'
      ? 'Revise the draft or reject it before it can become searchable memory.'
      : 'Review accuracy, usefulness, scope, privacy, labels, references, and duplicate risk.',
    reason,
  };
}

function knowledgeGapTarget(gap: KnowledgeGap, reason: string): ContextReviewTarget {
  return {
    kind: 'knowledge_gap',
    id: gap.id,
    status: gap.status,
    title: truncate(gap.reason ?? gap.prompt, 96),
    recommendedAction: gap.status === 'needs_changes'
      ? 'Revise the gap review notes or dismiss it after the missing context is handled.'
      : 'Inspect missing signals and decide whether to add knowledge, labels, references, or dismiss the gap.',
    reason,
  };
}

function learningProposalTarget(proposal: LearningProposal, reason: string): ContextReviewTarget {
  return {
    kind: 'learning_proposal',
    id: proposal.id,
    status: proposal.status,
    title: `${proposal.proposalType}: ${truncate(proposal.reason, 82)}`,
    recommendedAction: proposal.status === 'needs_changes'
      ? 'Revise proposal metadata or dismiss it before approval.'
      : learningProposalAction(proposal),
    reason,
  };
}

function contextPackTarget(pack: ContextPack, reason: string): ContextReviewTarget {
  return {
    kind: 'context_pack',
    id: pack.id,
    status: pack.status,
    title: `Context pack: ${truncate(pack.prompt, 82)}`,
    recommendedAction: 'Inspect the pack, confirm fit, and record a context decision when appropriate.',
    reason,
  };
}

function agentSessionTarget(session: AgentSession, reason: string): ContextReviewTarget {
  return {
    kind: 'agent_session',
    id: session.id,
    status: session.status,
    title: `Agent session: ${truncate(session.prompt, 82)}`,
    recommendedAction: session.status === 'active'
      ? 'Inspect context decisions and finish or annotate the active session.'
      : 'Inspect session decisions, outcome, and reflection links.',
    reason,
  };
}

function knowledgeTarget(knowledge: StoredKnowledge, reason: string): ContextReviewTarget {
  return {
    kind: 'knowledge',
    id: knowledge.id,
    status: knowledge.status ?? 'unknown',
    title: knowledge.title,
    recommendedAction: knowledge.status === 'needs_review'
      ? 'Review labels, references, freshness, and safety before relying on this knowledge.'
      : 'Inspect this knowledge item and confirm it is relevant to the task.',
    reason,
  };
}

function learningProposalAction(proposal: LearningProposal): string {
  switch (proposal.proposalType) {
    case 'missing_label':
      return 'Review suggested labels and approve, request changes, or dismiss.';
    case 'missing_reference':
      return 'Review suggested references and approve, request changes, or dismiss.';
    case 'missing_relation':
      return 'Review whether labels or graph relations should be tightened.';
    case 'supersedes':
      return 'Review whether the candidate should supersede affected knowledge.';
    case 'auto_memory_cleanup':
      return 'Review the auto-memory cleanup action before changing memory status.';
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

function selectedContextPackIds(decisions: AgentContextDecision[]): string[] {
  return uniqueStrings([
    ...decisions.flatMap((decision) => [decision.contextPackId, decision.retryContextPackId]),
  ].filter((value): value is string => Boolean(value)));
}

interface ContinuationSignals {
  files: string[];
  symbols: string[];
  errors: string[];
}

function emptyContinuationSignals(): ContinuationSignals {
  return { files: [], symbols: [], errors: [] };
}

function mergeSignals(target: ContinuationSignals, source: ContinuationSignals): void {
  target.files.push(...source.files);
  target.symbols.push(...source.symbols);
  target.errors.push(...source.errors);
}

function extractContextPackSignals(pack: ContextPack): ContinuationSignals {
  return {
    files: uniqueStrings([
      ...pack.classified.files,
      ...pack.sections.flatMap((section) => section.items.flatMap((item) => [
        ...item.labels.filter((label) => label.type === 'file').map((label) => label.value),
        ...item.references.filter((reference) => reference.type === 'file').map((reference) => reference.uri),
      ])),
    ].filter(isLikelyProjectFile)),
    symbols: uniqueStrings([
      ...pack.classified.symbols,
      ...pack.sections.flatMap((section) => section.items.flatMap((item) => (
        item.labels.filter((label) => label.type === 'symbol').map((label) => label.value)
      ))),
    ].filter(isUsefulContinuationSymbol)),
    errors: uniqueStrings([
      ...pack.classified.errors,
      ...pack.sections.flatMap((section) => section.items.flatMap((item) => (
        item.labels.filter((label) => label.type === 'error').map((label) => label.value)
      ))),
    ].filter(isUsefulContinuationError)),
  };
}

function extractPromptSignals(prompt: string): ContinuationSignals {
  return {
    files: prompt.match(/(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+|[\w.-]+\.[jt]sx?|[\w.-]+\.py|[\w.-]+\.go|[\w.-]+\.rs|[\w.-]+\.md/g)?.filter(isLikelyProjectFile) ?? [],
    symbols: uniqueStrings([
      ...(prompt.match(/\b[A-Z][A-Za-z0-9_]*(?:Service|Controller|Repository|Provider|Handler|Store|Model|Schema|Config|Client)\b/g) ?? []),
      ...(prompt.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? []),
    ].filter(isUsefulContinuationSymbol)),
    errors: uniqueStrings([
      ...(prompt.match(/\b[A-Z][A-Z0-9_]*(?:Error|Exception|Failure)\b/g) ?? []),
      ...(prompt.match(/\b[A-Z]{2,}[-_][A-Z0-9_-]+\b/g) ?? []),
      ...(prompt.match(/\b(?:TS|ERR|E)[-_]?\d{3,6}\b/g) ?? []),
    ].filter(isUsefulContinuationError)),
  };
}

function extractDecisionSignals(decision: AgentContextDecision): ContinuationSignals {
  return {
    files: metadataStringArray(decision.metadata.files).filter(isLikelyProjectFile),
    symbols: metadataStringArray(decision.metadata.symbols).filter(isUsefulContinuationSymbol),
    errors: metadataStringArray(decision.metadata.errors).filter(isUsefulContinuationError),
  };
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isLikelyProjectFile(value: string): boolean {
  return /^[\w./-]+\.[a-zA-Z0-9]+$/.test(value) && !value.includes('://');
}

function isUsefulContinuationSymbol(value: string): boolean {
  return /^[A-Za-z_$][\w$.:#-]{2,}$/.test(value)
    && !CONTINUATION_SYMBOL_STOP_WORDS.has(value.toLowerCase())
    && !isLikelyDocumentIdentifier(value);
}

function isUsefulContinuationError(value: string): boolean {
  return /^[A-Za-z0-9_-]{3,}$/.test(value)
    && (/\d/.test(value) || /(?:Error|Exception|Failure)$/.test(value))
    && !isLikelyDocumentIdentifier(value);
}

function mergeExplicitAndInferred(
  explicit: string[] | undefined,
  inferred: string[],
  inferredLimit: number,
): string[] | undefined {
  const explicitValues = explicit ?? [];
  const availableInferred = Math.max(0, inferredLimit - explicitValues.length);
  const merged = uniqueStrings([
    ...explicitValues,
    ...uniqueStrings(inferred).slice(0, availableInferred),
  ]);
  return merged.length ? merged : undefined;
}

function projectFromInput(input: ContextSearchInput): string | undefined {
  const hint = input.repoHint ?? input.cwd;
  return hint ? normalizeLabel(hint.split('/').filter(Boolean).at(-1) ?? hint) : undefined;
}

/** @internal Exposed for unit tests; matches the phrases that trigger continuation-provenance expansion. */
export function isContinuationPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  // Phrase-anchored: requires an explicit continuation construct. Avoids false positives like
  // "current rate limit policy", "continue using strict mode", "tests continue to pass" that
  // would otherwise pay the session × decision × pack expansion.
  return /\bcontinue\s+(?:the|our|my|this|where|from|previous|prior|last)\b|\bresume (?:the |my |our )?(?:work|session|task)\b|\bhand[ -]?off\b|\bpick up where\b|\bwhere we left off\b|\bpicking up where\b|\bpick up the (?:work|task)\b/.test(lower);
}

const CONTINUATION_SYMBOL_STOP_WORDS = new Set([
  'continue',
  'continuation',
  'current',
  'phase',
  'roadmap',
  'the',
  'for',
  'keep',
  'strip',
  'before',
  'after',
  'added',
  'updated',
  'verified',
  'loaded',
  'implemented',
  'improve',
  'focus',
  'next',
  'agent',
  'context',
  'usefulness',
  'hardening',
  'tuberosa',
  'mcp',
  'implement',
  'everything',
  'tried',
  'failed',
  'needed',
  'correction',
  'things',
  'status',
  'summary',
  'notes',
  'draft',
  'drafts',
  'gap',
  'gaps',
  'proposal',
  'proposals',
  'operation',
  'operations',
  'uuid',
  'uuids',
  'http',
  'api',
  'json',
]);

function isLikelyDocumentIdentifier(value: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(value) && value.includes('_') && !/\d/.test(value);
}

function usefulnessCapsForRequest(input: NormalizedContextSearchInput): UsefulnessCaps {
  if (input.debug) {
    return UNCAPPED_USEFULNESS_CAPS;
  }

  if (input.noiseTolerance === 'strict') {
    return {
      priorLessons: 3,
      adjacentContext: 1,
    };
  }

  if (input.deepContextBudget > DEFAULT_DEEP_CONTEXT_BUDGET) {
    const expansion = Math.min(2, input.deepContextBudget / DEFAULT_DEEP_CONTEXT_BUDGET);
    return {
      priorLessons: Math.ceil(DEFAULT_USEFULNESS_CAPS.priorLessons * expansion),
      adjacentContext: Math.ceil(DEFAULT_USEFULNESS_CAPS.adjacentContext * expansion),
    };
  }

  return DEFAULT_USEFULNESS_CAPS;
}

function normalizeSearchInput(input: ContextSearchInput, config: AppConfig): NormalizedContextSearchInput {
  return {
    ...input,
    tokenBudget: input.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    contextMode: input.contextMode ?? config.contextMode ?? 'layered',
    noiseTolerance: input.noiseTolerance ?? 'balanced',
    deepContextBudget: normalizeDeepContextBudget(input.deepContextBudget ?? config.deepContextBudget),
    rejectedKnowledgeIds: input.rejectedKnowledgeIds ?? [],
    debug: input.debug ?? false,
  };
}

function groupChunks(chunks: KnowledgeChunkRecord[]): Map<string, KnowledgeChunkRecord[]> {
  const grouped = new Map<string, KnowledgeChunkRecord[]>();
  for (const chunk of chunks) {
    const list = grouped.get(chunk.knowledgeId) ?? [];
    list.push(chunk);
    grouped.set(chunk.knowledgeId, list);
  }

  for (const list of grouped.values()) {
    list.sort((left, right) => left.chunkIndex - right.chunkIndex);
  }

  return grouped;
}

function takeChunksWithinBudget(chunks: KnowledgeChunkRecord[], budget: number): KnowledgeChunkRecord[] {
  const selected: KnowledgeChunkRecord[] = [];
  let tokens = 0;

  for (const chunk of chunks) {
    if (selected.length > 0 && tokens + chunk.tokenEstimate > budget) {
      break;
    }

    if (chunk.tokenEstimate > budget && selected.length === 0) {
      break;
    }

    selected.push(chunk);
    tokens += chunk.tokenEstimate;
  }

  return selected;
}

function buildDeepContextItem(
  candidate: RankedCandidate,
  chunks: KnowledgeChunkRecord[] | undefined,
  budget: number,
): DeepContextItem | undefined {
  const chunkIds = chunks?.map((chunk) => chunk.id) ?? (candidate.chunkId ? [candidate.chunkId] : []);
  const content = chunks?.map((chunk) => chunk.content).join('\n\n') ?? candidate.content;
  const contextualContent = chunks?.map((chunk) => chunk.contextualContent).join('\n\n---\n\n') ?? candidate.contextualContent;
  const tokenEstimate = chunks?.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0) ?? candidate.tokenEstimate;

  if (tokenEstimate > budget) {
    return undefined;
  }

  return {
    knowledgeId: candidate.knowledgeId,
    title: candidate.title,
    summary: candidate.summary,
    itemType: candidate.itemType,
    project: candidate.project,
    labels: candidate.labels,
    references: candidate.references,
    source: candidate.source,
    rank: candidate.rank,
    finalScore: candidate.finalScore,
    matchReasons: candidate.matchReasons,
    evidenceCategory: candidate.evidenceCategory,
    evidenceStrength: candidate.evidenceStrength,
    usefulnessReason: candidate.usefulnessReason,
    actionableMissingSignals: candidate.actionableMissingSignals,
    chunkIds,
    content,
    contextualContent,
    tokenEstimate,
  };
}

/**
 * Phase 6a — drop candidates whose persisted namespace mismatches the supplied filter.
 * Read-side filter; the candidate's `metadata.namespace` is set on upsert by both
 * stores. Backwards-compatible: a missing filter (the common case) returns the input
 * untouched.
 */
function applyNamespaceFilter(
  candidates: SearchCandidate[],
  filter: ContextSearchInput['namespace'] | undefined,
): SearchCandidate[] {
  if (!filter || (!filter.kind && !filter.agent && !filter.project)) return candidates;
  return candidates.filter((candidate) => {
    const stored = readNamespaceFromMetadata(candidate.metadata);
    return namespaceMatchesFilter(stored, filter);
  });
}

function enrichGraphCandidates(
  graphCandidates: KnowledgeSearchResult['graph'],
  classified: ClassifiedQuery,
  seedCandidates: KnowledgeSearchResult['graph'],
): KnowledgeSearchResult['graph'] {
  if (graphCandidates.length === 0) {
    return [];
  }

  const connectedSignals = compactRecord({
    files: signalsCoveredBySeeds(classified.files, seedCandidates),
    symbols: signalsCoveredBySeeds(classified.symbols, seedCandidates),
    errors: signalsCoveredBySeeds(classified.errors, seedCandidates),
  });

  if (Object.keys(connectedSignals).length === 0) {
    return graphCandidates;
  }

  return graphCandidates.map((candidate) => ({
    ...candidate,
    metadata: {
      ...(candidate.metadata ?? {}),
      graphContextFit: connectedSignals,
    },
  }));
}

function signalsCoveredBySeeds(signals: string[], seedCandidates: KnowledgeSearchResult['graph']): string[] {
  return uniqueStrings(signals.filter((signal) => seedCandidates.some((candidate) => candidateContainsSignal(candidate, signal))));
}

function candidateContainsSignal(candidate: KnowledgeSearchResult['graph'][number], signal: string): boolean {
  const text = [
    candidate.title,
    candidate.summary,
    candidate.content,
    candidate.contextualContent,
    candidate.labels.map((label) => `${label.type}:${label.value}`).join(' '),
    candidate.references.map((reference) => reference.uri).join(' '),
    JSON.stringify(candidate.metadata ?? {}),
  ].join(' ').toLowerCase();

  return text.includes(signal.toLowerCase());
}

function compactRecord<T extends Record<string, string[]>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, values]) => values.length > 0)) as Partial<T>;
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
    contextMode: input.contextMode,
    noiseTolerance: input.noiseTolerance,
    deepContextBudget: input.deepContextBudget,
    rejectedKnowledgeIds: input.rejectedKnowledgeIds,
    lexicalQuery: classified.lexicalQuery,
    exactTerms: classified.exactTerms,
    queryRewriteModel: rewrite?.model,
    rerankModel: config.openAiRerankModel,
    policyFingerprint: getRetrievalPolicyFingerprint(),
    namespace: input.namespace ?? null,
  }));
}

function applyNoiseTolerance(
  contextFit: ContextFit,
  classified: ClassifiedQuery,
  candidates: RankedCandidate[],
  noiseTolerance: NormalizedContextSearchInput['noiseTolerance'],
): ContextFit {
  if (noiseTolerance !== 'strict' || contextFit.fitStatus !== 'ready') {
    return contextFit;
  }

  const hasDirectEvidence = candidates.slice(0, 3).some((candidate) => hasHardSignalEvidence(candidate, classified));
  if (hasDirectEvidence) {
    return contextFit;
  }

  return {
    ...contextFit,
    fitStatus: 'needs_confirmation',
    fitScore: Math.min(contextFit.fitScore, 0.71),
    fitReasons: uniqueStrings([
      ...contextFit.fitReasons,
      'strict noise tolerance downgraded weak semantic match',
    ]),
    missingSignals: uniqueStrings([
      ...contextFit.missingSignals,
      'strict noise tolerance requires direct file, symbol, or error evidence before proceeding',
    ]),
  };
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

function feedbackMissingSignals(input: FeedbackInput, pack: ContextPack | undefined): string[] {
  const metadataSignals = metadataStringArray(input.metadata?.missingSignals);
  const signals = [
    ...(pack?.contextFit?.missingSignals ?? []),
    ...metadataSignals,
    ...(input.reason ? [input.reason] : []),
  ];

  return uniqueStrings(signals).slice(0, 16);
}

function feedbackAffectedKnowledgeIds(input: FeedbackInput, pack: ContextPack | undefined): string[] {
  if (input.rejectedKnowledgeIds?.length) {
    return uniqueStrings(input.rejectedKnowledgeIds);
  }

  return uniqueStrings(pack?.sections.flatMap((section) => section.items.map((item) => item.knowledgeId)) ?? []);
}

function proposalTypeForFeedback(feedbackType: FeedbackInput['feedbackType']): LearningProposalType {
  if (feedbackType === 'stale') {
    return 'supersedes';
  }

  return 'missing_relation';
}

function proposalReason(feedbackType: FeedbackInput['feedbackType'], reason: string | undefined): string {
  if (reason) {
    return reason;
  }

  if (feedbackType === 'stale') {
    return 'Stale context should be reviewed for a supersedes relation or archival.';
  }

  if (feedbackType === 'too_much_adjacent_context') {
    return 'Adjacent context dominated the pack; review labels, relations, or freshness to lower its rank for similar prompts.';
  }

  return 'Rejected or irrelevant context should be reviewed for missing labels, references, or relations.';
}

function suggestedActionForFeedback(feedbackType: FeedbackInput['feedbackType']): string {
  if (feedbackType === 'stale') {
    return 'review for a supersedes relation, freshness update, or archive';
  }

  if (feedbackType === 'too_much_adjacent_context') {
    return 'review adjacent context noise: tighten labels, add relations, or lower freshness/trust for similar prompts';
  }

  return 'review labels, references, and graph relations before changing ranking';
}

function proposalEvidence(
  input: FeedbackInput,
  pack: ContextPack | undefined,
  affectedKnowledgeId: string,
): string[] {
  const item = pack?.sections
    .flatMap((section) => section.items)
    .find((candidate) => candidate.knowledgeId === affectedKnowledgeId);
  const evidence = [
    `feedback:${input.feedbackType}`,
    input.contextPackId ? `contextPack:${input.contextPackId}` : undefined,
    input.reason ? `reason:${input.reason}` : undefined,
    ...(item?.matchReasons ?? []).slice(0, 6).map((reason) => `match:${reason}`),
    ...(item?.fitMissingSignals ?? []).slice(0, 6).map((signal) => `missing:${signal}`),
  ].filter((value): value is string => Boolean(value));

  return uniqueStrings(evidence).slice(0, 16);
}

function applyFeedbackSummary(
  candidate: RankedCandidate,
  summary: KnowledgeFeedbackSummary | undefined,
  onSuppression?: (event: SuppressionEvent) => void,
): RankedCandidate {
  if (!summary) {
    return candidate;
  }

  const adjustment = feedbackScoreAdjustment(summary);
  const status = feedbackStatus(summary);
  const feedbackMetadata = {
    status,
    selectedCount: summary.selectedCount,
    selectedNoisyCount: summary.selectedNoisyCount,
    rejectedCount: summary.rejectedCount,
    irrelevantCount: summary.irrelevantCount,
    staleCount: summary.staleCount,
    latestFeedbackType: summary.latestFeedbackType,
    latestFeedbackAt: summary.latestFeedbackAt,
    scoreAdjustment: adjustment,
  };

  if (onSuppression && adjustment < 0) {
    const reason = feedbackSuppressionReason(status);
    if (reason) {
      onSuppression({
        knowledgeId: candidate.knowledgeId,
        reason,
        deltaScore: adjustment,
        confidence: feedbackSuppressionConfidence(summary, status),
        evidence: `feedback status=${status}, latest=${summary.latestFeedbackType ?? 'unknown'}`,
      });
    }
  }

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

function feedbackSuppressionReason(status: string): SuppressionReason | undefined {
  switch (status) {
    case 'stale':
      return 'feedback_stale';
    case 'rejected':
      return 'feedback_rejected';
    case 'irrelevant':
      return 'feedback_irrelevant';
    default:
      return undefined;
  }
}

function feedbackSuppressionConfidence(summary: KnowledgeFeedbackSummary, status: string): number {
  const negativeCount = summary.staleCount + summary.rejectedCount + summary.irrelevantCount;
  if (negativeCount === 0) return 0.5;
  const baseline = Math.min(1, negativeCount / 3);
  const isLatestMatching = summary.latestFeedbackType === status;
  return clamp(isLatestMatching ? Math.max(baseline, 0.7) : baseline, 0, 1);
}

/**
 * Hard floor for cumulative suppression damping. A positive-scoring candidate
 * never drops below this floor purely from intent suppressions. Independent
 * positive boosts (e.g., domain_match) can still raise it above.
 */
const SUPPRESSION_FLOOR = 0.1;

function applyIntentSuppression(
  candidate: RankedCandidate,
  classified: ClassifiedQuery,
  supersededBy: KnowledgeRelation[],
  onSuppression?: (event: SuppressionEvent) => void,
): RankedCandidate {
  const adjustment = intentSuppressionAdjustment(candidate, classified, supersededBy);
  if (adjustment.factor === 1 && adjustment.boost === 0 && adjustment.events.length === 0) {
    return candidate;
  }

  if (onSuppression) {
    for (const event of adjustment.events) {
      if (event.deltaScore < 0) {
        onSuppression({ ...event, knowledgeId: candidate.knowledgeId });
      }
    }
  }

  // Phase 2 — multiplicative damping with hard floor. Penalties never push a
  // positive score below the floor; positive boosts (e.g., domain match) add on
  // top, then the result is clamped to [0, 1].
  const base = candidate.finalScore;
  const dampedBase = base > SUPPRESSION_FLOOR
    ? Math.max(base * adjustment.factor, SUPPRESSION_FLOOR)
    : base * adjustment.factor;
  const nextScore = clampScore(dampedBase + adjustment.boost);
  const effectiveDelta = nextScore - base;

  return {
    ...candidate,
    finalScore: nextScore,
    matchReasons: [
      ...candidate.matchReasons,
      ...adjustment.reasons,
    ],
    metadata: {
      ...(candidate.metadata ?? {}),
      retrievalSuppression: {
        scoreAdjustment: roundFeedbackAdjustment(effectiveDelta),
        suppressionFactor: roundFeedbackAdjustment(adjustment.factor),
        boost: roundFeedbackAdjustment(adjustment.boost),
        reasons: adjustment.reasons,
        supersededBy: supersededBy.map((relation) => relation.fromKnowledgeId),
      },
    },
  };
}

interface SuppressionAdjustment {
  /** Multiplicative damping factor in (0, 1] applied to finalScore before boosts. */
  factor: number;
  /** Additive positive boost (e.g., domain_match) applied AFTER damping. */
  boost: number;
  reasons: string[];
  events: Array<Omit<SuppressionEvent, 'knowledgeId'>>;
}

/**
 * Convert an additive-style "delta" (legacy: -0.14 etc.) into a multiplicative
 * factor in (0, 1]. The mapping preserves intent ordering (bigger penalty →
 * smaller factor) but bounds the per-source contribution so cumulative product
 * stays well-behaved.
 */
function penaltyDeltaToFactor(delta: number): number {
  if (delta >= 0) return 1;
  // |delta|=0.28 → ~0.62; |delta|=0.14 → ~0.79; |delta|=0.10 → ~0.85; |delta|=0.08 → ~0.88
  return clamp(Math.exp(2.2 * delta), 0.4, 1);
}

function intentSuppressionAdjustment(
  candidate: RankedCandidate,
  classified: ClassifiedQuery,
  supersededBy: KnowledgeRelation[],
): SuppressionAdjustment {
  const policy = getRetrievalPolicy();
  const reasons: string[] = [];
  const events: Array<Omit<SuppressionEvent, 'knowledgeId'>> = [];
  let factor = 1;
  let boost = 0;
  const hasHardEvidence = hasHardSignalEvidence(candidate, classified);

  if (policy.suppressionEnabled.superseded && supersededBy.length > 0) {
    const strongest = Math.max(...supersededBy.map((relation) => relation.confidence));
    const delta = -Math.min(0.28, 0.18 + strongest * 0.08);
    factor *= penaltyDeltaToFactor(delta);
    reasons.push(`suppression:superseded:${supersededBy[0].fromKnowledgeId}`);
    events.push({
      reason: 'superseded',
      deltaScore: roundFeedbackAdjustment(delta),
      confidence: clamp(strongest, 0, 1),
      evidence: `superseded by ${supersededBy[0].fromKnowledgeId} (confidence=${strongest.toFixed(2)})`,
    });
  }

  if (policy.suppressionEnabled.stale && isStaleCandidate(candidate) && !hasHardEvidence) {
    const delta = -0.14;
    factor *= penaltyDeltaToFactor(delta);
    reasons.push('suppression:freshness:stale');
    events.push({
      reason: 'stale_freshness',
      deltaScore: delta,
      confidence: staleFreshnessConfidence(candidate),
      evidence: `itemType=${candidate.itemType} freshnessAt=${candidate.freshnessAt ?? metadataString(candidate.metadata, 'freshnessAt') ?? 'unknown'}`,
    });
  }

  if (policy.suppressionEnabled.feedback) {
    const feedback = feedbackStatusFromCandidate(candidate);
    if ((feedback === 'stale' || feedback === 'rejected' || feedback === 'irrelevant') && !hasHardEvidence) {
      const delta = feedback === 'stale' ? -0.1 : -0.08;
      factor *= penaltyDeltaToFactor(delta);
      reasons.push(`suppression:prior feedback:${feedback}`);
      const suppressionReason: SuppressionReason = feedback === 'stale'
        ? 'feedback_stale'
        : feedback === 'rejected'
          ? 'feedback_rejected'
          : 'feedback_irrelevant';
      events.push({
        reason: suppressionReason,
        deltaScore: delta,
        confidence: 0.7,
        evidence: `candidate-side feedback status=${feedback}`,
      });
    }
  }

  if (policy.suppressionEnabled.evidenceMismatch
    && !hasHardEvidence
    && !requiredEvidenceMatches(candidate, classified.intent.requiredEvidenceTypes)) {
    const delta = -0.1;
    factor *= penaltyDeltaToFactor(delta);
    reasons.push('suppression:evidence_mismatch');
    events.push({
      reason: 'evidence_mismatch',
      deltaScore: delta,
      confidence: 0.6,
      evidence: `required evidence types=${classified.intent.requiredEvidenceTypes.join(',') || 'none'}`,
    });
  }

  // Phase 5 — worktree candidates that match a prompt-named file represent live truth;
  // give them a strong positive boost so they outrank conflicting durable memory for
  // continuation / self-edit tasks. RRF fusion otherwise compounds across multiple
  // memory/graph/lexical contributions and the single-source worktree weight (1.30)
  // alone cannot beat a memory hit by 3 sources. The boost is sized so that a
  // prompt-named worktree candidate at a mid-tier fused score reliably outranks a
  // memory candidate sweeping memory+graph+lexical at the top of the fused list.
  if (candidate.source === 'worktree') {
    const worktreeMeta = candidate.metadata?.worktree as { reason?: string; promptMatch?: boolean } | undefined;
    if (worktreeMeta?.promptMatch || worktreeMeta?.reason === 'prompt_named') {
      // The boost must overcome (a) the single-source-fusion penalty vs a memory
      // candidate hit by 3 sources, and (b) the domain_match bonus durable memories
      // typically already carry. Sized empirically against the Phase 5 regression
      // fixture; smaller values let multi-source memories win.
      const delta = 0.6;
      boost += delta;
      reasons.push('boost:worktree_live_evidence:prompt_named');
    } else if (worktreeMeta?.reason === 'git_changed') {
      const delta = 0.22;
      boost += delta;
      reasons.push('boost:worktree_live_evidence:git_changed');
    }
  }

  if (policy.suppressionEnabled.domainMismatch && classified.domain) {
    const domainLabels = candidate.labels.filter((label) => label.type === 'domain');
    if (domainLabels.length > 0) {
      const target = classified.domain.toLowerCase();
      const matches = domainLabels.some((label) => label.value.toLowerCase() === target);
      if (matches) {
        // Permissive boost: a matching domain (classifier-inferred is fine) lifts the score.
        const delta = policy.domainMismatch.matchBoost;
        boost += delta;
        reasons.push(`boost:domain_match:${classified.domain}`);
      } else {
        // Strict penalty: only fire when at least one EXPLICIT (user-supplied / reviewed) domain
        // label exists and none match. Classifier-inferred-only candidates are heuristic and
        // would create false-positive suppression for any candidate that simply lives under a
        // different `src/X/` directory than the query.
        const explicitDomainLabels = domainLabels.filter(isExplicitDomainCandidateLabel);
        if (explicitDomainLabels.length > 0) {
          const delta = policy.domainMismatch.mismatchPenalty;
          factor *= penaltyDeltaToFactor(delta);
          reasons.push(`suppression:domain_mismatch:${classified.domain}`);
          events.push({
            reason: 'domain_mismatch',
            deltaScore: roundFeedbackAdjustment(delta),
            confidence: 0.9,
            evidence: `candidate domain labels=[${explicitDomainLabels.map((label) => label.value).join(', ')}] expected=${classified.domain}`,
          });
        }
      }
    }
  }

  return { factor, boost, reasons, events };
}

function staleFreshnessConfidence(candidate: RankedCandidate): number {
  const freshnessAt = candidate.freshnessAt ?? metadataString(candidate.metadata, 'freshnessAt');
  if (!freshnessAt) return 0.5;
  const timestamp = Date.parse(freshnessAt);
  if (Number.isNaN(timestamp)) return 0.5;
  const policy = getRetrievalPolicy();
  const window = freshnessWindowFor(policy, candidate.itemType);
  const ageDays = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  if (ageDays <= window.staleDays) return 0.5;
  const overshootRatio = (ageDays - window.staleDays) / Math.max(1, window.staleDays);
  return clamp(0.6 + overshootRatio * 0.4, 0.6, 1);
}

function hasHardSignalEvidence(candidate: RankedCandidate, classified: ClassifiedQuery): boolean {
  return [
    ...classified.files,
    ...classified.symbols,
    ...classified.errors,
  ].some((signal) => candidateText(candidate).includes(signal.toLowerCase()));
}

function isStaleCandidate(candidate: RankedCandidate): boolean {
  const metadataStale = candidate.metadata?.stale === true || feedbackStatusFromCandidate(candidate) === 'stale';
  if (metadataStale) {
    return true;
  }

  const freshnessAt = candidate.freshnessAt ?? metadataString(candidate.metadata, 'freshnessAt');
  if (!freshnessAt) {
    return false;
  }

  const timestamp = Date.parse(freshnessAt);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  const policy = getRetrievalPolicy();
  const window = freshnessWindowFor(policy, candidate.itemType);
  return Date.now() - timestamp > window.staleDays * 86_400_000;
}

function requiredEvidenceMatches(candidate: RankedCandidate, evidenceTypes: RetrievalEvidenceType[]): boolean {
  if (evidenceTypes.length === 0) {
    return true;
  }

  return evidenceTypes.some((type) => candidateSupportsEvidence(candidate, type));
}

function candidateSupportsEvidence(candidate: RankedCandidate, evidenceType: RetrievalEvidenceType): boolean {
  switch (evidenceType) {
    case 'spec':
      return candidate.itemType === 'spec' || hasMetadataTaxonomy(candidate, 'domain_rule');
    case 'workflow':
      return candidate.itemType === 'workflow' || candidate.itemType === 'rule' || hasMetadataTaxonomy(candidate, 'workflow');
    case 'code_reference':
      return candidate.itemType === 'code_ref'
        || candidate.references.some((reference) => reference.type === 'file')
        || candidate.labels.some((label) => label.type === 'file' || label.type === 'symbol');
    case 'bugfix':
      return candidate.itemType === 'bugfix'
        || candidate.labels.some((label) => label.type === 'error' || (label.type === 'task_type' && label.value === 'debugging'));
    case 'incident_lesson':
      return hasMetadataTaxonomy(candidate, 'incident_lesson')
        || metadataString(candidate.metadata, 'triggerType') === 'error_recovery'
        || candidate.references.some((reference) => reference.uri.startsWith('tuberosa://error-logs/'));
    case 'reflection_memory':
      return candidate.itemType === 'memory' || Boolean(metadataString(candidate.metadata, 'triggerType'));
    case 'session_history':
      return Boolean(metadataString(candidate.metadata, 'agentSessionId'))
        || candidate.references.some((reference) => reference.type === 'conversation');
    case 'handoff':
      return candidate.references.some((reference) => reference.uri === 'handoff.md')
        || candidate.labels.some((label) => label.type === 'file' && label.value === 'handoff.md');
    case 'docs':
      return candidate.itemType === 'wiki'
        || candidate.references.some((reference) => reference.type === 'file' && reference.uri.endsWith('.md'));
    case 'tests':
      return candidate.references.some((reference) => /(^|\/|-)test(s)?[/.]|\.test\./.test(reference.uri))
        || candidate.labels.some((label) => label.type === 'file' && /(^|\/|-)test(s)?[/.]|\.test\./.test(label.value));
  }
}

function hasMetadataTaxonomy(candidate: RankedCandidate, taxonomy: string): boolean {
  return metadataString(candidate.metadata, 'taxonomy') === taxonomy;
}

function metadataUuidString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadataString(metadata, key);
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function feedbackStatusFromCandidate(candidate: RankedCandidate): string | undefined {
  const direct = metadataString(candidate.metadata, 'feedbackStatus') ?? metadataString(candidate.metadata, 'priorFeedback');
  if (direct) {
    return direct;
  }

  const feedback = candidate.metadata?.feedback;
  if (!feedback || typeof feedback !== 'object') {
    return undefined;
  }

  const status = (feedback as Record<string, unknown>).status;
  return typeof status === 'string' ? status : undefined;
}

function feedbackScoreAdjustment(summary: KnowledgeFeedbackSummary): number {
  const selectedBoost = Math.min(0.1, summary.selectedCount * 0.04);
  const noisyPenalty = Math.min(0.08, summary.selectedNoisyCount * 0.03);
  const stalePenalty = Math.min(0.24, summary.staleCount * 0.2);
  const rejectionPenalty = Math.min(0.18, (summary.rejectedCount + summary.irrelevantCount) * 0.09);

  return roundFeedbackAdjustment(selectedBoost - noisyPenalty - stalePenalty - rejectionPenalty);
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
  if (summary.selectedNoisyCount > 0) {
    reasons.push(`feedback:selected_but_noisy:${summary.selectedNoisyCount}`);
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

function isExplicitDomainCandidateLabel(label: LabelInput): boolean {
  const provenance = label.provenance?.source;
  if (!provenance) return true; // user-supplied input with no provenance attached
  return provenance !== 'classifier';
}
