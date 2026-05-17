import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { ValidationError } from '../errors.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import type {
  ErrorLog,
  ErrorLogCategory,
  ErrorLogInput,
  ErrorLogPatchInput,
  ErrorLogSeverity,
  ErrorLogStatus,
  ListErrorLogsOptions,
  ReferenceInput,
} from '../types.js';
import { sha256, stableJson } from '../util/hash.js';

export interface ErrorLogServiceOptions {
  rootDir?: string;
  maxBytes?: number;
  safety?: KnowledgeSafetyService;
  now?: () => Date;
}

interface LocatedErrorLog {
  log: ErrorLog;
  jsonPath: string;
  markdownPath: string;
}

const DEFAULT_ROOT_DIR = '.tuberosa/error-logs';
const DEFAULT_MAX_BYTES = 256 * 1024;
const UNPROJECTED_SEGMENT = 'unprojected';

export class ErrorLogService {
  private readonly rootDir: string;
  private readonly maxBytes: number;
  private readonly safety: KnowledgeSafetyService;
  private readonly now: () => Date;

  constructor(options: ErrorLogServiceOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? DEFAULT_ROOT_DIR);
    this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.safety = options.safety ?? new KnowledgeSafetyService();
    this.now = options.now ?? (() => new Date());
  }

  async recordLog(input: ErrorLogInput): Promise<ErrorLog> {
    const now = this.now().toISOString();
    const sanitized = sanitizeInput(input, this.safety, this.maxBytes);
    const fingerprint = sanitized.fingerprint ?? buildFingerprint(sanitized);
    const existing = await this.findByFingerprint(fingerprint);

    if (existing) {
      const merged: ErrorLog = enforceMaxBytes({
        ...existing.log,
        ...mergeIncidentFields(existing.log, sanitized),
        fingerprint,
        occurrenceCount: existing.log.occurrenceCount + 1,
        lastSeenAt: now,
        updatedAt: now,
        safety: combineSafety(existing.log.safety, sanitized.safety),
      }, this.maxBytes);
      await this.writeLog(merged, existing);
      return merged;
    }

    const log: ErrorLog = enforceMaxBytes({
      id: randomUUID(),
      project: sanitized.project,
      category: sanitized.category ?? 'unknown',
      severity: sanitized.severity ?? 'error',
      status: sanitized.status ?? 'open',
      title: sanitized.title,
      summary: sanitized.summary ?? firstMeaningfulLine(sanitized.message) ?? sanitized.title,
      message: sanitized.message ?? '',
      stack: sanitized.stack,
      toolName: sanitized.toolName,
      operation: sanitized.operation,
      command: sanitized.command,
      cwd: sanitized.cwd,
      files: uniqueStrings(sanitized.files ?? []),
      symbols: uniqueStrings(sanitized.symbols ?? []),
      errors: uniqueStrings(sanitized.errors ?? []),
      tags: uniqueStrings(sanitized.tags ?? []),
      agentName: sanitized.agentName,
      agentTool: sanitized.agentTool,
      sessionId: sanitized.sessionId,
      contextPackId: sanitized.contextPackId,
      reflectionDraftId: sanitized.reflectionDraftId,
      references: sanitized.references ?? [],
      metadata: sanitized.metadata ?? {},
      fingerprint,
      occurrenceCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      safety: sanitized.safety,
      truncated: false,
    }, this.maxBytes);

    await this.writeLog(log);
    return log;
  }

  async listLogs(options: ListErrorLogsOptions): Promise<ErrorLog[]> {
    const logs = await this.readAllLogs();
    const query = options.query?.toLowerCase();
    const tag = options.tag?.toLowerCase();

    return logs
      .filter(({ log }) => !options.project || log.project === options.project)
      .filter(({ log }) => !options.category || log.category === options.category)
      .filter(({ log }) => !options.severity || log.severity === options.severity)
      .filter(({ log }) => !options.status || log.status === options.status)
      .filter(({ log }) => !tag || log.tags.some((value) => value.toLowerCase() === tag))
      .filter(({ log }) => !query || searchableText(log).includes(query))
      .map(({ log }) => log)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || right.id.localeCompare(left.id))
      .slice(0, options.limit);
  }

  async getLog(id: string): Promise<ErrorLog | undefined> {
    return (await this.findById(id))?.log;
  }

  async readLogMarkdown(id: string): Promise<string | undefined> {
    const located = await this.findById(id);
    if (!located) {
      return undefined;
    }

    return readFile(located.markdownPath, 'utf8').catch(() => renderMarkdown(located.log));
  }

  async updateLog(id: string, patch: ErrorLogPatchInput): Promise<ErrorLog | undefined> {
    const located = await this.findById(id);
    if (!located) {
      return undefined;
    }

    const now = this.now().toISOString();
    const sanitized = sanitizePatch(patch, this.safety, this.maxBytes);
    const status = sanitized.status ?? located.log.status;
    const resolvedAt = status === 'fixed' || status === 'wont_fix'
      ? located.log.resolvedAt ?? now
      : status === 'open' || status === 'triaged'
        ? undefined
        : located.log.resolvedAt;
    const metadata = sanitized.notes
      ? {
          ...located.log.metadata,
          ...(sanitized.metadata ?? {}),
          notes: appendNotes(located.log.metadata.notes, sanitized.notes, now),
        }
      : { ...located.log.metadata, ...(sanitized.metadata ?? {}) };

    const updated: ErrorLog = enforceMaxBytes({
      ...located.log,
      category: sanitized.category ?? located.log.category,
      severity: sanitized.severity ?? located.log.severity,
      status,
      summary: sanitized.summary ?? located.log.summary,
      tags: sanitized.tags ?? located.log.tags,
      references: sanitized.references ?? located.log.references,
      reflectionDraftId: sanitized.reflectionDraftId === null
        ? undefined
        : sanitized.reflectionDraftId ?? located.log.reflectionDraftId,
      metadata,
      updatedAt: now,
      resolvedAt,
      safety: combineSafety(located.log.safety, sanitized.safety),
    }, this.maxBytes);

    await this.writeLog(updated, located);
    return updated;
  }

  private async findByFingerprint(fingerprint: string): Promise<LocatedErrorLog | undefined> {
    const logs = await this.readAllLogs();
    return logs.find(({ log }) => log.fingerprint === fingerprint);
  }

  private async findById(id: string): Promise<LocatedErrorLog | undefined> {
    validateIdentifier(id, 'error log id');
    const logs = await this.readAllLogs();
    return logs.find(({ log }) => log.id === id);
  }

  private async readAllLogs(): Promise<LocatedErrorLog[]> {
    const files = await walkJsonFiles(this.rootDir);
    const logs = await Promise.all(files.map(async (file) => {
      try {
        const log = JSON.parse(await readFile(file, 'utf8')) as ErrorLog;
        if (!isSafeChildPath(this.rootDir, file) || typeof log.id !== 'string') {
          return undefined;
        }
        const paths = this.pathsFor(log);
        return { log, jsonPath: file, markdownPath: paths.markdownPath };
      } catch {
        return undefined;
      }
    }));

    return logs.filter((entry): entry is LocatedErrorLog => Boolean(entry));
  }

  private async writeLog(log: ErrorLog, previous?: LocatedErrorLog): Promise<void> {
    const paths = this.pathsFor(log);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.jsonPath, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
    await writeFile(paths.markdownPath, renderMarkdown(log), 'utf8');

    if (previous && previous.jsonPath !== paths.jsonPath) {
      await Promise.allSettled([
        rm(previous.jsonPath, { force: true }),
        rm(previous.markdownPath, { force: true }),
      ]);
    }
  }

  private pathsFor(log: ErrorLog): { dir: string; jsonPath: string; markdownPath: string } {
    const project = sanitizeSegment(log.project ?? UNPROJECTED_SEGMENT);
    const category = sanitizeSegment(log.category);
    const month = monthSegment(log.firstSeenAt);
    const filename = sanitizeSegment(log.id);
    const dir = resolve(this.rootDir, project, category, month);
    const jsonPath = resolve(dir, `${filename}.json`);
    const markdownPath = resolve(dir, `${filename}.md`);

    if (!isSafeChildPath(this.rootDir, jsonPath) || !isSafeChildPath(this.rootDir, markdownPath)) {
      throw new ValidationError('Resolved error log path escaped the configured log directory.');
    }

    return { dir, jsonPath, markdownPath };
  }
}

function sanitizeInput(input: ErrorLogInput, safety: KnowledgeSafetyService, maxBytes: number): ErrorLogInput & {
  safety: ErrorLog['safety'];
} {
  const redactions = { count: 0 };
  return {
    ...input,
    title: sanitizeRequiredText(input.title, safety, redactions, maxBytes, 'error log title'),
    summary: sanitizeOptionalText(input.summary, safety, redactions, maxBytes),
    message: sanitizeOptionalText(input.message, safety, redactions, maxBytes),
    stack: sanitizeOptionalText(input.stack, safety, redactions, maxBytes),
    toolName: sanitizeOptionalText(input.toolName, safety, redactions, maxBytes),
    operation: sanitizeOptionalText(input.operation, safety, redactions, maxBytes),
    command: sanitizeOptionalText(input.command, safety, redactions, maxBytes),
    cwd: sanitizeOptionalText(input.cwd, safety, redactions, maxBytes),
    files: sanitizeStringArray(input.files, safety, redactions, maxBytes),
    symbols: sanitizeStringArray(input.symbols, safety, redactions, maxBytes),
    errors: sanitizeStringArray(input.errors, safety, redactions, maxBytes),
    tags: sanitizeStringArray(input.tags, safety, redactions, maxBytes),
    agentName: sanitizeOptionalText(input.agentName, safety, redactions, maxBytes),
    agentTool: sanitizeOptionalText(input.agentTool, safety, redactions, maxBytes),
    sessionId: sanitizeOptionalText(input.sessionId, safety, redactions, maxBytes),
    contextPackId: sanitizeOptionalText(input.contextPackId, safety, redactions, maxBytes),
    reflectionDraftId: sanitizeOptionalText(input.reflectionDraftId, safety, redactions, maxBytes),
    references: sanitizeReferences(input.references, safety, redactions, maxBytes),
    metadata: sanitizeRecord(input.metadata, safety, redactions, maxBytes),
    fingerprint: input.fingerprint,
    safety: { redactionCount: redactions.count, checkedAt: new Date().toISOString() },
  };
}

function sanitizePatch(input: ErrorLogPatchInput, safety: KnowledgeSafetyService, maxBytes: number): ErrorLogPatchInput & {
  safety: ErrorLog['safety'];
} {
  const redactions = { count: 0 };
  return {
    ...input,
    summary: sanitizeOptionalText(input.summary, safety, redactions, maxBytes),
    notes: sanitizeOptionalText(input.notes, safety, redactions, maxBytes),
    tags: sanitizeStringArray(input.tags, safety, redactions, maxBytes),
    references: sanitizeReferences(input.references, safety, redactions, maxBytes),
    reflectionDraftId: input.reflectionDraftId === null
      ? null
      : sanitizeOptionalText(input.reflectionDraftId, safety, redactions, maxBytes),
    metadata: sanitizeRecord(input.metadata, safety, redactions, maxBytes),
    safety: { redactionCount: redactions.count, checkedAt: new Date().toISOString() },
  };
}

function sanitizeRequiredText(
  value: string,
  safety: KnowledgeSafetyService,
  redactions: { count: number },
  maxBytes: number,
  path: string,
): string {
  const sanitized = sanitizeOptionalText(value, safety, redactions, maxBytes);
  if (!sanitized) {
    throw new ValidationError(`${path} must be a non-empty string.`);
  }
  return sanitized;
}

function sanitizeOptionalText(
  value: string | undefined,
  safety: KnowledgeSafetyService,
  redactions: { count: number },
  maxBytes: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const redacted = safety.redactSecrets(value);
  if (redacted !== value) {
    redactions.count += 1;
  }
  return truncateUtf8(redacted.trim(), Math.max(256, Math.floor(maxBytes / 3)));
}

function sanitizeStringArray(
  values: string[] | undefined,
  safety: KnowledgeSafetyService,
  redactions: { count: number },
  maxBytes: number,
): string[] | undefined {
  if (!values) {
    return undefined;
  }
  return uniqueStrings(values.map((value) => sanitizeOptionalText(value, safety, redactions, maxBytes)).filter(Boolean) as string[]);
}

function sanitizeReferences(
  references: ReferenceInput[] | undefined,
  safety: KnowledgeSafetyService,
  redactions: { count: number },
  maxBytes: number,
): ReferenceInput[] | undefined {
  if (!references) {
    return undefined;
  }
  return references.map((reference) => ({
    ...reference,
    uri: sanitizeRequiredText(reference.uri, safety, redactions, maxBytes, 'error log reference uri'),
    metadata: sanitizeRecord(reference.metadata, safety, redactions, maxBytes),
  }));
}

function sanitizeRecord(
  value: Record<string, unknown> | undefined,
  safety: KnowledgeSafetyService,
  redactions: { count: number },
  maxBytes: number,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  return sanitizeJsonValue(value, safety, redactions, maxBytes) as Record<string, unknown>;
}

function sanitizeJsonValue(
  value: unknown,
  safety: KnowledgeSafetyService,
  redactions: { count: number },
  maxBytes: number,
): unknown {
  if (typeof value === 'string') {
    return sanitizeOptionalText(value, safety, redactions, maxBytes);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeJsonValue(item, safety, redactions, maxBytes));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, nested]) => [key, sanitizeJsonValue(nested, safety, redactions, maxBytes)]),
    );
  }
  return value;
}

function mergeIncidentFields(existing: ErrorLog, input: ErrorLogInput): Partial<ErrorLog> {
  return {
    severity: moreSevere(existing.severity, input.severity ?? existing.severity),
    message: input.message || existing.message,
    stack: input.stack || existing.stack,
    files: uniqueStrings([...existing.files, ...(input.files ?? [])]),
    symbols: uniqueStrings([...existing.symbols, ...(input.symbols ?? [])]),
    errors: uniqueStrings([...existing.errors, ...(input.errors ?? [])]),
    tags: uniqueStrings([...existing.tags, ...(input.tags ?? [])]),
    references: mergeReferences(existing.references, input.references ?? []),
    metadata: { ...existing.metadata, ...(input.metadata ?? {}) },
  };
}

function combineSafety(left: ErrorLog['safety'], right: ErrorLog['safety']): ErrorLog['safety'] {
  return {
    redactionCount: left.redactionCount + right.redactionCount,
    checkedAt: right.checkedAt,
  };
}

function moreSevere(left: ErrorLogSeverity, right: ErrorLogSeverity): ErrorLogSeverity {
  const order: ErrorLogSeverity[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
  return order.indexOf(right) > order.indexOf(left) ? right : left;
}

function buildFingerprint(input: ErrorLogInput): string {
  return sha256(stableJson({
    project: input.project,
    category: input.category ?? 'unknown',
    title: normalizeFingerprintText(input.title),
    message: normalizeFingerprintText(firstMeaningfulLine(input.message) ?? ''),
    toolName: input.toolName,
    operation: input.operation,
    command: input.command,
    cwd: input.cwd,
    stackTop: firstStackFrame(input.stack),
  }));
}

function enforceMaxBytes(log: ErrorLog, maxBytes: number): ErrorLog {
  let output = { ...log, truncated: log.truncated };
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') <= maxBytes) {
    return output;
  }

  output = {
    ...output,
    message: truncateUtf8(output.message, Math.floor(maxBytes / 4)),
    stack: truncateUtf8(output.stack ?? '', Math.floor(maxBytes / 4)),
    metadata: {
      ...output.metadata,
      truncatedMetadata: true,
    },
    truncated: true,
  };

  if (Buffer.byteLength(JSON.stringify(output), 'utf8') <= maxBytes) {
    return output;
  }

  return {
    ...output,
    metadata: { truncatedMetadata: true },
    references: [],
    truncated: true,
  };
}

function renderMarkdown(log: ErrorLog): string {
  const lines = [
    `# ${log.title}`,
    '',
    `- id: ${log.id}`,
    `- project: ${log.project ?? 'unprojected'}`,
    `- category: ${log.category}`,
    `- severity: ${log.severity}`,
    `- status: ${log.status}`,
    `- occurrences: ${log.occurrenceCount}`,
    `- first seen: ${log.firstSeenAt}`,
    `- last seen: ${log.lastSeenAt}`,
  ];

  if (log.reflectionDraftId) {
    lines.push(`- reflection draft: ${log.reflectionDraftId}`);
  }

  lines.push('', '## Summary', '', log.summary || '(none)', '', '## Message', '', '```text', log.message || '(none)', '```');

  if (log.stack) {
    lines.push('', '## Stack', '', '```text', log.stack, '```');
  }

  if (log.command) {
    lines.push('', '## Command', '', '```text', log.command, '```');
  }

  if (log.references.length > 0) {
    lines.push('', '## References', '', ...log.references.map((reference) => `- ${reference.type}: ${reference.uri}`));
  }

  return `${lines.join('\n')}\n`;
}

async function walkJsonFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return walkJsonFiles(path);
      }
      return entry.isFile() && entry.name.endsWith('.json') ? [path] : [];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}

function searchableText(log: ErrorLog): string {
  return [
    log.title,
    log.summary,
    log.message,
    log.stack,
    log.toolName,
    log.operation,
    log.command,
    log.cwd,
    ...log.files,
    ...log.symbols,
    ...log.errors,
    ...log.tags,
  ].filter(Boolean).join('\n').toLowerCase();
}

function appendNotes(existing: unknown, note: string, at: string): Array<{ at: string; note: string }> {
  const notes = Array.isArray(existing) ? existing : [];
  return [...notes, { at, note }];
}

function monthSegment(value: string): string {
  return /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : new Date().toISOString().slice(0, 7);
}

function sanitizeSegment(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return 'unknown';
  }
  return sanitized.slice(0, 120);
}

function isSafeChildPath(root: string, child: string): boolean {
  const relativePath = relative(root, child);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !relativePath.includes(`..${sep}`) && !relativePath.startsWith(sep);
}

function validateIdentifier(value: string, path: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/.test(value) || basename(value) !== value) {
    throw new ValidationError(`${path} may only contain letters, numbers, dot, underscore, and dash.`);
  }
}

function firstMeaningfulLine(value: string | undefined): string | undefined {
  return value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function firstStackFrame(value: string | undefined): string | undefined {
  return value?.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('at '));
}

function normalizeFingerprintText(value: string): string {
  return value.toLowerCase().replace(/\b[0-9a-f]{8,}\b/g, '<hex>').replace(/\d+/g, '<n>').slice(0, 240);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  let output = value;
  while (Buffer.byteLength(`${output}\n[truncated]`, 'utf8') > maxBytes && output.length > 0) {
    output = output.slice(0, Math.floor(output.length * 0.8));
  }
  return `${output}\n[truncated]`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mergeReferences(left: ReferenceInput[], right: ReferenceInput[]): ReferenceInput[] {
  const seen = new Set<string>();
  return [...left, ...right].filter((reference) => {
    const key = `${reference.type}:${reference.uri}:${reference.lineStart ?? ''}:${reference.lineEnd ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
