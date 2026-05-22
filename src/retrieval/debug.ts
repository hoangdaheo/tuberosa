import type {
  ContextPack,
  FilterEvent,
  QueryRewriteResult,
  RankedCandidate,
  RerankDecision,
  RetrievalDebugCandidate,
  RetrievalDebugStage,
  RetrievalDebugStageName,
  RetrievalDebugTimingName,
  RetrievalDebugTrace,
  ScoreBreakdown,
  SearchCandidate,
  SuppressionEvent,
} from '../types.js';

interface RetrievalDebugBuilderInput {
  fingerprint: string;
  cacheKey: string;
  cacheHit: boolean;
  cacheBypassed: boolean;
  searchLimit: number;
  rerankLimit: number;
  tokenBudget: number;
  rejectedKnowledgeIds: string[];
}

export class RetrievalDebugBuilder {
  private readonly timingsMs: Partial<Record<RetrievalDebugTimingName, number>> = {};
  private readonly stages: RetrievalDebugStage[] = [];
  private queryRewrite?: RetrievalDebugTrace['queryRewrite'];
  private providerRerank?: RetrievalDebugTrace['providerRerank'];
  private fusionBreakdown?: Map<string, ScoreBreakdown>;
  private readonly filterEvents: FilterEvent[] = [];
  private readonly suppressionEvents: SuppressionEvent[] = [];

  constructor(private readonly input: RetrievalDebugBuilderInput) {}

  recordFusionBreakdown(breakdown: Map<string, ScoreBreakdown>): void {
    this.fusionBreakdown = breakdown;
  }

  recordRerankScores(candidates: Array<RankedCandidate>): void {
    if (!this.fusionBreakdown) {
      return;
    }
    for (const candidate of candidates) {
      const entry = this.fusionBreakdown.get(candidate.knowledgeId);
      if (entry) {
        entry.rerankScore = candidate.rerankScore;
        entry.rerankDelta = candidate.rerankScore - entry.fusedScore;
      }
    }
  }

  recordFitScores(candidates: Array<RankedCandidate>): void {
    if (!this.fusionBreakdown) {
      return;
    }
    for (const candidate of candidates) {
      const entry = this.fusionBreakdown.get(candidate.knowledgeId);
      if (entry && typeof candidate.fitScore === 'number') {
        entry.fitScore = candidate.fitScore;
      }
    }
  }

  recordFilterEvent(event: FilterEvent): void {
    this.filterEvents.push(event);
  }

  recordSuppressionEvent(event: SuppressionEvent): void {
    this.suppressionEvents.push(event);
    if (this.fusionBreakdown) {
      const entry = this.fusionBreakdown.get(event.knowledgeId);
      if (entry) {
        entry.suppressionDeltas.push(event);
      }
    }
  }

  recordTiming(name: RetrievalDebugTimingName, startedAt: number): void {
    this.timingsMs[name] = elapsedMs(startedAt);
  }

  recordElapsed(name: RetrievalDebugTimingName, milliseconds: number): void {
    this.timingsMs[name] = Math.max(0, milliseconds);
  }

  recordStage(name: RetrievalDebugStageName, candidates: Array<SearchCandidate | RankedCandidate>): void {
    this.stages.push({
      name,
      candidateCount: candidates.length,
      candidates: candidates.map(toDebugCandidate),
    });
  }

  recordQueryRewrite(input: {
    originalLexicalQuery: string;
    rewrite?: QueryRewriteResult;
    addedExactTerms: string[];
    /** Phase 7 — gating + probe metadata. Recorded even when the rewrite was skipped. */
    gated?: boolean;
    probeConfidence?: number;
    probeThreshold?: number;
    skipped?: 'probe_confident';
  }): void {
    // Phase 7 — also persist the gating decision when the rewrite was skipped
    // (no rewrite payload, but the gate ran). That signal is load-bearing for
    // debugging "why did the rewrite not fire on this query".
    if (!input.rewrite && !input.gated) {
      return;
    }

    this.queryRewrite = {
      originalLexicalQuery: input.originalLexicalQuery,
      rewrittenLexicalQuery: input.rewrite?.lexicalQuery ?? input.originalLexicalQuery,
      addedExactTerms: input.addedExactTerms,
      reasons: input.rewrite?.reasons ?? [],
      model: input.rewrite?.model,
      gated: input.gated,
      probeConfidence: input.probeConfidence,
      probeThreshold: input.probeThreshold,
      skipped: input.skipped,
    };
  }

  recordProviderRerank(input: {
    model?: string;
    inputKnowledgeIds: string[];
    decisions?: RerankDecision[];
  }): void {
    if (!input.decisions?.length && !input.model) {
      return;
    }

    this.providerRerank = {
      model: input.model,
      candidateCount: input.inputKnowledgeIds.length,
      inputKnowledgeIds: input.inputKnowledgeIds,
      decisions: input.decisions ?? [],
    };
  }

  buildTrace(pack: ContextPack): RetrievalDebugTrace {
    return {
      fingerprint: this.input.fingerprint,
      cache: {
        key: this.input.cacheKey,
        hit: this.input.cacheHit,
        bypassed: this.input.cacheBypassed,
      },
      limits: {
        searchLimit: this.input.searchLimit,
        rerankLimit: this.input.rerankLimit,
        tokenBudget: this.input.tokenBudget,
      },
      filters: {
        rejectedKnowledgeIds: this.input.rejectedKnowledgeIds,
        decisions: [
          ...this.input.rejectedKnowledgeIds.map((knowledgeId) => ({
            type: 'rejected_knowledge' as const,
            action: 'excluded_before_search' as const,
            knowledgeId,
            reason: 'Search input rejectedKnowledgeIds excluded this knowledge item from candidate searches.',
          })),
          ...this.input.rejectedKnowledgeIds.map((knowledgeId) => ({
            type: 'stale_feedback_retry' as const,
            action: 'retry_exclusion' as const,
            knowledgeId,
            reason: 'Rejected, stale, or irrelevant feedback retries pass rejectedKnowledgeIds into the next search.',
          })),
        ],
      },
      queryRewrite: this.queryRewrite,
      providerRerank: this.providerRerank,
      timingsMs: this.timingsMs,
      stages: this.stages,
      selected: Object.fromEntries(
        pack.sections.map((section) => [section.name, section.items.map(toDebugCandidate)]),
      ) as RetrievalDebugTrace['selected'],
      fusionBreakdown: this.fusionBreakdown ? [...this.fusionBreakdown.values()] : undefined,
      filterEvents: this.filterEvents.length > 0 ? this.filterEvents : undefined,
      suppressionEvents: this.suppressionEvents.length > 0 ? this.suppressionEvents : undefined,
    };
  }
}

export async function timed<T>(
  name: RetrievalDebugTimingName,
  work: Promise<T>,
  debug?: RetrievalDebugBuilder,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await work;
  } finally {
    debug?.recordTiming(name, startedAt);
  }
}

export function stripDebugTrace(pack: ContextPack): ContextPack {
  const { debug: _debug, ...withoutDebug } = pack;
  return withoutDebug;
}

function toDebugCandidate(candidate: SearchCandidate | RankedCandidate): RetrievalDebugCandidate {
  const ranked = candidate as Partial<RankedCandidate>;
  const debugCandidate: RetrievalDebugCandidate = {
    knowledgeId: candidate.knowledgeId,
    chunkId: candidate.chunkId,
    title: candidate.title,
    itemType: candidate.itemType,
    project: candidate.project,
    source: candidate.source,
    rank: candidate.rank,
    rawScore: roundScore(candidate.rawScore),
    trustLevel: candidate.trustLevel,
    tokenEstimate: candidate.tokenEstimate,
    matchReasons: ranked.matchReasons ?? [],
    references: candidate.references,
  };

  if (typeof ranked.fusedScore === 'number') {
    debugCandidate.fusedScore = roundScore(ranked.fusedScore);
  }
  if (typeof ranked.rerankScore === 'number') {
    debugCandidate.rerankScore = roundScore(ranked.rerankScore);
  }
  if (typeof ranked.finalScore === 'number') {
    debugCandidate.finalScore = roundScore(ranked.finalScore);
  }
  if (typeof ranked.fitScore === 'number') {
    debugCandidate.fitScore = roundScore(ranked.fitScore);
  }
  if (ranked.fitReasons) {
    debugCandidate.fitReasons = ranked.fitReasons;
  }
  if (ranked.fitMissingSignals) {
    debugCandidate.fitMissingSignals = ranked.fitMissingSignals;
  }
  if (ranked.evidenceCategory) {
    debugCandidate.evidenceCategory = ranked.evidenceCategory;
  }
  if (ranked.evidenceStrength) {
    debugCandidate.evidenceStrength = ranked.evidenceStrength;
  }
  if (ranked.usefulnessReason) {
    debugCandidate.usefulnessReason = ranked.usefulnessReason;
  }
  if (Array.isArray(candidate.metadata?.graphPaths)) {
    debugCandidate.graphPaths = candidate.metadata.graphPaths
      .filter((path): path is Record<string, unknown> => Boolean(path) && typeof path === 'object')
      .slice(0, 3);
  }

  return debugCandidate;
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
