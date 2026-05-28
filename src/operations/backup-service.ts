import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { ValidationError } from '../errors.js';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  BackupManifest,
  BackupExportData,
  BackupRetentionInput,
  BackupRetentionResult,
  BackupSchedulerStatus,
  BackupStatus,
  BackupSummary,
  BackupTableData,
  BackupTableName,
  BackupVerificationIssue,
  BackupVerificationResult,
  CreateBackupInput,
  RestoreBackupInput,
  RestoreBackupResult,
} from '../types.js';

export interface BackupRuntimeMetadata {
  appVersion?: string;
  appCommit?: string;
  schemaVersion?: number;
  embeddingDimensions?: number;
  modelProvider?: string;
  embeddingModel?: string;
}

export interface BackupScheduleOptions {
  enabled?: boolean;
  intervalSeconds?: number;
  startupDelaySeconds?: number;
  retentionCount?: number;
  retentionMaxAgeDays?: number;
  writeThroughEnabled?: boolean;
  writeThroughThrottleSeconds?: number;
}

export interface PhysicalMirrorOptions {
  enabled?: boolean;
  dir?: string;
  debounceMs?: number;
}

export interface BackupServiceOptions {
  backupDir?: string;
  storeKind?: 'postgres' | 'memory';
  metadata?: BackupRuntimeMetadata;
  schedule?: BackupScheduleOptions;
  physicalMirror?: PhysicalMirrorOptions;
}

const BACKUP_TABLES: BackupTableName[] = [
  'projects',
  'knowledge_sources',
  'knowledge_items',
  'labels',
  'knowledge_labels',
  'knowledge_references',
  'knowledge_relations',
  'knowledge_conflicts',
  'knowledge_chunks',
  'reflection_drafts',
  'context_queries',
  'context_packs',
  'feedback_events',
  'agent_sessions',
  'agent_context_decisions',
  'knowledge_gaps',
  'learning_proposals',
];

const REQUIRED_RETRIEVAL_TABLES: BackupTableName[] = [
  'projects',
  'knowledge_items',
  'knowledge_chunks',
];

export class BackupService {
  private readonly backupDir: string;
  private readonly physicalMirrorDir: string;
  private readonly physicalMirrorEnabled: boolean;
  private readonly physicalMirrorDebounceMs: number;
  private readonly storeKind: 'postgres' | 'memory';
  private readonly metadata: BackupRuntimeMetadata;
  private readonly schedule: Required<BackupScheduleOptions>;
  private timer: NodeJS.Timeout | undefined;
  private physicalMirrorTimer: NodeJS.Timeout | undefined;
  private inFlightBackup: Promise<BackupSummary> | undefined;
  private inFlightPhysicalMirror: Promise<BackupSummary | undefined> | undefined;
  private physicalMirrorDirty = false;
  private physicalMirrorReason = 'manual';
  private lastWriteThroughAt = 0;
  private schedulerState: {
    running: boolean;
    lastRunAt?: string;
    lastSuccessAt?: string;
    lastBackupId?: string;
    lastError?: string;
    nextRunAt?: string;
  } = { running: false };

  constructor(private readonly store: KnowledgeStore, options: BackupServiceOptions = {}) {
    this.backupDir = resolve(options.backupDir ?? '.tuberosa/backups');
    this.physicalMirrorDir = resolve(options.physicalMirror?.dir ?? '.tuberosa/current');
    this.physicalMirrorEnabled = options.physicalMirror?.enabled ?? false;
    const physicalMirrorDebounceMs = options.physicalMirror?.debounceMs ?? 500;
    this.physicalMirrorDebounceMs = Number.isFinite(physicalMirrorDebounceMs)
      ? Math.max(0, physicalMirrorDebounceMs)
      : 500;
    this.storeKind = options.storeKind ?? 'memory';
    this.metadata = options.metadata ?? {};
    this.schedule = {
      enabled: options.schedule?.enabled ?? false,
      intervalSeconds: Math.max(0, options.schedule?.intervalSeconds ?? 0),
      startupDelaySeconds: Math.max(0, options.schedule?.startupDelaySeconds ?? 0),
      retentionCount: Math.max(1, options.schedule?.retentionCount ?? 24),
      retentionMaxAgeDays: Math.max(0, options.schedule?.retentionMaxAgeDays ?? 30),
      writeThroughEnabled: options.schedule?.writeThroughEnabled ?? false,
      writeThroughThrottleSeconds: Math.max(0, options.schedule?.writeThroughThrottleSeconds ?? 600),
    };
  }

  async createBackup(input: CreateBackupInput = {}): Promise<BackupSummary> {
    if (this.inFlightBackup) {
      return this.inFlightBackup;
    }

    this.inFlightBackup = this.writeBackup(input);
    try {
      const backup = await this.inFlightBackup;
      this.schedulerState.lastSuccessAt = new Date().toISOString();
      this.schedulerState.lastBackupId = backup.id;
      this.schedulerState.lastError = undefined;
      return backup;
    } finally {
      this.inFlightBackup = undefined;
    }
  }

  async listBackups(): Promise<BackupSummary[]> {
    await mkdir(this.backupDir, { recursive: true });
    const entries = await readdir(this.backupDir);
    const summaries = await Promise.all(entries.map(async (entry) => {
      const backupPath = join(this.backupDir, entry);
      const stats = await stat(backupPath).catch(() => undefined);
      if (!stats?.isDirectory()) {
        return undefined;
      }

      const manifest = await readManifest(backupPath);
      return manifest ? toBackupSummary(backupPath, manifest) : undefined;
    }));

    return summaries
      .filter((summary): summary is BackupSummary => Boolean(summary))
      .sort(compareBackupSummaries);
  }

  async getBackupStatus(): Promise<BackupStatus> {
    const backups = await this.listBackups();
    const latestBackup = backups[0];
    const latestVerification = latestBackup
      ? await this.verifyBackup({ backupIdOrPath: latestBackup.id })
      : undefined;

    return {
      backupDir: this.backupDir,
      store: this.storeKind,
      health: latestVerification?.health ?? 'no_backups',
      latestBackup,
      latestVerification,
      backupCount: backups.length,
      totalRows: latestBackup?.totalRows ?? 0,
      scheduler: this.getSchedulerStatus(),
    };
  }

  async syncPhysicalMirror(reason = 'manual'): Promise<BackupSummary | undefined> {
    if (!this.physicalMirrorEnabled) {
      return undefined;
    }

    this.clearPhysicalMirrorTimer();
    this.physicalMirrorDirty = true;
    this.physicalMirrorReason = reason;
    return this.flushPhysicalMirror();
  }

  async verifyBackup(input: { backupIdOrPath?: string } = {}): Promise<BackupVerificationResult> {
    const backupPath = resolveBackupPath(this.backupDir, input.backupIdOrPath);
    const issues: BackupVerificationIssue[] = [];
    const manifest = await readManifest(backupPath);
    const checkedAt = new Date().toISOString();

    if (!manifest) {
      return {
        backupId: basename(backupPath),
        path: backupPath,
        ok: false,
        health: 'missing',
        checkedAt,
        rowCounts: {},
        totalRows: 0,
        issues: [{ severity: 'error', message: `Backup manifest not found at ${backupPath}.` }],
      };
    }

    validateManifestShape(manifest, issues);
    validateCompatibility(manifest, this.metadata, issues);

    const rowCounts: Partial<Record<BackupTableName, number>> = {};
    for (const tableName of BACKUP_TABLES) {
      const entry = manifest.tables.find((table) => table.name === tableName);
      if (!entry) {
        issues.push({ severity: 'error', table: tableName, message: `Backup is missing table ${tableName}.` });
        continue;
      }

      try {
        const filePath = join(backupPath, entry.file);
        const fileRaw = await readFile(filePath, 'utf8');
        const rows = parseJsonl(fileRaw, filePath);
        rowCounts[entry.name] = rows.length;

        if (rows.length !== entry.rows) {
          issues.push({
            severity: 'error',
            table: entry.name,
            message: `Table ${entry.name} row count mismatch: manifest=${entry.rows}, file=${rows.length}.`,
          });
        }

        if (entry.checksumSha256) {
          const actualChecksum = sha256(fileRaw);
          if (actualChecksum !== entry.checksumSha256) {
            issues.push({ severity: 'error', table: entry.name, message: `Table ${entry.name} checksum mismatch.` });
          }
        } else {
          issues.push({
            severity: 'warning',
            table: entry.name,
            message: `Table ${entry.name} has no checksum metadata; this backup predates integrity checks.`,
          });
        }
      } catch (error) {
        issues.push({
          severity: 'error',
          table: entry.name,
          message: error instanceof Error ? error.message : `Unable to read table ${entry.name}.`,
        });
      }
    }

    for (const tableName of REQUIRED_RETRIEVAL_TABLES) {
      if (!manifest.tables.some((table) => table.name === tableName)) {
        issues.push({ severity: 'error', table: tableName, message: `Required retrieval table ${tableName} is missing.` });
      }
    }

    const totalRows = Object.values(rowCounts).reduce((sum, count) => sum + (count ?? 0), 0);
    const hasErrors = issues.some((issue) => issue.severity === 'error');
    const hasWarnings = issues.some((issue) => issue.severity === 'warning');

    return {
      backupId: manifest.id || basename(backupPath),
      path: backupPath,
      ok: !hasErrors,
      health: hasErrors ? 'unhealthy' : hasWarnings ? 'degraded' : 'healthy',
      checkedAt,
      manifestVersion: manifest.version,
      source: manifest.source,
      rowCounts,
      totalRows,
      issues,
    };
  }

  async restoreBackup(input: RestoreBackupInput = {}): Promise<RestoreBackupResult> {
    if (!input.dryRun && !input.replace) {
      throw new ValidationError('Backup restore requires replace=true unless dryRun=true.');
    }

    const backupPath = resolveBackupPath(this.backupDir, input.backupIdOrPath);
    const verification = await this.verifyBackup({ backupIdOrPath: backupPath });
    if (!verification.ok) {
      throw new ValidationError('Backup verification failed; restore was not started.', verification);
    }

    const manifest = await readRequiredManifest(backupPath);
    const tables = await Promise.all(manifest.tables.map(async (table): Promise<BackupTableData> => ({
      name: table.name,
      rows: await readJsonl(join(backupPath, table.file)),
    })));
    const restored = await this.store.restoreBackup({
      tables,
      dryRun: input.dryRun,
      replace: input.replace,
    });

    return {
      backupId: manifest.id,
      dryRun: Boolean(input.dryRun),
      replace: Boolean(input.replace),
      verification,
      restored: restored as RestoreBackupResult['restored'],
    };
  }

  async pruneBackups(input: BackupRetentionInput = {}): Promise<BackupRetentionResult> {
    const keepCount = Math.max(1, input.keepCount ?? this.schedule.retentionCount);
    const maxAgeDays = Math.max(0, input.maxAgeDays ?? this.schedule.retentionMaxAgeDays);
    const backups = await this.listBackups();
    const kept = new Map<string, BackupSummary>();
    const pruned: BackupSummary[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const latest = backups[0];
    const now = Date.now();

    backups.slice(0, keepCount).forEach((backup) => kept.set(backup.path, backup));
    if (latest) {
      kept.set(latest.path, latest);
    }
    await this.keepLatestSuccessfulBackup(backups, kept);

    for (const backup of backups) {
      if (kept.has(backup.path)) {
        continue;
      }

      const olderThanMaxAge = maxAgeDays > 0
        && now - Date.parse(backup.createdAt) > maxAgeDays * 24 * 60 * 60 * 1000;
      const outsideKeepCount = backups.indexOf(backup) >= keepCount;
      if (!olderThanMaxAge && !outsideKeepCount) {
        kept.set(backup.path, backup);
        continue;
      }

      const verification = await this.verifyBackup({ backupIdOrPath: backup.path });
      if (!verification.ok) {
        skipped.push({ path: backup.path, reason: 'Backup did not pass verification; leaving it for manual inspection.' });
        kept.set(backup.path, backup);
        continue;
      }

      pruned.push(backup);
      if (!input.dryRun) {
        await rm(backup.path, { recursive: true, force: true });
      }
    }

    return {
      dryRun: Boolean(input.dryRun),
      keepCount,
      maxAgeDays,
      kept: [...kept.values()].sort(compareBackupSummaries),
      pruned,
      skipped,
    };
  }

  startScheduledBackups(): void {
    if (!this.schedule.enabled || this.schedule.intervalSeconds <= 0 || this.timer) {
      return;
    }

    this.scheduleNextRun(this.schedule.startupDelaySeconds);
  }

  stopScheduledBackups(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.schedulerState.nextRunAt = undefined;
    this.schedulerState.running = false;
  }

  async close(): Promise<void> {
    this.stopScheduledBackups();
    this.clearPhysicalMirrorTimer();
    if (this.inFlightBackup) {
      await this.inFlightBackup.catch(() => undefined);
    }
    if (this.physicalMirrorEnabled && (this.physicalMirrorDirty || this.inFlightPhysicalMirror)) {
      await this.flushPhysicalMirror().catch(() => undefined);
    }
  }

  getSchedulerStatus(): BackupSchedulerStatus {
    return {
      enabled: this.schedule.enabled,
      running: this.schedulerState.running,
      intervalSeconds: this.schedule.intervalSeconds,
      startupDelaySeconds: this.schedule.startupDelaySeconds,
      retentionCount: this.schedule.retentionCount,
      retentionMaxAgeDays: this.schedule.retentionMaxAgeDays,
      writeThroughEnabled: this.schedule.writeThroughEnabled,
      writeThroughThrottleSeconds: this.schedule.writeThroughThrottleSeconds,
      lastRunAt: this.schedulerState.lastRunAt,
      lastSuccessAt: this.schedulerState.lastSuccessAt,
      lastBackupId: this.schedulerState.lastBackupId,
      lastError: this.schedulerState.lastError,
      nextRunAt: this.schedulerState.nextRunAt,
    };
  }

  requestWriteThroughBackup(reason: string): void {
    if (!this.schedule.writeThroughEnabled) {
      return;
    }

    const now = Date.now();
    if (now - this.lastWriteThroughAt < this.schedule.writeThroughThrottleSeconds * 1000) {
      return;
    }

    this.lastWriteThroughAt = now;
    void this.runScheduledBackup(reason);
  }

  requestPhysicalMirror(reason: string): void {
    if (!this.physicalMirrorEnabled) {
      return;
    }

    this.physicalMirrorDirty = true;
    this.physicalMirrorReason = reason;

    if (this.inFlightPhysicalMirror) {
      return;
    }

    this.clearPhysicalMirrorTimer();
    this.physicalMirrorTimer = setTimeout(() => {
      this.physicalMirrorTimer = undefined;
      void this.flushPhysicalMirror().catch((error) => this.recordPhysicalMirrorError(error));
    }, this.physicalMirrorDebounceMs);
    this.physicalMirrorTimer.unref();
  }

  private async flushPhysicalMirror(): Promise<BackupSummary | undefined> {
    if (this.inFlightPhysicalMirror) {
      return this.inFlightPhysicalMirror;
    }

    this.inFlightPhysicalMirror = this.drainPhysicalMirror();
    try {
      return await this.inFlightPhysicalMirror;
    } finally {
      this.inFlightPhysicalMirror = undefined;
    }
  }

  private clearPhysicalMirrorTimer(): void {
    if (!this.physicalMirrorTimer) {
      return;
    }

    clearTimeout(this.physicalMirrorTimer);
    this.physicalMirrorTimer = undefined;
  }

  private recordPhysicalMirrorError(error: unknown): void {
    this.schedulerState.lastError = error instanceof Error ? error.message : String(error);
  }

  private async drainPhysicalMirror(): Promise<BackupSummary | undefined> {
    let latest: BackupSummary | undefined;

    while (this.physicalMirrorDirty) {
      const reason = this.physicalMirrorReason;
      this.physicalMirrorDirty = false;
      latest = await this.writePhysicalMirror(reason);
    }

    return latest;
  }

  private async writePhysicalMirror(reason: string): Promise<BackupSummary> {
    const exported = await this.store.exportBackup();
    const tempPath = `${this.physicalMirrorDir}.tmp-${process.pid}-${Date.now()}`;

    try {
      const manifest = await this.writeSnapshot(tempPath, 'current', exported, { reason, mirror: true });
      await rm(this.physicalMirrorDir, { recursive: true, force: true });
      await rename(tempPath, this.physicalMirrorDir);
      return toBackupSummary(this.physicalMirrorDir, manifest);
    } catch (error) {
      await rm(tempPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async writeBackup(input: CreateBackupInput = {}): Promise<BackupSummary> {
    const exported = await this.store.exportBackup();
    const id = sanitizeBackupId(input.id ?? backupId());
    const backupPath = join(this.backupDir, id);
    const manifest = await this.writeSnapshot(backupPath, id, exported, { reason: input.reason });
    if (input.prune) {
      await this.pruneBackups({ keepCount: this.schedule.retentionCount, maxAgeDays: this.schedule.retentionMaxAgeDays });
    }

    return toBackupSummary(backupPath, manifest);
  }

  private async writeSnapshot(
    path: string,
    id: string,
    exported: BackupExportData,
    metadata: Record<string, unknown> = {},
  ): Promise<BackupManifest> {
    await mkdir(path, { recursive: true });

    const tables = await Promise.all(exported.tables.map(async (table) => {
      const file = `${table.name}.jsonl`;
      const body = encodeJsonl(table.rows);
      await writeFile(join(path, file), body, 'utf8');
      return {
        name: table.name,
        file,
        rows: table.rows.length,
        checksumSha256: sha256(body),
      };
    }));

    const manifest: BackupManifest = {
      id,
      version: 1,
      format: 'jsonl',
      createdAt: new Date().toISOString(),
      source: {
        service: 'tuberosa',
        store: this.storeKind,
        ...this.metadata,
        metadata,
      },
      tables,
    };

    await writeFile(join(path, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeMirrorMarkdown(path, exported);
    return manifest;
  }

  private async keepLatestSuccessfulBackup(backups: BackupSummary[], kept: Map<string, BackupSummary>): Promise<void> {
    for (const backup of backups) {
      const verification = await this.verifyBackup({ backupIdOrPath: backup.path });
      if (verification.ok) {
        kept.set(backup.path, backup);
        return;
      }
    }
  }

  private scheduleNextRun(delaySeconds: number): void {
    const delayMs = Math.max(0, delaySeconds) * 1000;
    this.schedulerState.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runScheduledBackup('scheduled');
    }, delayMs);
    this.timer.unref();
  }

  private async runScheduledBackup(reason: string): Promise<void> {
    if (this.schedulerState.running) {
      return;
    }

    this.schedulerState.running = true;
    this.schedulerState.lastRunAt = new Date().toISOString();
    this.schedulerState.lastError = undefined;

    try {
      const backup = await this.createBackup({ reason, prune: true });
      this.schedulerState.lastSuccessAt = new Date().toISOString();
      this.schedulerState.lastBackupId = backup.id;
    } catch (error) {
      this.schedulerState.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.schedulerState.running = false;
      if (this.schedule.enabled && this.schedule.intervalSeconds > 0) {
        this.scheduleNextRun(this.schedule.intervalSeconds);
      }
    }
  }
}

function backupId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

function sanitizeBackupId(value: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new ValidationError('Backup id may only contain letters, numbers, dot, underscore, and dash.');
  }

  return value;
}

function encodeJsonl(rows: Array<Record<string, unknown>>): string {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  return body ? `${body}\n` : '';
}

async function writeMirrorMarkdown(path: string, exported: BackupExportData): Promise<void> {
  await Promise.all([
    writeFile(join(path, 'knowledge.md'), renderKnowledgeMarkdown(tableRows(exported.tables, 'knowledge_items')), 'utf8'),
    writeFile(join(path, 'reflection-drafts.md'), renderReflectionMarkdown(tableRows(exported.tables, 'reflection_drafts')), 'utf8'),
    writeFile(join(path, 'context-packs.md'), renderContextPackMarkdown(tableRows(exported.tables, 'context_packs')), 'utf8'),
    writeFile(join(path, 'agent-sessions.md'), renderAgentSessionMarkdown(tableRows(exported.tables, 'agent_sessions')), 'utf8'),
  ]);
}

function renderKnowledgeMarkdown(rows: Array<Record<string, unknown>>): string {
  return renderRows('Knowledge', rows, (row) => [
    `- id: ${row.id}`,
    `- type/status: ${row.item_type}/${row.status}`,
    `- trust: ${row.trust_level}`,
    `- summary: ${row.summary ?? ''}`,
    '',
    String(row.content ?? '').trim(),
  ]);
}

function renderReflectionMarkdown(rows: Array<Record<string, unknown>>): string {
  return renderRows('Reflection Drafts', rows, (row) => [
    `- id: ${row.id}`,
    `- type/status: ${row.item_type}/${row.status}`,
    `- trigger: ${row.trigger_type}`,
    `- summary: ${row.summary ?? ''}`,
    '',
    String(row.content ?? '').trim(),
  ]);
}

function renderContextPackMarkdown(rows: Array<Record<string, unknown>>): string {
  return renderRows('Context Packs', rows, (row) => {
    const pack = nestedOrRowRecord(row, 'pack');
    return [
      `- id: ${row.id}`,
      `- status: ${row.status ?? pack.status ?? ''}`,
      `- confidence: ${row.confidence ?? pack.confidence ?? ''}`,
      `- prompt: ${pack.prompt ?? ''}`,
      `- deep context tokens: ${objectRecord(pack.deepContext).tokenEstimate ?? 0}`,
    ];
  });
}

function renderAgentSessionMarkdown(rows: Array<Record<string, unknown>>): string {
  return renderRows('Agent Sessions', rows, (row) => [
    `- id: ${row.id}`,
    `- status/outcome: ${row.status}/${row.outcome ?? ''}`,
    `- prompt: ${row.prompt ?? ''}`,
    `- summary: ${row.summary ?? ''}`,
    `- compliance: ${String(JSON.stringify(objectRecord(row.metadata).contextCompliance ?? {}))}`,
  ]);
}

function renderRows(
  title: string,
  rows: Array<Record<string, unknown>>,
  render: (row: Record<string, unknown>) => string[],
): string {
  const sections = rows.map((row) => [
    `## ${String(row.title ?? row.id ?? 'Untitled')}`,
    ...render(row),
  ].join('\n'));

  return [`# ${title}`, '', ...sections].join('\n\n').trimEnd() + '\n';
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nestedOrRowRecord(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = objectRecord(row[key]);
  return Object.keys(nested).length ? nested : row;
}

function tableRows(tables: BackupTableData[], name: BackupTableName): Array<Record<string, unknown>> {
  return tables.find((table) => table.name === name)?.rows ?? [];
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  return parseJsonl(await readFile(path, 'utf8'), path);
}

function parseJsonl(raw: string, path: string): Array<Record<string, unknown>> {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        throw new ValidationError(`Invalid JSONL at ${path}:${index + 1}.`, error);
      }
    });
}

async function readManifest(path: string): Promise<BackupManifest | undefined> {
  try {
    return JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as BackupManifest;
  } catch {
    return undefined;
  }
}

async function readRequiredManifest(path: string): Promise<BackupManifest> {
  const manifest = await readManifest(path);
  if (!manifest) {
    throw new ValidationError(`Backup manifest not found at ${path}.`);
  }

  return manifest;
}

function resolveBackupPath(backupDir: string, backupIdOrPath: string | undefined): string {
  if (!backupIdOrPath) {
    throw new ValidationError('backupIdOrPath is required.');
  }

  // If a path-like value is supplied, require it to resolve under the configured backupDir.
  if (isAbsolute(backupIdOrPath) || backupIdOrPath.includes(sep) || backupIdOrPath.startsWith('.')) {
    const resolved = resolve(backupIdOrPath);
    const root = resolve(backupDir);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw new ValidationError('backupIdOrPath must resolve inside the configured backup directory.');
    }
    return resolved;
  }

  return join(backupDir, sanitizeBackupId(backupIdOrPath));
}

function toBackupSummary(path: string, manifest: BackupManifest): BackupSummary {
  const createdMs = Date.parse(manifest.createdAt);
  const totalRows = manifest.tables.reduce((sum, table) => sum + table.rows, 0);

  return {
    id: manifest.id || basename(path),
    path,
    createdAt: manifest.createdAt,
    format: manifest.format,
    source: manifest.source,
    tables: manifest.tables,
    totalRows,
    ageSeconds: Number.isFinite(createdMs) ? Math.max(0, Math.floor((Date.now() - createdMs) / 1000)) : 0,
  };
}

function compareBackupSummaries(left: BackupSummary, right: BackupSummary): number {
  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  return byCreatedAt || right.id.localeCompare(left.id);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateManifestShape(manifest: BackupManifest, issues: BackupVerificationIssue[]): void {
  if (manifest.version !== 1) {
    issues.push({ severity: 'error', message: `Unsupported backup manifest version ${manifest.version}.` });
  }

  if (manifest.format !== 'jsonl') {
    issues.push({ severity: 'error', message: `Unsupported backup format ${manifest.format}.` });
  }

  if (manifest.source?.service !== 'tuberosa') {
    issues.push({ severity: 'error', message: 'Backup source service is not tuberosa.' });
  }
}

function validateCompatibility(
  manifest: BackupManifest,
  current: BackupRuntimeMetadata,
  issues: BackupVerificationIssue[],
): void {
  if (
    manifest.source?.schemaVersion !== undefined
    && current.schemaVersion !== undefined
    && manifest.source.schemaVersion > current.schemaVersion
  ) {
    issues.push({
      severity: 'error',
      message: `Backup schema version ${manifest.source.schemaVersion} is newer than running schema version ${current.schemaVersion}.`,
    });
  }

  if (
    manifest.source?.embeddingDimensions !== undefined
    && current.embeddingDimensions !== undefined
    && manifest.source.embeddingDimensions !== current.embeddingDimensions
  ) {
    issues.push({
      severity: 'error',
      message: `Backup embedding dimensions ${manifest.source.embeddingDimensions} do not match running dimensions ${current.embeddingDimensions}.`,
    });
  }
}
