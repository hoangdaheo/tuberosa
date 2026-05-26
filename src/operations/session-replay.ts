import type {
  ContextFit,
  ContextPack,
  RetrievalDebugCandidate,
  RetrievalDebugStageName,
  RetrievalDebugTimingName,
} from '../types.js';
import type { KnowledgeStore } from '../storage/store.js';

export interface SessionReplayCandidate {
  id: string;
  score: number;
  rank?: number;
  title?: string;
  source?: string;
}

export interface SessionReplayBundle {
  sessionId: string;
  recordedAt?: string;
  classifier: Record<string, unknown>;
  sourceCandidates: Partial<Record<RetrievalDebugStageName, SessionReplayCandidate[]>>;
  fusionOrder: Array<{ id: string; rank: number; score: number }>;
  rerankDeltas: Array<{ id: string; before: number; after: number }>;
  adjustments: Array<{ id: string; reason: string; delta: number }>;
  contextFit: ContextFit;
  pack: {
    essential: Array<{ id: string }>;
    supporting: Array<{ id: string }>;
    optional: Array<{ id: string }>;
  };
  timings: {
    totalMs: number;
    stageMs: Partial<Record<RetrievalDebugTimingName, number>>;
  };
}

const SOURCE_STAGES: RetrievalDebugStageName[] = ['metadata', 'lexical', 'memory', 'vector', 'graph', 'worktree'];

export class SessionReplayService {
  constructor(private readonly store: KnowledgeStore) {}

  async writeReplay(bundle: SessionReplayBundle): Promise<void> {
    await this.store.writeSessionReplay({
      ...bundle,
      recordedAt: bundle.recordedAt ?? new Date().toISOString(),
    });
  }

  async readReplay(sessionId: string): Promise<SessionReplayBundle | null> {
    return this.store.readSessionReplay(sessionId);
  }
}

export function sessionReplayFromContextPack(
  sessionId: string,
  pack: ContextPack,
): SessionReplayBundle | undefined {
  if (!pack.debug || !pack.contextFit) {
    return undefined;
  }

  const stages = new Map(pack.debug.stages.map((stage) => [stage.name, stage.candidates]));
  const sourceCandidates: SessionReplayBundle['sourceCandidates'] = {};
  for (const stage of SOURCE_STAGES) {
    sourceCandidates[stage] = (stages.get(stage) ?? []).map(toReplayCandidate);
  }

  const fusionCandidates = stages.get('fusion') ?? [];
  const fusionOrder = fusionCandidates.length > 0
    ? fusionCandidates.map((candidate, index) => ({
      id: candidate.knowledgeId,
      rank: candidate.rank || index + 1,
      score: scoreForCandidate(candidate),
    }))
    : pack.sections
      .flatMap((section) => section.items)
      .map((item, index) => ({
        id: item.knowledgeId,
        rank: index + 1,
        score: item.finalScore,
      }));

  return {
    sessionId,
    recordedAt: new Date().toISOString(),
    classifier: pack.classified as unknown as Record<string, unknown>,
    sourceCandidates,
    fusionOrder,
    rerankDeltas: rerankDeltas(pack),
    adjustments: (pack.debug.suppressionEvents ?? []).map((event) => ({
      id: event.knowledgeId,
      reason: event.reason,
      delta: event.deltaScore,
    })),
    contextFit: pack.contextFit,
    pack: {
      essential: sectionIds(pack, 'essential'),
      supporting: sectionIds(pack, 'supporting'),
      optional: sectionIds(pack, 'optional'),
    },
    timings: {
      totalMs: pack.debug.timingsMs.total ?? 0,
      stageMs: pack.debug.timingsMs,
    },
  };
}

export function stripReplayDebug(pack: ContextPack): ContextPack {
  if (!pack.debug) {
    return pack;
  }
  const { debug: _debug, ...rest } = pack;
  return rest;
}

function toReplayCandidate(candidate: RetrievalDebugCandidate): SessionReplayCandidate {
  return {
    id: candidate.knowledgeId,
    rank: candidate.rank,
    title: candidate.title,
    source: candidate.source,
    score: scoreForCandidate(candidate),
  };
}

function scoreForCandidate(candidate: RetrievalDebugCandidate): number {
  return candidate.finalScore ?? candidate.rerankScore ?? candidate.fusedScore ?? candidate.rawScore ?? 0;
}

function rerankDeltas(pack: ContextPack): SessionReplayBundle['rerankDeltas'] {
  if (pack.debug?.fusionBreakdown?.length) {
    return pack.debug.fusionBreakdown.map((breakdown) => ({
      id: breakdown.knowledgeId,
      before: breakdown.fusedScore,
      after: breakdown.rerankScore,
    }));
  }

  const reranked = pack.debug?.stages.find((stage) => stage.name === 'rerank')?.candidates ?? [];
  return reranked
    .filter((candidate) => candidate.fusedScore !== undefined && candidate.rerankScore !== undefined)
    .map((candidate) => ({
      id: candidate.knowledgeId,
      before: candidate.fusedScore ?? 0,
      after: candidate.rerankScore ?? 0,
    }));
}

function sectionIds(pack: ContextPack, sectionName: keyof SessionReplayBundle['pack']): Array<{ id: string }> {
  return (pack.sections.find((section) => section.name === sectionName)?.items ?? [])
    .map((item) => ({ id: item.knowledgeId }));
}
