import type {
  EvidenceGraphTone,
  ReviewQueueFilter,
  ReviewQueueItemView,
  ReviewQueueViewModel,
  WorkbenchSummary,
} from '../types.js';

const FILTER_TYPE: Record<Exclude<ReviewQueueFilter, 'all'>, ReviewQueueItemView['type']> = {
  drafts: 'draft',
  quality: 'quality',
  gaps: 'gap',
  proposals: 'proposal',
  conflicts: 'conflict',
  risky: 'risky_memory',
  errors: 'error_log',
  maintenance: 'maintenance',
};

const FILTER_LABEL: Record<ReviewQueueFilter, string> = {
  all: 'All',
  drafts: 'Drafts',
  quality: 'Quality',
  gaps: 'Gaps',
  proposals: 'Proposals',
  conflicts: 'Conflicts',
  risky: 'Risky',
  errors: 'Errors',
  maintenance: 'Maintenance',
};

const FILTER_ORDER: ReviewQueueFilter[] = ['all', ...(Object.keys(FILTER_TYPE) as Array<Exclude<ReviewQueueFilter, 'all'>>)];

export function presentReviewQueue(summary: WorkbenchSummary, filter: ReviewQueueFilter = 'all'): ReviewQueueViewModel {
  const allItems: ReviewQueueItemView[] = [
    ...summary.contextQuality.records.map((item): ReviewQueueItemView => ({
      id: item.feedback.id,
      type: 'quality',
      priority: 1,
      tone: toneForFeedback(item.feedback.feedbackType),
      title: item.feedback.reason ?? item.contextPack?.prompt ?? item.session?.prompt ?? 'Context-quality feedback',
      summary: item.suggestedReviewActions[0] ?? 'Review why this context decision was recorded.',
      whyItMatters: 'Noisy, stale, rejected, or missing context directly affects agent startup trust.',
      evidence: [...item.missingSignals, ...item.suggestedReviewActions],
      primaryAction: 'Review feedback',
      secondaryActions: ['Open gaps', 'Open proposals'],
      createdAt: item.feedback.createdAt,
    })),
    ...summary.pendingDrafts.map((draft): ReviewQueueItemView => ({
      id: draft.id,
      type: 'draft',
      priority: 2,
      tone: 'warn',
      title: draft.title,
      summary: draft.summary,
      whyItMatters: 'Unreviewed drafts stay out of trusted retrieval until a reviewer decides.',
      evidence: [`${draft.labelCount} labels`, `${draft.referenceCount} references`, `${draft.duplicateCandidateCount} duplicate candidates`],
      primaryAction: 'Review draft',
      secondaryActions: ['Approve', 'Needs changes', 'Reject'],
      createdAt: draft.createdAt,
    })),
    ...summary.openGaps.map((gap): ReviewQueueItemView => ({
      id: gap.id,
      type: 'gap',
      priority: 3,
      tone: 'warn',
      title: gap.reason ?? gap.prompt,
      summary: gap.prompt,
      whyItMatters: 'Open gaps mark evidence agents could not find.',
      evidence: gap.missingSignals,
      primaryAction: 'Triage gap',
      secondaryActions: ['Approve', 'Needs changes', 'Dismiss'],
      createdAt: gap.createdAt,
    })),
    ...summary.openProposals.map((proposal): ReviewQueueItemView => ({
      id: proposal.id,
      type: 'proposal',
      priority: 3,
      tone: 'accent',
      title: proposal.reason,
      summary: proposal.proposalType,
      whyItMatters: 'Learning proposals are the review path for labels, relations, supersession, and cleanup.',
      evidence: proposal.evidence,
      primaryAction: 'Review proposal',
      secondaryActions: ['Approve', 'Needs changes', 'Dismiss'],
      createdAt: proposal.createdAt,
    })),
    ...summary.openConflicts.map((conflict): ReviewQueueItemView => ({
      id: conflict.id,
      type: 'conflict',
      priority: 3,
      tone: 'bad',
      title: conflict.reason,
      summary: `${conflict.leftKnowledgeId} vs ${conflict.rightKnowledgeId}`,
      whyItMatters: 'Conflicting guidance can make future context packs unreliable.',
      evidence: conflict.sharedEvidence,
      primaryAction: 'Resolve conflict',
      secondaryActions: ['Resolve', 'Dismiss'],
      createdAt: conflict.createdAt,
    })),
    ...summary.riskyAutoMemories.map((memory): ReviewQueueItemView => ({
      id: memory.id,
      type: 'risky_memory',
      priority: 2,
      tone: memory.trustLevel >= 80 ? 'warn' : 'bad',
      title: memory.title,
      summary: memory.summary,
      whyItMatters: 'Auto-approved memories with weak evidence should be audited before retrieval relies on them.',
      evidence: [`trust ${memory.trustLevel}`, `${memory.labelCount} labels`, `${memory.referenceCount} references`],
      primaryAction: 'Audit memory',
      secondaryActions: ['Mark needs review', 'Archive'],
      createdAt: memory.createdAt,
    })),
    ...summary.openErrorLogs.logs.map((log): ReviewQueueItemView => ({
      id: log.id,
      type: 'error_log',
      priority: isHighSeverity(log.severity) ? 2 : 4,
      tone: isHighSeverity(log.severity) ? 'bad' : 'warn',
      title: log.title,
      summary: log.summary ?? `${log.category} · ${log.status}`,
      whyItMatters: 'Resolved incidents can become reviewed bugfix lessons.',
      evidence: [...log.files, ...log.errors, ...log.tags],
      primaryAction: 'Triage error',
      secondaryActions: ['Mark triaged', 'Archive'],
      createdAt: log.lastSeenAt,
    })),
    ...summary.pendingMaintenance.items.map((item): ReviewQueueItemView => ({
      id: item.id,
      type: 'maintenance',
      priority: item.risk === 'high' ? 2 : 4,
      tone: item.risk === 'high' ? 'bad' : item.risk === 'medium' ? 'warn' : 'good',
      title: item.reason,
      summary: item.kind,
      whyItMatters: 'Maintenance keeps memory and relation quality from drifting.',
      evidence: [item.knowledgeId, item.relationId, item.reflectionDraftId, item.closestKnowledgeId].filter((value): value is string => Boolean(value)),
      primaryAction: 'Preview maintenance',
      secondaryActions: ['Apply selected'],
    })),
  ].sort((a, b) => a.priority - b.priority || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  const items = allItems.filter((item) => filterMatches(filter, item.type));
  return {
    activeFilter: filter,
    filters: FILTER_ORDER.map((key) => ({
      key,
      label: FILTER_LABEL[key],
      count: allItems.filter((item) => filterMatches(key, item.type)).length,
    })),
    items,
    emptyTitle: filter === 'all' ? 'Nothing needs a decision' : `No ${FILTER_LABEL[filter].toLowerCase()} items`,
    emptyHint: filter === 'all'
      ? 'Tuberosa will surface review work here after sessions, feedback, drafts, or maintenance scans.'
      : 'Change the filter or map a new task to create review work.',
  };
}

function filterMatches(filter: ReviewQueueFilter, type: ReviewQueueItemView['type']): boolean {
  return filter === 'all' || FILTER_TYPE[filter] === type;
}

function isHighSeverity(severity: string): boolean {
  return severity === 'error' || severity === 'critical' || severity === 'alert' || severity === 'emergency';
}

function toneForFeedback(type: string): EvidenceGraphTone {
  if (type === 'selected') return 'good';
  if (type === 'selected_but_noisy') return 'warn';
  if (type === 'missing_context' || type === 'rejected' || type === 'stale' || type === 'irrelevant') return 'bad';
  return 'muted';
}
