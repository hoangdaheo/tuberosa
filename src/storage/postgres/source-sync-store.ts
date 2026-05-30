import type { Pool } from 'pg';
import { isPersistedKnowledgeId } from '../../util/uuid.js';
import type {
  ListSourceFilesOptions,
  RenameSourceFileInput,
  CreateSyncRunInput,
  UpsertSourceFileInput,
} from '../store.js';
import type {
  SourceFileRecord,
  SourceFileStatus,
  SyncRunRecord,
} from '../../source-sync/types.js';
import { ensureProject, toIso } from './shared-helpers.js';

/**
 * Source-file + sync-run persistence extracted from `PostgresKnowledgeStore`.
 * None of these methods participate in `withTransaction`'s fan-out, so they run
 * directly against the pool (mirroring the existing sub-store pattern).
 */
export class PostgresSourceSyncStore {
  constructor(private readonly pool: Pool) {}

  private mapSourceFileRow(row: Record<string, unknown>): SourceFileRecord {
    return {
      id: String(row.id),
      project: String(row.project_name),
      path: String(row.path),
      contentHash: (row.content_hash as string | null) ?? null,
      status: row.status as SourceFileRecord['status'],
      lastSyncedSha: (row.last_synced_sha as string | null) ?? null,
      priorPaths: (row.prior_paths as string[] | null) ?? [],
      knowledgeCount: Number(row.knowledge_count ?? 0),
      firstSeenAt: toIso(row.first_seen_at),
      lastSeenAt: toIso(row.last_seen_at),
      archivedAt: row.archived_at ? toIso(row.archived_at) : null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    };
  }

  private mapSyncRunRow(row: Record<string, unknown>): SyncRunRecord {
    return {
      id: String(row.id),
      project: String(row.project_name),
      mode: row.mode as SyncRunRecord['mode'],
      fromSha: (row.from_sha as string | null) ?? null,
      toSha: (row.to_sha as string | null) ?? null,
      plan: typeof row.plan === 'string' ? JSON.parse(row.plan) : (row.plan as SyncRunRecord['plan']),
      applied: row.applied as boolean,
      trigger: row.trigger as SyncRunRecord['trigger'],
      createdAt: toIso(row.created_at),
      appliedAt: row.applied_at ? toIso(row.applied_at) : null,
    };
  }

  async upsertSourceFile(input: UpsertSourceFileInput): Promise<SourceFileRecord> {
    const projectId = await ensureProject(this.pool, input.project);
    const { rows } = await this.pool.query(
      `
        INSERT INTO source_files (project_id, path, content_hash, status, last_synced_sha, metadata, last_seen_at)
        VALUES ($1, $2, $3, COALESCE($4, 'tracked'), $5, COALESCE($6, '{}'::jsonb), now())
        ON CONFLICT (project_id, path) DO UPDATE SET
          content_hash = EXCLUDED.content_hash,
          status = COALESCE($4, source_files.status),
          last_synced_sha = COALESCE($5, source_files.last_synced_sha),
          metadata = COALESCE($6, source_files.metadata),
          last_seen_at = now()
        RETURNING *, (SELECT name FROM projects WHERE id = project_id) AS project_name
      `,
      [projectId, input.path, input.contentHash, input.status ?? null, input.lastSyncedSha ?? null, input.metadata ?? null],
    );
    return this.mapSourceFileRow(rows[0]);
  }

  async getSourceFile(options: { project: string; path: string }): Promise<SourceFileRecord | undefined> {
    const { rows } = await this.pool.query(
      `
        SELECT sf.*, p.name AS project_name
        FROM source_files sf JOIN projects p ON p.id = sf.project_id
        WHERE p.name = $1 AND sf.path = $2
      `,
      [options.project, options.path],
    );
    return rows[0] ? this.mapSourceFileRow(rows[0]) : undefined;
  }

  async listSourceFiles(options: ListSourceFilesOptions): Promise<SourceFileRecord[]> {
    const { rows } = await this.pool.query(
      `
        SELECT sf.*, p.name AS project_name
        FROM source_files sf JOIN projects p ON p.id = sf.project_id
        WHERE ($1::text IS NULL OR p.name = $1) AND ($2::text IS NULL OR sf.status = $2)
        ORDER BY sf.path
        LIMIT $3
      `,
      [options.project ?? null, options.status ?? null, options.limit],
    );
    return rows.map((row) => this.mapSourceFileRow(row));
  }

  async renameSourceFile(input: RenameSourceFileInput): Promise<SourceFileRecord | undefined> {
    const { rows } = await this.pool.query(
      `
        UPDATE source_files sf
        SET path = $3, prior_paths = array_append(sf.prior_paths, $2), last_seen_at = now()
        FROM projects p
        WHERE p.id = sf.project_id AND p.name = $1 AND sf.path = $2
        RETURNING sf.*, p.name AS project_name
      `,
      [input.project, input.from, input.to],
    );
    return rows[0] ? this.mapSourceFileRow(rows[0]) : undefined;
  }

  async setSourceFileStatus(options: { project: string; path: string; status: SourceFileStatus }): Promise<SourceFileRecord | undefined> {
    const { rows } = await this.pool.query(
      `
        UPDATE source_files sf
        SET status = $3, archived_at = CASE WHEN $3 = 'archived' THEN now() ELSE sf.archived_at END
        FROM projects p
        WHERE p.id = sf.project_id AND p.name = $1 AND sf.path = $2
        RETURNING sf.*, p.name AS project_name
      `,
      [options.project, options.path, options.status],
    );
    return rows[0] ? this.mapSourceFileRow(rows[0]) : undefined;
  }

  async createSyncRun(input: CreateSyncRunInput): Promise<SyncRunRecord> {
    const projectId = await ensureProject(this.pool, input.project);
    const { rows } = await this.pool.query(
      `
        INSERT INTO sync_runs (project_id, mode, from_sha, to_sha, plan, trigger)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *, (SELECT name FROM projects WHERE id = project_id) AS project_name
      `,
      [projectId, input.mode, input.fromSha ?? null, input.toSha ?? null, JSON.stringify(input.plan), input.trigger],
    );
    return this.mapSyncRunRow(rows[0]);
  }

  async getSyncRun(id: string): Promise<SyncRunRecord | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const { rows } = await this.pool.query(
      `
        SELECT sr.*, p.name AS project_name
        FROM sync_runs sr JOIN projects p ON p.id = sr.project_id
        WHERE sr.id = $1
      `,
      [id],
    );
    return rows[0] ? this.mapSyncRunRow(rows[0]) : undefined;
  }

  async markSyncRunApplied(id: string): Promise<SyncRunRecord | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const { rows } = await this.pool.query(
      `
        UPDATE sync_runs sr
        SET applied = true, applied_at = now()
        FROM projects p
        WHERE p.id = sr.project_id AND sr.id = $1
        RETURNING sr.*, p.name AS project_name
      `,
      [id],
    );
    return rows[0] ? this.mapSyncRunRow(rows[0]) : undefined;
  }
}
