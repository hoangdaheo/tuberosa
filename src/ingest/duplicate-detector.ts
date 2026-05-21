import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeInput, StoredKnowledge } from '../types.js';
import { DuplicateIngestionError } from '../errors.js';
import { getRetrievalPolicy } from '../retrieval/policy.js';

export interface DuplicateDecision {
  decision: 'allow' | 'flag' | 'block' | 'reject';
  jaccard: number;
  cosine: number;
  match?: StoredKnowledge;
  reason?: string;
}

export class DuplicateDetector {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly models: ModelProvider,
  ) {}

  async assess(input: KnowledgeInput): Promise<DuplicateDecision> {
    const policy = getRetrievalPolicy();
    if (policy.duplicateDetector === 'off') {
      return { decision: 'allow', jaccard: 0, cosine: 0 };
    }

    const candidates = await this.collectCandidates(input);
    if (candidates.length === 0) {
      return { decision: 'allow', jaccard: 0, cosine: 0 };
    }

    const incomingTokens = sevenGramTokens(input.content);
    const incomingEmbedding = await this.models.embed(buildEmbedSurface(input));

    let best: { jaccard: number; cosine: number; match: StoredKnowledge } | null = null;
    for (const candidate of candidates) {
      const jaccard = jaccardSimilarity(incomingTokens, sevenGramTokens(candidate.content));
      const cosine = await safeCosineFor(candidate, incomingEmbedding, this.models);
      if (!best || combinedScore(jaccard, cosine) > combinedScore(best.jaccard, best.cosine)) {
        best = { jaccard, cosine, match: candidate };
      }
    }

    if (!best) {
      return { decision: 'allow', jaccard: 0, cosine: 0 };
    }

    const jaccardHit = best.jaccard >= policy.duplicateJaccardThreshold;
    const cosineHit = best.cosine >= policy.duplicateCosineThreshold;

    if (jaccardHit && cosineHit) {
      return {
        decision: 'reject',
        jaccard: best.jaccard,
        cosine: best.cosine,
        match: best.match,
        reason: `Auto-reject: textual and semantic duplicate of ${best.match.id}.`,
      };
    }

    if (jaccardHit) {
      return {
        decision: 'block',
        jaccard: best.jaccard,
        cosine: best.cosine,
        match: best.match,
        reason: `Textual near-duplicate of ${best.match.id}; jaccard=${best.jaccard.toFixed(3)}.`,
      };
    }

    if (cosineHit) {
      return {
        decision: 'flag',
        jaccard: best.jaccard,
        cosine: best.cosine,
        match: best.match,
        reason: `Semantic near-duplicate of ${best.match.id}; cosine=${best.cosine.toFixed(3)}.`,
      };
    }

    return { decision: 'allow', jaccard: best.jaccard, cosine: best.cosine, match: best.match };
  }

  async assertNotDuplicate(input: KnowledgeInput): Promise<DuplicateDecision> {
    const decision = await this.assess(input);
    if (decision.decision === 'reject' || decision.decision === 'block') {
      throw new DuplicateIngestionError(decision.reason ?? 'Duplicate detected.', {
        decision: decision.decision,
        jaccard: decision.jaccard,
        cosine: decision.cosine,
        duplicateOf: decision.match?.id,
      });
    }
    return decision;
  }

  private async collectCandidates(input: KnowledgeInput): Promise<StoredKnowledge[]> {
    const items = await this.store.listKnowledge({
      project: input.project,
      status: 'approved',
      limit: 64,
    });
    return items.filter((item) => item.sourceUri !== input.sourceUri);
  }
}

function combinedScore(jaccard: number, cosine: number): number {
  return jaccard * 0.6 + cosine * 0.4;
}

export function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of smaller) {
    if (larger.has(value)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function sevenGramTokens(text: string, n = 7): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens = new Set<string>();
  if (normalized.length < n) {
    if (normalized.length > 0) {
      tokens.add(normalized);
    }
    return tokens;
  }
  for (let i = 0; i <= normalized.length - n; i += 1) {
    tokens.add(normalized.slice(i, i + n));
  }
  return tokens;
}

function buildEmbedSurface(input: KnowledgeInput): string {
  return [input.title, input.summary ?? '', input.content].filter(Boolean).join('\n');
}

async function safeCosineFor(candidate: StoredKnowledge, incoming: number[], models: ModelProvider): Promise<number> {
  try {
    const candidateEmbedding = await models.embed(buildEmbedSurfaceStored(candidate));
    return cosineSimilarity(incoming, candidateEmbedding);
  } catch {
    return 0;
  }
}

function buildEmbedSurfaceStored(candidate: StoredKnowledge): string {
  return [candidate.title, candidate.summary, candidate.content].filter(Boolean).join('\n');
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const len = Math.min(left.length, right.length);
  if (len === 0) return 0;
  let dot = 0;
  let normL = 0;
  let normR = 0;
  for (let i = 0; i < len; i += 1) {
    dot += left[i] * right[i];
    normL += left[i] * left[i];
    normR += right[i] * right[i];
  }
  if (normL === 0 || normR === 0) return 0;
  return dot / (Math.sqrt(normL) * Math.sqrt(normR));
}
