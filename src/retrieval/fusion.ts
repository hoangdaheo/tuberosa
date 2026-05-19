import type { ClassifiedQuery, RankedCandidate, SearchCandidate } from '../types.js';
import { clamp } from '../util/text.js';

const SOURCE_WEIGHTS: Record<SearchCandidate['source'], number> = {
  metadata: 1.15,
  reference: 1.12,
  graph: 1.1,
  memory: 1.08,
  lexical: 1,
  vector: 0.92,
};

export function fuseCandidates(groups: SearchCandidate[][], classified: ClassifiedQuery): RankedCandidate[] {
  const byKnowledge = new Map<string, RankedCandidate>();

  for (const group of groups) {
    for (const candidate of group) {
      const existing = byKnowledge.get(candidate.knowledgeId);
      const sourceBoost = sourceWeight(candidate, classified);
      const contribution = sourceBoost / (60 + Math.max(1, candidate.rank));

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

  return [...byKnowledge.values()]
    .map((candidate) => ({
      ...candidate,
      fusedScore: clamp(candidate.fusedScore / maxScore, 0, 1),
    }))
    .sort((left, right) => right.fusedScore - left.fusedScore);
}

function sourceWeight(candidate: SearchCandidate, classified: ClassifiedQuery): number {
  let weight = SOURCE_WEIGHTS[candidate.source];

  if (classified.files.length || classified.symbols.length || classified.errors.length) {
    if (candidate.source === 'metadata' || candidate.source === 'lexical' || candidate.source === 'graph') {
      weight += 0.18;
    }
    if (candidate.source === 'vector') {
      weight -= 0.08;
    }
  }

  if (classified.taskType === 'debugging' && ['bugfix', 'memory', 'workflow'].includes(candidate.itemType)) {
    weight += 0.16;
  }

  if (classified.taskType === 'planning' && ['spec', 'wiki', 'workflow'].includes(candidate.itemType)) {
    weight += 0.12;
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
