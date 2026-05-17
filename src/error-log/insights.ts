import { ValidationError } from '../errors.js';
import type { ReflectionService } from '../reflection/service.js';
import type {
  CollectErrorLogsOptions,
  CreateErrorLogReflectionDraftInput,
  CreateErrorLogReflectionDraftResult,
  ErrorLog,
  ErrorLogCategory,
  ErrorLogCluster,
  ErrorLogCollection,
  ErrorLogSeverity,
  ErrorLogStatus,
  ErrorLogSummary,
  LabelInput,
  ReferenceInput,
  ReflectionDraftInput,
  ResolveErrorLogInput,
  ResolveErrorLogResult,
} from '../types.js';
import { uniqueStrings } from '../util/text.js';
import type { ErrorLogService } from './service.js';

const TOP_ROLLUP_LIMIT = 12;
const TOP_CLUSTER_LIMIT = 20;
const SEVERITY_ORDER: ErrorLogSeverity[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

export class ErrorLogInsightService {
  constructor(
    private readonly errorLogs: ErrorLogService,
    private readonly reflection?: ReflectionService,
  ) {}

  async collect(options: CollectErrorLogsOptions): Promise<ErrorLogCollection> {
    const { logs, totalMatched } = await this.errorLogs.collectLogs(options);
    const summaries = logs.map(summarizeLog);
    const clusters = buildClusters(logs);

    return {
      project: options.project,
      generatedAt: new Date().toISOString(),
      totalMatched,
      returned: summaries.length,
      nextOffset: options.offset + summaries.length < totalMatched ? options.offset + summaries.length : undefined,
      filters: options,
      rollups: buildRollups(logs),
      clusters,
      logs: summaries,
      agentBrief: renderAgentBrief(summaries, clusters, totalMatched, options),
    };
  }

  async createReflectionDraft(input: CreateErrorLogReflectionDraftInput): Promise<CreateErrorLogReflectionDraftResult> {
    if (!this.reflection) {
      throw new ValidationError('Reflection draft creation requires configured reflection storage.');
    }

    const logs = await this.readSelectedLogs(input.errorLogIds);
    const project = resolveDraftProject(logs, input.project);
    const draftInput = buildReflectionDraftInput(logs, project, input);
    const draft = await this.reflection.createDraft(draftInput);
    const linkedErrorLogIds: string[] = [];

    if (input.linkLogs !== false) {
      for (const log of logs) {
        const updated = await this.errorLogs.updateLog(log.id, { reflectionDraftId: draft.id });
        if (updated?.reflectionDraftId === draft.id) {
          linkedErrorLogIds.push(log.id);
        }
      }
    }

    return { draft, linkedErrorLogIds };
  }

  async resolve(input: ResolveErrorLogInput): Promise<ResolveErrorLogResult | undefined> {
    const existing = await this.errorLogs.getLog(input.id);
    if (!existing) {
      return undefined;
    }

    const status = input.status ?? 'fixed';
    const log = await this.errorLogs.updateLog(input.id, {
      status,
      reflectionDraftId: input.reflectionDraftId,
      notes: buildResolutionNotes(input),
      metadata: {
        ...input.metadata,
        resolution: {
          rootCause: input.rootCause,
          summary: input.resolutionSummary,
          changedFiles: input.changedFiles ?? [],
          verificationCommands: input.verificationCommands ?? [],
          reflectionDraftId: input.reflectionDraftId,
          resolvedBy: 'tuberosa_resolve_error_log',
          resolvedAt: new Date().toISOString(),
        },
      },
    });

    if (!log) {
      return undefined;
    }

    return {
      log,
      instruction: log.reflectionDraftId
        ? 'Error log resolved and linked to a reflection draft.'
        : 'Error log resolved. Create or link a reviewed reflection draft if this fix created a durable lesson.',
    };
  }

  private async readSelectedLogs(ids: string[]): Promise<ErrorLog[]> {
    const uniqueIds = uniqueStrings(ids);
    const logs = await Promise.all(uniqueIds.map((id) => this.errorLogs.getLog(id)));
    const missing = uniqueIds.filter((id, index) => !logs[index]);

    if (missing.length > 0) {
      throw new ValidationError(`Error logs not found: ${missing.join(', ')}`);
    }

    return logs.filter((log): log is ErrorLog => Boolean(log));
  }
}

function buildResolutionNotes(input: ResolveErrorLogInput): string {
  return [
    input.notes,
    `Root cause: ${input.rootCause}`,
    `Resolution: ${input.resolutionSummary}`,
    input.changedFiles?.length ? `Changed files: ${input.changedFiles.join(', ')}` : undefined,
    input.verificationCommands?.length ? `Verification: ${input.verificationCommands.join(' | ')}` : undefined,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function summarizeLog(log: ErrorLog): ErrorLogSummary {
  return {
    id: log.id,
    project: log.project,
    category: log.category,
    severity: log.severity,
    status: log.status,
    title: log.title,
    summary: log.summary,
    occurrenceCount: log.occurrenceCount,
    firstSeenAt: log.firstSeenAt,
    lastSeenAt: log.lastSeenAt,
    files: log.files,
    symbols: log.symbols,
    errors: log.errors,
    tags: log.tags,
    fingerprint: log.fingerprint,
    reflectionDraftId: log.reflectionDraftId,
    references: log.references,
  };
}

function buildClusters(logs: ErrorLog[]): ErrorLogCluster[] {
  const byFingerprint = new Map<string, ErrorLog[]>();

  for (const log of logs) {
    const group = byFingerprint.get(log.fingerprint) ?? [];
    group.push(log);
    byFingerprint.set(log.fingerprint, group);
  }

  return [...byFingerprint.entries()]
    .map(([fingerprint, group]) => {
      const sorted = [...group].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
      const latest = sorted[0];
      return {
        fingerprint,
        title: latest.title,
        count: group.length,
        occurrenceCount: sum(group.map((log) => log.occurrenceCount)),
        severity: mostSevere(group.map((log) => log.severity)),
        statuses: uniqueStrings(group.map((log) => log.status)) as ErrorLogStatus[],
        categories: uniqueStrings(group.map((log) => log.category)) as ErrorLogCategory[],
        firstSeenAt: minString(group.map((log) => log.firstSeenAt)),
        lastSeenAt: maxString(group.map((log) => log.lastSeenAt)),
        logIds: sorted.map((log) => log.id),
        files: topValues(group.flatMap((log) => log.files), 8).map((entry) => entry.value),
        symbols: topValues(group.flatMap((log) => log.symbols), 8).map((entry) => entry.value),
        errors: topValues(group.flatMap((log) => log.errors), 8).map((entry) => entry.value),
        tags: topValues(group.flatMap((log) => log.tags), 8).map((entry) => entry.value),
      };
    })
    .sort((left, right) => (
      right.occurrenceCount - left.occurrenceCount
      || severityRank(right.severity) - severityRank(left.severity)
      || right.lastSeenAt.localeCompare(left.lastSeenAt)
    ))
    .slice(0, TOP_CLUSTER_LIMIT);
}

function buildRollups(logs: ErrorLog[]): ErrorLogCollection['rollups'] {
  return {
    categories: topValues(logs.map((log) => log.category), TOP_ROLLUP_LIMIT) as Array<{ value: ErrorLogCategory; count: number }>,
    severities: topValues(logs.map((log) => log.severity), TOP_ROLLUP_LIMIT) as Array<{ value: ErrorLogSeverity; count: number }>,
    statuses: topValues(logs.map((log) => log.status), TOP_ROLLUP_LIMIT) as Array<{ value: ErrorLogStatus; count: number }>,
    files: topValues(logs.flatMap((log) => log.files), TOP_ROLLUP_LIMIT),
    symbols: topValues(logs.flatMap((log) => log.symbols), TOP_ROLLUP_LIMIT),
    errors: topValues(logs.flatMap((log) => log.errors), TOP_ROLLUP_LIMIT),
    tags: topValues(logs.flatMap((log) => log.tags), TOP_ROLLUP_LIMIT),
  };
}

function renderAgentBrief(
  logs: ErrorLogSummary[],
  clusters: ErrorLogCluster[],
  totalMatched: number,
  options: CollectErrorLogsOptions,
): string {
  const lines = [
    '# Error Log Brief',
    '',
    `Matched ${totalMatched} incident${totalMatched === 1 ? '' : 's'}; returned ${logs.length}.`,
  ];

  if (options.project) {
    lines.push(`Project: ${options.project}.`);
  }

  if (clusters.length > 0) {
    lines.push('', '## Recurring Patterns');
    for (const cluster of clusters.slice(0, 5)) {
      lines.push(`- ${cluster.title} (${cluster.occurrenceCount} occurrence${cluster.occurrenceCount === 1 ? '' : 's'}, ${cluster.severity}, ${cluster.statuses.join('/')})`);
    }
  }

  if (logs.length > 0) {
    lines.push('', '## Recent Incidents');
    for (const log of logs.slice(0, 8)) {
      lines.push(`- ${log.title} [${log.severity}/${log.status}] last seen ${log.lastSeenAt}; id ${log.id}`);
    }
  }

  lines.push(
    '',
    'Use tuberosa_get_error_log only for incidents that need raw debugging context. Create a reviewed reflection draft for durable lessons before they become searchable memory.',
  );

  return `${lines.join('\n')}\n`;
}

function buildReflectionDraftInput(
  logs: ErrorLog[],
  project: string | undefined,
  input: CreateErrorLogReflectionDraftInput,
): ReflectionDraftInput {
  const clusters = buildClusters(logs);
  const title = input.title ?? defaultDraftTitle(logs, clusters);
  const summary = input.summary ?? defaultDraftSummary(logs, clusters);
  const content = input.content ?? defaultDraftContent(logs, clusters);
  const references = buildDraftReferences(logs);

  return {
    project,
    title,
    summary,
    content,
    itemType: 'bugfix',
    triggerType: 'error_recovery',
    labels: buildDraftLabels(logs, project),
    references,
    metadata: {
      ...(input.metadata ?? {}),
      taxonomy: 'incident_lesson',
      source: 'error-log-insights',
      errorLogIds: logs.map((log) => log.id),
      fingerprints: uniqueStrings(logs.map((log) => log.fingerprint)),
      categories: uniqueStrings(logs.map((log) => log.category)),
      severities: uniqueStrings(logs.map((log) => log.severity)),
      statuses: uniqueStrings(logs.map((log) => log.status)),
      tags: uniqueStrings(logs.flatMap((log) => log.tags)),
      references,
    },
  };
}

function resolveDraftProject(logs: ErrorLog[], project: string | undefined): string | undefined {
  if (project) {
    return project;
  }

  const projects = uniqueStrings(logs.map((log) => log.project ?? 'unprojected'));
  if (projects.length > 1) {
    throw new ValidationError('errorLogIds span multiple projects; provide project to create a cross-project reflection draft.');
  }

  return projects[0] === 'unprojected' ? undefined : projects[0];
}

function defaultDraftTitle(logs: ErrorLog[], clusters: ErrorLogCluster[]): string {
  const title = clusters[0]?.title ?? logs[0]?.title ?? 'Error log incident lesson';
  return `Incident lesson: ${title}`.slice(0, 160);
}

function defaultDraftSummary(logs: ErrorLog[], clusters: ErrorLogCluster[]): string {
  const top = clusters[0];
  if (top) {
    return `A recurring ${top.severity} incident appeared ${top.occurrenceCount} time(s) across ${logs.length} log record(s).`;
  }
  return `A selected error-log incident needs a durable reviewed lesson for future agents.`;
}

function defaultDraftContent(logs: ErrorLog[], clusters: ErrorLogCluster[]): string {
  const lines = [
    'Durable lesson candidate from selected Tuberosa error logs.',
    '',
    '## Incident Pattern',
  ];

  for (const cluster of clusters.slice(0, 5)) {
    lines.push(`- ${cluster.title}: ${cluster.occurrenceCount} occurrence(s), severity ${cluster.severity}, status ${cluster.statuses.join('/')}.`);
  }

  lines.push('', '## Evidence');
  for (const log of logs.slice(0, 10)) {
    lines.push(`- ${log.title}: ${log.summary} (${log.category}, ${log.severity}, ${log.status}, id ${log.id}).`);
  }

  lines.push('', 'Review this draft after the fix is known. Keep only the durable cause, working path, and prevention rule before approval.');

  return lines.join('\n');
}

function buildDraftLabels(logs: ErrorLog[], project: string | undefined): LabelInput[] {
  const labels: LabelInput[] = [];

  if (project) {
    labels.push({ type: 'project', value: project, weight: 1 });
  }

  labels.push({ type: 'task_type', value: 'debugging', weight: 0.9 });

  for (const severity of uniqueStrings(logs.map((log) => log.severity))) {
    labels.push({ type: 'severity', value: severity, weight: 0.8 });
  }
  for (const file of topValues(logs.flatMap((log) => log.files), 12)) {
    labels.push({ type: 'file', value: file.value, weight: 0.85 });
  }
  for (const symbol of topValues(logs.flatMap((log) => log.symbols), 12)) {
    labels.push({ type: 'symbol', value: symbol.value, weight: 0.8 });
  }
  for (const error of topValues(logs.flatMap((log) => log.errors), 12)) {
    labels.push({ type: 'error', value: error.value, weight: 0.9 });
  }

  return labels;
}

function buildDraftReferences(logs: ErrorLog[]): ReferenceInput[] {
  const references: ReferenceInput[] = [];

  for (const log of logs) {
    references.push({
      type: 'external',
      uri: `tuberosa://error-logs/${log.id}`,
      metadata: { category: log.category, severity: log.severity, status: log.status },
    });
    references.push(...log.references.filter((reference) => reference.type === 'file'));
  }

  return uniqueReferences(references).slice(0, 40);
}

function uniqueReferences(references: ReferenceInput[]): ReferenceInput[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.type}:${reference.uri}:${reference.lineStart ?? ''}:${reference.lineEnd ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function topValues(values: string[], limit: number): Array<{ value: string; count: number }> {
  const counts = new Map<string, { value: string; count: number }>();

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    const existing = counts.get(key);
    counts.set(key, { value: existing?.value ?? trimmed, count: (existing?.count ?? 0) + 1 });
  }

  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, limit);
}

function mostSevere(values: ErrorLogSeverity[]): ErrorLogSeverity {
  return values.reduce((current, candidate) => (
    severityRank(candidate) > severityRank(current) ? candidate : current
  ), 'debug' as ErrorLogSeverity);
}

function severityRank(value: ErrorLogSeverity): number {
  return SEVERITY_ORDER.indexOf(value);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function minString(values: string[]): string {
  return values.reduce((min, value) => value < min ? value : min, values[0] ?? '');
}

function maxString(values: string[]): string {
  return values.reduce((max, value) => value > max ? value : max, values[0] ?? '');
}
