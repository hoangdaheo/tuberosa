import type {
  ErrorLogSummary,
  WorkbenchKnowledgeConflictSummary,
  WorkbenchKnowledgeGapSummary,
  WorkbenchKnowledgeSummary,
  WorkbenchLearningProposalSummary,
  WorkbenchReflectionDraftSummary,
  WorkbenchRecommendedAction,
  WorkbenchSummary,
  WorkbenchSummaryCountKey,
} from '../types.js';
import { buildWorkbenchSummary, type WorkbenchSummaryServices } from './workbench-summary.js';

export interface WorkbenchCliOptions {
  project?: string;
  limit: number;
  apiBase?: string;
  json: boolean;
  help: boolean;
}

export interface WorkbenchFormatOptions {
  apiBase?: string;
}

export function parseWorkbenchArgs(args: string[]): WorkbenchCliOptions {
  const options: WorkbenchCliOptions = {
    limit: 10,
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--') {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--project') {
      options.project = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--limit') {
      options.limit = readPositiveInteger(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === '--api-base') {
      options.apiBase = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}\n\n${workbenchUsage()}`);
  }

  return options;
}

export async function runWorkbenchSummary(
  services: WorkbenchSummaryServices,
  options: WorkbenchCliOptions,
): Promise<WorkbenchSummary> {
  return buildWorkbenchSummary(services, {
    project: options.project,
    limit: options.limit,
  });
}

export function formatWorkbenchSummary(
  summary: WorkbenchSummary,
  options: WorkbenchFormatOptions = {},
): string {
  const lines = [
    '# Tuberosa Workbench',
    '',
    `Generated: ${summary.generatedAt}`,
    `Filters: ${formatFilters(summary.filters)}`,
    `Workbench: ${endpoint('/workbench', options.apiBase)}`,
    `Summary API: ${endpointWithQuery('/operations/workbench/summary', {
      project: summary.filters.project,
      limit: summary.filters.limit,
    }, options.apiBase)}`,
    '',
    '## Health',
    `Store: ${summary.health.store} (${summary.health.durability})`,
    `Cache: ${summary.health.cache}`,
    `Model provider: ${summary.health.modelProvider}`,
    `Backups: ${summary.health.backupStatus.health}; count=${summary.health.backupStatus.backupCount}; dir=${summary.health.backupDir}`,
    '',
    '## Counts',
    `Count scan limit: ${summary.countMetadata.scanLimit}; capped values end with +`,
    `Recent sessions: ${formatCount(summary, 'recentSessions')}; active=${formatCount(summary, 'activeSessions')}`,
    `Context quality: matched=${formatCount(summary, 'contextQualityMatched')}; showing=${formatCount(summary, 'contextQualityRecords')}`,
    `Pending drafts: ${formatCount(summary, 'pendingDrafts')}`,
    `Open gaps/proposals/conflicts: ${formatCount(summary, 'openGaps')}/${formatCount(summary, 'openProposals')}/${formatCount(summary, 'openConflicts')}`,
    `Auto memories: ${formatCount(summary, 'autoMemories')}; risky=${formatCount(summary, 'riskyAutoMemories')}`,
    `Open error logs: ${formatCount(summary, 'openErrorLogs')}`,
    '',
    '## Recommended Actions',
    ...formatRecommendedActions(summary.recommendedActions, options.apiBase),
    '',
    '## Recent Sessions',
    ...formatRecentSessions(summary),
    '',
    '## Context Quality',
    ...formatContextQuality(summary, options.apiBase),
    '',
    '## Memory Review',
    ...formatMemoryReview(summary, options.apiBase),
    '',
    '## Error Logs',
    ...formatErrorLogs(summary.openErrorLogs.logs, options.apiBase),
  ];

  return lines.join('\n');
}

export function workbenchUsage(): string {
  return [
    'Usage: pnpm run workbench -- [--project <name>] [--limit <n>] [--api-base <url>] [--json]',
    '',
    'Prints a read-only local workbench summary from existing Tuberosa operations APIs.',
  ].join('\n');
}

function formatRecommendedActions(actions: WorkbenchRecommendedAction[], apiBase?: string): string[] {
  return actions.map((action, index) => {
    const href = action.href ? ` | ${endpoint(action.href, apiBase)}` : '';
    return `${index + 1}. ${action.label} (${action.count})${href}\n   Reason: ${action.reason}`;
  });
}

function formatRecentSessions(summary: WorkbenchSummary): string[] {
  if (summary.recentSessions.length === 0) {
    return ['No recent sessions matched these filters.'];
  }

  return summary.recentSessions.map((session) => {
    const outcome = session.outcome ? `/${session.outcome}` : '';
    return `- ${session.id} | ${session.status}${outcome} | ${truncateLine(session.prompt, 100)}`;
  });
}

function formatContextQuality(summary: WorkbenchSummary, apiBase?: string): string[] {
  if (summary.contextQuality.records.length === 0) {
    return ['No context-quality feedback matched these filters.'];
  }

  return summary.contextQuality.records.map((record) => {
    const pack = record.contextPack
      ? ` | pack=${endpoint(`/context/packs/${encodeURIComponent(record.contextPack.id)}`, apiBase)}`
      : '';
    return `- ${record.feedback.feedbackType} (${record.feedback.id})${pack} | actions=${record.suggestedReviewActions.length}`;
  });
}

function formatMemoryReview(summary: WorkbenchSummary, apiBase?: string): string[] {
  const lines: string[] = [];
  appendDrafts(lines, summary.pendingDrafts, apiBase);
  appendAutoMemories(lines, summary.riskyAutoMemories, apiBase);
  appendGaps(lines, summary.openGaps, apiBase);
  appendProposals(lines, summary.openProposals, apiBase);
  appendConflicts(lines, summary.openConflicts, apiBase);

  return lines.length > 0 ? lines : ['No pending memory review items matched these filters.'];
}

function appendDrafts(lines: string[], drafts: WorkbenchReflectionDraftSummary[], apiBase?: string): void {
  if (drafts.length === 0) {
    return;
  }

  lines.push('Pending drafts:');
  for (const draft of drafts) {
    lines.push(`- ${draft.title} (${draft.id}) | ${endpoint(`/reflection-drafts/${encodeURIComponent(draft.id)}`, apiBase)}`);
  }
}

function appendAutoMemories(lines: string[], memories: WorkbenchKnowledgeSummary[], apiBase?: string): void {
  if (memories.length === 0) {
    return;
  }

  lines.push('Risky auto memories:');
  for (const memory of memories) {
    lines.push(`- ${memory.title} (${memory.id}) | status=${memory.status ?? 'approved'} | ${endpoint(`/knowledge/${encodeURIComponent(memory.id)}`, apiBase)}`);
  }
}

function appendGaps(lines: string[], gaps: WorkbenchKnowledgeGapSummary[], apiBase?: string): void {
  if (gaps.length === 0) {
    return;
  }

  lines.push('Open gaps:');
  for (const gap of gaps) {
    lines.push(`- ${gap.id} | missing=${formatStringList(gap.missingSignals, 5)} | ${endpoint(`/operations/knowledge-gaps/${encodeURIComponent(gap.id)}`, apiBase)}`);
  }
}

function appendProposals(lines: string[], proposals: WorkbenchLearningProposalSummary[], apiBase?: string): void {
  if (proposals.length === 0) {
    return;
  }

  lines.push('Open proposals:');
  for (const proposal of proposals) {
    lines.push(`- ${proposal.proposalType} (${proposal.id}) | ${truncateLine(proposal.reason, 100)} | ${endpoint(`/operations/learning-proposals/${encodeURIComponent(proposal.id)}`, apiBase)}`);
  }
}

function appendConflicts(lines: string[], conflicts: WorkbenchKnowledgeConflictSummary[], apiBase?: string): void {
  if (conflicts.length === 0) {
    return;
  }

  lines.push('Open conflicts:');
  for (const conflict of conflicts) {
    lines.push(`- ${conflict.conflictType} (${conflict.id}) | ${endpoint(`/operations/conflicts/${encodeURIComponent(conflict.id)}`, apiBase)}`);
  }
}

function formatErrorLogs(logs: ErrorLogSummary[], apiBase?: string): string[] {
  if (logs.length === 0) {
    return ['No open or triaged error logs matched these filters.'];
  }

  return logs.map((log) => (
    `- ${log.title} (${log.id}) | ${log.status}/${log.severity} | ${endpoint(`/operations/error-logs/${encodeURIComponent(log.id)}`, apiBase)}`
  ));
}

function formatFilters(filters: WorkbenchSummary['filters']): string {
  return [
    filters.project ? `project=${filters.project}` : 'project=all',
    `limit=${filters.limit}`,
  ].join('; ');
}

function formatCount(summary: WorkbenchSummary, key: WorkbenchSummaryCountKey): string {
  const value = summary.counts[key];
  return summary.countMetadata.capped[key] ? `${value}+` : String(value);
}

function endpointWithQuery(
  path: string,
  params: Record<string, string | number | undefined>,
  apiBase?: string,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      query.set(key, String(value));
    }
  }

  const serialized = query.toString();
  return endpoint(serialized ? `${path}?${serialized}` : path, apiBase);
}

function endpoint(path: string, apiBase?: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (!apiBase) {
    return normalizedPath;
  }

  return `${apiBase.replace(/\/+$/, '')}${normalizedPath}`;
}

function formatStringList(values: string[], max: number): string {
  if (values.length === 0) {
    return 'none';
  }

  const visible = values.slice(0, max);
  const suffix = values.length > max ? `, +${values.length - max} more` : '';
  return `${visible.join(', ')}${suffix}`;
}

function truncateLine(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

function readPositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${option} requires a positive integer.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) {
    throw new Error(`${option} requires a positive integer.`);
  }

  return Math.min(parsed, 100);
}
