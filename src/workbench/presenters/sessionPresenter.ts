import type { AgentSessionStartResult, ContextPack, ContextPackSection, RankedCandidate } from '../types.js';

export interface SessionViewModel {
  sessionId: string;
  fitStatus: 'ready' | 'needs_confirmation' | 'insufficient' | 'unknown';
  fitHeadline: string;
  policyAction: 'proceed' | 'confirm' | 'clarify';
  policyInstruction: string;
  goal?: string;
  actionItems: Array<{ priority: number; label: string; reason?: string; command?: string; targetPath?: string }>;
  recommendedFiles: Array<{ path: string; reason: string }>;
  verificationCommands: string[];
  missingSignals: string[];
  essential: EvidenceRow[];
  supporting: EvidenceRow[];
  optional: EvidenceRow[];
}

export interface EvidenceRow {
  knowledgeId: string;
  title: string;
  summary: string;
  itemType: string;
  evidenceCategoryLabel: string;
  evidenceStrengthLabel: string;
  matchReasons: string[];
  usefulnessReason?: string;
  score: number;
}

export function presentSessionStart(result: AgentSessionStartResult): SessionViewModel {
  const pack = result.contextPack;
  const fit = pack.contextFit;
  const fitStatus = fit?.fitStatus ?? 'unknown';
  return {
    sessionId: result.session.id,
    fitStatus,
    fitHeadline: fitHeadline(fitStatus, fit?.fitScore),
    policyAction: result.policy.action,
    policyInstruction: result.policy.instruction,
    goal: pack.taskBrief?.goal,
    actionItems: (pack.taskBrief?.actionItems ?? []).slice(0, 8).map((a) => ({
      priority: a.priority,
      label: a.label,
      reason: a.reason,
      command: a.command,
      targetPath: a.targetPath,
    })),
    recommendedFiles: pack.orientation?.recommendedFiles ?? [],
    verificationCommands: pack.orientation?.verificationCommands ?? [],
    missingSignals: flattenMissing(pack),
    essential: sectionRows(pack, 'essential'),
    supporting: sectionRows(pack, 'supporting'),
    optional: sectionRows(pack, 'optional'),
  };
}

function fitHeadline(status: string, score?: number): string {
  const pct = score !== undefined ? ` (${Math.round(score * 100)}%)` : '';
  switch (status) {
    case 'ready':              return `Context fit is ready${pct} — the agent should proceed with the suggested pack.`;
    case 'needs_confirmation': return `Context fit needs confirmation${pct} — review before relying on it.`;
    case 'insufficient':       return `Context is insufficient${pct} — the agent should ask for more signal.`;
    default:                   return 'No context fit recorded.';
  }
}

function flattenMissing(pack: ContextPack): string[] {
  const missing = pack.orientation?.missingSignals ?? pack.contextFit?.missingSignals;
  if (!missing) return [];
  if (Array.isArray(missing)) return missing;
  return Object.entries(missing).flatMap(([kind, items]) =>
    (items as string[]).map((value) => `${kind}: ${value}`),
  );
}

function sectionRows(pack: ContextPack, name: ContextPackSection['name']): EvidenceRow[] {
  const section = pack.sections.find((s) => s.name === name);
  if (!section) return [];
  return section.items.map(renderCandidate);
}

function renderCandidate(item: RankedCandidate): EvidenceRow {
  return {
    knowledgeId: item.knowledgeId,
    title: item.title,
    summary: item.summary,
    itemType: item.itemType,
    evidenceCategoryLabel: evidenceCategoryLabel(item.evidenceCategory),
    evidenceStrengthLabel: item.evidenceStrength ?? 'unrated',
    matchReasons: item.matchReasons ?? [],
    usefulnessReason: item.usefulnessReason,
    score: item.finalScore,
  };
}

function evidenceCategoryLabel(c: RankedCandidate['evidenceCategory']): string {
  switch (c) {
    case 'directTaskEvidence': return 'Direct evidence';
    case 'priorLessons':       return 'Prior lesson';
    case 'workflowGuidance':   return 'Workflow guidance';
    case 'adjacentContext':    return 'Adjacent context';
    default:                   return 'Context';
  }
}
