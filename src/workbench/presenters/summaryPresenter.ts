import type { WorkbenchCounts, WorkbenchRecommendedActionTarget, WorkbenchSummary } from '../types.js';

export type SummaryRouteTarget =
  | 'overview'
  | 'session'
  | 'quality'
  | 'guide'
  | { view: 'memory'; memoryTab: 'drafts' | 'knowledge' | 'gaps' | 'proposals' | 'conflicts' | 'risky' | 'errors' };

export interface SummaryViewModel {
  health: { line: string; warning: boolean };
  metrics: Array<{ label: string; value: number; capped?: boolean; emphasis?: 'warn' | 'good'; hint: string; target: SummaryRouteTarget }>;
  recommendedActions: Array<{ priority: number; label: string; reason?: string; count: number; target: SummaryRouteTarget }>;
  queues: {
    contextQuality: WorkbenchSummary['contextQuality']['records'];
    pendingDrafts: WorkbenchSummary['pendingDrafts'];
    gaps: WorkbenchSummary['openGaps'];
    proposals: WorkbenchSummary['openProposals'];
    conflicts: WorkbenchSummary['openConflicts'];
    risky: WorkbenchSummary['riskyAutoMemories'];
    errorLogs: WorkbenchSummary['openErrorLogs']['logs'];
    recentSessions: WorkbenchSummary['recentSessions'];
  };
  emptyStates: Record<'drafts' | 'quality' | 'gaps' | 'proposals' | 'conflicts' | 'risky' | 'errors', string>;
}

export function presentSummary(summary: WorkbenchSummary): SummaryViewModel {
  const lastBackup = summary.health.backupStatus?.latestBackup;
  const lastBackupRel = lastBackup?.ageSeconds !== undefined ? formatSecondsAgo(lastBackup.ageSeconds) : undefined;
  const counts = summary.counts ?? {};
  const capped = summary.countMetadata?.capped ?? {};

  return {
    health: {
      line: `${summary.health.store} store · ${summary.health.cache} cache · ${summary.health.modelProvider} provider${lastBackupRel ? ` · last backup ${lastBackupRel}` : ''}.`,
      warning: summary.health.store !== 'postgres',
    },
    metrics: [
      metric('Pending drafts', counts.pendingDrafts, capped.pendingDrafts, 'warn', 'Unreviewed reflection drafts waiting for approve, needs_changes, or reject.', { view: 'memory', memoryTab: 'drafts' }),
      metric('Risky memories', counts.riskyAutoMemories, capped.riskyAutoMemories, 'warn', 'Auto-approved memories that still tripped a review heuristic and need a quick audit.', { view: 'memory', memoryTab: 'risky' }),
      metric('Quality feedback', counts.contextQualityMatched, undefined, undefined, 'Selected_but_noisy, missing_context, stale, and rejected context decisions to triage.', 'quality'),
      metric('Knowledge gaps', counts.openGaps, capped.openGaps, undefined, 'Missing evidence agents reported, usually a prompt to ingest a file, runbook, or lesson.', { view: 'memory', memoryTab: 'gaps' }),
      metric('Proposals', counts.openProposals, capped.openProposals, undefined, 'Reviewable cleanup suggestions for labels, references, supersession, or memory cleanup.', { view: 'memory', memoryTab: 'proposals' }),
      metric('Conflicts', counts.openConflicts, capped.openConflicts, undefined, 'Knowledge items that disagree or need a human decision before retrieval should trust them.', { view: 'memory', memoryTab: 'conflicts' }),
      metric('Error logs', counts.openErrorLogs, undefined, 'warn', 'Open captured failures that can become bugfix memories after triage.', { view: 'memory', memoryTab: 'errors' }),
      metric('Sessions', counts.recentSessions, capped.recentSessions, 'good', 'Recent agent sessions used to trace context decisions and learning outcomes.', 'session'),
    ].filter((m): m is NonNullable<typeof m> => m !== null),
    recommendedActions: summary.recommendedActions.slice(0, 6).map((a) => ({
      priority: a.priority,
      label: a.label,
      reason: a.reason,
      count: a.count,
      target: actionTarget(a.target),
    })),
    queues: {
      contextQuality: summary.contextQuality.records,
      pendingDrafts: summary.pendingDrafts,
      gaps: summary.openGaps,
      proposals: summary.openProposals,
      conflicts: summary.openConflicts,
      risky: summary.riskyAutoMemories,
      errorLogs: summary.openErrorLogs.logs,
      recentSessions: summary.recentSessions,
    },
    emptyStates: {
      drafts: 'No reflection drafts need review. Start or finish a session to create new learning candidates.',
      quality: 'No context-quality feedback matches these filters. Agents will populate this queue when they record context decisions.',
      gaps: 'No open gaps. Missing-context feedback will create gaps when agents cannot find needed evidence.',
      proposals: 'No learning proposals. Tuberosa creates proposals when feedback suggests labels, references, relations, or cleanup.',
      conflicts: 'No open conflicts. Detected contradictions or freshness problems will appear here.',
      risky: 'No risky auto-approved memories. Strict auto-learning has not flagged any approved memory under these filters.',
      errors: 'No open error logs. Captured failures will appear here after agents or tools record incidents.',
    },
  };
}

function metric(
  label: string,
  value: number | undefined,
  capped: boolean | undefined,
  emphasis: 'warn' | 'good' | undefined,
  hint: string,
  target: SummaryRouteTarget,
) {
  if (value === undefined) return null;
  return { label, value, capped, emphasis: value > 0 ? emphasis : undefined, hint, target };
}

export function actionTarget(target: WorkbenchRecommendedActionTarget): SummaryRouteTarget {
  switch (target) {
    case 'context_quality':
      return 'quality';
    case 'pending_drafts':
      return { view: 'memory', memoryTab: 'drafts' };
    case 'risky_auto_memories':
      return { view: 'memory', memoryTab: 'risky' };
    case 'knowledge_gaps':
      return { view: 'memory', memoryTab: 'gaps' };
    case 'learning_proposals':
      return { view: 'memory', memoryTab: 'proposals' };
    case 'knowledge_conflicts':
      return { view: 'memory', memoryTab: 'conflicts' };
    case 'error_logs':
      return { view: 'memory', memoryTab: 'errors' };
    case 'agent_sessions':
      return 'session';
    case 'backup_health':
    case 'none':
      return 'overview';
  }
}

function formatSecondsAgo(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

export function countValue(counts: WorkbenchCounts, key: keyof WorkbenchCounts): number {
  return counts?.[key] ?? 0;
}
