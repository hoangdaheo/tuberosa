import type { ClassifiedQuery, ContextFit, FitDiagnostics, RankedCandidate, TaskType } from '../types.js';
import { clamp, metadataString, normalizeLabel, sameSignal } from '../util/text.js';
import { candidateText } from './candidate-helpers.js';
import { hasDomainMismatch } from './classifier.js';
import { contextFitConfigFor, coverageProfileFor, freshnessWindowFor, getRetrievalPolicy } from './policy.js';

const TOP_CANDIDATE_LIMIT = 6;
const CURRENT_FRESHNESS_BONUS = 0.05;
const AGING_PENALTY = -0.04;

/**
 * Phase 3 — optional signal flowing in from the retrieval service describing whether
 * the reranker ran successfully. When `rerankerAvailable: false`, the evaluator
 * downgrades the fit status to `needs_confirmation` and records the reason, instead
 * of letting trust collapse silently.
 */
export interface ContextFitSignal {
  rerankerAvailable?: boolean;
  rerankerError?: string;
  /** Phase 5 placeholder — when populated, scores the worktree contribution in [0,1]. */
  worktreeMatchScore?: number;
}

interface ContextFitEvaluationInput {
  project?: string;
  classified: ClassifiedQuery;
  candidates: RankedCandidate[];
  rejectedKnowledgeIds?: string[];
  now?: Date;
  signal?: ContextFitSignal;
}

interface ContextFitEvaluation {
  candidates: RankedCandidate[];
  contextFit: ContextFit;
}

interface CandidateFitResult {
  candidate: RankedCandidate;
  comparisonScore: number;
}

interface SignalCoverage {
  matched: string[];
  missing: string[];
  ratio: number;
}

interface AggregateCoverage {
  score: number;
  reasons: string[];
  missingSignals: string[];
  hasHardSignals: boolean;
  hasCriticalMiss: boolean;
}

export class ContextFitEvaluator {
  evaluate(input: ContextFitEvaluationInput): ContextFitEvaluation {
    const rejectedIds = new Set(input.rejectedKnowledgeIds ?? []);
    const evaluated = input.candidates.map((candidate) => this.evaluateCandidate(candidate, input, rejectedIds));
    const candidates = [...evaluated]
      .sort((left, right) => {
        const scoreDelta = right.comparisonScore - left.comparisonScore;
        return scoreDelta || right.candidate.finalScore - left.candidate.finalScore || left.candidate.rank - right.candidate.rank;
      })
      .map((result, index) => ({ ...result.candidate, rank: index + 1 }));

    return {
      candidates,
      contextFit: buildContextFit(input, candidates),
    };
  }

  private evaluateCandidate(
    candidate: RankedCandidate,
    input: ContextFitEvaluationInput,
    rejectedIds: Set<string>,
  ): CandidateFitResult {
    const reasons: string[] = [];
    const missingSignals: string[] = [];
    let score = clamp(candidate.finalScore, 0, 1) * 0.28;

    if (candidate.finalScore >= 0.7) {
      reasons.push('strong retrieval rank');
    }

    const expectedProject = input.project ?? input.classified.project;
    if (expectedProject) {
      if (sameSignal(candidate.project, expectedProject)) {
        score += 0.1;
        reasons.push(`project:${expectedProject}`);
      } else {
        score -= 0.18;
        missingSignals.push(`missing project:${expectedProject}`);
      }
    }

    score += applyCoverage('file', input.classified.files, candidate, 0.18, reasons, missingSignals);
    score += applyCoverage('symbol', input.classified.symbols, candidate, 0.15, reasons, missingSignals);
    score += applyCoverage('error', input.classified.errors, candidate, 0.15, reasons, missingSignals);
    score += applyCoverage('technology', input.classified.technologies, candidate, 0.08, reasons, missingSignals);
    score += applyCoverage('business area', input.classified.businessAreas, candidate, 0.08, reasons, missingSignals);

    if (input.classified.taskType !== 'unknown') {
      if (candidateSupportsTask(candidate, input.classified.taskType)) {
        score += 0.07;
        reasons.push(`task:${input.classified.taskType}`);
      } else if (hasTaskLabel(candidate)) {
        score -= 0.04;
        missingSignals.push(`missing task:${input.classified.taskType}`);
      }
    }

    score += trustAdjustment(candidate, reasons, missingSignals);
    score += freshnessAdjustment(candidate, input.now ?? new Date(), reasons, missingSignals);
    score += safetyAdjustment(candidate.metadata, reasons, missingSignals);
    score += graphAdjustment(candidate, reasons);
    score += feedbackAdjustment(candidate, rejectedIds, reasons, missingSignals);
    score += domainAdjustment(candidate, input.classified, reasons, missingSignals);

    const fitScore = roundScore(clamp(score, 0, 1));
    const fitted = {
      ...candidate,
      fitScore,
      fitReasons: unique(reasons),
      fitMissingSignals: unique(missingSignals),
    };

    return {
      candidate: fitted,
      comparisonScore: fitted.finalScore * 0.65 + fitScore * 0.35,
    };
  }
}

function buildContextFit(input: ContextFitEvaluationInput, candidates: RankedCandidate[]): ContextFit {
  const fitConfig = contextFitConfigFor(getRetrievalPolicy());
  const baseWeights = fitConfig.weights;
  const thresholds = fitConfig.thresholds;
  const signal = input.signal ?? {};
  const rerankerAvailable = signal.rerankerAvailable !== false;
  // Phase 3 — placeholder until the Phase 5 worktree provider lands.
  const worktreeProvided = typeof signal.worktreeMatchScore === 'number';
  const worktreeMatchScore = clamp(signal.worktreeMatchScore ?? 0, 0, 1);

  // Phase 3 deviation — when the Phase 5 worktree signal is absent (`worktreeMatchScore`
  // undefined or 0), redistribute the worktreeMatch weight proportionally across the
  // three remaining contributors so the achievable maximum stays at 1.0 and the
  // existing thresholds (ready=0.72 etc.) keep their meaning. Once Phase 5 starts
  // emitting nonzero worktree scores, the redistribution naturally fades to no-op.
  const effectiveWeights = (() => {
    if (worktreeProvided && worktreeMatchScore > 0) {
      return baseWeights;
    }
    const remainder = baseWeights.top1 + baseWeights.top3Avg + baseWeights.coverage;
    if (remainder <= 0) {
      return baseWeights;
    }
    const scale = 1 / remainder;
    return {
      top1: baseWeights.top1 * scale,
      top3Avg: baseWeights.top3Avg * scale,
      coverage: baseWeights.coverage * scale,
      worktreeMatch: 0,
    };
  })();

  if (candidates.length === 0) {
    const diagnostics: FitDiagnostics = {
      contributors: { top1: 0, top3Avg: 0, coverage: 0, worktreeMatchScore },
      weights: { ...baseWeights },
      thresholds: { ...thresholds },
      rerankerAvailable,
      notes: rerankerAvailable ? [] : ['rerank_fallback:fused_order'],
    };
    return {
      fitStatus: 'insufficient',
      fitScore: 0,
      fitReasons: rerankerAvailable ? [] : ['reranker_unavailable'],
      missingSignals: rerankerAvailable
        ? ['no retrieval candidates matched the query']
        : ['no retrieval candidates matched the query', 'rerank stage threw — using fused ordering'],
      fitDiagnostics: diagnostics,
    };
  }

  const topCandidates = candidates.slice(0, TOP_CANDIDATE_LIMIT);
  const coverage = aggregateCoverage(input, topCandidates);
  const top1 = clamp(topCandidates[0]?.fitScore ?? 0, 0, 1);
  const top3Avg = clamp(
    average(topCandidates.slice(0, 3).map((candidate) => candidate.fitScore ?? 0)),
    0,
    1,
  );
  const coverageScore = clamp(coverage.score, 0, 1);

  // Phase 3 — recomposed score: 0.55*top1 + 0.20*top3Avg + 0.15*coverage + 0.10*worktreeMatch.
  // (When Phase 5's worktreeMatchScore is absent, effectiveWeights renormalize over the
  // remaining contributors so the achievable max stays at 1.0.)
  let fitScore = roundScore(clamp(
    top1 * effectiveWeights.top1
      + top3Avg * effectiveWeights.top3Avg
      + coverageScore * effectiveWeights.coverage
      + worktreeMatchScore * effectiveWeights.worktreeMatch,
    0,
    1,
  ));

  const missingSignals = [...coverage.missingSignals];

  if (!coverage.hasHardSignals) {
    fitScore = Math.min(fitScore, thresholds.ready - 0.01);
    missingSignals.push('no concrete file, symbol, or error signal was supplied');
  }

  if ((input.rejectedKnowledgeIds ?? []).length > 0) {
    coverage.reasons.push('prior rejected or stale knowledge was excluded before search');
  }

  if (coverage.hasCriticalMiss) {
    fitScore = Math.min(fitScore, thresholds.needsConfirmation - 0.01);
  }

  let fitStatus = statusForScore(fitScore, thresholds);
  const reasons: string[] = [`top candidate:${topCandidates[0]!.title}`, ...coverage.reasons];
  const notes: string[] = [];

  // Phase 3 — rerank fallback: never advertise "ready" if the reranker silently fell back.
  // The fused ordering may be acceptable, but the agent should confirm before trusting it.
  if (!rerankerAvailable) {
    if (fitStatus === 'ready') {
      fitStatus = 'needs_confirmation';
    }
    reasons.push('reranker_unavailable');
    const detail = signal.rerankerError
      ? `rerank stage threw — using fused ordering (${signal.rerankerError})`
      : 'rerank stage threw — using fused ordering';
    missingSignals.push(detail);
    notes.push('rerank_fallback:fused_order');
    if (signal.rerankerError) {
      notes.push(`rerank_error:${signal.rerankerError}`);
    }
  }

  const diagnostics: FitDiagnostics = {
    contributors: {
      top1: roundScore(top1),
      top3Avg: roundScore(top3Avg),
      coverage: roundScore(coverageScore),
      worktreeMatchScore: roundScore(worktreeMatchScore),
    },
    // Report the *configured* weights (not the renormalized ones) so the workbench can
    // show the policy contract; the renormalization is a transitional Phase-3-pre-Phase-5
    // shim documented in the plan.
    weights: { ...baseWeights },
    thresholds: { ...thresholds },
    rerankerAvailable,
    notes,
  };

  return {
    fitStatus,
    fitScore,
    fitReasons: unique(reasons),
    missingSignals: unique([
      ...missingSignals,
      ...(fitStatus === 'ready' ? [] : topCandidates[0]!.fitMissingSignals ?? []),
    ]),
    fitDiagnostics: diagnostics,
  };
}

function aggregateCoverage(input: ContextFitEvaluationInput, candidates: RankedCandidate[]): AggregateCoverage {
  const reasons: string[] = [];
  const missingSignals: string[] = [];
  let matchedWeight = 0;
  let possibleWeight = 0;
  const coverage = coverageProfileFor(getRetrievalPolicy(), input.classified.taskType);

  const add = (name: string, signals: string[], weight: number) => {
    if (signals.length === 0) {
      return;
    }

    const cov = aggregateSignalCoverage(signals, candidates);
    possibleWeight += weight;
    matchedWeight += weight * cov.ratio;

    if (cov.matched.length > 0) {
      reasons.push(`covered ${name}:${cov.matched.length}/${signals.length}`);
    }
    for (const signal of cov.missing) {
      missingSignals.push(`missing ${name}:${signal}`);
    }
  };

  add('file', input.classified.files, coverage.file);
  add('symbol', input.classified.symbols, coverage.symbol);
  add('error', input.classified.errors, coverage.error);
  add('technology', input.classified.technologies, coverage.technology);
  add('business area', input.classified.businessAreas, coverage.businessArea);

  const expectedProject = input.project ?? input.classified.project;
  if (expectedProject) {
    possibleWeight += 0.08;
    if (candidates.some((candidate) => sameSignal(candidate.project, expectedProject))) {
      matchedWeight += 0.08;
      reasons.push(`covered project:${expectedProject}`);
    } else {
      missingSignals.push(`missing project:${expectedProject}`);
    }
  }

  if (input.classified.taskType !== 'unknown') {
    possibleWeight += 0.08;
    if (candidates.some((candidate) => candidateSupportsTask(candidate, input.classified.taskType))) {
      matchedWeight += 0.08;
      reasons.push(`covered task:${input.classified.taskType}`);
    } else {
      missingSignals.push(`missing task:${input.classified.taskType}`);
    }
  }

  const hardSignals = [
    ...input.classified.files,
    ...input.classified.symbols,
    ...input.classified.errors,
  ];
  const hardMissing = hardSignals.filter((signal) => !candidates.some((candidate) => candidateMatchesSignal(candidate, signal)));

  return {
    score: possibleWeight > 0 ? matchedWeight / possibleWeight : 0.45,
    reasons,
    missingSignals,
    hasHardSignals: hardSignals.length > 0,
    hasCriticalMiss: hardSignals.length > 0 && hardMissing.length === hardSignals.length,
  };
}

function applyCoverage(
  name: string,
  signals: string[],
  candidate: RankedCandidate,
  weight: number,
  reasons: string[],
  missingSignals: string[],
): number {
  if (signals.length === 0) {
    return 0;
  }

  const coverage = signalCoverage(signals, candidate);
  for (const signal of coverage.matched) {
    reasons.push(`matched ${name}:${signal}`);
  }
  for (const signal of coverage.missing) {
    missingSignals.push(`missing ${name}:${signal}`);
  }

  return coverage.ratio * weight;
}

function signalCoverage(signals: string[], candidate: RankedCandidate): SignalCoverage {
  const matched = signals.filter((signal) => candidateMatchesSignal(candidate, signal));
  return {
    matched,
    missing: signals.filter((signal) => !matched.includes(signal)),
    ratio: signals.length === 0 ? 1 : matched.length / signals.length,
  };
}

function aggregateSignalCoverage(signals: string[], candidates: RankedCandidate[]): SignalCoverage {
  const matched = signals.filter((signal) => candidates.some((candidate) => candidateMatchesSignal(candidate, signal)));
  return {
    matched,
    missing: signals.filter((signal) => !matched.includes(signal)),
    ratio: signals.length === 0 ? 1 : matched.length / signals.length,
  };
}

function candidateMatchesSignal(candidate: RankedCandidate, signal: string): boolean {
  const rawSignal = signal.toLowerCase();
  const normalizedSignal = normalizeLabel(signal);
  return candidateText(candidate).includes(rawSignal)
    || candidateNormalizedText(candidate).includes(normalizedSignal)
    || graphConnectedSignals(candidate).some((connected) => sameSignal(connected, signal));
}

function candidateSupportsTask(candidate: RankedCandidate, taskType: TaskType): boolean {
  return candidate.labels.some((label) => label.type === 'task_type' && sameSignal(label.value, taskType))
    || taskAlignedItemTypes(taskType).includes(candidate.itemType);
}

function hasTaskLabel(candidate: RankedCandidate): boolean {
  return candidate.labels.some((label) => label.type === 'task_type');
}

function taskAlignedItemTypes(taskType: TaskType): Array<RankedCandidate['itemType']> {
  switch (taskType) {
    case 'debugging':
      return ['bugfix', 'memory', 'workflow'];
    case 'implementation':
      return ['code_ref', 'spec', 'workflow', 'rule'];
    case 'refactor':
      return ['code_ref', 'rule', 'workflow'];
    case 'review':
      return ['rule', 'spec', 'code_ref', 'memory'];
    case 'planning':
      return ['spec', 'wiki', 'workflow'];
    case 'exploration':
      return ['wiki', 'code_ref', 'memory', 'workflow'];
    case 'testing':
      return ['workflow', 'rule', 'bugfix', 'code_ref'];
    case 'unknown':
      return [];
  }
}

function domainAdjustment(
  candidate: RankedCandidate,
  classified: ClassifiedQuery,
  reasons: string[],
  missingSignals: string[],
): number {
  if (!classified.domain) {
    return 0;
  }
  const domainLabels = candidate.labels.filter((label) => label.type === 'domain');
  if (domainLabels.length === 0) {
    return 0;
  }
  if (hasDomainMismatch(candidate, classified)) {
    missingSignals.push(`off-domain:${classified.domain}`);
    return -0.18;
  }
  reasons.push(`domain:${classified.domain}`);
  return 0.08;
}

function trustAdjustment(candidate: RankedCandidate, reasons: string[], missingSignals: string[]): number {
  if (candidate.trustLevel >= 80) {
    reasons.push(`high trust:${candidate.trustLevel}`);
    return 0.08;
  }

  if (candidate.trustLevel >= 50) {
    return 0.04;
  }

  missingSignals.push(`low trust:${candidate.trustLevel}`);
  return -0.08;
}

function freshnessAdjustment(
  candidate: RankedCandidate,
  now: Date,
  reasons: string[],
  missingSignals: string[],
): number {
  if (metadataFlag(candidate.metadata, 'stale')) {
    missingSignals.push('candidate metadata is marked stale');
    return -0.18;
  }

  const freshnessAt = candidate.freshnessAt ?? metadataString(candidate.metadata, 'freshnessAt');
  if (!freshnessAt) {
    return 0;
  }

  const daysOld = ageInDays(freshnessAt, now);
  if (daysOld === undefined) {
    return 0;
  }

  const window = freshnessWindowFor(getRetrievalPolicy(), candidate.itemType);

  if (daysOld <= window.currentDays) {
    reasons.push(`freshness:current:${candidate.itemType}`);
    return CURRENT_FRESHNESS_BONUS;
  }

  if (daysOld > window.staleDays) {
    missingSignals.push(`freshness:stale:${candidate.itemType}`);
    return window.stalePenalty ?? -0.12;
  }

  missingSignals.push(`freshness:aging:${candidate.itemType}`);
  return AGING_PENALTY;
}

function safetyAdjustment(
  metadata: Record<string, unknown> | undefined,
  reasons: string[],
  missingSignals: string[],
): number {
  const status = safetyStatus(metadata);
  if (status === 'safe') {
    reasons.push('safety:safe');
    return 0.03;
  }

  if (status === 'suspicious') {
    missingSignals.push('safety:suspicious');
    return -0.08;
  }

  return 0;
}

function graphAdjustment(candidate: RankedCandidate, reasons: string[]): number {
  if (candidate.source !== 'graph') {
    return 0;
  }

  let score = 0.04;
  reasons.push('graph connection');

  for (const file of graphContextSignals(candidate.metadata, 'files')) {
    reasons.push(`connected file:${file}`);
    score += 0.025;
  }
  for (const symbol of graphContextSignals(candidate.metadata, 'symbols')) {
    reasons.push(`connected symbol:${symbol}`);
    score += 0.025;
  }
  for (const error of graphContextSignals(candidate.metadata, 'errors')) {
    reasons.push(`connected error:${error}`);
    score += 0.025;
  }
  for (const session of sessionSignals(candidate)) {
    reasons.push(`connected session:${session}`);
    score += 0.015;
  }
  if (isIncidentLesson(candidate)) {
    reasons.push('connected incident lesson');
    score += 0.02;
  }

  return Math.min(score, 0.12);
}

function graphConnectedSignals(candidate: RankedCandidate): string[] {
  return [
    ...graphContextSignals(candidate.metadata, 'files'),
    ...graphContextSignals(candidate.metadata, 'symbols'),
    ...graphContextSignals(candidate.metadata, 'errors'),
  ];
}

function graphContextSignals(metadata: Record<string, unknown> | undefined, key: 'files' | 'symbols' | 'errors'): string[] {
  const graphContextFit = metadata?.graphContextFit;
  if (!graphContextFit || typeof graphContextFit !== 'object') {
    return [];
  }

  const values = (graphContextFit as Record<string, unknown>)[key];
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
}

function sessionSignals(candidate: RankedCandidate): string[] {
  const sessionIds = [
    metadataString(candidate.metadata, 'agentSessionId'),
    ...candidate.references
      .filter((reference) => reference.type === 'conversation')
      .map((reference) => reference.uri.replace(/^conversation:\/\//, '')),
  ].filter((value): value is string => Boolean(value));

  return unique(sessionIds).slice(0, 4);
}

function isIncidentLesson(candidate: RankedCandidate): boolean {
  if (metadataString(candidate.metadata, 'taxonomy') === 'incident_lesson') {
    return true;
  }

  if (metadataString(candidate.metadata, 'triggerType') === 'error_recovery') {
    return true;
  }

  return candidate.references.some((reference) => reference.uri.startsWith('tuberosa://error-logs/'));
}

function feedbackAdjustment(
  candidate: RankedCandidate,
  rejectedIds: Set<string>,
  reasons: string[],
  missingSignals: string[],
): number {
  if (rejectedIds.has(candidate.knowledgeId)) {
    missingSignals.push('prior feedback:rejected');
    return -0.22;
  }

  const status = feedbackStatus(candidate.metadata);
  if (status === 'selected') {
    reasons.push('prior feedback:selected');
    return 0.05;
  }

  if (status === 'stale') {
    missingSignals.push('prior feedback:stale');
    return -0.18;
  }

  if (status === 'rejected' || status === 'irrelevant') {
    missingSignals.push(`prior feedback:${status}`);
    return -0.14;
  }

  return 0;
}

function statusForScore(
  score: number,
  thresholds: { ready: number; needsConfirmation: number },
): ContextFit['fitStatus'] {
  if (score >= thresholds.ready) {
    return 'ready';
  }

  if (score >= thresholds.needsConfirmation) {
    return 'needs_confirmation';
  }

  return 'insufficient';
}

function candidateNormalizedText(candidate: RankedCandidate): string {
  return normalizeLabel(candidateText(candidate));
}

function metadataFlag(metadata: Record<string, unknown> | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

function safetyStatus(metadata: Record<string, unknown> | undefined): string | undefined {
  return nestedStatus(metadata, 'retrievalSafety') ?? nestedStatus(metadata, 'safety');
}

function feedbackStatus(metadata: Record<string, unknown> | undefined): string | undefined {
  const direct = metadataString(metadata, 'feedbackStatus') ?? metadataString(metadata, 'priorFeedback');
  if (direct) {
    return direct;
  }

  const feedback = metadata?.feedback;
  if (!feedback || typeof feedback !== 'object') {
    return undefined;
  }

  const status = (feedback as Record<string, unknown>).status;
  return typeof status === 'string' ? status : undefined;
}

function nestedStatus(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const status = (value as Record<string, unknown>).status;
  return typeof status === 'string' ? status : undefined;
}

function ageInDays(value: string, now: Date): number | undefined {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return Math.max(0, Math.floor((now.getTime() - timestamp) / 86_400_000));
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
