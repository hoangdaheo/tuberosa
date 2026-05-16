import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { ValidationError } from '../errors.js';
import type { IngestFileInput, IngestionMode } from '../ingest/service.js';
import type { IngestionService } from '../ingest/service.js';
import type { KnowledgeStore } from '../storage/store.js';
import type {
  BackupManifest,
  BackupSummary,
  BackupTableData,
  CreateBackupInput,
  CleanupOperationsInput,
  KnowledgePatchInput,
  ListKnowledgeOptions,
  ListRecordsOptions,
  ReflectionDraftPatchInput,
  RestoreBackupInput,
  RestoreBackupResult,
} from '../types.js';

export interface ImportFilesInput {
  project: string;
  files: IngestFileInput[];
  mode?: IngestionMode;
}

export class OperationsService {
  private readonly backupDir: string;
  private readonly storeKind: 'postgres' | 'memory';

  constructor(
    private readonly store: KnowledgeStore,
    private readonly ingestion: IngestionService,
    options: { backupDir?: string; storeKind?: 'postgres' | 'memory' } = {},
  ) {
    this.backupDir = resolve(options.backupDir ?? '.tuberosa/backups');
    this.storeKind = options.storeKind ?? 'memory';
  }

  listKnowledge(options: ListKnowledgeOptions) {
    return this.store.listKnowledge(options);
  }

  getKnowledge(id: string) {
    return this.store.getKnowledge(id);
  }

  updateKnowledge(id: string, patch: KnowledgePatchInput) {
    return this.store.updateKnowledge(id, patch);
  }

  listLabels(options: { project?: string; limit: number }) {
    return this.store.listLabels(options);
  }

  listContextPacks(options: ListRecordsOptions) {
    return this.store.listContextPacks(options);
  }

  listFeedbackEvents(options: ListRecordsOptions) {
    return this.store.listFeedbackEvents(options);
  }

  listAgentSessions(options: ListRecordsOptions) {
    return this.store.listAgentSessions(options);
  }

  getAgentSession(id: string) {
    return this.store.getAgentSession(id);
  }

  listAgentContextDecisions(options: { sessionId?: string; limit: number }) {
    return this.store.listAgentContextDecisions(options);
  }

  listReflectionDrafts(options: ListRecordsOptions) {
    return this.store.listReflectionDrafts(options);
  }

  getReflectionDraft(id: string) {
    return this.store.getReflectionDraft(id);
  }

  updateReflectionDraft(id: string, patch: ReflectionDraftPatchInput) {
    return this.store.updateReflectionDraft(id, patch);
  }

  importFiles(input: ImportFilesInput) {
    return this.ingestion.ingestFiles(input.project, input.files, { mode: input.mode });
  }

  cleanup(input: CleanupOperationsInput) {
    return this.store.cleanupOperations(input);
  }

  async createBackup(input: CreateBackupInput = {}): Promise<BackupSummary> {
    const exported = await this.store.exportBackup();
    const id = sanitizeBackupId(input.id ?? backupId());
    const backupPath = join(this.backupDir, id);

    await mkdir(backupPath, { recursive: true });

    const manifest: BackupManifest = {
      id,
      version: 1,
      format: 'jsonl',
      createdAt: new Date().toISOString(),
      source: {
        service: 'tuberosa',
        store: this.storeKind,
      },
      tables: exported.tables.map((table) => ({
        name: table.name,
        file: `${table.name}.jsonl`,
        rows: table.rows.length,
      })),
    };

    await Promise.all(exported.tables.map((table) => writeJsonl(join(backupPath, `${table.name}.jsonl`), table.rows)));
    await writeFile(join(backupPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    return toBackupSummary(backupPath, manifest);
  }

  async listBackups(): Promise<BackupSummary[]> {
    await mkdir(this.backupDir, { recursive: true });
    const entries = await readdir(this.backupDir);
    const summaries = await Promise.all(entries.map(async (entry) => {
      const backupPath = join(this.backupDir, entry);
      const stats = await stat(backupPath);
      if (!stats.isDirectory()) {
        return undefined;
      }

      const manifest = await readManifest(backupPath);
      return manifest ? toBackupSummary(backupPath, manifest) : undefined;
    }));

    return summaries
      .filter((summary): summary is BackupSummary => Boolean(summary))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async restoreBackup(input: RestoreBackupInput = {}): Promise<RestoreBackupResult> {
    if (!input.dryRun && !input.replace) {
      throw new ValidationError('Backup restore requires replace=true unless dryRun=true.');
    }

    const backupPath = resolveBackupPath(this.backupDir, input.backupIdOrPath);
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
      restored: restored as RestoreBackupResult['restored'],
    };
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

async function writeJsonl(path: string, rows: Array<Record<string, unknown>>): Promise<void> {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await writeFile(path, body ? `${body}\n` : '', 'utf8');
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

  if (isAbsolute(backupIdOrPath) || backupIdOrPath.includes(sep) || backupIdOrPath.startsWith('.')) {
    return resolve(backupIdOrPath);
  }

  return join(backupDir, sanitizeBackupId(backupIdOrPath));
}

function toBackupSummary(path: string, manifest: BackupManifest): BackupSummary {
  return {
    id: manifest.id || basename(path),
    path,
    createdAt: manifest.createdAt,
    format: manifest.format,
    tables: manifest.tables,
  };
}
