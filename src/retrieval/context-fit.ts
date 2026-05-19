import type { ClassifiedQuery, ContextFit, RankedCandidate, TaskType } from '../types.js';
import { clamp, normalizeLabel } from '../util/text.js';

const TOP_CANDIDATE_LIMIT = 6;
const READY_THRESHOLD = 0.72;
const NEEDS_CONFIRMATION_THRESHOLD = 0.45;
const CURRENT_FRESHNESS_DAYS = 180;
const STALE_FRESHNESS_DAYS = 365;

interface ContextFitEvaluationInput {
  project?: string;
  classified: ClassifiedQuery;
  candidates: RankedCandidate[];
  rejectedKnowledgeIds?: string[];
  now?: Date;
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
  if (candidates.length === 0) {
    return {
      fitStatus: 'insufficient',
      fitScore: 0,
      fitReasons: [],
      missingSignals: ['no retrieval candidates matched the query'],
    };
  }

  const topCandidates = candidates.slice(0, TOP_CANDIDATE_LIMIT);
  const coverage = aggregateCoverage(input, topCandidates);
  const topScore = topCandidates[0]?.fitScore ?? 0;
  const averageTopScore = average(topCandidates.slice(0, 3).map((candidate) => candidate.fitScore ?? 0));
  let fitScore = roundScore(clamp(topScore * 0.58 + averageTopScore * 0.22 + coverage.score * 0.2, 0, 1));
  const missingSignals = [...coverage.missingSignals];

  if (!coverage.hasHardSignals) {
    fitScore = Math.min(fitScore, READY_THRESHOLD - 0.01);
    missingSignals.push('no concrete file, symbol, or error signal was supplied');
  }

  if ((input.rejectedKnowledgeIds ?? []).length > 0) {
    coverage.reasons.push('prior rejected or stale knowledge was excluded before search');
  }

  if (coverage.hasCriticalMiss) {
    fitScore = Math.min(fitScore, NEEDS_CONFIRMATION_THRESHOLD - 0.01);
  }

  const fitStatus = statusForScore(fitScore);

  return {
    fitStatus,
    fitScore,
    fitReasons: unique([
      `top candidate:${topCandidates[0].title}`,
      ...coverage.reasons,
    ]),
    missingSignals: unique([
      ...missingSignals,
      ...(fitStatus === 'ready' ? [] : topCandidates[0].fitMissingSignals ?? []),
    ]),
  };
}

function aggregateCoverage(input: ContextFitEvaluationInput, candidates: RankedCandidate[]): AggregateCoverage {
  const reasons: string[] = [];
  const missingSignals: string[] = [];
  let matchedWeight = 0;
  let possibleWeight = 0;

  const add = (name: string, signals: string[], weight: number) => {
    if (signals.length === 0) {
      return;
    }

    const coverage = aggregateSignalCoverage(signals, candidates);
    possibleWeight += weight;
    matchedWeight += weight * coverage.ratio;

    if (coverage.matched.length > 0) {
      reasons.push(`covered ${name}:${coverage.matched.length}/${signals.length}`);
    }
    for (const signal of coverage.missing) {
      missingSignals.push(`missing ${name}:${signal}`);
    }
  };

  add('file', input.classified.files, 0.24);
  add('symbol', input.classified.symbols, 0.22);
  add('error', input.classified.errors, 0.22);
  add('technology', input.classified.technologies, 0.12);
  add('business area', input.classified.businessAreas, 0.12);

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
  return candidateSearchText(candidate).includes(rawSignal)
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

  if (daysOld <= CURRENT_FRESHNESS_DAYS) {
    reasons.push('freshness:current');
    return 0.05;
  }

  if (daysOld > STALE_FRESHNESS_DAYS) {
    missingSignals.push('freshness:stale');
    return -0.12;
  }

  missingSignals.push('freshness:aging');
  return -0.04;
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

function statusForScore(score: number): ContextFit['fitStatus'] {
  if (score >= READY_THRESHOLD) {
    return 'ready';
  }

  if (score >= NEEDS_CONFIRMATION_THRESHOLD) {
    return 'needs_confirmation';
  }

  return 'insufficient';
}

function candidateSearchText(candidate: RankedCandidate): string {
  return [
    candidate.title,
    candidate.summary,
    candidate.content,
    candidate.contextualContent,
    candidate.labels.map((label) => `${label.type}:${label.value}`).join(' '),
    candidate.references.map((reference) => reference.uri).join(' '),
    JSON.stringify(candidate.metadata ?? {}),
  ].join(' ').toLowerCase();
}

function candidateNormalizedText(candidate: RankedCandidate): string {
  return normalizeLabel(candidateSearchText(candidate));
}

function sameSignal(left: string, right: string): boolean {
  return normalizeLabel(left) === normalizeLabel(right);
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
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
