import type {
  ContextPack,
  QueryRewriteResult,
  RankedCandidate,
  RerankDecision,
  RetrievalDebugCandidate,
  RetrievalDebugStage,
  RetrievalDebugStageName,
  RetrievalDebugTimingName,
  RetrievalDebugTrace,
  SearchCandidate,
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

  constructor(private readonly input: RetrievalDebugBuilderInput) {}

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
  }): void {
    if (!input.rewrite) {
      return;
    }

    this.queryRewrite = {
      originalLexicalQuery: input.originalLexicalQuery,
      rewrittenLexicalQuery: input.rewrite.lexicalQuery,
      addedExactTerms: input.addedExactTerms,
      reasons: input.rewrite.reasons ?? [],
      model: input.rewrite.model,
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

  return debugCandidate;
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
