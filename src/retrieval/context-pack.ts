import { randomUUID } from 'node:crypto';
import type {
  ActionableMissingSignals,
  ClassifiedQuery,
  ContextEvidenceCategory,
  ContextEvidenceStrength,
  ContextFit,
  ContextPack,
  ContextPackActionItem,
  ContextPackOrientation,
  ContextPackTaskBrief,
  ContextReviewTarget,
  FitDiagnostics,
  RankedCandidate,
  TaskBriefMode,
} from '../types.js';
import { clamp, truncate, uniqueStrings } from '../util/text.js';
import { candidateText as candidateTextHelper } from './candidate-helpers.js';
import { hasDomainMismatch } from './classifier.js';
import { composeStartupBrief } from './startup-brief.js';

const ANCHORED_MIN_FINAL_SCORE = 0.6;
const GENERAL_MIN_FINAL_SCORE = 0.35;
const GRAPH_EVIDENCE_MIN_RAW_SCORE = 0.45;
export const DEFAULT_DEEP_CONTEXT_BUDGET = 60_000;
export const MIN_DEEP_CONTEXT_BUDGET = 30_000;
export const MAX_DEEP_CONTEXT_BUDGET = 100_000;

export interface UsefulnessCaps {
  priorLessons?: number;
  adjacentContext?: number;
}

export const DEFAULT_USEFULNESS_CAPS: Required<UsefulnessCaps> = {
  priorLessons: 6,
  adjacentContext: 4,
};

export const UNCAPPED_USEFULNESS_CAPS: Required<UsefulnessCaps> = {
  priorLessons: Number.POSITIVE_INFINITY,
  adjacentContext: Number.POSITIVE_INFINITY,
};

export interface AssembleContextPackInput {
  queryId?: string;
  project?: string;
  prompt: string;
  classified: ClassifiedQuery;
  candidates: RankedCandidate[];
  tokenBudget: number;
  rejectedKnowledgeIds?: string[];
  contextFit?: ContextFit;
  usefulnessCaps?: UsefulnessCaps;
  reviewTargets?: ContextReviewTarget[];
  omittedReviewTargetCount?: number;
}

export function normalizeDeepContextBudget(value: number | undefined): number {
  return Math.round(clamp(value ?? DEFAULT_DEEP_CONTEXT_BUDGET, MIN_DEEP_CONTEXT_BUDGET, MAX_DEEP_CONTEXT_BUDGET));
}

export function assembleContextPack(input: AssembleContextPackInput): ContextPack {
  const budget = Math.max(900, input.tokenBudget);
  const essentialBudget = Math.ceil(budget * 0.52);
  const supportingBudget = Math.ceil(budget * 0.34);
  const optionalBudget = budget - essentialBudget - supportingBudget;

  const prioritized = prioritizeUsefulCandidates(filterAcceptedCandidates(input), input);
  const accepted = capUsefulnessCategories(prioritized, input.usefulnessCaps);
  const essential = takeWithinBudget(accepted, essentialBudget, 0, 4);
  const supporting = takeWithinBudget(without(accepted, essential), supportingBudget, 0, 6);
  const optional = takeWithinBudget(without(accepted, [...essential, ...supporting]), optionalBudget, 0, 8);
  const selected = [...essential, ...supporting, ...optional];
  const actionableMissingSignals = buildActionableMissingSignals(input.contextFit?.missingSignals ?? []);

  const topScore = prioritized[0]?.finalScore ?? 0;
  const density = Math.min(1, prioritized.length / 6);
  const fitScore = input.contextFit?.fitScore ?? 0;
  const confidence = clamp(topScore * 0.56 + input.classified.confidence * 0.16 + density * 0.08 + fitScore * 0.2, 0, 0.99);
  const orientation = buildOrientation(input, selected, actionableMissingSignals);

  // Phase 8 — tag review targets with evidenceIds tied to pack candidates (when present).
  const reviewTargets = tagReviewTargetsWithEvidence(input.reviewTargets ?? [], selected);

  const briefBuild = buildTaskBrief({ ...input, reviewTargets }, selected, orientation);
  const contextFit = mergeBriefWarningsIntoContextFit(input.contextFit, briefBuild.warnings);
  const startupBrief = composeStartupBrief({
    prompt: input.prompt,
    classified: input.classified,
    candidates: prioritized,
    contextFit,
  });

  return {
    id: randomUUID(),
    queryId: input.queryId,
    project: input.project ?? input.classified.project,
    prompt: input.prompt,
    confidence,
    status: 'proposed',
    classified: input.classified,
    contextFit,
    orientation,
    taskBrief: briefBuild.taskBrief,
    startupBrief,
    actionableMissingSignals,
    sections: [
      { name: 'essential', items: sanitizeItems(essential), tokenEstimate: sumTokens(essential) },
      { name: 'supporting', items: sanitizeItems(supporting), tokenEstimate: sumTokens(supporting) },
      { name: 'optional', items: sanitizeItems(optional), tokenEstimate: sumTokens(optional) },
    ],
    rejectedKnowledgeIds: input.rejectedKnowledgeIds ?? [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Phase 8 — merge brief-groundedness warnings into the pack's ContextFit by appending them
 * to `fitDiagnostics.notes` (as instructed by the Phase 3 carry-over: the `notes` array is
 * the carrier for taskBrief warnings, prefixed with `brief_warning:`).
 *
 * Returns a fresh ContextFit so the caller's input is never mutated.
 */
function mergeBriefWarningsIntoContextFit(
  contextFit: ContextFit | undefined,
  warnings: string[],
): ContextFit | undefined {
  if (!contextFit) {
    if (warnings.length === 0) {
      return undefined;
    }
    // No contextFit was passed in but we have warnings to surface — synthesize a
    // minimal diagnostics block so the warnings aren't lost.
    return {
      fitStatus: 'insufficient',
      fitScore: 0,
      fitReasons: [],
      missingSignals: [],
      fitDiagnostics: {
        contributors: { top1: 0, top3Avg: 0, coverage: 0, worktreeMatchScore: 0 },
        weights: { top1: 0.55, top3Avg: 0.2, coverage: 0.15, worktreeMatch: 0.1 },
        thresholds: { ready: 0.72, needsConfirmation: 0.45 },
        rerankerAvailable: true,
        notes: [...warnings],
      },
    };
  }

  if (warnings.length === 0) {
    return contextFit;
  }

  const baseDiagnostics: FitDiagnostics | undefined = contextFit.fitDiagnostics;
  const diagnostics: FitDiagnostics = baseDiagnostics
    ? { ...baseDiagnostics, notes: [...baseDiagnostics.notes, ...warnings] }
    : {
      contributors: { top1: 0, top3Avg: 0, coverage: 0, worktreeMatchScore: 0 },
      weights: { top1: 0.55, top3Avg: 0.2, coverage: 0.15, worktreeMatch: 0.1 },
      thresholds: { ready: 0.72, needsConfirmation: 0.45 },
      rerankerAvailable: true,
      notes: [...warnings],
    };
  return { ...contextFit, fitDiagnostics: diagnostics };
}

/**
 * Phase 8 — when a review target's `id` matches a pack candidate's `knowledgeId`, record
 * that candidate id under `evidenceIds`. Otherwise leave the field absent — the workbench
 * still resolves the target via its own `id`, but no pack candidate currently grounds it.
 */
function tagReviewTargetsWithEvidence(
  reviewTargets: ContextReviewTarget[],
  selected: RankedCandidate[],
): ContextReviewTarget[] {
  if (reviewTargets.length === 0) {
    return reviewTargets;
  }
  const idSet = new Set(selected.map((candidate) => candidate.knowledgeId));
  return reviewTargets.map((target) => {
    if (idSet.has(target.id)) {
      return { ...target, evidenceIds: [target.id] };
    }
    return target;
  });
}

function filterAcceptedCandidates(input: AssembleContextPackInput): RankedCandidate[] {
  const rejectedIds = new Set(input.rejectedKnowledgeIds ?? []);
  const filtered = input.candidates.filter((candidate) => !rejectedIds.has(candidate.knowledgeId));
  const threshold = hasAnchors(input.classified) ? ANCHORED_MIN_FINAL_SCORE : GENERAL_MIN_FINAL_SCORE;
  const strong = filtered.filter((candidate, index) => (
    index === 0
    || candidate.finalScore >= threshold
    || isGraphEvidence(candidate)
    || isVerifiedAtomEvidence(candidate)
  ));
  return strong.length ? strong : filtered.slice(0, 1);
}

function isGraphEvidence(candidate: RankedCandidate): boolean {
  return candidate.source === 'graph'
    && candidate.rawScore >= GRAPH_EVIDENCE_MIN_RAW_SCORE
    && !candidate.matchReasons.some((reason) => reason.startsWith('suppression:superseded:'));
}

/**
 * Trigger-matched verified/canonical atoms are high-precision evidence: when an atom
 * surfaces for a query trigger it directly answers the task, so it is accepted past
 * the final-score floor (its low fused score reflects single-source presence, not low
 * relevance). Drafts are NOT allowlisted — they must clear the score floor on merit.
 */
function isVerifiedAtomEvidence(candidate: RankedCandidate): boolean {
  return candidate.source === 'atoms'
    && (candidate.metadata?.atomTier === 'verified' || candidate.metadata?.atomTier === 'canonical')
    && !candidate.matchReasons.some((reason) => reason.startsWith('suppression:'));
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

function capUsefulnessCategories(
  candidates: RankedCandidate[],
  overrides: UsefulnessCaps | undefined,
): RankedCandidate[] {
  const caps = { ...DEFAULT_USEFULNESS_CAPS, ...overrides };
  const counts = { priorLessons: 0, adjacentContext: 0 };
  const capped: RankedCandidate[] = [];

  for (const candidate of candidates) {
    const limit = capForCategory(candidate.evidenceCategory, caps);
    if (limit === undefined) {
      capped.push(candidate);
      continue;
    }

    const bucket = candidate.evidenceCategory === 'priorLessons' ? 'priorLessons' : 'adjacentContext';
    if (counts[bucket] >= limit) {
      continue;
    }

    counts[bucket] += 1;
    capped.push(candidate);
  }

  return capped;
}

function capForCategory(
  category: RankedCandidate['evidenceCategory'],
  caps: Required<UsefulnessCaps>,
): number | undefined {
  if (category === 'priorLessons') {
    return caps.priorLessons;
  }

  if (category === 'adjacentContext') {
    return caps.adjacentContext;
  }

  return undefined;
}

function prioritizeUsefulCandidates(candidates: RankedCandidate[], input: AssembleContextPackInput): RankedCandidate[] {
  return candidates
    .map((candidate) => annotateUsefulness(candidate, input.classified))
    .sort((left, right) => {
      const categoryDelta = evidenceCategoryPriority(left.evidenceCategory, input.classified) - evidenceCategoryPriority(right.evidenceCategory, input.classified);
      if (categoryDelta !== 0) {
        return categoryDelta;
      }

      return right.finalScore - left.finalScore || left.rank - right.rank;
    });
}

function annotateUsefulness(candidate: RankedCandidate, classified: ClassifiedQuery): RankedCandidate {
  const directSignals = directTaskSignals(candidate, classified);
  const category = evidenceCategory(candidate, classified, directSignals);
  const strength = evidenceStrength(candidate, category, directSignals);

  return {
    ...candidate,
    evidenceCategory: category,
    evidenceStrength: strength,
    usefulnessReason: usefulnessReason(candidate, category, directSignals),
    actionableMissingSignals: buildActionableMissingSignals(candidate.fitMissingSignals ?? []),
  };
}

function evidenceCategory(
  candidate: RankedCandidate,
  classified: ClassifiedQuery,
  directSignals: string[],
): ContextEvidenceCategory {
  if (
    candidate.source === 'atoms'
    && (candidate.metadata?.atomTier === 'verified' || candidate.metadata?.atomTier === 'canonical')
  ) {
    return 'verifiedAtom';
  }

  if (directSignals.length > 0 && !hasDomainMismatch(candidate, classified)) {
    return 'directTaskEvidence';
  }

  if (isPriorLesson(candidate)) {
    return 'priorLessons';
  }

  if (candidate.source === 'graph' || hasOnlyWeakSemanticReasons(candidate)) {
    return 'adjacentContext';
  }

  if (isWorkflowGuidance(candidate, classified)) {
    return 'workflowGuidance';
  }

  return 'adjacentContext';
}

function directTaskSignals(candidate: RankedCandidate, classified: ClassifiedQuery): string[] {
  const reasons = [...candidate.matchReasons, ...(candidate.fitReasons ?? [])];
  const explicitReasonSignals = reasons.flatMap((reason) => {
    if (reason.startsWith('file:')) {
      return [`file:${reason.slice('file:'.length)}`];
    }
    if (reason.startsWith('symbol:')) {
      return [`symbol:${reason.slice('symbol:'.length)}`];
    }
    if (reason.startsWith('error:')) {
      return [`error:${reason.slice('error:'.length)}`];
    }
    if (reason.startsWith('matched file:')) {
      return [`file:${reason.slice('matched file:'.length)}`];
    }
    if (reason.startsWith('matched symbol:')) {
      return [`symbol:${reason.slice('matched symbol:'.length)}`];
    }
    if (reason.startsWith('matched error:')) {
      return [`error:${reason.slice('matched error:'.length)}`];
    }
    return [];
  });

  const labelSignals = candidate.labels.flatMap((label) => {
    if (label.type === 'file' && classified.files.includes(label.value)) {
      return [`file:${label.value}`];
    }
    if (label.type === 'symbol' && classified.symbols.includes(label.value)) {
      return [`symbol:${label.value}`];
    }
    if (label.type === 'error' && classified.errors.includes(label.value)) {
      return [`error:${label.value}`];
    }
    return [];
  });

  const referenceSignals = candidate.references.flatMap((reference) => (
    reference.type === 'file' && classified.files.includes(reference.uri)
      ? [`file:${reference.uri}`]
      : []
  ));

  const continuationSignals = classified.intent.workflowStage === 'continuation'
    ? candidate.references
      .filter((reference) => reference.type === 'file' && isContinuationAnchorFile(reference.uri))
      .map((reference) => `file:${reference.uri}`)
    : [];

  const objectHintSignals = (classified.intent.objectHints ?? [])
    .filter((hint) => candidateText(candidate).includes(hint.toLowerCase()))
    .map((hint) => `object:${hint}`);

  return uniqueStrings([
    ...explicitReasonSignals,
    ...labelSignals,
    ...referenceSignals,
    ...continuationSignals,
    ...objectHintSignals,
  ]).slice(0, 8);
}

function candidateText(candidate: RankedCandidate): string {
  return candidateTextHelper(candidate, { includeKnowledgeId: true });
}

function isContinuationAnchorFile(value: string): boolean {
  return value === 'handoff.md'
    || value === 'tuberosa-project.md'
    || value.endsWith('/AGENT_CONTEXT_ROADMAP.md')
    || value === 'docs/AGENT_CONTEXT_ROADMAP.md';
}

function isPriorLesson(candidate: RankedCandidate): boolean {
  const isLesson = candidate.itemType === 'memory'
    || candidate.itemType === 'bugfix'
    || candidate.itemType === 'conversation'
    || candidate.matchReasons.includes('prior approved memory')
    || candidate.matchReasons.some((reason) => reason.startsWith('feedback:selected'))
    || candidate.references.some((reference) => reference.uri.startsWith('reflection://') || reference.uri.startsWith('tuberosa://agent-sessions/'));

  return isLesson && ((candidate.fitScore ?? 0) >= 0.65 || hasDirectReason(candidate));
}

function hasDirectReason(candidate: RankedCandidate): boolean {
  return candidate.matchReasons.some((reason) => (
    reason.startsWith('file:')
    || reason.startsWith('symbol:')
    || reason.startsWith('error:')
  ));
}

function hasOnlyWeakSemanticReasons(candidate: RankedCandidate): boolean {
  return candidate.matchReasons.some((reason) => reason === 'vector match')
    && !candidate.matchReasons.some((reason) => reason.startsWith('file:') || reason.startsWith('symbol:') || reason.startsWith('error:') || reason.startsWith('feedback:selected'));
}

function isWorkflowGuidance(candidate: RankedCandidate, classified: ClassifiedQuery): boolean {
  return candidate.itemType === 'workflow'
    || candidate.itemType === 'spec'
    || candidate.itemType === 'rule'
    || candidate.itemType === 'wiki'
    || candidate.labels.some((label) => (
      label.type === 'workflow_stage'
      || label.type === 'task_type' && label.value === classified.taskType
      || label.type === 'business_area' && classified.businessAreas.includes(label.value)
    ));
}

function evidenceStrength(
  candidate: RankedCandidate,
  category: ContextEvidenceCategory,
  directSignals: string[],
): ContextEvidenceStrength {
  if (
    category === 'directTaskEvidence'
    && (directSignals.length >= 2 || (candidate.fitScore ?? 0) >= 0.72 || candidate.finalScore >= 0.78)
  ) {
    return 'strong';
  }

  if ((candidate.fitScore ?? 0) >= 0.55 || candidate.finalScore >= 0.65 || directSignals.length > 0) {
    return 'moderate';
  }

  return 'weak';
}

function extractMatchedSignals(candidate: RankedCandidate): string {
  const files = candidate.matchReasons
    .filter((r) => r.startsWith('file:') || r.startsWith('matched file:'))
    .map((r) => r.replace(/^(?:matched )?file:/, ''))
    .slice(0, 2)
    .map((f) => `file:${f}`);
  const symbols = candidate.matchReasons
    .filter((r) => r.startsWith('symbol:') || r.startsWith('matched symbol:'))
    .map((r) => r.replace(/^(?:matched )?symbol:/, ''))
    .slice(0, 2)
    .map((s) => `symbol:${s}`);
  const parts = [...files, ...symbols];
  return parts.length > 0 ? ` Matched on: ${parts.join(', ')}.` : '';
}

function usefulnessReason(
  candidate: RankedCandidate,
  category: ContextEvidenceCategory,
  directSignals: string[],
): string {
  const details = [
    graphRelationReason(candidate),
    feedbackContributionReason(candidate),
    freshnessReason(candidate),
    suppressionReason(candidate),
  ].filter((detail): detail is string => Boolean(detail));

  const suffix = details.length > 0 ? ` ${details.join(' ')}` : '';

  if (category === 'verifiedAtom') {
    const tier = candidate.metadata?.atomTier === 'canonical' ? 'canonical' : 'verified';
    return `Trigger-matched ${tier} knowledge atom; prefer ahead of other evidence.${extractMatchedSignals(candidate)}${suffix}`;
  }

  if (category === 'directTaskEvidence') {
    return `Direct task evidence from ${directSignals.slice(0, 3).join(', ')}.${extractMatchedSignals(candidate)}${suffix}`;
  }

  if (category === 'priorLessons') {
    return `Prior lesson or selected memory tied to similar work; use after direct task evidence.${extractMatchedSignals(candidate)}${suffix}`;
  }

  if (category === 'workflowGuidance') {
    return `Workflow guidance for ${candidate.itemType} context; use to preserve project conventions.${extractMatchedSignals(candidate)}${suffix}`;
  }

  return `Adjacent related context; inspect only if direct evidence is not enough.${extractMatchedSignals(candidate)}${suffix}`;
}

function graphRelationReason(candidate: RankedCandidate): string | undefined {
  const paths = metadataRecordArray(candidate.metadata?.graphPaths);
  const first = paths[0];
  if (!first) {
    return undefined;
  }

  const relationType = metadataString(first, 'relationType') ?? 'related_to';
  const from = metadataString(first, 'fromKnowledgeId');
  const target = metadataString(first, 'targetKnowledgeId') ?? metadataString(first, 'targetValue');
  const pieces = [
    `Graph relation path: ${relationType}`,
    from ? `from ${from}` : undefined,
    target ? `to ${target}` : undefined,
  ].filter(Boolean);

  return `${pieces.join(' ')}.`;
}

function feedbackContributionReason(candidate: RankedCandidate): string | undefined {
  const feedback = metadataRecord(candidate.metadata?.feedback);
  if (!feedback) {
    return undefined;
  }

  const counts = [
    feedbackCount(feedback, 'selectedCount', 'selected'),
    feedbackCount(feedback, 'selectedNoisyCount', 'selected_but_noisy'),
    feedbackCount(feedback, 'rejectedCount', 'rejected'),
    feedbackCount(feedback, 'irrelevantCount', 'irrelevant'),
    feedbackCount(feedback, 'staleCount', 'stale'),
  ].filter((value): value is string => Boolean(value));
  const latest = metadataString(feedback, 'latestFeedbackType');
  const adjustment = metadataNumber(feedback, 'scoreAdjustment');

  if (counts.length === 0 && !latest && adjustment === undefined) {
    return undefined;
  }

  const parts = [
    counts.length > 0 ? `Feedback history: ${counts.join(', ')}` : undefined,
    latest ? `latest ${latest}` : undefined,
    adjustment !== undefined && adjustment !== 0
      ? `score ${adjustment > 0 ? '+' : ''}${adjustment.toFixed(3)}`
      : undefined,
  ].filter(Boolean);

  return `${parts.join('; ')}.`;
}

function feedbackCount(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const count = metadataNumber(record, key);
  return count && count > 0 ? `${label}:${count}` : undefined;
}

function freshnessReason(candidate: RankedCandidate): string | undefined {
  const freshnessAt = candidate.freshnessAt ?? metadataString(candidate.metadata, 'freshnessAt');
  const date = freshnessAt ? ` (${freshnessAt.slice(0, 10)})` : '';
  const signals = [
    ...candidate.matchReasons,
    ...(candidate.fitReasons ?? []),
    ...(candidate.fitMissingSignals ?? []),
  ];

  if (signals.some((signal) => signal === 'freshness:current')) {
    return `Freshness: current${date}.`;
  }

  if (signals.some((signal) => signal === 'freshness:stale' || signal === 'suppression:freshness:stale')) {
    return `Freshness risk: stale${date}.`;
  }

  if (signals.some((signal) => signal === 'freshness:aging')) {
    return `Freshness risk: aging${date}.`;
  }

  return freshnessAt ? `Freshness date${date}.` : undefined;
}

function suppressionReason(candidate: RankedCandidate): string | undefined {
  const reasons = [
    ...candidate.matchReasons,
    ...metadataStringArray(candidate.metadata?.retrievalSuppression, 'reasons'),
  ];
  const superseded = reasons.find((reason) => reason.startsWith('suppression:superseded:'));
  if (superseded) {
    return `Supersession suppression: superseded by ${superseded.slice('suppression:superseded:'.length)}.`;
  }

  const feedbackSuppression = reasons.find((reason) => reason.startsWith('suppression:prior feedback:'));
  if (feedbackSuppression) {
    return `Suppression from prior ${feedbackSuppression.slice('suppression:prior feedback:'.length)} feedback.`;
  }

  if (reasons.includes('suppression:evidence_mismatch')) {
    return 'Suppression: missing required evidence type for this task.';
  }

  return undefined;
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function metadataRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.flatMap((item) => {
    const record = metadataRecord(item);
    return record ? [record] : [];
  }) : [];
}

function metadataString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function metadataNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function metadataStringArray(container: unknown, key: string): string[] {
  const record = metadataRecord(container);
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function evidenceCategoryPriority(
  category: ContextEvidenceCategory | undefined,
  classified: ClassifiedQuery,
): number {
  if (prefersWorkflowBeforePriorLessons(taskBriefModeFor(classified))) {
    switch (category) {
      case 'verifiedAtom':
        return 0;
      case 'directTaskEvidence':
        return 1;
      case 'workflowGuidance':
        return 2;
      case 'priorLessons':
        return 3;
      case 'adjacentContext':
        return 4;
      default:
        return 5;
    }
  }

  switch (category) {
    case 'verifiedAtom':
      return 0;
    case 'directTaskEvidence':
      return 1;
    case 'priorLessons':
      return 2;
    case 'workflowGuidance':
      return 3;
    case 'adjacentContext':
      return 4;
    default:
      return 5;
  }
}

function buildOrientation(
  input: AssembleContextPackInput,
  selected: RankedCandidate[],
  missingSignals: ActionableMissingSignals,
): ContextPackOrientation {
  const recommendedFiles = recommendedFilesFor(input.classified, selected);

  return {
    inferredTask: input.classified.intent.taskGoal,
    workflowStage: input.classified.intent.workflowStage,
    taskType: input.classified.taskType,
    confidence: input.classified.confidence,
    recommendedFiles,
    likelySurfaces: likelySurfacesFor(recommendedFiles, selected),
    verificationCommands: verificationCommandsFor(input.classified, input.prompt, recommendedFiles.map((file) => file.path)),
    missingSignals,
    notes: orientationNotes(input, selected),
  };
}

interface TaskBriefBuildResult {
  taskBrief: ContextPackTaskBrief;
  warnings: string[];
}

function buildTaskBrief(
  input: AssembleContextPackInput,
  selected: RankedCandidate[],
  orientation: ContextPackOrientation,
): TaskBriefBuildResult {
  const mode = taskBriefModeFor(input.classified);
  const reviewTargets = input.reviewTargets ?? [];
  const directEvidenceKnowledgeIds = selected
    .filter((candidate) => candidate.evidenceCategory === 'directTaskEvidence')
    .map((candidate) => candidate.knowledgeId);
  const adjacentKnowledgeIds = selected
    .filter((candidate) => candidate.evidenceCategory === 'adjacentContext')
    .map((candidate) => candidate.knowledgeId);

  const { actionItems, warnings } = buildActionItems({
    input,
    selected,
    orientation,
    reviewTargets,
    mode,
  });

  const followUpSearches = input.classified.preprocessing?.subTasks;
  return {
    taskBrief: {
      mode,
      goal: taskBriefGoal(input.classified, mode),
      actionItems,
      reviewTargets,
      directEvidenceKnowledgeIds,
      adjacentKnowledgeIds,
      omittedReviewTargetCount: input.omittedReviewTargetCount ?? 0,
      followUpSearches: followUpSearches && followUpSearches.length > 0 ? followUpSearches : undefined,
    },
    warnings,
  };
}

interface BuildActionItemsResult {
  actionItems: ContextPackActionItem[];
  warnings: string[];
}

/**
 * Phase 8 — `run_verification`, `ask_clarification`, and `inspect_shortlist` are policy /
 * system recommendations rather than knowledge-grounded actions. They are exempt from the
 * brief-groundedness guard: the workbench surfaces them as-is, and they never carry
 * `evidenceIds`.
 */
const POLICY_ONLY_ACTIONS = new Set(['run_verification', 'ask_clarification', 'inspect_shortlist']);

function buildActionItems(input: {
  input: AssembleContextPackInput;
  selected: RankedCandidate[];
  orientation: ContextPackOrientation;
  reviewTargets: ContextReviewTarget[];
  mode: TaskBriefMode;
}): BuildActionItemsResult {
  const candidate: ContextPackActionItem[] = [];
  const explicitObjectHints = new Set(input.input.classified.intent.objectHints ?? []);

  for (const target of input.reviewTargets.filter((t) => explicitObjectHints.has(t.id)).slice(0, 4)) {
    candidate.push({
      priority: 1,
      action: 'review_target',
      label: `Review ${target.title}`,
      targetKind: target.kind,
      targetId: target.id,
      targetStatus: target.status,
      targetTitle: target.title,
      reason: target.reason,
    });
  }

  for (const file of input.orientation.recommendedFiles.slice(0, 3)) {
    candidate.push({
      priority: 2,
      action: 'read_file',
      label: `Read ${file.path}`,
      targetKind: 'file',
      targetPath: file.path,
      reason: file.reason,
    });
  }

  const queuedTargets = input.reviewTargets
    .filter((target) => !explicitObjectHints.has(target.id))
    .slice(0, isReviewQueueMode(input.mode) ? 5 : 2);
  for (const target of queuedTargets) {
    candidate.push({
      priority: 3,
      action: 'inspect_review_target',
      label: `Inspect ${target.title}`,
      targetKind: target.kind,
      targetId: target.id,
      targetStatus: target.status,
      targetTitle: target.title,
      reason: target.reason,
    });
  }

  for (const command of input.orientation.verificationCommands.slice(0, 2)) {
    candidate.push({
      priority: 4,
      action: 'run_verification',
      label: command,
      targetKind: 'command',
      command,
      reason: 'Likely verification command for the classified task.',
    });
  }

  if (input.input.contextFit?.fitStatus === 'insufficient') {
    candidate.push({
      priority: 5,
      action: 'ask_clarification',
      label: 'Clarify missing context before relying on this pack',
      targetKind: 'clarification',
      reason: input.input.contextFit.missingSignals.slice(0, 3).join('; ') || 'Context fit is insufficient.',
    });
  }

  // Phase 8 — apply the groundedness guard. Walk every candidate action and either keep it
  // with evidenceIds set, or drop it with a structured warning recorded.
  const warnings: string[] = [];
  const kept: ContextPackActionItem[] = [];
  for (const item of candidate) {
    const decision = groundActionItem(item, input.selected);
    if (decision.keep) {
      kept.push(decision.item);
    } else {
      warnings.push(decision.warning);
    }
  }

  if (kept.length === 0) {
    kept.push({
      priority: 5,
      action: 'inspect_shortlist',
      label: 'Inspect the returned shortlist before working',
      reason: 'No direct files, review targets, or verification commands were inferred.',
    });
  }

  return {
    actionItems: kept
      .sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label))
      .slice(0, 10),
    warnings,
  };
}

type GroundActionDecision =
  | { keep: true; item: ContextPackActionItem }
  | { keep: false; warning: string };

/**
 * Phase 8 — decide whether to keep an action and (if kept) attach evidenceIds.
 *
 * Behavior by action kind:
 *  - `read_file`: must be backed by ≥1 pack candidate that lists the file in its labels or
 *    references. If none → drop (ungrounded). If some but none share a non-trivial token
 *    with the action's keywords → drop (zero overlap).
 *  - `review_target` / `inspect_review_target`: when the target's `id` matches a pack
 *    candidate's `knowledgeId`, that candidate must share ≥1 token with the action's
 *    keywords (else drop, zero overlap). Otherwise the action is kept and self-grounded
 *    via `targetId` — `evidenceIds` is set to `[target.id]` to signal the navigation
 *    pointer even when no pack candidate matches.
 *  - Policy-only actions (`run_verification`, `ask_clarification`, `inspect_shortlist`):
 *    kept verbatim; never carry `evidenceIds`.
 */
function groundActionItem(item: ContextPackActionItem, selected: RankedCandidate[]): GroundActionDecision {
  if (POLICY_ONLY_ACTIONS.has(item.action)) {
    return { keep: true, item };
  }

  const keywords = actionKeywords(item);

  if (item.action === 'read_file' && item.targetPath) {
    const fileMatches = matchingFileCandidates(item.targetPath, selected);
    if (fileMatches.length === 0) {
      return {
        keep: false,
        warning: `brief_warning:dropped_ungrounded_action:read_file:${item.targetPath}`,
      };
    }
    const overlapping = fileMatches.filter((cand) => hasTokenOverlap(keywords, cand));
    if (overlapping.length === 0) {
      return {
        keep: false,
        warning: `brief_warning:dropped_zero_overlap_action:read_file:${item.targetPath}`,
      };
    }
    return {
      keep: true,
      item: { ...item, evidenceIds: uniqueStrings(overlapping.map((c) => c.knowledgeId)) },
    };
  }

  if (item.action === 'review_target' || item.action === 'inspect_review_target') {
    if (!item.targetId) {
      return { keep: true, item };
    }
    const matched = selected.find((cand) => cand.knowledgeId === item.targetId);
    if (matched) {
      if (!hasTokenOverlap(keywords, matched)) {
        return {
          keep: false,
          warning: `brief_warning:dropped_zero_overlap_action:${item.action}:${item.targetTitle ?? item.targetId}`,
        };
      }
      return { keep: true, item: { ...item, evidenceIds: [item.targetId] } };
    }
    // No candidate match — the review target is self-grounded via its own id.
    return { keep: true, item: { ...item, evidenceIds: [item.targetId] } };
  }

  // Unknown action kinds — keep verbatim. New action types should register their grounding
  // here explicitly.
  return { keep: true, item };
}

function matchingFileCandidates(path: string, selected: RankedCandidate[]): RankedCandidate[] {
  return selected.filter((candidate) =>
    candidate.labels.some((label) => label.type === 'file' && label.value === path)
    || candidate.references.some((reference) => reference.type === 'file' && reference.uri === path),
  );
}

const ACTION_TOKEN_MIN_LENGTH = 3;
const ACTION_TOKEN_STOP_WORDS = new Set([
  'read', 'review', 'inspect', 'run', 'verify', 'check', 'clarify', 'fix', 'add',
  'the', 'and', 'for', 'with', 'this', 'that', 'into', 'from', 'has', 'any',
  'all', 'are', 'was', 'were', 'before', 'after', 'next', 'pending', 'review_target',
  'inspect_review_target', 'read_file', 'context', 'pack',
]);

/**
 * Phase 8 — tokenize action-facing strings (label / targetTitle / targetPath / reason) into
 * a deduplicated lowercase set, filtering trivial tokens and a tiny stop-list of common
 * verbs/connectors. The set is used for the response-relevancy-style token overlap check.
 */
function actionKeywords(item: ContextPackActionItem): Set<string> {
  const parts: string[] = [];
  if (item.label) parts.push(item.label);
  if (item.targetTitle) parts.push(item.targetTitle);
  if (item.targetPath) parts.push(item.targetPath);
  if (item.command) parts.push(item.command);
  if (item.reason) parts.push(item.reason);
  return tokenizeForOverlap(parts.join(' '));
}

function tokenizeForOverlap(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < ACTION_TOKEN_MIN_LENGTH) continue;
    if (ACTION_TOKEN_STOP_WORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

function candidateOverlapText(candidate: RankedCandidate): string {
  const labelText = candidate.labels.map((label) => label.value).join(' ');
  const refText = candidate.references.map((reference) => reference.uri).join(' ');
  return `${candidate.title} ${candidate.summary} ${candidate.content} ${candidate.contextualContent} ${labelText} ${refText}`;
}

function hasTokenOverlap(actionTokens: Set<string>, candidate: RankedCandidate): boolean {
  if (actionTokens.size === 0) {
    return true; // graceful fallback — no keywords to compare
  }
  const candTokens = tokenizeForOverlap(candidateOverlapText(candidate));
  for (const token of actionTokens) {
    if (candTokens.has(token)) return true;
  }
  return false;
}

function taskBriefModeFor(classified: ClassifiedQuery): TaskBriefMode {
  if (classified.intent.taskBriefMode) {
    return classified.intent.taskBriefMode;
  }

  switch (classified.taskType) {
    case 'debugging':
      return 'debugging';
    case 'planning':
      return 'planning';
    case 'review':
      return 'review';
    case 'implementation':
    case 'refactor':
    case 'testing':
    case 'exploration':
      return 'implementation';
    case 'unknown':
      return 'unknown';
  }
}

function taskBriefGoal(classified: ClassifiedQuery, mode: TaskBriefMode): string {
  switch (mode) {
    case 'reflection_review':
      return 'review reflection drafts';
    case 'context_quality_review':
      return 'review context-quality feedback and noisy retrieval signals';
    case 'handoff_cleanup':
      return 'clean up current handoff state';
    case 'operations_review':
      return 'review open knowledge gaps and learning proposals';
    default:
      return classified.intent.taskGoal;
  }
}

function prefersWorkflowBeforePriorLessons(mode: TaskBriefMode): boolean {
  return mode === 'review'
    || mode === 'reflection_review'
    || mode === 'context_quality_review'
    || mode === 'handoff_cleanup'
    || mode === 'operations_review';
}

function isReviewQueueMode(mode: TaskBriefMode): boolean {
  return mode === 'reflection_review'
    || mode === 'context_quality_review'
    || mode === 'handoff_cleanup'
    || mode === 'operations_review';
}

function recommendedFilesFor(
  classified: ClassifiedQuery,
  selected: RankedCandidate[],
): ContextPackOrientation['recommendedFiles'] {
  const files = uniqueStrings([
    ...(classified.intent.workflowStage === 'continuation' && classified.project === 'tuberosa'
      ? ['handoff.md', 'docs/AGENT_CONTEXT_ROADMAP.md', 'tuberosa-project.md']
      : []),
    ...classified.files,
    ...selected
      .filter((candidate) => candidate.evidenceCategory === 'directTaskEvidence')
      .flatMap((candidate) => [
        ...candidate.labels.filter((label) => label.type === 'file').map((label) => label.value),
        ...candidate.references.filter((reference) => reference.type === 'file').map((reference) => reference.uri),
      ]),
  ].filter(isLikelyProjectFile)).slice(0, 8);

  return files.map((path) => ({
    path,
    reason: recommendedFileReason(path, classified),
  }));
}

function recommendedFileReason(path: string, classified: ClassifiedQuery): string {
  if (path === 'handoff.md') {
    return 'Current continuation state and next-step notes.';
  }
  if (path === 'tuberosa-project.md') {
    return 'Project intent and agent workflow constraints.';
  }
  if (path.endsWith('AGENT_CONTEXT_ROADMAP.md')) {
    return 'Roadmap phase scope and acceptance criteria.';
  }
  if (path.startsWith('test/') || path.includes('/test/')) {
    return 'Likely regression test surface for this task.';
  }
  if (classified.intent.workflowStage === 'continuation') {
    return 'Recent selected-session or handoff signal for continued work.';
  }
  return 'Direct file evidence from the current task.';
}

function likelySurfacesFor(
  recommendedFiles: ContextPackOrientation['recommendedFiles'],
  selected: RankedCandidate[],
): string[] {
  const codeFiles = recommendedFiles
    .map((file) => file.path)
    .filter((path) => !path.endsWith('.md'));

  if (codeFiles.length > 0) {
    return codeFiles.slice(0, 8);
  }

  return uniqueStrings(selected
    .filter((candidate) => candidate.evidenceCategory === 'directTaskEvidence')
    .map((candidate) => candidate.title))
    .slice(0, 5);
}

function verificationCommandsFor(
  classified: ClassifiedQuery,
  prompt: string,
  files: string[],
): string[] {
  if (classified.project !== 'tuberosa') {
    return [];
  }

  const commands: string[] = [];
  if (classified.taskType !== 'planning' && classified.taskType !== 'exploration') {
    commands.push('pnpm run build', 'pnpm test');
  }

  const text = `${prompt}\n${files.join('\n')}`.toLowerCase();
  if (/\bretrieval\b|context-pack|classifier|ranking|rerank|signal/.test(text)) {
    commands.push('pnpm run eval:retrieval');
  }
  if (/\bagent[-_\s]?context\b|\bagent session\b|\bmcp\b|context-decision|start_session|finish_session/.test(text)) {
    commands.push('pnpm run eval:agent-context');
  }
  if (/\bstorage\b|\bmigration\b|\bpostgres\b|\bredis\b|\bdocker\b|\bcache\b/.test(text)) {
    commands.push('pnpm run test:integration');
  }

  return uniqueStrings(commands).slice(0, 5);
}

function orientationNotes(input: AssembleContextPackInput, selected: RankedCandidate[]): string[] {
  const notes = [...input.classified.intent.uncertaintyReasons];
  if (input.contextFit?.fitStatus === 'insufficient') {
    notes.push('Context fit is insufficient; ask for clarification or inspect the missing local files first.');
  } else if (input.contextFit?.fitStatus === 'needs_confirmation') {
    notes.push('Context fit needs confirmation before relying on the pack.');
  }

  if (selected.some((candidate) => candidate.evidenceCategory === 'adjacentContext')) {
    notes.push('Adjacent context is lower priority than direct task evidence.');
  }

  return uniqueStrings(notes).slice(0, 6);
}

function buildActionableMissingSignals(signals: string[]): ActionableMissingSignals {
  const buckets: ActionableMissingSignals = {
    files: [],
    symbols: [],
    errors: [],
    docs: [],
    intent: [],
    other: [],
  };

  for (const signal of signals) {
    const value = signal.trim();
    if (!value) {
      continue;
    }

    if (value.startsWith('missing file:')) {
      pushMissingSignal(buckets.files, value.slice('missing file:'.length));
    } else if (value.startsWith('missing symbol:')) {
      pushMissingSignal(buckets.symbols, value.slice('missing symbol:'.length));
    } else if (value.startsWith('missing error:')) {
      pushMissingSignal(buckets.errors, value.slice('missing error:'.length));
    } else if (/handoff|roadmap|doc|docs|project/i.test(value)) {
      pushMissingSignal(buckets.docs, value);
    } else if (/project is unclear|task type is unclear|no concrete|unclear/i.test(value)) {
      pushMissingSignal(buckets.intent, value);
    } else {
      pushMissingSignal(buckets.other, value);
    }
  }

  return {
    files: uniqueStrings(buckets.files).slice(0, 8),
    symbols: uniqueStrings(buckets.symbols).slice(0, 8),
    errors: uniqueStrings(buckets.errors).slice(0, 8),
    docs: uniqueStrings(buckets.docs).slice(0, 8),
    intent: uniqueStrings(buckets.intent).slice(0, 8),
    other: uniqueStrings(buckets.other).slice(0, 8),
  };
}

function pushMissingSignal(target: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed) {
    target.push(trimmed);
  }
}

function isLikelyProjectFile(value: string): boolean {
  return /^[\w./-]+\.[a-zA-Z0-9]+$/.test(value) && !value.includes('://');
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
