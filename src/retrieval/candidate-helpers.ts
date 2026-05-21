import type { RankedCandidate, SearchCandidate } from '../types.js';

export interface CandidateTextOptions {
  /** When true, prepends knowledgeId to the searchable text (used by pack-evidence checks). */
  includeKnowledgeId?: boolean;
}

const plainCache = new WeakMap<RankedCandidate | SearchCandidate, string>();
const withIdCache = new WeakMap<RankedCandidate | SearchCandidate, string>();

/**
 * Build the lowercase searchable text for a candidate — title, summary, content, contextual content,
 * labels, references, and metadata. Memoized per candidate object so repeated filter/sort passes
 * over the same list don't rebuild the string on every comparison.
 */
export function candidateText(
  candidate: RankedCandidate | SearchCandidate,
  options: CandidateTextOptions = {},
): string {
  const cache = options.includeKnowledgeId ? withIdCache : plainCache;
  const hit = cache.get(candidate);
  if (hit !== undefined) {
    return hit;
  }

  const parts: string[] = [];
  if (options.includeKnowledgeId) {
    parts.push(candidate.knowledgeId);
  }
  parts.push(
    candidate.title,
    candidate.summary,
    candidate.content,
    candidate.contextualContent,
    candidate.labels.map((label) => `${label.type}:${label.value}`).join(' '),
    candidate.references.map((reference) => reference.uri).join(' '),
    JSON.stringify(candidate.metadata ?? {}),
  );

  const text = parts.join(' ').toLowerCase();
  cache.set(candidate, text);
  return text;
}
