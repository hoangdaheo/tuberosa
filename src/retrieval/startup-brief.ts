import type {
  AgentContextDecisionType,
  ClassifiedQuery,
  ContextFit,
  RankedCandidate,
  StartupBrief,
} from '../types.js';
import { uniqueStrings } from '../util/text.js';

interface ComposeStartupBriefInput {
  prompt: string;
  classified: ClassifiedQuery;
  candidates: RankedCandidate[];
  contextFit?: ContextFit;
}

export function composeStartupBrief(input: ComposeStartupBriefInput): StartupBrief {
  const worktreePaths = new Set(
    input.candidates
      .filter((candidate) => candidate.source === 'worktree')
      .map(candidatePath)
      .filter((path): path is string => Boolean(path)),
  );
  const availablePaths = new Set(
    input.candidates
      .map(candidatePath)
      .filter((path): path is string => Boolean(path)),
  );
  const requiredFiles = requiredContinuationFiles(input.prompt, input.classified);
  const missingSignals = uniqueStrings([
    ...(input.contextFit?.missingSignals ?? []),
    ...requiredFiles
      .filter((path) => !availablePaths.has(path))
      .map((path) => missingSignalForPath(path)),
  ]);
  const mismatches = detectPlanMismatches(input.candidates);
  if (mismatches.length) {
    missingSignals.push('plan_mismatch');
  }

  const requiredMissing = requiredFiles.some((path) => !availablePaths.has(path));
  const requiredNotInWorktree = requiredFiles.some((path) => !worktreePaths.has(path));
  const verdict = requiredMissing || input.contextFit?.fitStatus === 'insufficient'
    ? 'clarify'
    : mismatches.length || requiredNotInWorktree || input.contextFit?.fitStatus === 'needs_confirmation'
      ? 'confirm'
      : 'proceed';

  return {
    verdict,
    readFirst: readFirstItems(input.candidates),
    directEvidence: directEvidence(input.candidates),
    adjacentEvidence: adjacentEvidence(input.candidates),
    missingSignals: uniqueStrings(missingSignals),
    riskyAreas: riskyAreasFor(verdict, mismatches),
    verificationCommands: verificationCommandsFor(input.classified),
    requiredContextDecision: requiredContextDecisionFor(verdict),
  };
}

function readFirstItems(candidates: RankedCandidate[]): StartupBrief['readFirst'] {
  const seen = new Set<string>();
  const items: StartupBrief['readFirst'] = [];
  for (const candidate of candidates) {
    const path = candidatePath(candidate);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    items.push({
      path,
      source: candidate.source === 'worktree' ? 'worktree' : 'memory',
      reason: readFirstReason(path, candidate),
    });
    if (items.length >= 6) break;
  }
  return items;
}

function directEvidence(candidates: RankedCandidate[]): StartupBrief['directEvidence'] {
  return candidates
    .filter((candidate) => candidate.source === 'worktree' || candidate.evidenceCategory === 'directTaskEvidence')
    .slice(0, 6)
    .map((candidate) => ({
      knowledgeId: candidate.knowledgeId.startsWith('worktree:') ? undefined : candidate.knowledgeId,
      path: candidatePath(candidate),
      reason: candidate.matchReasons[0] ?? candidate.usefulnessReason ?? 'Direct task evidence.',
    }));
}

function adjacentEvidence(candidates: RankedCandidate[]): StartupBrief['adjacentEvidence'] {
  const directIds = new Set(directEvidence(candidates).map((item) => item.knowledgeId).filter(Boolean));
  return candidates
    .filter((candidate) => !candidate.knowledgeId.startsWith('worktree:') && !directIds.has(candidate.knowledgeId))
    .slice(0, 6)
    .map((candidate) => ({
      knowledgeId: candidate.knowledgeId,
      reason: candidate.matchReasons[0] ?? candidate.usefulnessReason ?? 'Adjacent retrieval evidence.',
    }));
}

function requiredContinuationFiles(prompt: string, classified: ClassifiedQuery): string[] {
  if (classified.intent.workflowStage !== 'continuation') {
    return [];
  }

  const files = extractPromptContinuationFiles(prompt);
  if (
    files.length === 0
    && /\bhandoff\b/i.test(prompt)
    && classified.intent.requiredEvidenceTypes.includes('handoff')
  ) {
    return ['handoff.md'];
  }
  return uniqueStrings(files);
}

function extractPromptContinuationFiles(prompt: string): string[] {
  const matches = prompt.match(/(?:[\w.-]+\/)+[\w.-]+\.md|[\w.-]+\.md/g) ?? [];
  return matches.filter((path) => /(^|\/)(handoff|plan|roadmap|status|notes)[^/]*\.md$/i.test(path));
}

function missingSignalForPath(path: string): string {
  if (/handoff/i.test(path)) return 'handoff_file';
  if (/plan|roadmap/i.test(path)) return 'plan_file';
  return 'required_file';
}

function detectPlanMismatches(candidates: RankedCandidate[]): string[] {
  const worktreeByPath = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.source !== 'worktree') continue;
    const path = candidatePath(candidate);
    const heading = firstHeading(candidate);
    if (path && heading) {
      worktreeByPath.set(path, normalizeHeading(heading));
    }
  }

  const mismatches: string[] = [];
  for (const candidate of candidates) {
    if (candidate.source === 'worktree') continue;
    const path = candidatePath(candidate);
    const worktreeHeading = path ? worktreeByPath.get(path) : undefined;
    if (!path || !worktreeHeading || !/plan|roadmap|handoff|status|notes/i.test(path)) continue;
    const memoryTitle = normalizeHeading(candidate.title);
    if (memoryTitle && memoryTitle !== worktreeHeading && !memoryTitle.includes(worktreeHeading) && !worktreeHeading.includes(memoryTitle)) {
      mismatches.push(path);
    }
  }
  return uniqueStrings(mismatches);
}

function candidatePath(candidate: RankedCandidate): string | undefined {
  const worktree = candidate.metadata?.worktree as { path?: string } | undefined;
  if (worktree?.path) return worktree.path;
  const fileLabel = candidate.labels.find((label) => label.type === 'file')?.value;
  if (fileLabel) return fileLabel;
  return candidate.references.find((reference) => reference.type === 'file')?.uri;
}

function firstHeading(candidate: RankedCandidate): string | undefined {
  const worktree = candidate.metadata?.worktree as { firstHeading?: string } | undefined;
  return worktree?.firstHeading;
}

function normalizeHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function readFirstReason(path: string, candidate: RankedCandidate): string {
  if (candidate.source === 'worktree') {
    return 'Live worktree evidence for the current task.';
  }
  if (/handoff/i.test(path)) {
    return 'Durable handoff evidence for continuation.';
  }
  if (/plan|roadmap/i.test(path)) {
    return 'Durable plan evidence for continuation.';
  }
  return 'Retrieved file evidence for this task.';
}

function riskyAreasFor(verdict: StartupBrief['verdict'], mismatches: string[]): string[] {
  if (verdict === 'proceed' && mismatches.length === 0) {
    return [];
  }
  return uniqueStrings([
    ...(mismatches.length ? ['memory_worktree_disagreement'] : []),
    verdict === 'clarify' ? 'missing_required_context' : undefined,
    verdict === 'confirm' ? 'context_confirmation_needed' : undefined,
  ].filter((value): value is string => Boolean(value)));
}

function verificationCommandsFor(classified: ClassifiedQuery): string[] {
  if (classified.taskType === 'testing') return ['pnpm test'];
  if (classified.taskType === 'debugging' || classified.taskType === 'implementation' || classified.taskType === 'refactor') {
    return ['pnpm run build', 'pnpm test'];
  }
  return ['pnpm run build'];
}

function requiredContextDecisionFor(verdict: StartupBrief['verdict']): AgentContextDecisionType {
  if (verdict === 'proceed') return 'selected';
  if (verdict === 'confirm') return 'selected_but_noisy';
  return 'missing_context';
}
