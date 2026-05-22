import type { ModelProvider } from '../model/provider.js';
import type { LabelInput, ReferenceInput } from '../types.js';
import { normalizeLabel } from '../util/text.js';

/**
 * Phase 6b — Local-heuristic write gate (Mem0 pattern, NO LLM call).
 *
 * Given a new reflection draft and the top-K duplicate candidates that already
 * cover overlapping ground (returned by KnowledgeStore.searchMemories), decide
 * whether the draft should be persisted as a new memory (`ADD`), merged into
 * an existing memory (`UPDATE`), supersede an existing memory (`DELETE`), or
 * skipped entirely (`NOOP`).
 *
 * The decision is deterministic — it never calls an LLM to choose. When a
 * ModelProvider is supplied, true vector cosine is computed from the draft's
 * summary+content embedding versus the candidate's content embedding. When
 * absent, the candidate's `rawScore` (already ranked by searchMemories) is
 * used as a proxy similarity in [0,1]. Both paths converge to the same
 * decision rules.
 *
 * The output is metadata-only: the AgentSessionService / ReflectionService
 * stamps it onto `draft.metadata.writeGate` and `evaluateGates` surfaces it as
 * a synthetic gate so reviewers see the recommendation. Auto-mutation is
 * deliberately out of scope.
 */
export type WriteGateDecision = 'ADD' | 'UPDATE' | 'NOOP' | 'DELETE';

export interface WriteGateScores {
  /** Best cosine (or proxy) similarity across all candidates. Range [0,1]. */
  cosine: number;
  /** Jaccard label overlap (file/symbol/error labels) against the closest candidate. */
  labelOverlap: number;
  /** Jaccard reference overlap (file/url URIs) against the closest candidate. */
  referenceOverlap: number;
  /** Days since the closest candidate's freshnessAt (or createdAt). */
  recencyDays: number;
}

export interface WriteGateInputCandidate {
  knowledgeId: string;
  title?: string;
  summary?: string;
  content?: string;
  contextualContent?: string;
  rawScore?: number;
  labels?: LabelInput[];
  references?: ReferenceInput[];
  freshnessAt?: string;
  createdAt?: string;
}

export interface WriteGateDraftSnapshot {
  title: string;
  summary: string;
  content: string;
  labels: LabelInput[];
  references: ReferenceInput[];
}

export interface WriteGateInput {
  draft: WriteGateDraftSnapshot;
  candidates: WriteGateInputCandidate[];
  models?: ModelProvider;
  now?: Date;
}

export interface WriteGateResult {
  decision: WriteGateDecision;
  scores: WriteGateScores;
  evidenceIds: string[];
  reason: string;
  closestKnowledgeId?: string;
}

const COSINE_NOOP_THRESHOLD = 0.92;
const LABEL_NOOP_THRESHOLD = 0.7;
const COSINE_NEAR_THRESHOLD = 0.8;
const LABEL_NEAR_THRESHOLD = 0.5;

export async function computeWriteGate(input: WriteGateInput): Promise<WriteGateResult> {
  const now = input.now ?? new Date();
  if (input.candidates.length === 0) {
    return {
      decision: 'ADD',
      scores: { cosine: 0, labelOverlap: 0, referenceOverlap: 0, recencyDays: Number.POSITIVE_INFINITY },
      evidenceIds: [],
      reason: 'No prior memories matched the draft topic.',
    };
  }

  const draftEmbedding = input.models
    ? await safeEmbed(input.models, `${input.draft.summary}\n${input.draft.content}`)
    : undefined;
  const cosineFn = await buildCosineFn(input.models, draftEmbedding);

  let best: { candidate: WriteGateInputCandidate; scores: WriteGateScores; contradicts: boolean; addsNovelFacts: boolean } | undefined;

  for (const candidate of input.candidates) {
    const cosine = await cosineFn(candidate);
    const labelOverlap = jaccardLabelOverlap(input.draft.labels, candidate.labels ?? []);
    const referenceOverlap = jaccardReferenceOverlap(input.draft.references, candidate.references ?? []);
    const recencyDays = daysBetween(candidate.freshnessAt ?? candidate.createdAt, now);
    const contradicts = detectContradiction(input.draft, candidate);
    const addsNovelFacts = draftAddsNovelFacts(input.draft, candidate);

    if (!best || cosine > best.scores.cosine) {
      best = {
        candidate,
        scores: { cosine, labelOverlap, referenceOverlap, recencyDays },
        contradicts,
        addsNovelFacts,
      };
    }
  }

  // Safe: candidates is non-empty here so the loop ran at least once.
  const { candidate, scores, contradicts, addsNovelFacts } = best!;

  if (scores.cosine >= COSINE_NOOP_THRESHOLD && scores.labelOverlap >= LABEL_NOOP_THRESHOLD) {
    return {
      decision: 'NOOP',
      scores,
      evidenceIds: [candidate.knowledgeId],
      closestKnowledgeId: candidate.knowledgeId,
      reason: `Existing memory ${truncateTitle(candidate.title)} covers this lesson (cosine ${scores.cosine.toFixed(2)}, label overlap ${scores.labelOverlap.toFixed(2)}).`,
    };
  }

  if (scores.cosine >= COSINE_NEAR_THRESHOLD && contradicts) {
    return {
      decision: 'DELETE',
      scores,
      evidenceIds: [candidate.knowledgeId],
      closestKnowledgeId: candidate.knowledgeId,
      reason: `Draft references conflicting evidence vs ${truncateTitle(candidate.title)}; propose superseding the old memory.`,
    };
  }

  if (scores.cosine >= COSINE_NEAR_THRESHOLD && scores.labelOverlap >= LABEL_NEAR_THRESHOLD && addsNovelFacts) {
    return {
      decision: 'UPDATE',
      scores,
      evidenceIds: [candidate.knowledgeId],
      closestKnowledgeId: candidate.knowledgeId,
      reason: `Draft adds new facts to existing memory ${truncateTitle(candidate.title)}; propose merging.`,
    };
  }

  return {
    decision: 'ADD',
    scores,
    evidenceIds: [],
    closestKnowledgeId: candidate.knowledgeId,
    reason: 'Closest existing memory diverges enough that a new entry is the right move.',
  };
}

async function buildCosineFn(
  models: ModelProvider | undefined,
  draftEmbedding: number[] | undefined,
): Promise<(candidate: WriteGateInputCandidate) => Promise<number>> {
  if (models && draftEmbedding) {
    return async (candidate) => {
      const text = candidate.contextualContent ?? candidate.content ?? `${candidate.title ?? ''}\n${candidate.summary ?? ''}`;
      if (!text.trim()) {
        return clampCosine(candidate.rawScore);
      }
      const candidateEmbedding = await safeEmbed(models, text);
      if (!candidateEmbedding || candidateEmbedding.length === 0) {
        return clampCosine(candidate.rawScore);
      }
      return cosineSimilarity(draftEmbedding, candidateEmbedding);
    };
  }
  return async (candidate) => clampCosine(candidate.rawScore);
}

async function safeEmbed(models: ModelProvider, text: string): Promise<number[] | undefined> {
  try {
    return await models.embed(text);
  } catch {
    return undefined;
  }
}

function clampCosine(rawScore: number | undefined): number {
  if (typeof rawScore !== 'number' || Number.isNaN(rawScore)) return 0;
  if (rawScore < 0) return 0;
  if (rawScore > 1) return 1;
  return rawScore;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < length; i += 1) {
    const l = left[i];
    const r = right[i];
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function jaccardLabelOverlap(left: LabelInput[], right: LabelInput[]): number {
  const leftKeys = new Set(left
    .filter((label) => label.type === 'file' || label.type === 'symbol' || label.type === 'error')
    .map(labelKey));
  const rightKeys = new Set(right
    .filter((label) => label.type === 'file' || label.type === 'symbol' || label.type === 'error')
    .map(labelKey));
  return jaccard(leftKeys, rightKeys);
}

function jaccardReferenceOverlap(left: ReferenceInput[], right: ReferenceInput[]): number {
  const leftKeys = new Set(left.map(referenceKey));
  const rightKeys = new Set(right.map(referenceKey));
  return jaccard(leftKeys, rightKeys);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const key of left) {
    if (right.has(key)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function labelKey(label: LabelInput): string {
  return `${label.type}:${normalizeLabel(label.value)}`;
}

function referenceKey(reference: ReferenceInput): string {
  return `${reference.type}:${normalizeLabel(reference.uri)}`;
}

function daysBetween(at: string | undefined, now: Date): number {
  if (!at) return Number.POSITIVE_INFINITY;
  const past = Date.parse(at);
  if (Number.isNaN(past)) return Number.POSITIVE_INFINITY;
  const deltaMs = Math.max(0, now.getTime() - past);
  return deltaMs / (1000 * 60 * 60 * 24);
}

/**
 * Phase 6b heuristic: draft contradicts candidate when they share at least one
 * file or symbol label but the file-URI references disagree on the *same
 * basename*. e.g. draft says `src/email/sender.ts` for symbol X while the
 * existing memory references `src/legacy/email/sender.ts` for X — same role,
 * different path.
 */
function detectContradiction(
  draft: WriteGateDraftSnapshot,
  candidate: WriteGateInputCandidate,
): boolean {
  const sharedLabel = sharesAnyLabel(draft.labels, candidate.labels ?? []);
  if (!sharedLabel) return false;
  const draftFiles = draft.references.filter((ref) => ref.type === 'file').map((ref) => ref.uri);
  const candidateFiles = (candidate.references ?? []).filter((ref) => ref.type === 'file').map((ref) => ref.uri);
  if (draftFiles.length === 0 || candidateFiles.length === 0) return false;
  for (const draftFile of draftFiles) {
    const draftBase = basename(draftFile);
    if (!draftBase) continue;
    for (const candidateFile of candidateFiles) {
      if (basename(candidateFile) === draftBase && draftFile !== candidateFile) {
        return true;
      }
    }
  }
  return false;
}

function sharesAnyLabel(left: LabelInput[], right: LabelInput[]): boolean {
  const leftKeys = new Set(left
    .filter((label) => label.type === 'file' || label.type === 'symbol')
    .map(labelKey));
  for (const label of right) {
    if (label.type !== 'file' && label.type !== 'symbol') continue;
    if (leftKeys.has(labelKey(label))) return true;
  }
  return false;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * Phase 6b heuristic: a draft adds novel facts when it contains lexical
 * tokens of meaningful length that are absent from every candidate's body.
 * A small ratio threshold (≥ 0.2 of draft tokens unique) keeps the signal
 * resistant to incidental wording overlap.
 */
function draftAddsNovelFacts(
  draft: WriteGateDraftSnapshot,
  candidate: WriteGateInputCandidate,
): boolean {
  const draftTokens = significantTokens(`${draft.title}\n${draft.summary}\n${draft.content}`);
  if (draftTokens.size === 0) return false;
  const candidateText = `${candidate.title ?? ''}\n${candidate.summary ?? ''}\n${candidate.content ?? ''}\n${candidate.contextualContent ?? ''}`;
  const candidateTokens = significantTokens(candidateText);
  let novel = 0;
  for (const token of draftTokens) {
    if (!candidateTokens.has(token)) novel += 1;
  }
  return novel / draftTokens.size >= 0.2;
}

function significantTokens(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9_./:-]{4,}/g) ?? [];
  return new Set(tokens);
}

function truncateTitle(title: string | undefined): string {
  const value = title?.trim() ?? '';
  if (value.length <= 60) return value;
  return `${value.slice(0, 57)}…`;
}
