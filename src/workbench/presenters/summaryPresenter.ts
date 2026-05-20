import type { WorkbenchCounts, WorkbenchSummary } from '../types.js';

export interface SummaryViewModel {
  health: { line: string; warning: boolean };
  metrics: Array<{ label: string; value: number; capped?: boolean; emphasis?: 'warn' | 'good' }>;
  recommendedActions: Array<{ priority: number; label: string; reason?: string; count: number }>;
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
      metric('Pending drafts', counts.pendingDrafts, capped.pendingDrafts, 'warn'),
      metric('Risky memories', counts.riskyAutoMemories, capped.riskyAutoMemories, 'warn'),
      metric('Quality feedback', counts.contextQualityMatched, undefined),
      metric('Knowledge gaps', counts.openGaps, capped.openGaps),
      metric('Proposals', counts.openProposals, capped.openProposals),
      metric('Conflicts', counts.openConflicts, capped.openConflicts),
      metric('Error logs', counts.openErrorLogs, undefined, 'warn'),
      metric('Sessions', counts.recentSessions, capped.recentSessions, 'good'),
    ].filter((m): m is NonNullable<typeof m> => m !== null),
    recommendedActions: summary.recommendedActions.slice(0, 6).map((a) => ({
      priority: a.priority,
      label: a.label,
      reason: a.reason,
      count: a.count,
    })),
  };
}

function metric(label: string, value: number | undefined, capped: boolean | undefined, emphasis?: 'warn' | 'good') {
  if (value === undefined) return null;
  return { label, value, capped, emphasis: value > 0 ? emphasis : undefined };
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
