import type { DraftRecommendation, ReflectionDraft, TriggerType, KnowledgeItemType } from '../types.js';

export interface DraftViewModel {
  id: string;
  status: ReflectionDraft['status'];
  headline: string;
  oneLineSummary: string;
  whatItClaims: string;
  whyItExists: string;
  itemTypeLabel: string;
  whereItCameFrom: { label: string; sessionId?: string; errorLogIds?: string[] };
  evidenceStrength: 'strong' | 'mixed' | 'weak';
  groundedRefCount: number;
  conversationRefCount: number;
  concreteLabelCount: number;
  duplicates: Array<{ title: string; score: number }>;
  age: string;
  recommendationSummary?: { verdict: DraftRecommendation['verdict']; confidence: DraftRecommendation['confidence']; rationale: string };
}

export function presentDraft(draft: ReflectionDraft, recommendation?: DraftRecommendation): DraftViewModel {
  const grounded = draft.references.filter((r) => r.type !== 'conversation');
  const conversation = draft.references.filter((r) => r.type === 'conversation');
  const concreteLabels = draft.suggestedLabels.filter((l) => ['task_type', 'file', 'symbol', 'error'].includes(l.type));
  const errorLogIds = arrayOfStrings(draft.metadata.errorLogIds);
  const sessionId = stringFromMetadata(draft.metadata, 'agentSessionId');

  return {
    id: draft.id,
    status: draft.status,
    headline: truncate(draft.title, 96),
    oneLineSummary: firstSentence(draft.summary, 160),
    whatItClaims: truncate(draft.content, 380),
    whyItExists: triggerTypeSentence(draft.triggerType),
    itemTypeLabel: itemTypeSentence(draft.itemType),
    whereItCameFrom: {
      label: provenanceSentence(draft, sessionId, errorLogIds),
      sessionId,
      errorLogIds,
    },
    evidenceStrength: evidenceStrength(grounded.length, concreteLabels.length, draft.duplicateCandidates.length),
    groundedRefCount: grounded.length,
    conversationRefCount: conversation.length,
    concreteLabelCount: concreteLabels.length,
    duplicates: draft.duplicateCandidates.slice(0, 5).map((c) => ({ title: c.title, score: c.score })),
    age: relativeAge(draft.createdAt),
    recommendationSummary: recommendation
      ? { verdict: recommendation.verdict, confidence: recommendation.confidence, rationale: recommendation.oneLineRationale }
      : undefined,
  };
}

function evidenceStrength(grounded: number, concreteLabels: number, duplicates: number): 'strong' | 'mixed' | 'weak' {
  if (duplicates > 0) return 'mixed';
  if (grounded >= 2 && concreteLabels >= 2) return 'strong';
  if (grounded >= 1 && concreteLabels >= 1) return 'mixed';
  return 'weak';
}

function triggerTypeSentence(trigger: TriggerType): string {
  switch (trigger) {
    case 'complex_task_success':   return 'Captured after a complex task completed successfully — the agent thought this was worth remembering.';
    case 'error_recovery':         return 'Captured while recovering from an error — the lesson protects future tasks from repeating it.';
    case 'user_correction':        return 'Captured because the user corrected the agent — preserves the user preference for next time.';
    case 'non_trivial_workflow':   return 'Captured from a non-trivial workflow — documents a repeatable sequence the agent worked out.';
    case 'manual':                 return 'Created manually — a human authored this lesson directly.';
    default:                       return 'Captured by Tuberosa.';
  }
}

function itemTypeSentence(itemType: KnowledgeItemType): string {
  switch (itemType) {
    case 'spec':         return 'Spec';
    case 'workflow':     return 'Workflow';
    case 'memory':       return 'Memory';
    case 'bugfix':       return 'Bug fix';
    case 'code_ref':     return 'Code reference';
    case 'rule':         return 'Rule';
    case 'wiki':         return 'Wiki';
    case 'conversation': return 'Conversation';
    default:             return itemType;
  }
}

function provenanceSentence(draft: ReflectionDraft, sessionId: string | undefined, errorLogIds: string[]): string {
  const age = relativeAge(draft.createdAt);
  if (errorLogIds.length > 0) {
    return `Generated ${age} from ${errorLogIds.length} linked error log${errorLogIds.length === 1 ? '' : 's'}.`;
  }
  if (sessionId) {
    const outcome = stringFromMetadata(draft.metadata, 'sessionOutcome');
    if (outcome) {
      return `Generated ${age} from an agent session that ${outcome}.`;
    }
    return `Generated ${age} from an agent session.`;
  }
  return `Created ${age}.`;
}

function relativeAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

function firstSentence(text: string, max: number): string {
  const match = /^(.{0,200}?[.!?])\s/.exec(text);
  const candidate = match ? match[1] : text;
  return truncate(candidate, max);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stringFromMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
