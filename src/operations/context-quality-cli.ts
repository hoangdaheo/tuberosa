import type {
  ContextQualityFeedbackRecord,
  ContextQualityReport,
  ContextQualityReportInput,
  FeedbackQualityType,
} from '../types.js';
import { CONTEXT_QUALITY_FEEDBACK_TYPES } from '../validation.js';

export interface ContextQualityCliOptions {
  project?: string;
  feedbackType?: FeedbackQualityType;
  limit: number;
  out?: string;
  apiBase?: string;
  json: boolean;
  help: boolean;
}

export interface ContextQualityWorkbenchOperations {
  collectContextQualityFeedback(input: ContextQualityReportInput): Promise<ContextQualityReport>;
}

export interface ContextQualityFormatOptions {
  apiBase?: string;
}

export function parseContextQualityArgs(args: string[]): ContextQualityCliOptions {
  const options: ContextQualityCliOptions = {
    limit: 25,
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

    if (arg === '--feedback-type' || arg === '--feedbackType' || arg === '--type') {
      options.feedbackType = readFeedbackType(readOptionValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg === '--limit') {
      options.limit = readPositiveInteger(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === '--out') {
      options.out = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--api-base') {
      options.apiBase = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}\n\n${contextQualityUsage()}`);
  }

  return options;
}

export async function runContextQualityWorkbench(
  operations: ContextQualityWorkbenchOperations,
  options: ContextQualityCliOptions,
): Promise<ContextQualityReport> {
  return operations.collectContextQualityFeedback({
    project: options.project,
    feedbackType: options.feedbackType,
    limit: options.limit,
  });
}

export function formatContextQualityWorkbench(
  report: ContextQualityReport,
  options: ContextQualityFormatOptions = {},
): string {
  const lines: string[] = [
    '# Context Quality Workbench',
    '',
    `Generated: ${report.generatedAt}`,
    `Filters: ${formatFilters(report.filters)}`,
    `Matched: ${report.totalMatched}; showing: ${report.records.length}`,
    `Report: ${contextQualityReportEndpoint(report.filters, options.apiBase)}`,
    '',
    'Review routes below use existing operations APIs. This workbench does not mutate data.',
    '',
    '## Rollups',
    ...formatRollups(report),
  ];

  if (report.records.length === 0) {
    lines.push('', 'No context-quality feedback matched these filters.');
    return lines.join('\n');
  }

  lines.push('', '## Feedback Records');
  for (const [index, record] of report.records.entries()) {
    lines.push('', ...formatRecord(index + 1, record, options.apiBase));
  }

  return lines.join('\n');
}

export function contextQualityUsage(): string {
  return [
    'Usage: pnpm run context-quality -- [--project <name>] [--feedback-type <type>] [--limit <n>] [--api-base <url>] [--json] [--out <path>]',
    '',
    'Prints a review workbench for context-quality feedback from /operations/context-quality.',
    '',
    'Feedback types:',
    ...CONTEXT_QUALITY_FEEDBACK_TYPES.map((type) => `  - ${type}`),
  ].join('\n');
}

function formatRollups(report: ContextQualityReport): string[] {
  return [
    `Feedback types: ${formatCountList(report.rollups.feedbackTypes)}`,
    `Projects: ${formatCountList(report.rollups.projects)}`,
    `Missing signals: ${formatCountList(report.rollups.missingSignals, 8)}`,
    `Suggested actions: ${formatCountList(report.rollups.suggestedReviewActions, 5)}`,
    `Adjacent items: ${formatAdjacentRollup(report.rollups.adjacentItems)}`,
  ];
}

function formatRecord(index: number, record: ContextQualityFeedbackRecord, apiBase?: string): string[] {
  const project = record.feedback.project ?? record.contextPack?.project ?? 'unknown';
  const lines = [
    `### ${index}. ${record.feedback.feedbackType} (${record.feedback.id})`,
    `Project: ${project}`,
    `Created: ${record.feedback.createdAt}`,
  ];

  if (record.feedback.reason) {
    lines.push(`Reason: ${record.feedback.reason}`);
  }

  if (record.contextPack) {
    const fit = record.contextPack.fitStatus
      ? `${record.contextPack.fitStatus}${typeof record.contextPack.fitScore === 'number' ? ` ${formatScore(record.contextPack.fitScore)}` : ''}`
      : 'not recorded';
    lines.push(
      `Context pack: ${record.contextPack.id} | fit=${fit} | ${endpoint(`/context/packs/${encodeURIComponent(record.contextPack.id)}`, apiBase)}`,
    );
  }

  if (record.session) {
    const outcome = record.session.outcome ? `/${record.session.outcome}` : '';
    lines.push(
      `Session: ${record.session.id} | ${record.session.status}${outcome} | ${endpoint(`/agent-sessions/${encodeURIComponent(record.session.id)}`, apiBase)}`,
    );
  }

  if (record.missingSignals.length > 0) {
    lines.push(`Missing signals: ${formatStringList(record.missingSignals, 10)}`);
  }

  lines.push('', 'Suggested review:');
  if (record.suggestedReviewActions.length === 0) {
    lines.push('- Inspect the linked feedback, context pack, and session before changing retrieval behavior.');
  } else {
    for (const action of record.suggestedReviewActions) {
      lines.push(`- ${action}`);
    }
  }

  appendAdjacentItems(lines, record, apiBase);
  appendKnowledgeGaps(lines, record, apiBase);
  appendLearningProposals(lines, record, apiBase);

  if (record.feedback.rejectedKnowledgeIds && record.feedback.rejectedKnowledgeIds.length > 0) {
    lines.push('', `Rejected knowledge ids: ${formatStringList(record.feedback.rejectedKnowledgeIds, 12)}`);
  }

  return lines;
}

function appendAdjacentItems(lines: string[], record: ContextQualityFeedbackRecord, apiBase?: string): void {
  if (record.adjacentItems.length === 0) {
    return;
  }

  lines.push('', 'Noisy or adjacent items:');
  for (const item of record.adjacentItems) {
    const evidence = [item.evidenceCategory, item.evidenceStrength].filter(Boolean).join('/');
    lines.push(`- ${item.title} (${item.knowledgeId})${evidence ? ` | ${evidence}` : ''} | score=${formatScore(item.score)}`);
    lines.push(`  Inspect: ${endpoint(`/knowledge/${encodeURIComponent(item.knowledgeId)}`, apiBase)}`);
    lines.push(`  Mark for review: PATCH ${endpoint(`/knowledge/${encodeURIComponent(item.knowledgeId)}`, apiBase)} with {"status":"needs_review"}`);
    lines.push(`  Supersede if needed: POST ${endpoint('/operations/relations', apiBase)} with {"fromKnowledgeId":"<newer-id>","relationType":"supersedes","targetKind":"knowledge","targetKnowledgeId":"${item.knowledgeId}"}`);
    if (item.reasons.length > 0) {
      lines.push(`  Reasons: ${formatStringList(item.reasons, 5)}`);
    }
    if (item.missingSignals.length > 0) {
      lines.push(`  Missing signals: ${formatStringList(item.missingSignals, 5)}`);
    }
  }
}

function appendKnowledgeGaps(lines: string[], record: ContextQualityFeedbackRecord, apiBase?: string): void {
  if (record.openKnowledgeGaps.length === 0) {
    return;
  }

  lines.push('', 'Open knowledge gaps:');
  for (const gap of record.openKnowledgeGaps) {
    lines.push(`- ${gap.id} (${gap.status})${gap.reason ? ` | ${gap.reason}` : ''}`);
    if (gap.missingSignals.length > 0) {
      lines.push(`  Missing signals: ${formatStringList(gap.missingSignals, 8)}`);
    }
    lines.push(`  Review: PATCH ${endpoint(`/operations/knowledge-gaps/${encodeURIComponent(gap.id)}`, apiBase)} with {"status":"approved"} after review, or use "dismissed"/"needs_changes".`);
  }
}

function appendLearningProposals(lines: string[], record: ContextQualityFeedbackRecord, apiBase?: string): void {
  if (record.openLearningProposals.length === 0) {
    return;
  }

  lines.push('', 'Open learning proposals:');
  for (const proposal of record.openLearningProposals) {
    const affected = proposal.affectedKnowledgeId ? ` | affected=${proposal.affectedKnowledgeId}` : '';
    lines.push(`- ${proposal.id} (${proposal.proposalType}, ${proposal.status})${affected} | ${proposal.reason}`);
    if (proposal.evidence.length > 0) {
      lines.push(`  Evidence: ${formatStringList(proposal.evidence, 6)}`);
    }
    lines.push(`  Review: PATCH ${endpoint(`/operations/learning-proposals/${encodeURIComponent(proposal.id)}`, apiBase)} with {"status":"approved"} after review, or use "dismissed"/"needs_changes".`);
  }
}

function formatFilters(filters: ContextQualityReportInput): string {
  return [
    filters.project ? `project=${filters.project}` : 'project=all',
    filters.feedbackType ? `feedbackType=${filters.feedbackType}` : 'feedbackType=all',
    `limit=${filters.limit}`,
  ].join('; ');
}

function contextQualityReportEndpoint(filters: ContextQualityReportInput, apiBase?: string): string {
  return endpointWithQuery('/operations/context-quality', {
    project: filters.project,
    feedbackType: filters.feedbackType,
    limit: filters.limit,
  }, apiBase);
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

function formatCountList<T extends { count: number }>(
  values: T[],
  max = 6,
): string {
  if (values.length === 0) {
    return 'none';
  }

  return values
    .slice(0, max)
    .map((item) => {
      const value = 'value' in item ? String(item.value) : 'title' in item ? String(item.title) : JSON.stringify(item);
      return `${value} (${item.count})`;
    })
    .join(', ');
}

function formatAdjacentRollup(values: ContextQualityReport['rollups']['adjacentItems']): string {
  if (values.length === 0) {
    return 'none';
  }

  return values
    .slice(0, 6)
    .map((item) => `${item.title} (${item.count})`)
    .join(', ');
}

function formatStringList(values: string[], max: number): string {
  if (values.length === 0) {
    return 'none';
  }

  const visible = values.slice(0, max);
  const suffix = values.length > max ? `, +${values.length - max} more` : '';
  return `${visible.join(', ')}${suffix}`;
}

function formatScore(value: number): string {
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function readFeedbackType(value: string): FeedbackQualityType {
  if (CONTEXT_QUALITY_FEEDBACK_TYPES.includes(value as FeedbackQualityType)) {
    return value as FeedbackQualityType;
  }

  throw new Error(`Unknown feedback type: ${value}\n\n${contextQualityUsage()}`);
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

  return parsed;
}
