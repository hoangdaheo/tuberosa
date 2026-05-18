import { randomUUID } from 'node:crypto';
import type { ClassifiedQuery, ContextFit, ContextPack, RankedCandidate } from '../types.js';
import { clamp, truncate } from '../util/text.js';

const ANCHORED_MIN_FINAL_SCORE = 0.6;
const GENERAL_MIN_FINAL_SCORE = 0.35;
const GRAPH_EVIDENCE_MIN_RAW_SCORE = 0.45;
export const DEFAULT_DEEP_CONTEXT_BUDGET = 60_000;
export const MIN_DEEP_CONTEXT_BUDGET = 30_000;
export const MAX_DEEP_CONTEXT_BUDGET = 100_000;

export interface AssembleContextPackInput {
  queryId?: string;
  project?: string;
  prompt: string;
  classified: ClassifiedQuery;
  candidates: RankedCandidate[];
  tokenBudget: number;
  rejectedKnowledgeIds?: string[];
  contextFit?: ContextFit;
}

export function normalizeDeepContextBudget(value: number | undefined): number {
  return Math.round(clamp(value ?? DEFAULT_DEEP_CONTEXT_BUDGET, MIN_DEEP_CONTEXT_BUDGET, MAX_DEEP_CONTEXT_BUDGET));
}

export function assembleContextPack(input: AssembleContextPackInput): ContextPack {
  const budget = Math.max(900, input.tokenBudget);
  const essentialBudget = Math.ceil(budget * 0.52);
  const supportingBudget = Math.ceil(budget * 0.34);
  const optionalBudget = budget - essentialBudget - supportingBudget;

  const accepted = filterAcceptedCandidates(input);
  const essential = takeWithinBudget(accepted, essentialBudget, 0, 4);
  const supporting = takeWithinBudget(without(accepted, essential), supportingBudget, 0, 6);
  const optional = takeWithinBudget(without(accepted, [...essential, ...supporting]), optionalBudget, 0, 8);

  const topScore = accepted[0]?.finalScore ?? 0;
  const density = Math.min(1, accepted.length / 6);
  const fitScore = input.contextFit?.fitScore ?? 0;
  const confidence = clamp(topScore * 0.56 + input.classified.confidence * 0.16 + density * 0.08 + fitScore * 0.2, 0, 0.99);

  return {
    id: randomUUID(),
    queryId: input.queryId,
    project: input.project ?? input.classified.project,
    prompt: input.prompt,
    confidence,
    status: 'proposed',
    classified: input.classified,
    contextFit: input.contextFit,
    sections: [
      { name: 'essential', items: sanitizeItems(essential), tokenEstimate: sumTokens(essential) },
      { name: 'supporting', items: sanitizeItems(supporting), tokenEstimate: sumTokens(supporting) },
      { name: 'optional', items: sanitizeItems(optional), tokenEstimate: sumTokens(optional) },
    ],
    rejectedKnowledgeIds: input.rejectedKnowledgeIds ?? [],
    createdAt: new Date().toISOString(),
  };
}

function filterAcceptedCandidates(input: AssembleContextPackInput): RankedCandidate[] {
  const rejectedIds = new Set(input.rejectedKnowledgeIds ?? []);
  const filtered = input.candidates.filter((candidate) => !rejectedIds.has(candidate.knowledgeId));
  const threshold = hasAnchors(input.classified) ? ANCHORED_MIN_FINAL_SCORE : GENERAL_MIN_FINAL_SCORE;
  const strong = filtered.filter((candidate, index) => (
    index === 0
    || candidate.finalScore >= threshold
    || isGraphEvidence(candidate)
  ));
  return strong.length ? strong : filtered.slice(0, 1);
}

function isGraphEvidence(candidate: RankedCandidate): boolean {
  return candidate.source === 'graph'
    && candidate.rawScore >= GRAPH_EVIDENCE_MIN_RAW_SCORE
    && !candidate.matchReasons.some((reason) => reason.startsWith('suppression:superseded:'));
}

function hasAnchors(classified: ClassifiedQuery): boolean {
  return Boolean(
    classified.files.length
    || classified.symbols.length
    || classified.errors.length
    || classified.businessAreas.length
    || classified.technologies.length,
  );
}

function takeWithinBudget(candidates: RankedCandidate[], budget: number, min: number, max: number): RankedCandidate[] {
  const selected: RankedCandidate[] = [];
  let tokens = 0;

  for (const candidate of candidates) {
    if (selected.length >= max) {
      break;
    }

    const itemTokens = Math.min(candidate.tokenEstimate, budget);
    if (selected.length >= min && tokens + itemTokens > budget) {
      continue;
    }

    selected.push(candidate);
    tokens += itemTokens;
  }

  return selected;
}

function without(candidates: RankedCandidate[], removed: RankedCandidate[]): RankedCandidate[] {
  const removedIds = new Set(removed.map((candidate) => candidate.knowledgeId));
  return candidates.filter((candidate) => !removedIds.has(candidate.knowledgeId));
}

function sanitizeItems(items: RankedCandidate[]): RankedCandidate[] {
  return items.map((item) => ({
    ...item,
    content: truncate(item.content, 2800),
    contextualContent: truncate(item.contextualContent, 3600),
  }));
}

function sumTokens(items: RankedCandidate[]): number {
  return items.reduce((sum, item) => sum + item.tokenEstimate, 0);
}
