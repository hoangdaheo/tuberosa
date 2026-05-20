import type {
  ClassifiedQuery,
  FusionContribution,
  FusionContributionStage,
  KnowledgeItemType,
  RankedCandidate,
  ScoreBreakdown,
  SearchCandidate,
} from '../types.js';
import { clamp } from '../util/text.js';
import { getRetrievalPolicy } from './policy.js';

export interface FuseOptions {
  collectBreakdown?: boolean;
}

export interface FuseResult {
  ranked: RankedCandidate[];
  breakdown?: Map<string, ScoreBreakdown>;
}

export function fuseCandidates(
  groups: SearchCandidate[][],
  classified: ClassifiedQuery,
): RankedCandidate[];
export function fuseCandidates(
  groups: SearchCandidate[][],
  classified: ClassifiedQuery,
  options: FuseOptions,
): FuseResult;
export function fuseCandidates(
  groups: SearchCandidate[][],
  classified: ClassifiedQuery,
  options?: FuseOptions,
): RankedCandidate[] | FuseResult {
  const byKnowledge = new Map<string, RankedCandidate>();
  const breakdown = options?.collectBreakdown ? new Map<string, ScoreBreakdown>() : undefined;

  for (const group of groups) {
    for (const candidate of group) {
      const existing = byKnowledge.get(candidate.knowledgeId);
      const sourceBoost = sourceWeight(candidate, classified);
      const contribution = sourceBoost / (60 + Math.max(1, candidate.rank));

      if (breakdown) {
        const entry = breakdown.get(candidate.knowledgeId) ?? createBreakdown(candidate.knowledgeId);
        entry.contributions.push(buildContribution(candidate, sourceBoost, contribution));
        entry.fusedScoreBeforeNormalize += contribution;
        breakdown.set(candidate.knowledgeId, entry);
      }

      if (!existing) {
        byKnowledge.set(candidate.knowledgeId, {
          ...candidate,
          fusedScore: contribution,
          rerankScore: 0,
          finalScore: 0,
          matchReasons: matchReasons(candidate, classified),
        });
        continue;
      }

      const keepExistingChunk = existing.rawScore >= candidate.rawScore;
      byKnowledge.set(candidate.knowledgeId, {
        ...(keepExistingChunk ? existing : { ...existing, ...candidate }),
        fusedScore: existing.fusedScore + contribution,
        rawScore: Math.max(existing.rawScore, candidate.rawScore),
        matchReasons: [...new Set([...existing.matchReasons, ...matchReasons(candidate, classified)])],
      });
    }
  }

  const maxScore = Math.max(...[...byKnowledge.values()].map((candidate) => candidate.fusedScore), 0.0001);

  const ranked = [...byKnowledge.values()]
    .map((candidate) => ({
      ...candidate,
      fusedScore: clamp(candidate.fusedScore / maxScore, 0, 1),
    }))
    .sort((left, right) => right.fusedScore - left.fusedScore);

  if (!breakdown) {
    return ranked;
  }

  for (const candidate of ranked) {
    const entry = breakdown.get(candidate.knowledgeId);
    if (entry) {
      entry.fusedScore = candidate.fusedScore;
    }
  }

  return { ranked, breakdown };
}

function buildContribution(
  candidate: SearchCandidate,
  sourceWeightValue: number,
  contribution: number,
): FusionContribution {
  return {
    source: candidate.source as FusionContributionStage,
    rank: candidate.rank,
    rawScore: candidate.rawScore,
    sourceWeight: sourceWeightValue,
    contribution,
  };
}

function createBreakdown(knowledgeId: string): ScoreBreakdown {
  return {
    knowledgeId,
    contributions: [],
    fusedScoreBeforeNormalize: 0,
    fusedScore: 0,
    rerankScore: 0,
    rerankDelta: 0,
    suppressionDeltas: [],
  };
}

function sourceWeight(candidate: SearchCandidate, classified: ClassifiedQuery): number {
  const policy = getRetrievalPolicy();
  let weight = policy.sourceWeights[candidate.source] ?? 1;

  const hasHardSignal = classified.files.length || classified.symbols.length || classified.errors.length;
  if (hasHardSignal) {
    if (policy.hardSignalBoost.sources.includes(candidate.source)) {
      weight += policy.hardSignalBoost.bonus;
    }
    if (candidate.source === 'vector') {
      weight += policy.hardSignalVectorPenalty;
    }
  }

  for (const boost of policy.taskItemTypeBoosts) {
    if (classified.taskType === boost.taskType && (boost.itemTypes as KnowledgeItemType[]).includes(candidate.itemType)) {
      weight += boost.bonus;
    }
  }

  return weight;
}

function matchReasons(candidate: SearchCandidate, classified: ClassifiedQuery): string[] {
  const reasons = [`${candidate.source} match`];
  const text = `${candidate.title} ${candidate.summary} ${candidate.contextualContent} ${candidate.references.map((reference) => reference.uri).join(' ')}`.toLowerCase();

  const labelsByType = new Map<string, string[]>();
  for (const label of candidate.labels) {
    const key = String(label.type ?? '');
    const val = String(label.value ?? '').toLowerCase();
    const existing = labelsByType.get(key);
    if (existing) {
      existing.push(val);
    } else {
      labelsByType.set(key, [val]);
    }
  }

  for (const file of classified.files) {
    const fileLower = file.toLowerCase();
    const fileLabels = labelsByType.get('file') ?? [];
    const labelMatch = fileLabels.some((lv) => lv === fileLower || lv.endsWith(`/${fileLower}`) || lv.endsWith(fileLower));
    if (text.includes(fileLower) || labelMatch) {
      reasons.push(`file:${file}`);
    }
  }

  for (const symbol of classified.symbols) {
    const symbolLower = symbol.toLowerCase();
    const symbolLabels = labelsByType.get('symbol') ?? [];
    if (text.includes(symbolLower) || symbolLabels.includes(symbolLower)) {
      reasons.push(`symbol:${symbol}`);
    }
  }

  for (const error of classified.errors) {
    const errorLower = error.toLowerCase();
    const errorLabels = labelsByType.get('error') ?? [];
    if (text.includes(errorLower) || errorLabels.includes(errorLower)) {
      reasons.push(`error:${error}`);
    }
  }

  if (candidate.itemType === 'memory') {
    reasons.push('prior approved memory');
  }

  if (candidate.itemType === 'rule') {
    reasons.push('standing rule');
  }

  return [...new Set(reasons)];
}
