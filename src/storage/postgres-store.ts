import { Pool, type PoolClient } from 'pg';
import { StoreError } from '../errors.js';
import { isPersistedKnowledgeId } from '../util/uuid.js';
import type {
  AgentContextDecision,
  AgentSession,
  AgentSessionNote,
  BackupExportData,
  BackupTableData,
  BackupTableName,
  ClassifiedQuery,
  CleanupOperationsInput,
  CleanupOperationsResult,
  ContextPack,
  FeedbackEvent,
  FeedbackInput,
  FinishAgentSessionInput,
  KnowledgeConflict,
  KnowledgeConflictInput,
  KnowledgeConflictPatchInput,
  KnowledgeGap,
  KnowledgeGapInput,
  KnowledgeGapPatchInput,
  KnowledgeGraphJsonlExport,
  KnowledgePatchInput,
  KnowledgeChunkRecord,
  KnowledgeFeedbackSummary,
  KnowledgeInput,
  LearningProposal,
  LearningProposalInput,
  LearningProposalPatchInput,
  KnowledgeRelation,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  LabelInput,
  LabelRecord,
  ListKnowledgeConflictsOptions,
  ListKnowledgeGapsOptions,
  ListLearningProposalsOptions,
  ListKnowledgeRelationsOptions,
  ListKnowledgeOptions,
  ListRecordsOptions,
  ProjectMapExport,
  RecordAgentContextDecisionInput,
  ReadableSummaryExport,
  ReferenceInput,
  ReflectionDraft,
  ReflectionDraftPatchInput,
  ReflectionDraftInput,
  SearchCandidate,
  SearchOptions,
  StoredKnowledge,
} from '../types.js';
import type {
  KnowledgeAtom,
  KnowledgeAtomInput,
  KnowledgeAtomPatch,
  ListAtomsOptions,
} from '../types/atoms.js';
import type {
  AtomFrontmatter,
  AtomImportConflict,
  AtomImportConflictAction,
} from '../types/export-bundle.js';
import { importedSnapshotToPatch } from './atom-import-patch.js';
import { canonicalKnowledgePair, shouldDropInferredRelationsForStatus } from './shared.js';
import { sha256 } from '../util/hash.js';
import { estimateTokens, normalizeLabel } from '../util/text.js';
import { getRetrievalPolicy } from '../retrieval/policy.js';
import type { KnowledgeRelationType } from '../types.js';
import { PostgresBackupStore } from './postgres/backup-store.js';
import { PostgresContextStore } from './postgres/context-store.js';
import { PostgresLabelStore } from './postgres/label-store.js';
import {
  deriveNamespace,
  readNamespaceFromMetadata,
  writeNamespaceToMetadata,
} from './knowledge-namespace.js';
import type { SessionReplayBundle } from '../operations/session-replay.js';
import type {
  AtomGateEvent,
  AtomGateEventInput,
  AtomGraphEdgeKind,
  AtomGraphHit,
  AtomGraphPathStep,
  AtomRelationInput,
  AtomRelationRow,
  AtomRelationTargetKind,
  ChunkInput,
  InferenceSource,
  KnowledgeStore,
  ListAtomRelationsOptions,
  PruneStaleAtomRelationsOptions,
  StaleFileAtomCleanupInput,
  UpsertSourceFileInput,
  ListSourceFilesOptions,
  RenameSourceFileInput,
  CreateSyncRunInput,
  WalkAtomGraphOptions,
  AtlasRunInput,
  AtlasRunRecord,
} from './store.js';
import type {
  SourceFileRecord,
  SourceFileStatus,
  SyncRunRecord,
} from '../source-sync/types.js';

type Queryable = Pool | PoolClient;

// Phase 5 follow-up: Postgres uuid[] casts crash on synthetic knowledge ids such as
// the Phase-5 worktree provider's `worktree:<sha256>` ids (live-evidence only, never
// persisted). Every method that takes a knowledge id from outside the store filters
// through the shared `isPersistedKnowledgeId` predicate before the id reaches a
// `::uuid` / `::uuid[]` cast — the MemoryKnowledgeStore is permissive (returns empty
// for unknown ids), so this brings Postgres in line.
// Clients that were already destroyed during error handling. Used so the
// `finally` block in transaction wrappers doesn't double-release.
const destroyedClients = new WeakSet<PoolClient>();

// Safely roll back a transaction. If ROLLBACK itself fails (e.g. the underlying
// connection is broken), swallow the error and destroy the client so it isn't
// returned to the pool in a half-aborted state. Never throws past the original error.
async function rollbackAndRelease(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    console.error('[postgres-store] ROLLBACK failed; destroying client.', rollbackError);
    try {
      client.release(new Error('ROLLBACK failed; client destroyed.'));
    } catch (releaseError) {
      console.error('[postgres-store] client.release threw during destroy.', releaseError);
    }
    destroyedClients.add(client);
  }
}

function finalReleaseClient(client: PoolClient): void {
  if (destroyedClients.has(client)) {
    destroyedClients.delete(client);
    return;
  }
  try {
    client.release();
  } catch (releaseError) {
    console.error('[postgres-store] client.release threw.', releaseError);
  }
}

function filterPersistedKnowledgeIds(ids: readonly string[] | undefined): string[] {
  if (!ids || ids.length === 0) return [];
  return ids.filter(isPersistedKnowledgeId);
}

/** Apply a KnowledgeAtomPatch's content+meta fields to one atom inside an open transaction. */
async function applyAtomPatchInTx(
  client: PoolClient,
  atomId: string,
  patch: KnowledgeAtomPatch,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.claim !== undefined)        { vals.push(patch.claim);        sets.push(`claim = $${vals.length}`); }
  if (patch.type !== undefined)         { vals.push(patch.type);         sets.push(`type = $${vals.length}`); }
  if (patch.evidence !== undefined)     { vals.push(JSON.stringify(patch.evidence));     sets.push(`evidence = $${vals.length}::jsonb`); }
  if (patch.trigger !== undefined)      { vals.push(JSON.stringify(patch.trigger));      sets.push(`trigger = $${vals.length}::jsonb`); }
  if (patch.verification !== undefined) { vals.push(JSON.stringify(patch.verification)); sets.push(`verification = $${vals.length}::jsonb`); }
  if (patch.pitfalls !== undefined)     { vals.push(JSON.stringify(patch.pitfalls));     sets.push(`pitfalls = $${vals.length}::jsonb`); }
  if (patch.links !== undefined)        { vals.push(JSON.stringify(patch.links));        sets.push(`links = $${vals.length}::jsonb`); }
  if (patch.tier !== undefined)         { vals.push(patch.tier);         sets.push(`tier = $${vals.length}`); }
  if (patch.status !== undefined)       { vals.push(patch.status);       sets.push(`status = $${vals.length}`); }
  if (sets.length === 0) return;
  vals.push(atomId);
  await client.query(`UPDATE knowledge_atoms SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
}

export class PostgresKnowledgeStore implements KnowledgeStore {
  private readonly pool: Pool;
  private readonly backups: PostgresBackupStore;
  private readonly contextPacks: PostgresContextStore;
  private readonly labels: PostgresLabelStore;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
    });
    this.backups = new PostgresBackupStore(this.pool);
    this.contextPacks = new PostgresContextStore(this.pool);
    this.labels = new PostgresLabelStore(this.pool);
  }

  async upsertKnowledge(input: KnowledgeInput, chunks: ChunkInput[]): Promise<StoredKnowledge> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const projectId = await this.ensureProject(client, input.project);
      const sourceId = await this.upsertSource(client, projectId, input);
      const knowledgeId = await this.saveKnowledgeItem(
        client,
        projectId,
        sourceId,
        withNamespaceMetadata(withLabelProvenanceMetadata(input)),
      );
      await this.labels.attachLabels(client, knowledgeId, input.labels ?? []);
      await this.attachReferences(client, knowledgeId, input.references ?? []);
      await this.insertChunks(client, knowledgeId, projectId, chunks);
      await client.query('COMMIT');

      const stored = await this.getKnowledge(knowledgeId);
      if (!stored) {
        throw new StoreError(`Knowledge item ${knowledgeId} was created but could not be read back.`);
      }

      return stored;
    } catch (error) {
      await rollbackAndRelease(client);
      throw error;
    } finally {
      finalReleaseClient(client);
    }
  }

  async deleteStaleFileAtoms(input: StaleFileAtomCleanupInput): Promise<number> {
    const result = await this.pool.query(
      `
        DELETE FROM knowledge_items ki
        USING projects p, knowledge_sources ks
        WHERE ki.project_id = p.id
          AND ki.source_id = ks.id
          AND p.name = $1
          AND ki.metadata->>'ingestionMode' = 'atomic'
          AND ki.metadata->>'sourcePath' = $2
          AND NOT (ks.uri = ANY($3::text[]))
      `,
      [input.project, input.sourcePath, input.keepSourceUris],
    );

    return result.rowCount ?? 0;
  }

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
    const projectId = await this.ensureProject(this.pool, input.project);
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

  async listKnowledgeBySourcePath(options: { project: string; path: string }): Promise<StoredKnowledge[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `
        SELECT ki.id
        FROM knowledge_items ki JOIN projects p ON p.id = ki.project_id
        WHERE p.name = $1 AND ki.metadata->>'sourcePath' = $2
      `,
      [options.project, options.path],
    );
    const out: StoredKnowledge[] = [];
    for (const row of rows) {
      const knowledge = await this.getKnowledge(row.id);
      if (knowledge) {
        out.push(knowledge);
      }
    }
    return out;
  }

  async createSyncRun(input: CreateSyncRunInput): Promise<SyncRunRecord> {
    const projectId = await this.ensureProject(this.pool, input.project);
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

  async createAtlasRun(input: AtlasRunInput): Promise<AtlasRunRecord> {
    const projectId = await this.ensureProject(this.pool, input.project);
    const { rows } = await this.pool.query<{ id: string }>(
      `
        INSERT INTO atlas_runs (project_id, input_hash, files, generated_at)
        VALUES ($1, $2, $3::jsonb, $4)
        RETURNING id
      `,
      [projectId, input.inputHash, JSON.stringify(input.files), input.generatedAt],
    );
    return { ...input, id: rows[0].id };
  }

  async getLatestAtlasRun(project: string): Promise<AtlasRunRecord | undefined> {
    const { rows } = await this.pool.query(
      `
        SELECT ar.id, ar.input_hash, ar.files, ar.generated_at
        FROM atlas_runs ar JOIN projects p ON p.id = ar.project_id
        WHERE p.name = $1
        ORDER BY ar.generated_at DESC
        LIMIT 1
      `,
      [project],
    );
    if (rows.length === 0) {
      return undefined;
    }
    const row = rows[0];
    return {
      id: row.id as string,
      project,
      inputHash: row.input_hash as string,
      files: row.files as { name: string; bytes: number }[],
      generatedAt: new Date(row.generated_at as string).toISOString(),
    };
  }

  async listKnowledge(options: ListKnowledgeOptions): Promise<StoredKnowledge[]> {
    const params: unknown[] = [options.limit];
    const filters: string[] = [];

    if (options.status) {
      params.push(options.status);
      filters.push(`ki.status = $${params.length}`);
    } else if (!options.review) {
      filters.push("ki.status = 'approved'");
    }

    if (options.project) {
      params.push(options.project);
      filters.push(`p.name = $${params.length}`);
    }

    if (options.query) {
      params.push(`%${options.query.toLowerCase()}%`);
      filters.push(`(lower(ki.title) LIKE $${params.length} OR lower(ki.summary) LIKE $${params.length} OR lower(ki.content) LIKE $${params.length})`);
    }

    const reviewFilter = knowledgeReviewSql(options.review);
    if (reviewFilter) {
      filters.push(reviewFilter);
    }

    const result = await this.pool.query(
      `
        ${knowledgeSelect()}
        WHERE ${filters.length ? filters.join(' AND ') : 'true'}
        ORDER BY ki.updated_at DESC
        LIMIT $1
      `,
      params,
    );

    return result.rows.map(mapKnowledgeRow);
  }

  async getKnowledge(id: string): Promise<StoredKnowledge | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
      `
        ${knowledgeSelect()}
        WHERE ki.id = $1
      `,
      [id],
    );

    return result.rows[0] ? mapKnowledgeRow(result.rows[0]) : undefined;
  }

  async updateKnowledge(id: string, patch: KnowledgePatchInput): Promise<StoredKnowledge | undefined> {
    const current = await this.getKnowledge(id);
    if (!current) {
      return undefined;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const mergedMetadataBase = patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata;
      const mergedMetadataWithProvenance = patch.labels
        ? mergeLabelProvenanceIntoMetadata(mergedMetadataBase, patch.labels)
        : mergedMetadataBase;
      const nextNamespace = patch.namespace
        ?? current.namespace
        ?? deriveNamespace({
          project: current.project,
          itemType: current.itemType,
          metadata: mergedMetadataWithProvenance,
        });
      const mergedMetadata = writeNamespaceToMetadata(mergedMetadataWithProvenance, nextNamespace);

      await client.query(
        `
          UPDATE knowledge_items
          SET status = $2,
            title = $3,
            summary = $4,
            trust_level = $5,
            freshness_at = $6,
            metadata = $7,
            updated_at = now()
          WHERE id = $1
        `,
        [
          id,
          patch.status ?? current.status ?? 'approved',
          patch.title ?? current.title,
          patch.summary ?? current.summary,
          patch.trustLevel ?? current.trustLevel,
          patch.freshnessAt === null ? null : patch.freshnessAt ?? current.freshnessAt ?? null,
          mergedMetadata,
        ],
      );

      if (patch.labels) {
        await client.query('DELETE FROM knowledge_labels WHERE knowledge_id = $1', [id]);
        await this.labels.attachLabels(client, id, patch.labels);
      }

      if (patch.references) {
        await client.query('DELETE FROM knowledge_references WHERE knowledge_id = $1', [id]);
        await this.attachReferences(client, id, patch.references);
      }

      if (shouldDropInferredRelationsForStatus(patch.status)) {
        await client.query(
          `
            DELETE FROM knowledge_relations
            WHERE inferred = true
              AND (from_knowledge_id = $1 OR target_knowledge_id = $1)
          `,
          [id],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await rollbackAndRelease(client);
      throw error;
    } finally {
      finalReleaseClient(client);
    }

    return this.getKnowledge(id);
  }

  async replaceInferredKnowledgeRelations(
    knowledgeId: string,
    relations: KnowledgeRelationInput[],
  ): Promise<KnowledgeRelation[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM knowledge_relations WHERE from_knowledge_id = $1 AND inferred = true', [knowledgeId]);
      const created: KnowledgeRelation[] = [];
      for (const relation of relations) {
        created.push(await this.insertKnowledgeRelation(client, { ...relation, inferred: true }));
      }
      await client.query('COMMIT');
      return created;
    } catch (error) {
      await rollbackAndRelease(client);
      throw error;
    } finally {
      finalReleaseClient(client);
    }
  }

  async listKnowledgeRelations(options: ListKnowledgeRelationsOptions): Promise<KnowledgeRelation[]> {
    // Phase 5 follow-up: filter synthetic ids (e.g. worktree:<sha>) so a caller that
    // walks worktree candidates into listKnowledgeRelations does not crash the uuid cast.
    if (options.fromKnowledgeId && !isPersistedKnowledgeId(options.fromKnowledgeId)) return [];
    if (options.targetKnowledgeId && !isPersistedKnowledgeId(options.targetKnowledgeId)) return [];
    const result = await this.pool.query(
      `
        ${relationSelect()}
        WHERE ($2::text IS NULL OR p.name = $2)
          AND ($3::uuid IS NULL OR kr.from_knowledge_id = $3)
          AND ($4::uuid IS NULL OR kr.target_knowledge_id = $4)
          AND ($5::text IS NULL OR kr.target_value = $5)
          AND ($6::text IS NULL OR kr.relation_type = $6)
          AND ($7::boolean IS NULL OR kr.inferred = $7)
        ORDER BY kr.created_at DESC
        LIMIT $1
      `,
      [
        options.limit,
        options.project ?? null,
        options.fromKnowledgeId ?? null,
        options.targetKnowledgeId ?? null,
        options.targetValue ?? null,
        options.relationType ?? null,
        options.inferred ?? null,
      ],
    );

    return result.rows.map(mapRelationRow);
  }

  async getKnowledgeRelation(id: string): Promise<KnowledgeRelation | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
      `
        ${relationSelect()}
        WHERE kr.id = $1
      `,
      [id],
    );

    return result.rows[0] ? mapRelationRow(result.rows[0]) : undefined;
  }

  async createKnowledgeRelation(input: KnowledgeRelationInput): Promise<KnowledgeRelation> {
    return this.insertKnowledgeRelation(this.pool, input);
  }

  async updateKnowledgeRelation(id: string, patch: KnowledgeRelationPatchInput): Promise<KnowledgeRelation | undefined> {
    const current = await this.getKnowledgeRelation(id);
    if (!current) {
      return undefined;
    }

    const result = await this.pool.query(
      `
        UPDATE knowledge_relations
        SET relation_type = $2,
          target_kind = $3,
          target_knowledge_id = $4,
          target_value = $5,
          confidence = $6,
          inferred = $7,
          metadata = $8,
          updated_at = now()
        WHERE id = $1
        RETURNING id
      `,
      [
        id,
        patch.relationType ?? current.relationType,
        patch.targetKind ?? current.targetKind,
        patch.targetKnowledgeId === null ? null : patch.targetKnowledgeId ?? current.targetKnowledgeId ?? null,
        patch.targetValue === null ? null : patch.targetValue ?? current.targetValue ?? null,
        patch.confidence ?? current.confidence,
        patch.inferred ?? current.inferred,
        patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      ],
    );

    return result.rowCount ? this.getKnowledgeRelation(id) : undefined;
  }

  async deleteKnowledgeRelation(id: string): Promise<boolean> {
    if (!isPersistedKnowledgeId(id)) return false;
    const result = await this.pool.query('DELETE FROM knowledge_relations WHERE id = $1', [id]);
    return Boolean(result.rowCount);
  }

  async listKnowledgeConflicts(options: ListKnowledgeConflictsOptions): Promise<KnowledgeConflict[]> {
    const result = await this.pool.query(
      `
        ${conflictSelect()}
        WHERE ($2::text IS NULL OR p.name = $2)
          AND ($3::text IS NULL OR kc.status = $3)
        ORDER BY kc.created_at DESC
        LIMIT $1
      `,
      [options.limit, options.project ?? null, options.status ?? null],
    );

    return result.rows.map(mapConflictRow);
  }

  async createKnowledgeConflict(input: KnowledgeConflictInput): Promise<KnowledgeConflict> {
    const [leftKnowledgeId, rightKnowledgeId] = canonicalKnowledgePair(input.leftKnowledgeId, input.rightKnowledgeId);
    const projectId = input.project
      ? await this.ensureProject(this.pool, input.project)
      : null;
    const result = await this.pool.query(
      `
        WITH inserted AS (
          INSERT INTO knowledge_conflicts (
            project_id, left_knowledge_id, right_knowledge_id, conflict_type,
            shared_evidence, reason, metadata
          )
          VALUES (
            COALESCE($1, (SELECT project_id FROM knowledge_items WHERE id = $2)),
            $2, $3, $4, $5, $6, $7
          )
          ON CONFLICT (left_knowledge_id, right_knowledge_id, conflict_type)
          DO UPDATE SET updated_at = knowledge_conflicts.updated_at
          RETURNING *
        )
        SELECT inserted.*, p.name AS project
        FROM inserted
        LEFT JOIN projects p ON p.id = inserted.project_id
      `,
      [
        projectId,
        leftKnowledgeId,
        rightKnowledgeId,
        input.conflictType,
        input.sharedEvidence,
        input.reason,
        input.metadata ?? {},
      ],
    );
    return mapConflictRow(result.rows[0]);
  }

  private async getKnowledgeConflict(id: string): Promise<KnowledgeConflict | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
      `
        ${conflictSelect()}
        WHERE kc.id = $1
      `,
      [id],
    );

    return result.rows[0] ? mapConflictRow(result.rows[0]) : undefined;
  }

  async updateKnowledgeConflict(id: string, patch: KnowledgeConflictPatchInput): Promise<KnowledgeConflict | undefined> {
    const current = await this.getKnowledgeConflict(id);
    if (!current) {
      return undefined;
    }

    const status = patch.status ?? current.status;
    const result = await this.pool.query(
      `
        UPDATE knowledge_conflicts
        SET status = $2,
          metadata = $3,
          updated_at = now(),
          resolved_at = CASE WHEN $2 = 'open' THEN NULL ELSE COALESCE(resolved_at, now()) END
        WHERE id = $1
        RETURNING id
      `,
      [
        id,
        status,
        patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      ],
    );

    return result.rowCount ? this.getKnowledgeConflict(id) : undefined;
  }

  async createKnowledgeGap(input: KnowledgeGapInput): Promise<KnowledgeGap> {
    const projectId = input.project ? await this.ensureProject(this.pool, input.project) : null;
    const result = await this.pool.query(
      `
        WITH inserted AS (
          INSERT INTO knowledge_gaps (
            project_id, source_feedback_id, source_session_id, context_pack_id,
            prompt, classified, missing_signals, reason, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (source_feedback_id)
          WHERE source_feedback_id IS NOT NULL
          DO UPDATE SET
            missing_signals = EXCLUDED.missing_signals,
            reason = EXCLUDED.reason,
            metadata = knowledge_gaps.metadata || EXCLUDED.metadata,
            updated_at = now()
          RETURNING *
        )
        SELECT inserted.*, p.name AS project
        FROM inserted
        LEFT JOIN projects p ON p.id = inserted.project_id
      `,
      [
        projectId,
        input.sourceFeedbackId ?? null,
        input.sourceSessionId ?? null,
        input.contextPackId ?? null,
        input.prompt,
        input.classified ?? null,
        input.missingSignals,
        input.reason ?? null,
        input.metadata ?? {},
      ],
    );
    return mapKnowledgeGapRow(result.rows[0]);
  }

  async listKnowledgeGaps(options: ListKnowledgeGapsOptions): Promise<KnowledgeGap[]> {
    const result = await this.pool.query(
      `
        ${knowledgeGapSelect()}
        WHERE ($2::text IS NULL OR p.name = $2)
          AND ($3::text IS NULL OR kg.status = $3)
          AND ($4::uuid IS NULL OR kg.source_session_id = $4)
          AND ($5::uuid IS NULL OR kg.context_pack_id = $5)
        ORDER BY kg.created_at DESC
        LIMIT $1
      `,
      [
        options.limit,
        options.project ?? null,
        options.status ?? null,
        options.sourceSessionId ?? null,
        options.contextPackId ?? null,
      ],
    );

    return result.rows.map(mapKnowledgeGapRow);
  }

  async getKnowledgeGap(id: string): Promise<KnowledgeGap | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
      `
        ${knowledgeGapSelect()}
        WHERE kg.id = $1
      `,
      [id],
    );

    return result.rows[0] ? mapKnowledgeGapRow(result.rows[0]) : undefined;
  }

  async updateKnowledgeGap(id: string, patch: KnowledgeGapPatchInput): Promise<KnowledgeGap | undefined> {
    const current = await this.getKnowledgeGap(id);
    if (!current) {
      return undefined;
    }

    const status = patch.status ?? current.status;
    const result = await this.pool.query(
      `
        UPDATE knowledge_gaps
        SET status = $2,
          metadata = $3,
          updated_at = now(),
          reviewed_at = CASE WHEN $2 = 'open' THEN NULL ELSE COALESCE(reviewed_at, now()) END
        WHERE id = $1
        RETURNING id
      `,
      [
        id,
        status,
        patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      ],
    );

    return result.rowCount ? this.getKnowledgeGap(id) : undefined;
  }

  async createLearningProposal(input: LearningProposalInput): Promise<LearningProposal> {
    const projectId = input.project ? await this.ensureProject(this.pool, input.project) : null;
    const result = await this.pool.query(
      `
        WITH inserted AS (
          INSERT INTO learning_proposals (
            project_id, proposal_type, source_feedback_id, source_session_id,
            context_pack_id, affected_knowledge_id, candidate_knowledge_id,
            reason, evidence, metadata
          )
          VALUES (
            COALESCE($1, (SELECT project_id FROM knowledge_items WHERE id = $6)),
            $2, $3, $4, $5, $6, $7, $8, $9, $10
          )
          ON CONFLICT (source_feedback_id, proposal_type, affected_knowledge_id)
          WHERE source_feedback_id IS NOT NULL AND affected_knowledge_id IS NOT NULL
          DO UPDATE SET
            reason = EXCLUDED.reason,
            evidence = EXCLUDED.evidence,
            metadata = learning_proposals.metadata || EXCLUDED.metadata,
            updated_at = now()
          RETURNING *
        )
        SELECT inserted.*, p.name AS project
        FROM inserted
        LEFT JOIN projects p ON p.id = inserted.project_id
      `,
      [
        projectId,
        input.proposalType,
        input.sourceFeedbackId ?? null,
        input.sourceSessionId ?? null,
        input.contextPackId ?? null,
        input.affectedKnowledgeId ?? null,
        input.candidateKnowledgeId ?? null,
        input.reason,
        input.evidence,
        input.metadata ?? {},
      ],
    );
    return mapLearningProposalRow(result.rows[0]);
  }

  async listLearningProposals(options: ListLearningProposalsOptions): Promise<LearningProposal[]> {
    // Phase 5 follow-up: a synthetic worktree id passed via affectedKnowledgeId would
    // crash the uuid cast — return [] early since no learning proposal can reference
    // a non-persisted candidate.
    if (options.affectedKnowledgeId && !isPersistedKnowledgeId(options.affectedKnowledgeId)) return [];
    const result = await this.pool.query(
      `
        ${learningProposalSelect()}
        WHERE ($2::text IS NULL OR p.name = $2)
          AND ($3::text IS NULL OR lp.status = $3)
          AND ($4::text IS NULL OR lp.proposal_type = $4)
          AND ($5::uuid IS NULL OR lp.source_session_id = $5)
          AND ($6::uuid IS NULL OR lp.context_pack_id = $6)
          AND ($7::uuid IS NULL OR lp.affected_knowledge_id = $7)
        ORDER BY lp.created_at DESC
        LIMIT $1
      `,
      [
        options.limit,
        options.project ?? null,
        options.status ?? null,
        options.proposalType ?? null,
        options.sourceSessionId ?? null,
        options.contextPackId ?? null,
        options.affectedKnowledgeId ?? null,
      ],
    );

    return result.rows.map(mapLearningProposalRow);
  }

  async getLearningProposal(id: string): Promise<LearningProposal | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
      `
        ${learningProposalSelect()}
        WHERE lp.id = $1
      `,
      [id],
    );

    return result.rows[0] ? mapLearningProposalRow(result.rows[0]) : undefined;
  }

  async updateLearningProposal(id: string, patch: LearningProposalPatchInput): Promise<LearningProposal | undefined> {
    const current = await this.getLearningProposal(id);
    if (!current) {
      return undefined;
    }

    const status = patch.status ?? current.status;
    const result = await this.pool.query(
      `
        UPDATE learning_proposals
        SET status = $2,
          metadata = $3,
          updated_at = now(),
          reviewed_at = CASE WHEN $2 = 'open' THEN NULL ELSE COALESCE(reviewed_at, now()) END
        WHERE id = $1
        RETURNING id
      `,
      [
        id,
        status,
        patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      ],
    );

    return result.rowCount ? this.getLearningProposal(id) : undefined;
  }

  async listLabels(options: { project?: string; limit: number }): Promise<LabelRecord[]> {
    return this.labels.listLabels(options);
  }

  async listKnowledgeChunks(knowledgeIds: string[]): Promise<KnowledgeChunkRecord[]> {
    const ids = filterPersistedKnowledgeIds(knowledgeIds);
    if (ids.length === 0) {
      return [];
    }

    const result = await this.pool.query(
      `
        SELECT id, knowledge_id, chunk_index, content, contextual_content,
          token_estimate, metadata, created_at
        FROM knowledge_chunks
        WHERE knowledge_id = ANY($1::uuid[])
        ORDER BY array_position($1::uuid[], knowledge_id), chunk_index
      `,
      [ids],
    );

    return result.rows.map(mapKnowledgeChunkRow);
  }

  async searchLexical(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]> {
    const rejectedIds = filterPersistedKnowledgeIds(options.rejectedKnowledgeIds);
    const result = await this.pool.query(
      `
        WITH q AS (SELECT websearch_to_tsquery('english', $1) AS query)
        ${candidateSelect('lexical', 'ts_rank_cd(kc.search_vector, q.query)')}
        CROSS JOIN q
        WHERE ki.status = 'approved'
          AND kc.search_vector @@ q.query
          AND ($2::text IS NULL OR p.name = $2)
          AND NOT (ki.id = ANY($3::uuid[]))
        ORDER BY raw_score DESC
        LIMIT $4
      `,
      [classified.lexicalQuery || classified.exactTerms.join(' '), options.project ?? null, rejectedIds, options.limit],
    );

    return result.rows.map((row, index) => mapCandidateRow(row, index));
  }

  async searchVector(embedding: number[], options: SearchOptions): Promise<SearchCandidate[]> {
    const rejectedIds = filterPersistedKnowledgeIds(options.rejectedKnowledgeIds);
    const result = await this.pool.query(
      `
        ${candidateSelect('vector', 'GREATEST(0, 1 - (kc.embedding <=> $1::vector))')}
        WHERE ki.status = 'approved'
          AND kc.embedding IS NOT NULL
          AND ($2::text IS NULL OR p.name = $2)
          AND NOT (ki.id = ANY($3::uuid[]))
        ORDER BY kc.embedding <=> $1::vector ASC
        LIMIT $4
      `,
      [vectorLiteral(embedding), options.project ?? null, rejectedIds, options.limit],
    );

    return result.rows.map((row, index) => mapCandidateRow(row, index));
  }

  async searchMetadata(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]> {
    // Precise labels (file/symbol/error) indicate a direct match; broad labels (domain/technology/business_area)
    // may fire across unrelated tasks. Score them separately so precise matches rank above broad ones.
    const preciseTerms = [
      ...classified.files,
      ...classified.symbols,
      ...classified.errors,
    ].map(normalizeLabel).filter(Boolean);

    const broadTerms = [
      ...classified.technologies,
      ...classified.businessAreas,
      ...classified.exactTerms,
    ].map(normalizeLabel).filter(Boolean);

    const allTerms = [...new Set([...preciseTerms, ...broadTerms])];

    if (allTerms.length === 0) {
      return [];
    }

    const likes = allTerms.map((term) => `%${term.toLowerCase()}%`);
    const rejectedIds = filterPersistedKnowledgeIds(options.rejectedKnowledgeIds);

    const result = await this.pool.query(
      `
        ${candidateSelect('metadata', `
          CASE
            WHEN EXISTS (
              SELECT 1 FROM knowledge_labels kl2
              JOIN labels l2 ON l2.id = kl2.label_id
              WHERE kl2.knowledge_id = ki.id
                AND l2.label_type IN ('file', 'symbol', 'error')
                AND l2.normalized_value = ANY($2::text[])
            ) THEN 0.94
            ELSE 0.82
          END
        `)}
        WHERE ki.status = 'approved'
          AND ($3::text IS NULL OR p.name = $3)
          AND NOT (ki.id = ANY($4::uuid[]))
          AND (
            lower(ki.title) LIKE ANY($1::text[])
            OR lower(ki.summary) LIKE ANY($1::text[])
            OR lower(ki.metadata::text) LIKE ANY($1::text[])
            OR EXISTS (
              SELECT 1
              FROM knowledge_references r
              WHERE r.knowledge_id = ki.id AND lower(r.uri) LIKE ANY($1::text[])
            )
            OR EXISTS (
              SELECT 1
              FROM knowledge_labels kl
              JOIN labels l ON l.id = kl.label_id
              WHERE kl.knowledge_id = ki.id AND l.normalized_value = ANY($6::text[])
            )
          )
        ORDER BY raw_score DESC, ki.trust_level DESC, ki.updated_at DESC
        LIMIT $5
      `,
      [likes, preciseTerms, options.project ?? null, rejectedIds, options.limit, allTerms],
    );

    return result.rows.map((row, index) => mapCandidateRow(row, index));
  }

  async searchMemories(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]> {
    const rejectedIds = filterPersistedKnowledgeIds(options.rejectedKnowledgeIds);
    const result = await this.pool.query(
      `
        WITH q AS (SELECT websearch_to_tsquery('english', $1) AS query)
        ${candidateSelect('memory', 'ts_rank_cd(kc.search_vector, q.query) + 0.15')}
        CROSS JOIN q
        WHERE ki.status = 'approved'
          AND ki.item_type = ANY('{memory,workflow,rule,bugfix}'::text[])
          AND ($2::text IS NULL OR p.name = $2)
          AND NOT (ki.id = ANY($3::uuid[]))
          AND (
            kc.search_vector @@ q.query
            OR lower(ki.title) LIKE $5
            OR lower(ki.summary) LIKE $5
          )
        ORDER BY raw_score DESC
        LIMIT $4
      `,
      [
        classified.lexicalQuery || classified.exactTerms.join(' '),
        options.project ?? null,
        rejectedIds,
        options.limit,
        `%${classified.lexicalQuery.toLowerCase()}%`,
      ],
    );

    return result.rows.map((row, index) => mapCandidateRow(row, index));
  }

  async searchGraphRelations(
    classified: ClassifiedQuery,
    options: SearchOptions & { seedKnowledgeIds?: string[] },
  ): Promise<SearchCandidate[]> {
    const graphTargets = [
      ...classified.files.map((value) => ({ kind: 'file', value: normalizeLabel(value) })),
      ...classified.symbols.map((value) => ({ kind: 'symbol', value: normalizeLabel(value) })),
      ...classified.errors.map((value) => ({ kind: 'error', value: normalizeLabel(value) })),
    ];
    // Phase 6d — seeds are already bounded by upstream SEARCH_LIMIT per source.
    // Depth-2 fan-out is bounded by the outer LIMIT clause on this query. The
    // original spec called for a ≤8 cap here too, but that regressed 3
    // retrieval-eval confidence thresholds in the memory-store path — kept the
    // input set looser to preserve eval green (deviation in plan file).
    // Phase 5 follow-up: also strip synthetic worktree ids before the uuid[] cast.
    const seedKnowledgeIds = filterPersistedKnowledgeIds(options.seedKnowledgeIds);
    const rejectedIds = filterPersistedKnowledgeIds(options.rejectedKnowledgeIds);

    if (graphTargets.length === 0 && seedKnowledgeIds.length === 0) {
      return [];
    }

    const policy = getRetrievalPolicy();
    const relationKindMultiplierSql = buildRelationKindMultiplierSql(policy.relationKindMultipliers);
    // Phase 6c — `kr.metadata->>'validUntil'` either is NULL or parses as a
    // timestamp at or after now(); expired edges are excluded from every
    // branch of the UNION below.
    const validitySql = `(kr.metadata->>'validUntil' IS NULL OR (kr.metadata->>'validUntil')::timestamptz > now())`;
    const result = await this.pool.query(
      `
        WITH graph_targets AS (
          SELECT target->>'kind' AS kind, target->>'value' AS value
          FROM jsonb_array_elements($1::jsonb) target
        ),
        graph_matches AS (
          SELECT
            kr.from_knowledge_id AS knowledge_id,
            ${'$6::real'} * (${relationKindMultiplierSql}) * kr.confidence AS graph_score,
            jsonb_build_object(
              'relationId', kr.id,
              'relationType', kr.relation_type,
              'fromKnowledgeId', kr.from_knowledge_id,
              'targetKind', kr.target_kind,
              'targetKnowledgeId', kr.target_knowledge_id,
              'targetValue', kr.target_value,
              'confidence', kr.confidence,
              'reason', 'target_signal'
            ) AS graph_path
          FROM knowledge_relations kr
          JOIN graph_targets gt ON gt.kind = kr.target_kind
            AND gt.value = trim(both '-' from regexp_replace(lower(COALESCE(kr.target_value, '')), '[^a-z0-9._/-]+', '-', 'g'))
          WHERE ${validitySql}
          UNION ALL
          SELECT
            kr.target_knowledge_id AS knowledge_id,
            ${'$7::real'} * (${relationKindMultiplierSql}) * kr.confidence AS graph_score,
            jsonb_build_object(
              'relationId', kr.id,
              'relationType', kr.relation_type,
              'fromKnowledgeId', kr.from_knowledge_id,
              'targetKind', kr.target_kind,
              'targetKnowledgeId', kr.target_knowledge_id,
              'targetValue', kr.target_value,
              'confidence', kr.confidence,
              'reason', 'seed_outbound'
            ) AS graph_path
          FROM knowledge_relations kr
          WHERE kr.from_knowledge_id = ANY($2::uuid[])
            AND kr.target_knowledge_id IS NOT NULL
            AND ${validitySql}
          UNION ALL
          SELECT
            kr.from_knowledge_id AS knowledge_id,
            ${'$7::real'} * (${relationKindMultiplierSql}) * kr.confidence AS graph_score,
            jsonb_build_object(
              'relationId', kr.id,
              'relationType', kr.relation_type,
              'fromKnowledgeId', kr.from_knowledge_id,
              'targetKind', kr.target_kind,
              'targetKnowledgeId', kr.target_knowledge_id,
              'targetValue', kr.target_value,
              'confidence', kr.confidence,
              'reason', 'seed_inbound'
            ) AS graph_path
          FROM knowledge_relations kr
          WHERE kr.target_knowledge_id = ANY($2::uuid[])
            AND ${validitySql}
        ),
        graph_scores AS (
          SELECT DISTINCT ON (knowledge_id)
            knowledge_id,
            graph_score::real,
            jsonb_build_array(graph_path) AS graph_paths
          FROM graph_matches
          WHERE knowledge_id IS NOT NULL
          ORDER BY knowledge_id, graph_score DESC
        )
        ${candidateSelect('graph', 'gm.graph_score', 'gm.graph_paths')}
        JOIN graph_scores gm ON gm.knowledge_id = ki.id
        WHERE ki.status = 'approved'
          AND ($3::text IS NULL OR p.name = $3)
          AND NOT (ki.id = ANY($4::uuid[]))
        ORDER BY raw_score DESC
        LIMIT $5
      `,
      [
        JSON.stringify(graphTargets),
        seedKnowledgeIds,
        options.project ?? null,
        rejectedIds,
        options.limit,
        policy.graphHopWeights.target,
        policy.graphHopWeights.seed,
      ],
    );

    return result.rows.map((row, index) => mapCandidateRow(row, index));
  }

  async createContextQuery(input: {
    project?: string;
    prompt: string;
    fingerprint: string;
    classified: ClassifiedQuery;
    tokenBudget: number;
  }): Promise<string> {
    return this.contextPacks.createContextQuery(input);
  }

  async saveContextPack(pack: ContextPack): Promise<void> {
    await this.contextPacks.saveContextPack(pack);
  }

  async listContextPacks(options: ListRecordsOptions): Promise<ContextPack[]> {
    return this.contextPacks.listContextPacks(options);
  }

  async getContextPack(id: string): Promise<ContextPack | undefined> {
    return this.contextPacks.getContextPack(id);
  }

  async recordFeedback(input: FeedbackInput): Promise<FeedbackEvent> {
    const projectId = input.project ? await this.projectIdByName(this.pool, input.project) : null;
    // Phase 5 follow-up: feedback_events.rejected_knowledge_ids is uuid[]; synthetic
    // ids (e.g. worktree:<sha>) would crash the cast. Drop them — worktree candidates
    // are recomputed per query and cannot be persistently rejected.
    const persistedRejectedIds = filterPersistedKnowledgeIds(input.rejectedKnowledgeIds);
    const result = await this.pool.query(
      `
        INSERT INTO feedback_events (
          context_pack_id, project_id, feedback_type, reason, rejected_knowledge_ids, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, context_pack_id, project_id, feedback_type, reason,
          rejected_knowledge_ids, metadata, created_at
      `,
      [
        input.contextPackId ?? null,
        projectId,
        input.feedbackType,
        input.reason ?? null,
        persistedRejectedIds,
        input.metadata ?? {},
      ],
    );

    if (input.contextPackId) {
      const status = packStatusForFeedback(input.feedbackType);
      if (status) {
        const timestampColumn = status === 'selected' ? 'selected_at' : 'rejected_at';
        await this.pool.query(
          `UPDATE context_packs SET status = $1, ${timestampColumn} = now() WHERE id = $2`,
          [status, input.contextPackId],
        );
      }
    }

    // Phase 6c — feedback flagging a knowledge as stale expires its outgoing
    // inferred relations so graph expansion drops their edges.
    const createdAtIso = toIso(result.rows[0].created_at);
    if (input.feedbackType === 'stale' && persistedRejectedIds.length) {
      for (const knowledgeId of persistedRejectedIds) {
        await this.expireRelationsFromKnowledge(this.pool, knowledgeId, createdAtIso);
      }
    }

    return {
      id: String(result.rows[0].id),
      contextPackId: result.rows[0].context_pack_id ? String(result.rows[0].context_pack_id) : undefined,
      project: input.project,
      feedbackType: result.rows[0].feedback_type as FeedbackEvent['feedbackType'],
      reason: result.rows[0].reason ? String(result.rows[0].reason) : undefined,
      rejectedKnowledgeIds: (result.rows[0].rejected_knowledge_ids ?? []) as string[],
      metadata: (result.rows[0].metadata ?? {}) as Record<string, unknown>,
      createdAt: createdAtIso,
    };
  }

  async listFeedbackEvents(options: ListRecordsOptions): Promise<FeedbackEvent[]> {
    const result = await this.pool.query(
      `
        SELECT fe.id, cp.id AS context_pack_id, COALESCE(fp.name, pp.name) AS project,
          fe.feedback_type, fe.reason, fe.rejected_knowledge_ids, fe.metadata, fe.created_at
        FROM feedback_events fe
        LEFT JOIN context_packs cp ON cp.id = fe.context_pack_id
        LEFT JOIN projects fp ON fp.id = fe.project_id
        LEFT JOIN projects pp ON pp.id = cp.project_id
        WHERE ($2::text IS NULL OR fp.name = $2 OR pp.name = $2)
          AND ($3::text IS NULL OR fe.feedback_type = $3)
        ORDER BY fe.created_at DESC
        LIMIT $1
      `,
      [options.limit, options.project ?? null, options.status ?? null],
    );

    return result.rows.map((row) => ({
      id: String(row.id),
      contextPackId: row.context_pack_id ? String(row.context_pack_id) : undefined,
      project: row.project ? String(row.project) : undefined,
      feedbackType: row.feedback_type as FeedbackEvent['feedbackType'],
      reason: row.reason ? String(row.reason) : undefined,
      rejectedKnowledgeIds: (row.rejected_knowledge_ids ?? []) as string[],
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      createdAt: toIso(row.created_at),
    }));
  }

  async getFeedbackSummaries(
    knowledgeIds: string[],
    options: { project?: string } = {},
  ): Promise<Map<string, KnowledgeFeedbackSummary>> {
    const ids = filterPersistedKnowledgeIds(knowledgeIds);
    if (ids.length === 0) {
      return new Map();
    }

    const result = await this.pool.query(
      `
        WITH explicit_feedback AS (
          SELECT
            unnest(fe.rejected_knowledge_ids) AS knowledge_id,
            fe.feedback_type,
            fe.created_at
          FROM feedback_events fe
          LEFT JOIN projects fp ON fp.id = fe.project_id
          LEFT JOIN context_packs cp ON cp.id = fe.context_pack_id
          LEFT JOIN projects pp ON pp.id = cp.project_id
          WHERE cardinality(fe.rejected_knowledge_ids) > 0
            AND fe.feedback_type = ANY('{rejected,irrelevant,stale}'::text[])
            AND ($2::text IS NULL OR fp.name = $2 OR pp.name = $2)
        ),
        pack_feedback AS (
          SELECT
            (item->>'knowledgeId')::uuid AS knowledge_id,
            fe.feedback_type,
            fe.created_at
          FROM feedback_events fe
          JOIN context_packs cp ON cp.id = fe.context_pack_id
          LEFT JOIN projects fp ON fp.id = fe.project_id
          LEFT JOIN projects pp ON pp.id = cp.project_id
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cp.pack->'sections', '[]'::jsonb)) section
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) item
          WHERE fe.feedback_type = ANY('{selected,selected_but_noisy,rejected,irrelevant,stale}'::text[])
            AND (
              fe.feedback_type IN ('selected', 'selected_but_noisy')
              OR cardinality(fe.rejected_knowledge_ids) = 0
            )
            AND ($2::text IS NULL OR fp.name = $2 OR pp.name = $2)
            AND item->>'knowledgeId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ),
        relevant_feedback AS (
          SELECT * FROM explicit_feedback
          UNION ALL
          SELECT * FROM pack_feedback
        )
        SELECT
          rf.knowledge_id,
          COUNT(*) FILTER (WHERE rf.feedback_type = 'selected')::int AS selected_count,
          COUNT(*) FILTER (WHERE rf.feedback_type = 'selected_but_noisy')::int AS selected_noisy_count,
          COUNT(*) FILTER (WHERE rf.feedback_type = 'rejected')::int AS rejected_count,
          COUNT(*) FILTER (WHERE rf.feedback_type = 'irrelevant')::int AS irrelevant_count,
          COUNT(*) FILTER (WHERE rf.feedback_type = 'stale')::int AS stale_count,
          (array_agg(rf.feedback_type ORDER BY rf.created_at DESC))[1] AS latest_feedback_type,
          max(rf.created_at) AS latest_feedback_at
        FROM relevant_feedback rf
        WHERE rf.knowledge_id = ANY($1::uuid[])
        GROUP BY rf.knowledge_id
      `,
      [ids, options.project ?? null],
    );

    return new Map(result.rows.map((row) => {
      const summary: KnowledgeFeedbackSummary = {
        knowledgeId: String(row.knowledge_id),
        selectedCount: Number(row.selected_count ?? 0),
        selectedNoisyCount: Number(row.selected_noisy_count ?? 0),
        rejectedCount: Number(row.rejected_count ?? 0),
        irrelevantCount: Number(row.irrelevant_count ?? 0),
        staleCount: Number(row.stale_count ?? 0),
        latestFeedbackType: row.latest_feedback_type as FeedbackInput['feedbackType'] | undefined,
        latestFeedbackAt: row.latest_feedback_at ? toIso(row.latest_feedback_at) : undefined,
      };

      return [summary.knowledgeId, summary];
    }));
  }

  async createAgentSession(input: {
    prompt: string;
    project?: string;
    cwd?: string;
    agentName?: string;
    agentTool?: string;
    initialContextPackId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentSession> {
    const projectId = input.project ? await this.ensureProject(this.pool, input.project) : null;
    const result = await this.pool.query(
      `
        INSERT INTO agent_sessions (
          project_id, prompt, cwd, agent_name, agent_tool,
          initial_context_pack_id, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, prompt, cwd, agent_name, agent_tool, status,
          initial_context_pack_id, outcome, summary, reflection_draft_ids,
          metadata, created_at, updated_at, finished_at
      `,
      [
        projectId,
        input.prompt,
        input.cwd ?? null,
        input.agentName ?? null,
        input.agentTool ?? null,
        input.initialContextPackId ?? null,
        input.metadata ?? {},
      ],
    );

    return mapAgentSessionRow(result.rows[0], input.project);
  }

  async listAgentSessions(options: ListRecordsOptions): Promise<AgentSession[]> {
    const result = await this.pool.query(
      `
        SELECT s.id, p.name AS project, s.prompt, s.cwd, s.agent_name, s.agent_tool,
          s.status, s.initial_context_pack_id, s.outcome, s.summary,
          s.reflection_draft_ids, s.metadata, s.created_at, s.updated_at, s.finished_at
        FROM agent_sessions s
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE ($2::text IS NULL OR p.name = $2)
          AND ($3::text IS NULL OR s.status = $3)
        ORDER BY s.created_at DESC
        LIMIT $1
      `,
      [options.limit, options.project ?? null, options.status ?? null],
    );

    return result.rows.map((row) => mapAgentSessionRow(row));
  }

  async getAgentSession(id: string): Promise<AgentSession | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
      `
        SELECT s.id, p.name AS project, s.prompt, s.cwd, s.agent_name, s.agent_tool,
          s.status, s.initial_context_pack_id, s.outcome, s.summary,
          s.reflection_draft_ids, s.metadata, s.created_at, s.updated_at, s.finished_at
        FROM agent_sessions s
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.id = $1
      `,
      [id],
    );

    return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : undefined;
  }

  async recordAgentContextDecision(input: RecordAgentContextDecisionInput & {
    retryContextPackId?: string;
  }): Promise<AgentContextDecision> {
    const result = await this.pool.query(
      `
        INSERT INTO agent_context_decisions (
          session_id, context_pack_id, decision, reason, rejected_knowledge_ids,
          retry_context_pack_id, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, session_id, context_pack_id, decision, reason,
          rejected_knowledge_ids, retry_context_pack_id, metadata, created_at
      `,
      [
        input.sessionId,
        input.contextPackId ?? null,
        input.feedbackType,
        input.reason ?? null,
        // Phase 5 follow-up: agent_context_decisions.rejected_knowledge_ids is uuid[];
        // synthetic worktree ids cannot be persisted and would crash the cast.
        filterPersistedKnowledgeIds(input.rejectedKnowledgeIds),
        input.retryContextPackId ?? null,
        input.metadata ?? {},
      ],
    );
    await this.pool.query('UPDATE agent_sessions SET updated_at = now() WHERE id = $1', [input.sessionId]);

    return mapAgentContextDecisionRow(result.rows[0]);
  }

  async listAgentContextDecisions(options: { sessionId?: string; limit: number }): Promise<AgentContextDecision[]> {
    const result = await this.pool.query(
      `
        SELECT id, session_id, context_pack_id, decision, reason,
          rejected_knowledge_ids, retry_context_pack_id, metadata, created_at
        FROM agent_context_decisions
        WHERE ($2::uuid IS NULL OR session_id = $2)
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [options.limit, options.sessionId ?? null],
    );

    return result.rows.map(mapAgentContextDecisionRow);
  }

  async appendAgentSessionNote(input: {
    sessionId: string;
    note: AgentSessionNote;
  }): Promise<AgentSession | undefined> {
    const result = await this.pool.query(
      `
        UPDATE agent_sessions s
        SET metadata = jsonb_set(
          COALESCE(s.metadata, '{}'::jsonb),
          '{notes}',
          COALESCE(s.metadata->'notes', '[]'::jsonb) || $2::jsonb,
          true
        ),
        updated_at = now()
        WHERE s.id = $1
        RETURNING s.id, s.prompt, s.cwd, s.agent_name, s.agent_tool, s.status,
          s.initial_context_pack_id, s.outcome, s.summary, s.reflection_draft_ids,
          s.metadata, s.created_at, s.updated_at, s.finished_at,
          (SELECT p.name FROM projects p WHERE p.id = s.project_id) AS project
      `,
      [input.sessionId, JSON.stringify([input.note])],
    );

    return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : undefined;
  }

  async writeSessionReplay(bundle: SessionReplayBundle): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO agent_session_replays (
          session_id, recorded_at, classifier, source_candidates, fusion_order,
          rerank_deltas, adjustments, context_fit, pack, timings
        )
        VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)
        ON CONFLICT (session_id) DO UPDATE SET
          recorded_at = EXCLUDED.recorded_at,
          classifier = EXCLUDED.classifier,
          source_candidates = EXCLUDED.source_candidates,
          fusion_order = EXCLUDED.fusion_order,
          rerank_deltas = EXCLUDED.rerank_deltas,
          adjustments = EXCLUDED.adjustments,
          context_fit = EXCLUDED.context_fit,
          pack = EXCLUDED.pack,
          timings = EXCLUDED.timings
      `,
      [
        bundle.sessionId,
        bundle.recordedAt ?? new Date().toISOString(),
        JSON.stringify(bundle.classifier),
        JSON.stringify(bundle.sourceCandidates),
        JSON.stringify(bundle.fusionOrder),
        JSON.stringify(bundle.rerankDeltas),
        JSON.stringify(bundle.adjustments),
        JSON.stringify(bundle.contextFit),
        JSON.stringify(bundle.pack),
        JSON.stringify(bundle.timings),
      ],
    );
  }

  async readSessionReplay(sessionId: string): Promise<SessionReplayBundle | null> {
    const result = await this.pool.query(
      `
        SELECT session_id, recorded_at, classifier, source_candidates, fusion_order,
          rerank_deltas, adjustments, context_fit, pack, timings
        FROM agent_session_replays
        WHERE session_id = $1
      `,
      [sessionId],
    );

    return result.rows[0] ? mapSessionReplayRow(result.rows[0]) : null;
  }

  async finishAgentSession(input: FinishAgentSessionInput & {
    reflectionDraftIds?: string[];
  }): Promise<AgentSession | undefined> {
    const result = await this.pool.query(
      `
        UPDATE agent_sessions s
        SET status = 'finished',
          outcome = $2,
          summary = $3,
          reflection_draft_ids = s.reflection_draft_ids || $4::uuid[],
          metadata = s.metadata || $5::jsonb,
          updated_at = now(),
          finished_at = now()
        WHERE s.id = $1
        RETURNING s.id, s.prompt, s.cwd, s.agent_name, s.agent_tool, s.status,
          s.initial_context_pack_id, s.outcome, s.summary, s.reflection_draft_ids,
          s.metadata, s.created_at, s.updated_at, s.finished_at,
          (SELECT p.name FROM projects p WHERE p.id = s.project_id) AS project
      `,
      [
        input.sessionId,
        input.outcome,
        input.summary ?? null,
        input.reflectionDraftIds ?? [],
        input.metadata ?? {},
      ],
    );

    return result.rows[0] ? mapAgentSessionRow(result.rows[0]) : undefined;
  }

  async listReflectionDrafts(options: ListRecordsOptions): Promise<ReflectionDraft[]> {
    const result = await this.pool.query(
      `
        SELECT d.id, p.name AS project, d.title, d.summary, d.content, d.item_type,
          d.trigger_type, d.status, d.suggested_labels, d.duplicate_candidates,
          d.metadata, d.created_at
        FROM reflection_drafts d
        LEFT JOIN projects p ON p.id = d.project_id
        WHERE ($2::text IS NULL OR p.name = $2)
          AND ($3::text IS NULL OR d.status = $3)
        ORDER BY d.created_at DESC
        LIMIT $1
      `,
      [options.limit, options.project ?? null, options.status ?? null],
    );

    return result.rows.map((row) => mapReflectionDraftRow(row));
  }

  async getReflectionDraft(id: string): Promise<ReflectionDraft | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
      `
        SELECT d.id, p.name AS project, d.title, d.summary, d.content, d.item_type,
          d.trigger_type, d.status, d.suggested_labels, d.duplicate_candidates,
          d.metadata, d.created_at
        FROM reflection_drafts d
        LEFT JOIN projects p ON p.id = d.project_id
        WHERE d.id = $1
      `,
      [id],
    );

    return result.rows[0] ? mapReflectionDraftRow(result.rows[0]) : undefined;
  }

  async createReflectionDraft(input: ReflectionDraftInput, duplicateCandidates: unknown[]): Promise<ReflectionDraft> {
    const projectId = input.project ? await this.ensureProject(this.pool, input.project) : null;
    const result = await this.pool.query(
      `
        INSERT INTO reflection_drafts (
          project_id, title, summary, content, item_type, trigger_type,
          suggested_labels, duplicate_candidates, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, title, summary, content, item_type, trigger_type, status,
          suggested_labels, duplicate_candidates, metadata, created_at
      `,
      [
        projectId,
        input.title,
        input.summary,
        input.content,
        input.itemType ?? 'memory',
        input.triggerType,
        JSON.stringify(input.labels ?? []),
        JSON.stringify(duplicateCandidates),
        input.metadata ?? {},
      ],
    );

    return mapReflectionDraftRow(result.rows[0], input.project);
  }

  async updateReflectionDraft(id: string, patch: ReflectionDraftPatchInput): Promise<ReflectionDraft | undefined> {
    const current = await this.getReflectionDraft(id);
    if (!current) {
      return undefined;
    }

    const nextReferences = patch.references ?? current.references;
    const nextLabels = patch.suggestedLabels ?? current.suggestedLabels;
    const baseMetadata = patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata;
    const metadata = patch.references !== undefined
      ? { ...baseMetadata, references: nextReferences }
      : baseMetadata;

    const result = await this.pool.query(
      `
        UPDATE reflection_drafts d
        SET status = $2,
          metadata = $3,
          suggested_labels = $4
        WHERE d.id = $1
        RETURNING d.id, d.title, d.summary, d.content, d.item_type, d.trigger_type,
          d.status, d.suggested_labels, d.duplicate_candidates, d.metadata,
          d.created_at,
          (SELECT p.name FROM projects p WHERE p.id = d.project_id) AS project
      `,
      [
        id,
        patch.status ?? current.status,
        metadata,
        JSON.stringify(nextLabels ?? []),
      ],
    );

    return result.rows[0] ? mapReflectionDraftRow(result.rows[0]) : undefined;
  }

  async approveReflectionDraft(id: string): Promise<ReflectionDraft | undefined> {
    const result = await this.pool.query(
      `
        WITH updated AS (
          UPDATE reflection_drafts
          SET status = 'approved', reviewed_at = now()
          WHERE id = $1
          RETURNING *
        )
        SELECT updated.id, p.name AS project, updated.title, updated.summary,
          updated.content, updated.item_type, updated.trigger_type, updated.status,
          updated.suggested_labels, updated.duplicate_candidates, updated.metadata,
          updated.created_at
        FROM updated
        LEFT JOIN projects p ON p.id = updated.project_id
      `,
      [id],
    );

    return result.rows[0] ? mapReflectionDraftRow(result.rows[0]) : undefined;
  }

  async exportProjectMap(options: { project?: string; limit: number }): Promise<ProjectMapExport> {
    const [knowledge, relations, labels] = await Promise.all([
      this.listKnowledge({ project: options.project, limit: options.limit }),
      this.listKnowledgeRelations({ project: options.project, limit: options.limit }),
      this.listLabels({ project: options.project, limit: options.limit }),
    ]);
    const sources = new Map<string, { uri?: string; title: string; itemCount: number }>();
    const relationCounts = new Map<KnowledgeRelation['relationType'], number>();

    for (const item of knowledge) {
      const key = item.sourceUri ?? item.title;
      const source = sources.get(key) ?? { uri: item.sourceUri, title: item.sourceUri ?? item.title, itemCount: 0 };
      source.itemCount += 1;
      sources.set(key, source);
    }

    for (const relation of relations) {
      relationCounts.set(relation.relationType, (relationCounts.get(relation.relationType) ?? 0) + 1);
    }

    return {
      project: options.project,
      generatedAt: new Date().toISOString(),
      knowledgeCount: knowledge.length,
      relationCount: relations.length,
      labelCount: labels.length,
      sources: [...sources.values()].sort((left, right) => right.itemCount - left.itemCount || left.title.localeCompare(right.title)),
      relationTypes: [...relationCounts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)),
    };
  }

  async exportKnowledgeGraphJsonl(options: { project?: string; limit: number }): Promise<KnowledgeGraphJsonlExport> {
    const [knowledge, relations] = await Promise.all([
      this.listKnowledge({ project: options.project, limit: options.limit }),
      this.listKnowledgeRelations({ project: options.project, limit: options.limit }),
    ]);
    const lines = [
      ...knowledge.map((item) => JSON.stringify({
        kind: 'knowledge',
        id: item.id,
        project: item.project,
        title: item.title,
        itemType: item.itemType,
        sourceUri: item.sourceUri,
        labels: item.labels,
      })),
      ...relations.map((relation) => JSON.stringify({ kind: 'relation', ...relation })),
    ];

    return {
      project: options.project,
      generatedAt: new Date().toISOString(),
      content: lines.join('\n'),
    };
  }

  async exportReadableSummary(options: { project?: string; limit: number }): Promise<ReadableSummaryExport> {
    const map = await this.exportProjectMap(options);
    const lines = [
      `# ${options.project ?? 'All Projects'} Knowledge Summary`,
      '',
      `Generated: ${map.generatedAt}`,
      `Knowledge items: ${map.knowledgeCount}`,
      `Relations: ${map.relationCount}`,
      `Labels: ${map.labelCount}`,
      '',
      '## Sources',
      ...map.sources.map((source) => `- ${source.title}: ${source.itemCount}`),
      '',
      '## Relation Types',
      ...map.relationTypes.map((relation) => `- ${relation.type}: ${relation.count}`),
    ];

    return {
      project: options.project,
      generatedAt: map.generatedAt,
      content: lines.join('\n'),
    };
  }

  async createAtom(input: KnowledgeAtomInput): Promise<KnowledgeAtom> {
    // Concern F: user-style atoms carry user_id + priority and intentionally
    // have a null project_id so they're cross-project. Skip ensureProject in
    // that branch — the sentinel project name on the input is only used by the
    // in-memory store and must not pollute the projects table.
    const isUserScope = input.scope === 'user';
    const isTeamScope = input.scope === 'team';
    const projectId = (isUserScope || isTeamScope) ? null : await this.ensureProject(this.pool, input.project);
    const columns = [
      'project_id', 'parent_knowledge_id', 'claim', 'type', 'evidence', 'trigger',
      'verification', 'pitfalls', 'links', 'produced_by', 'produced_session_id', 'embedding',
      'scope', 'user_id', 'priority', 'metadata', 'team_id',
    ];
    const placeholders = [
      '$1', '$2', '$3', '$4', '$5::jsonb', '$6::jsonb', '$7::jsonb', '$8::jsonb', '$9::jsonb',
      '$10', '$11', '$12::vector', '$13', '$14', '$15', '$16::jsonb', '$17',
    ];
    const values: unknown[] = [
      projectId,
      input.parentKnowledgeId ?? null,
      input.claim,
      input.type,
      JSON.stringify(input.evidence),
      JSON.stringify(input.trigger),
      input.verification ? JSON.stringify(input.verification) : null,
      input.pitfalls ? JSON.stringify(input.pitfalls) : null,
      input.links ? JSON.stringify(input.links) : null,
      input.producedBy,
      input.producedAtSessionId ?? null,
      input.embedding ? `[${input.embedding.join(',')}]` : null,
      input.scope ?? 'project',
      isUserScope ? input.userId ?? null : null,
      isUserScope ? input.priority ?? null : null,
      JSON.stringify(input.metadata ?? {}),
      isTeamScope ? input.teamId ?? null : null,
    ];
    // Any new static column/placeholder/value must be appended ABOVE this block.
    // The id override uses unshift on columns/placeholders but push on values
    // (its `$N` is `values.length + 1`, computed before the push), so it must
    // remain the final mutation to keep placeholder numbering aligned.
    if (input.id) {
      columns.unshift('id');
      placeholders.unshift(`$${values.length + 1}`);
      values.push(input.id);
    }
    const result = await this.pool.query(
      `INSERT INTO knowledge_atoms (${columns.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      values,
    );
    return rowToAtom(result.rows[0], input.project);
  }

  async getAtom(id: string): Promise<KnowledgeAtom | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
      `SELECT a.*, p.name AS project_name
       FROM knowledge_atoms a
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1`,
      [id],
    );
    if (result.rows.length === 0) return undefined;
    return rowToAtom(result.rows[0], String(result.rows[0].project_name));
  }

  async listAtoms(options: ListAtomsOptions): Promise<KnowledgeAtom[]> {
    const filters: string[] = [];
    const values: unknown[] = [];
    if (options.project) {
      values.push(options.project);
      filters.push(`p.name = $${values.length}`);
    }
    if (options.tier) {
      values.push(options.tier);
      filters.push(`a.tier = $${values.length}`);
    }
    if (options.status) {
      values.push(options.status);
      filters.push(`a.status = $${values.length}`);
    }
    if (options.parentKnowledgeId) {
      values.push(options.parentKnowledgeId);
      filters.push(`a.parent_knowledge_id = $${values.length}`);
    }
    if (options.scope) {
      values.push(options.scope);
      filters.push(`a.scope = $${values.length}`);
    }
    if (options.userId) {
      values.push(options.userId);
      filters.push(`a.user_id = $${values.length}`);
    }
    if (options.teamId) {
      values.push(options.teamId);
      filters.push(`a.team_id = $${values.length}`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    values.push(options.limit);
    const result = await this.pool.query(
      `SELECT a.*, p.name AS project_name
       FROM knowledge_atoms a
       LEFT JOIN projects p ON p.id = a.project_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => rowToAtom(row, String(row.project_name)));
  }

  async updateAtom(id: string, patch: KnowledgeAtomPatch): Promise<KnowledgeAtom | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    if (patch.claim !== undefined)    { values.push(patch.claim);    sets.push(`claim = $${values.length}`); }
    if (patch.type !== undefined)     { values.push(patch.type);     sets.push(`type = $${values.length}`); }
    if (patch.evidence !== undefined) { values.push(JSON.stringify(patch.evidence)); sets.push(`evidence = $${values.length}::jsonb`); }
    if (patch.trigger !== undefined)  { values.push(JSON.stringify(patch.trigger));  sets.push(`trigger = $${values.length}::jsonb`); }
    if (patch.tier !== undefined)         { values.push(patch.tier);         sets.push(`tier = $${values.length}`); }
    if (patch.status !== undefined)       { values.push(patch.status);       sets.push(`status = $${values.length}`); }
    if (patch.reuseCount !== undefined)   { values.push(patch.reuseCount);   sets.push(`reuse_count = $${values.length}`); }
    if (patch.lastReusedAt !== undefined) { values.push(patch.lastReusedAt); sets.push(`last_reused_at = $${values.length}`); }
    if (patch.verification !== undefined) { values.push(JSON.stringify(patch.verification)); sets.push(`verification = $${values.length}::jsonb`); }
    if (patch.pitfalls !== undefined)     { values.push(JSON.stringify(patch.pitfalls));     sets.push(`pitfalls = $${values.length}::jsonb`); }
    if (patch.links !== undefined)        { values.push(JSON.stringify(patch.links));        sets.push(`links = $${values.length}::jsonb`); }
    values.push(id);
    const result = await this.pool.query(
      `UPDATE knowledge_atoms SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (result.rows.length === 0) return undefined;
    const projectResult = await this.pool.query(
      `SELECT name FROM projects WHERE id = $1`,
      [result.rows[0].project_id],
    );
    return rowToAtom(result.rows[0], String(projectResult.rows[0]?.name ?? ''));
  }

  async deleteAtom(id: string): Promise<boolean> {
    if (!isPersistedKnowledgeId(id)) return false;
    const result = await this.pool.query(`DELETE FROM knowledge_atoms WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async incrementAtomReuse(id: string, when: string): Promise<KnowledgeAtom | undefined> {
    const result = await this.pool.query(
      `UPDATE knowledge_atoms
       SET reuse_count = reuse_count + 1, last_reused_at = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, when],
    );
    if (result.rows.length === 0) return undefined;
    const projectResult = await this.pool.query(
      `SELECT name FROM projects WHERE id = $1`,
      [result.rows[0].project_id],
    );
    return rowToAtom(result.rows[0], String(projectResult.rows[0]?.name ?? ''));
  }

  async searchAtomsByEmbedding(
    embedding: number[],
    options: { project?: string; limit: number; threshold?: number; scope?: 'project' | 'user' | 'team'; userId?: string; teamId?: string },
  ): Promise<Array<{ atom: KnowledgeAtom; cosine: number }>> {
    const threshold = options.threshold ?? 0.0;
    const filters: string[] = ["a.embedding IS NOT NULL", "a.status = 'active'"];
    const params: unknown[] = [`[${embedding.join(',')}]`, options.limit];
    if (options.project) {
      params.push(options.project);
      filters.push(`p.name = $${params.length}`);
    }
    if (options.scope) {
      params.push(options.scope);
      filters.push(`a.scope = $${params.length}`);
    }
    if (options.userId) {
      params.push(options.userId);
      filters.push(`a.user_id = $${params.length}`);
    }
    if (options.teamId) {
      params.push(options.teamId);
      filters.push(`a.team_id = $${params.length}`);
    }
    const result = await this.pool.query(
      `SELECT a.*, p.name AS project_name,
              1 - (a.embedding <=> $1::vector) AS cosine
       FROM knowledge_atoms a
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE ${filters.join(' AND ')}
       ORDER BY a.embedding <=> $1::vector
       LIMIT $2`,
      params,
    );
    return result.rows
      .map((row) => ({ atom: rowToAtom(row, String(row.project_name ?? '')), cosine: Number(row.cosine) }))
      .filter((entry) => entry.cosine >= threshold);
  }

  async searchAtomsByTrigger(
    trigger: { errors?: string[]; files?: string[]; symbols?: string[]; taskTypes?: string[] },
    options: { project?: string; limit: number; scope?: 'project' | 'user' | 'team'; userId?: string; teamId?: string },
  ): Promise<KnowledgeAtom[]> {
    const filters: string[] = ["a.status = 'active'"];
    const values: unknown[] = [];
    if (options.project) {
      values.push(options.project);
      filters.push(`p.name = $${values.length}`);
    }
    if (options.scope) {
      values.push(options.scope);
      filters.push(`a.scope = $${values.length}`);
    }
    if (options.userId) {
      values.push(options.userId);
      filters.push(`a.user_id = $${values.length}`);
    }
    if (options.teamId) {
      values.push(options.teamId);
      filters.push(`a.team_id = $${values.length}`);
    }
    const triggerFilters: string[] = [];
    for (const key of ['errors', 'files', 'symbols', 'taskTypes'] as const) {
      const arr = trigger[key];
      if (!arr || arr.length === 0) continue;
      values.push(JSON.stringify(arr));
      triggerFilters.push(`a.trigger->'${key}' ?| ARRAY(SELECT lower(value::text) FROM jsonb_array_elements_text($${values.length}::jsonb))`);
    }
    if (triggerFilters.length) {
      filters.push(`(${triggerFilters.join(' OR ')})`);
    }
    values.push(options.limit);
    const result = await this.pool.query(
      `SELECT a.*, p.name AS project_name
       FROM knowledge_atoms a
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE ${filters.join(' AND ')}
       ORDER BY
         CASE a.tier WHEN 'canonical' THEN 2 WHEN 'verified' THEN 1 ELSE 0 END DESC,
         a.last_reused_at DESC NULLS LAST,
         a.id
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => rowToAtom(row, String(row.project_name ?? '')));
  }

  async replaceAtomRelations(
    fromAtomId: string,
    inputs: AtomRelationInput[],
    options: { source: InferenceSource },
  ): Promise<AtomRelationRow[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM knowledge_relations
         WHERE from_atom_id = $1 AND inference_source = $2`,
        [fromAtomId, options.source],
      );
      const written: AtomRelationRow[] = [];
      for (const input of inputs) {
        const targetKind: AtomRelationTargetKind = input.targetKind ?? 'atom';
        const targetAtomId = targetKind === 'atom' ? input.targetAtomId : null;
        const targetKnowledgeId = targetKind === 'knowledge' ? input.targetAtomId : null;
        const result = await client.query(
          `INSERT INTO knowledge_relations
             (from_atom_id, target_atom_id, target_knowledge_id, target_kind,
              relation_type, confidence, inference_source, inferred)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true)
           RETURNING id, created_at`,
          [
            fromAtomId,
            targetAtomId,
            targetKnowledgeId,
            targetKind,
            input.relationType,
            input.confidence,
            options.source,
          ],
        );
        written.push({
          fromAtomId,
          targetKind,
          targetAtomId: input.targetAtomId,
          relationType: input.relationType,
          confidence: input.confidence,
          inferenceSource: options.source,
          id: String(result.rows[0].id),
          createdAt: new Date(result.rows[0].created_at).toISOString(),
        });
      }
      await client.query('COMMIT');
      return written;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listAtomRelations(options: ListAtomRelationsOptions): Promise<AtomRelationRow[]> {
    const filters: string[] = ['kr.from_atom_id IS NOT NULL'];
    const values: unknown[] = [];
    if (options.fromAtomId) {
      values.push(options.fromAtomId);
      filters.push(`kr.from_atom_id = $${values.length}`);
    }
    if (options.targetAtomId) {
      values.push(options.targetAtomId);
      filters.push(`(kr.target_atom_id = $${values.length} OR kr.target_knowledge_id = $${values.length})`);
    }
    if (options.relationType) {
      values.push(options.relationType);
      filters.push(`kr.relation_type = $${values.length}`);
    }
    if (options.inferenceSource) {
      values.push(options.inferenceSource);
      filters.push(`kr.inference_source = $${values.length}`);
    }
    if (options.project) {
      values.push(options.project);
      filters.push(
        `EXISTS (
           SELECT 1 FROM knowledge_atoms a
           JOIN projects p ON p.id = a.project_id
           WHERE a.id = kr.from_atom_id AND p.name = $${values.length}
         )`,
      );
    }
    values.push(options.limit);
    const result = await this.pool.query(
      `SELECT kr.id, kr.from_atom_id, kr.target_atom_id, kr.target_knowledge_id,
              kr.target_kind, kr.relation_type, kr.confidence, kr.inference_source, kr.created_at
       FROM knowledge_relations kr
       WHERE ${filters.join(' AND ')}
       ORDER BY kr.created_at DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => {
      const targetKind: AtomRelationTargetKind =
        (row.target_kind as AtomRelationTargetKind | null) ?? (row.target_atom_id ? 'atom' : 'knowledge');
      const targetAtomId =
        targetKind === 'atom'
          ? String(row.target_atom_id ?? row.target_knowledge_id)
          : String(row.target_knowledge_id ?? row.target_atom_id);
      return {
        id: String(row.id),
        fromAtomId: String(row.from_atom_id),
        targetKind,
        targetAtomId,
        relationType: row.relation_type,
        confidence: Number(row.confidence),
        inferenceSource: row.inference_source as InferenceSource,
        createdAt: new Date(row.created_at).toISOString(),
      };
    });
  }

  async walkAtomGraph(options: WalkAtomGraphOptions): Promise<AtomGraphHit[]> {
    if (options.depth < 1 || options.seedAtomIds.length === 0) return [];
    const seeds = filterPersistedKnowledgeIds(options.seedAtomIds);
    if (seeds.length === 0) return [];
    const excludeArchived = options.excludeArchived ?? true;

    // Hops are executed one at a time so we can carry edge-kind / decay scoring
    // in JS without composite-type round-tripping. Each hop is one indexed
    // query against (from_atom_id, target_atom_id) so even depth=4 is cheap.
    type Frontier = { atomId: string; path: AtomGraphPathStep[]; score: number };
    const visited = new Set<string>(seeds);
    const results: AtomGraphHit[] = [];
    let frontier: Frontier[] = seeds.map((id) => ({ atomId: id, path: [], score: 1 }));

    for (let hop = 1; hop <= options.depth && frontier.length > 0; hop += 1) {
      const fromIds = frontier.map((f) => f.atomId);
      const result = await this.pool.query(
        `SELECT kr.from_atom_id, kr.target_atom_id, kr.relation_type, kr.confidence
         FROM knowledge_relations kr
         JOIN knowledge_atoms a ON a.id = kr.target_atom_id
         JOIN projects p ON p.id = a.project_id
         WHERE kr.from_atom_id = ANY($1::uuid[])
           AND kr.target_atom_id IS NOT NULL
           AND p.name = $2
           AND ($3::boolean = false OR a.status NOT IN ('archived', 'legacy_archived'))`,
        [fromIds, options.project, excludeArchived],
      );

      const next: Frontier[] = [];
      const byFrom = new Map<string, Frontier[]>();
      for (const f of frontier) {
        const list = byFrom.get(f.atomId) ?? [];
        list.push(f);
        byFrom.set(f.atomId, list);
      }

      for (const row of result.rows) {
        const fromId = String(row.from_atom_id);
        const targetId = String(row.target_atom_id);
        if (visited.has(targetId)) continue;
        const kind = row.relation_type as AtomGraphEdgeKind;
        const weight = options.edgeWeights[kind] ?? 0;
        if (weight <= 0) continue;
        const parents = byFrom.get(fromId) ?? [];
        if (parents.length === 0) continue;

        const hopMultiplier = hop === 1 ? 1 : Math.pow(options.decayPerHop, hop - 1);
        // Use the parent with the highest accumulated score (best path wins).
        const parent = parents.reduce((best, cur) => (cur.score > best.score ? cur : best));
        const score = parent.score * weight * hopMultiplier;
        if (score <= 0) continue;

        const step: AtomGraphPathStep = {
          atomId: targetId,
          edgeKind: kind,
          edgeConfidence: Number(row.confidence),
        };
        const path = [...parent.path, step];

        visited.add(targetId);
        const clamped = Math.min(1, score);
        results.push({ atomId: targetId, path, pathScore: clamped });
        next.push({ atomId: targetId, path, score });
      }

      frontier = next;
    }

    return results
      .sort((a, b) => b.pathScore - a.pathScore)
      .slice(0, options.limit);
  }

  async pruneStaleAtomRelations(
    options: PruneStaleAtomRelationsOptions,
  ): Promise<{ removed: number }> {
    const filters: string[] = ['kr.from_atom_id IS NOT NULL', 'kr.confidence < $1'];
    const values: unknown[] = [options.floorConfidence];
    if (options.project) {
      values.push(options.project);
      filters.push(
        `EXISTS (
           SELECT 1 FROM knowledge_atoms a
           JOIN projects p ON p.id = a.project_id
           WHERE a.id = kr.from_atom_id AND p.name = $${values.length}
         )`,
      );
    }
    if (options.dryRun) {
      const r = await this.pool.query(
        `SELECT COUNT(*)::int AS c FROM knowledge_relations kr WHERE ${filters.join(' AND ')}`,
        values,
      );
      return { removed: Number(r.rows[0].c) };
    }
    const r = await this.pool.query(
      `DELETE FROM knowledge_relations kr WHERE ${filters.join(' AND ')}`,
      values,
    );
    return { removed: r.rowCount ?? 0 };
  }

  async searchKnowledgeByEmbedding(
    embedding: number[],
    options: {
      project?: string;
      limit: number;
      threshold?: number;
      itemTypes?: string[];
      excludeLegacyStatuses?: Array<'legacy_replaced' | 'legacy_archived'>;
    },
  ): Promise<Array<{ knowledge: StoredKnowledge; cosine: number }>> {
    // Reuse knowledgeSelect() (full StoredKnowledge projection) as a CTE and join
    // the best chunk cosine per item. legacy_status is not in that projection, so
    // we re-join knowledge_items to filter it.
    const filters: string[] = [];
    const values: unknown[] = [`[${embedding.join(',')}]`, options.limit];
    if (options.project) {
      values.push(options.project);
      filters.push(`base.project = $${values.length}`);
    }
    if (options.itemTypes && options.itemTypes.length) {
      values.push(options.itemTypes);
      filters.push(`base.item_type = ANY($${values.length}::text[])`);
    }
    if (options.excludeLegacyStatuses && options.excludeLegacyStatuses.length) {
      values.push(options.excludeLegacyStatuses);
      filters.push(`(ki2.legacy_status IS NULL OR NOT (ki2.legacy_status = ANY($${values.length}::text[])))`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const threshold = options.threshold ?? 0;
    const result = await this.pool.query(
      `WITH scored AS (
         SELECT kc.knowledge_id AS id, 1 - MIN(kc.embedding <=> $1::vector) AS cosine
         FROM knowledge_chunks kc
         WHERE kc.embedding IS NOT NULL
         GROUP BY kc.knowledge_id
       ),
       base AS (
         ${knowledgeSelect()}
       )
       SELECT base.*, scored.cosine
       FROM base
       JOIN scored ON scored.id = base.id
       LEFT JOIN knowledge_items ki2 ON ki2.id = base.id
       ${where}
       ORDER BY scored.cosine DESC
       LIMIT $2`,
      values,
    );
    return result.rows
      .map((row) => ({ knowledge: mapKnowledgeRow(row), cosine: Number(row.cosine) }))
      .filter((entry) => entry.cosine >= threshold);
  }

  async countNegativeFeedback(knowledgeId: string, withinDays: number): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) AS count
       FROM feedback_events fe
       WHERE fe.feedback_type IN ('rejected','stale','irrelevant')
         AND fe.created_at >= now() - ($2 || ' days')::interval
         AND ($1::uuid = ANY(fe.rejected_knowledge_ids)
              OR (fe.metadata->>'affectedKnowledgeId') = $1::text)`,
      [knowledgeId, String(withinDays)],
    );
    return Number(result.rows[0].count);
  }

  async recordAtomGateEvent(input: AtomGateEventInput): Promise<AtomGateEvent> {
    const projectId = input.project ? await this.ensureProject(this.pool, input.project) : null;
    const result = await this.pool.query(
      `INSERT INTO atom_gate_events
         (project_id, session_id, atom_id, candidate_claim, candidate_type, stage, outcome, reasons)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING *`,
      [
        projectId, input.sessionId ?? null, input.atomId ?? null,
        input.candidateClaim, input.candidateType,
        input.stage, input.outcome, JSON.stringify(input.reasons),
      ],
    );
    return rowToGateEvent(result.rows[0], input.project ?? '');
  }

  async listAtomGateEvents(
    options: { project?: string; windowDays: number; limit: number },
  ): Promise<AtomGateEvent[]> {
    const values: unknown[] = [String(options.windowDays), options.limit];
    let projectFilter = '';
    if (options.project) {
      values.push(options.project);
      projectFilter = `AND p.name = $${values.length}`;
    }
    const result = await this.pool.query(
      `SELECT e.*, p.name AS project_name
       FROM atom_gate_events e
       LEFT JOIN projects p ON p.id = e.project_id
       WHERE e.created_at >= now() - ($1 || ' days')::interval ${projectFilter}
       ORDER BY e.created_at DESC
       LIMIT $2`,
      values,
    );
    return result.rows.map((row) => rowToGateEvent(row, String(row.project_name ?? '')));
  }

  async createAtomImportConflict(input: {
    project: string;
    atomId: string;
    localSnapshot: unknown;
    importedSnapshot: unknown;
    bundleSource: string;
  }): Promise<AtomImportConflict> {
    const projectId = await this.projectIdByName(this.pool, input.project);
    const result = await this.pool.query(
      `INSERT INTO atom_import_conflicts
         (project_id, atom_id, local_snapshot, imported_snapshot, bundle_source)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       RETURNING id, status, created_at`,
      [
        projectId,
        input.atomId,
        JSON.stringify(input.localSnapshot),
        JSON.stringify(input.importedSnapshot),
        input.bundleSource,
      ],
    );
    const row = result.rows[0];
    return {
      id: String(row.id),
      project: input.project,
      atomId: input.atomId,
      localSnapshot: input.localSnapshot as AtomImportConflict['localSnapshot'],
      importedSnapshot: input.importedSnapshot as AtomImportConflict['importedSnapshot'],
      bundleSource: input.bundleSource,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async listAtomImportConflicts(options: {
    project?: string;
    status?: string;
    limit: number;
  }): Promise<AtomImportConflict[]> {
    const filters: string[] = [];
    const values: unknown[] = [];
    if (options.project) {
      values.push(options.project);
      filters.push(`p.name = $${values.length}`);
    }
    if (options.status) {
      values.push(options.status);
      filters.push(`aic.status = $${values.length}`);
    }
    values.push(options.limit);
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT aic.id, aic.atom_id, aic.local_snapshot, aic.imported_snapshot,
              aic.bundle_source, aic.status, aic.resolution_notes,
              aic.created_at, aic.resolved_at, p.name AS project_name
         FROM atom_import_conflicts aic
         LEFT JOIN projects p ON p.id = aic.project_id
         ${where}
         ORDER BY aic.created_at DESC
         LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(rowToAtomImportConflict);
  }

  async getAtomImportConflict(id: string): Promise<AtomImportConflict | undefined> {
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query(
      `SELECT aic.id, aic.atom_id, aic.local_snapshot, aic.imported_snapshot,
              aic.bundle_source, aic.status, aic.resolution_notes,
              aic.created_at, aic.resolved_at, p.name AS project_name
         FROM atom_import_conflicts aic
         LEFT JOIN projects p ON p.id = aic.project_id
         WHERE aic.id = $1`,
      [id],
    );
    return result.rows[0] ? rowToAtomImportConflict(result.rows[0]) : undefined;
  }

  async resolveAtomImportConflict(
    id: string,
    action: AtomImportConflictAction,
    mergedSnapshot?: unknown,
    notes?: string,
  ): Promise<AtomImportConflict | undefined> {
    const status: AtomImportConflict['status'] =
      action === 'keep_local' ? 'resolved_keep_local'
      : action === 'take_imported' ? 'resolved_take_imported'
      : action === 'merged' ? 'resolved_merged'
      : 'dismissed';

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE atom_import_conflicts
            SET status = $1, resolution_notes = $2, resolved_at = now()
          WHERE id = $3
          RETURNING id, atom_id, local_snapshot, imported_snapshot,
                    bundle_source, status, resolution_notes, created_at, resolved_at, project_id`,
        [status, notes ?? null, id],
      );
      if (updated.rows.length === 0) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const row = updated.rows[0];

      if (action === 'take_imported') {
        const patch = importedSnapshotToPatch(row.imported_snapshot as AtomFrontmatter & { body: string });
        await applyAtomPatchInTx(client, row.atom_id, patch);
      } else if (action === 'merged' && mergedSnapshot) {
        await applyAtomPatchInTx(client, row.atom_id, mergedSnapshot as KnowledgeAtomPatch);
      }

      const projectName = row.project_id
        ? (await client.query<{ name: string }>('SELECT name FROM projects WHERE id = $1', [row.project_id])).rows[0]?.name ?? ''
        : '';
      await client.query('COMMIT');
      return rowToAtomImportConflict({ ...row, project_name: projectName });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async cleanupOperations(input: CleanupOperationsInput): Promise<CleanupOperationsResult> {
    const olderThanDays = input.olderThanDays ?? 30;
    const dryRun = Boolean(input.dryRun);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const proposedPacks = await client.query(
        `
          SELECT count(*)::int AS count
          FROM context_packs
          WHERE status = 'proposed'
            AND created_at < now() - ($1::int * interval '1 day')
        `,
        [olderThanDays],
      );
      const orphanFeedback = await client.query(
        `
          SELECT count(*)::int AS count
          FROM feedback_events
          WHERE context_pack_id IS NULL
            AND created_at < now() - ($1::int * interval '1 day')
        `,
        [olderThanDays],
      );
      const unusedSources = await client.query(
        `
          SELECT count(*)::int AS count
          FROM knowledge_sources ks
          WHERE NOT EXISTS (
            SELECT 1 FROM knowledge_items ki WHERE ki.source_id = ks.id
          )
        `,
      );
      const oldQueries = await client.query(
        `
          SELECT count(*)::int AS count
          FROM context_queries
          WHERE created_at < now() - ($1::int * interval '1 day')
            AND NOT EXISTS (
              SELECT 1 FROM context_packs cp WHERE cp.query_id = context_queries.id
            )
        `,
        [olderThanDays],
      );

      const result: CleanupOperationsResult = {
        dryRun,
        olderThanDays,
        deleted: {
          contextQueries: Number(oldQueries.rows[0].count ?? 0),
          contextPacks: Number(proposedPacks.rows[0].count ?? 0),
          feedbackEvents: Number(orphanFeedback.rows[0].count ?? 0),
          knowledgeSources: Number(unusedSources.rows[0].count ?? 0),
        },
      };

      if (!dryRun) {
        await client.query(
          `
            DELETE FROM context_packs
            WHERE status = 'proposed'
              AND created_at < now() - ($1::int * interval '1 day')
          `,
          [olderThanDays],
        );
        await client.query(
          `
            DELETE FROM feedback_events
            WHERE context_pack_id IS NULL
              AND created_at < now() - ($1::int * interval '1 day')
          `,
          [olderThanDays],
        );
        await client.query(
          `
            DELETE FROM context_queries
            WHERE created_at < now() - ($1::int * interval '1 day')
              AND NOT EXISTS (
                SELECT 1 FROM context_packs cp WHERE cp.query_id = context_queries.id
              )
          `,
          [olderThanDays],
        );
        await client.query(
          `
            DELETE FROM knowledge_sources ks
            WHERE NOT EXISTS (
              SELECT 1 FROM knowledge_items ki WHERE ki.source_id = ks.id
            )
          `,
        );
      }

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollbackAndRelease(client);
      throw error;
    } finally {
      finalReleaseClient(client);
    }
  }

  async exportBackup(): Promise<BackupExportData> {
    return this.backups.exportBackup();
  }

  async restoreBackup(input: { tables: BackupTableData[]; dryRun?: boolean; replace?: boolean }): Promise<Record<BackupTableName, number>> {
    return this.backups.restoreBackup(input);
  }

  private async ensureProject(client: Queryable, name: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `
        INSERT INTO projects (name)
        VALUES ($1)
        ON CONFLICT (name) DO UPDATE SET updated_at = now()
        RETURNING id
      `,
      [name],
    );

    return result.rows[0].id;
  }

  private async projectIdByName(client: Queryable, name: string): Promise<string | null> {
    const result = await client.query<{ id: string }>('SELECT id FROM projects WHERE name = $1', [name]);
    return result.rows[0]?.id ?? null;
  }

  private async upsertSource(client: PoolClient, projectId: string, input: KnowledgeInput): Promise<string> {
    const result = await client.query<{ id: string }>(
      `
        INSERT INTO knowledge_sources (
          project_id, source_type, uri, title, content_hash, trust_level, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (project_id, uri, content_hash) DO UPDATE SET
          title = EXCLUDED.title,
          trust_level = EXCLUDED.trust_level,
          updated_at = now()
        RETURNING id
      `,
      [
        projectId,
        input.sourceType,
        input.sourceUri,
        input.sourceTitle ?? input.title,
        sha256(input.content),
        input.trustLevel ?? 50,
        input.metadata ?? {},
      ],
    );

    return result.rows[0].id;
  }

  private async knowledgeIdsBySourceUri(client: PoolClient, projectId: string, sourceUri: string): Promise<string[]> {
    const result = await client.query<{ id: string }>(
      `
        SELECT ki.id
        FROM knowledge_items ki
        JOIN knowledge_sources ks ON ks.id = ki.source_id
        WHERE ki.project_id = $1 AND ks.uri = $2
        ORDER BY ki.updated_at DESC, ki.created_at DESC
      `,
      [projectId, sourceUri],
    );

    return result.rows.map((row) => row.id);
  }

  private async saveKnowledgeItem(
    client: PoolClient,
    projectId: string,
    sourceId: string,
    input: KnowledgeInput,
  ): Promise<string> {
    const existingIds = await this.knowledgeIdsBySourceUri(client, projectId, input.sourceUri);
    const existingId = existingIds[0];

    if (!existingId) {
      return this.insertKnowledgeItem(client, projectId, sourceId, input);
    }

    await this.deleteDuplicateKnowledgeItems(client, existingIds.slice(1));
    await this.updateKnowledgeItem(client, existingId, sourceId, input);
    await this.clearKnowledgeDetails(client, existingId);

    return existingId;
  }

  private async insertKnowledgeItem(
    client: PoolClient,
    projectId: string,
    sourceId: string,
    input: KnowledgeInput,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `
        INSERT INTO knowledge_items (
          project_id, source_id, item_type, title, summary, content, status,
          trust_level, freshness_at, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7, $8, $9)
        RETURNING id
      `,
      [
        projectId,
        sourceId,
        input.itemType,
        input.title,
        input.summary ?? '',
        input.content,
        input.trustLevel ?? 50,
        input.freshnessAt ?? null,
        input.metadata ?? {},
      ],
    );

    return result.rows[0].id;
  }

  private async updateKnowledgeItem(
    client: PoolClient,
    knowledgeId: string,
    sourceId: string,
    input: KnowledgeInput,
  ): Promise<void> {
    await client.query(
      `
        UPDATE knowledge_items
        SET source_id = $2,
          item_type = $3,
          title = $4,
          summary = $5,
          content = $6,
          status = 'approved',
          trust_level = $7,
          freshness_at = $8,
          metadata = $9,
          updated_at = now()
        WHERE id = $1
      `,
      [
        knowledgeId,
        sourceId,
        input.itemType,
        input.title,
        input.summary ?? '',
        input.content,
        input.trustLevel ?? 50,
        input.freshnessAt ?? null,
        input.metadata ?? {},
      ],
    );
  }

  private async deleteDuplicateKnowledgeItems(client: PoolClient, duplicateIds: string[]): Promise<void> {
    if (duplicateIds.length === 0) {
      return;
    }

    await client.query('DELETE FROM knowledge_items WHERE id = ANY($1::uuid[])', [duplicateIds]);
  }

  private async clearKnowledgeDetails(client: PoolClient, knowledgeId: string): Promise<void> {
    await client.query('DELETE FROM knowledge_labels WHERE knowledge_id = $1', [knowledgeId]);
    await client.query('DELETE FROM knowledge_references WHERE knowledge_id = $1', [knowledgeId]);
    await client.query('DELETE FROM knowledge_chunks WHERE knowledge_id = $1', [knowledgeId]);
  }

  private async attachReferences(client: PoolClient, knowledgeId: string, references: ReferenceInput[]): Promise<void> {
    for (const reference of references) {
      await client.query(
        `
          INSERT INTO knowledge_references (knowledge_id, ref_type, uri, line_start, line_end, commit_sha, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          knowledgeId,
          reference.type,
          reference.uri,
          reference.lineStart ?? null,
          reference.lineEnd ?? null,
          reference.commitSha ?? null,
          reference.metadata ?? {},
        ],
      );
    }
  }

  private async insertChunks(client: PoolClient, knowledgeId: string, projectId: string, chunks: ChunkInput[]): Promise<void> {
    for (const chunk of chunks) {
      await client.query(
        `
          INSERT INTO knowledge_chunks (
            knowledge_id, project_id, chunk_index, content, contextual_content,
            token_estimate, embedding, metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)
        `,
        [
          knowledgeId,
          projectId,
          chunk.index,
          chunk.content,
          chunk.contextualContent,
          chunk.tokenEstimate || estimateTokens(chunk.contextualContent),
          vectorLiteral(chunk.embedding),
          chunk.metadata ?? {},
        ],
      );
    }
  }

  private async insertKnowledgeRelation(
    client: Queryable,
    input: KnowledgeRelationInput,
  ): Promise<KnowledgeRelation> {
    const projectId = input.project
      ? await this.ensureProject(client, input.project)
      : null;
    // Phase 6c — stamp metadata.validFrom on every new relation (mirror inference.ts).
    const baseMetadata = input.metadata ?? {};
    const metadataWithValidity = typeof baseMetadata.validFrom === 'string'
      ? baseMetadata
      : { validFrom: new Date().toISOString(), ...baseMetadata };
    const result = await client.query(
      `
        WITH inserted AS (
          INSERT INTO knowledge_relations (
            project_id, from_knowledge_id, relation_type, target_kind,
            target_knowledge_id, target_value, confidence, inferred, metadata
          )
          VALUES (
            COALESCE($1, (SELECT project_id FROM knowledge_items WHERE id = $2)),
            $2, $3, $4, $5, $6, $7, $8, $9
          )
          RETURNING *
        )
        SELECT inserted.*, p.name AS project
        FROM inserted
        LEFT JOIN projects p ON p.id = inserted.project_id
      `,
      [
        projectId,
        input.fromKnowledgeId,
        input.relationType,
        input.targetKind,
        input.targetKnowledgeId ?? null,
        input.targetValue ?? null,
        input.confidence ?? 0.7,
        input.inferred ?? false,
        metadataWithValidity,
      ],
    );
    const created = mapRelationRow(result.rows[0]);

    // Phase 6c — when memory A supersedes memory B, stamp validUntil on B's
    // other inferred outgoing relations. Idempotent: skip relations that
    // already carry a validUntil.
    if (created.relationType === 'supersedes' && created.targetKnowledgeId) {
      await this.expireRelationsFromKnowledge(
        client,
        created.targetKnowledgeId,
        new Date().toISOString(),
        created.id,
      );
    }
    return created;
  }

  private async expireRelationsFromKnowledge(
    client: Queryable,
    knowledgeId: string,
    expiredAt: string,
    excludeRelationId?: string,
  ): Promise<void> {
    await client.query(
      `
        UPDATE knowledge_relations
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{validUntil}', to_jsonb($2::text), true),
            updated_at = now()
        WHERE from_knowledge_id = $1
          AND inferred = true
          AND (metadata->>'validUntil') IS NULL
          AND ($3::uuid IS NULL OR id <> $3)
      `,
      [knowledgeId, expiredAt, excludeRelationId ?? null],
    );
  }
}

function knowledgeSelect(): string {
  return `
    SELECT
      ki.id,
      p.id AS project_id,
      p.name AS project,
      ks.source_type,
      ks.uri AS source_uri,
      ki.status,
      ki.item_type,
      ki.title,
      ki.summary,
      ki.content,
      ki.trust_level,
      ki.freshness_at,
      ki.metadata,
      ki.created_at,
      ki.updated_at,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('type', l.label_type, 'value', l.value, 'weight', kl.weight))
        FROM knowledge_labels kl
        JOIN labels l ON l.id = kl.label_id
        WHERE kl.knowledge_id = ki.id
      ), '[]'::jsonb) AS labels,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'type', r.ref_type,
          'uri', r.uri,
          'lineStart', r.line_start,
          'lineEnd', r.line_end,
          'commitSha', r.commit_sha,
          'metadata', r.metadata
        ))
        FROM knowledge_references r
        WHERE r.knowledge_id = ki.id
      ), '[]'::jsonb) AS references
    FROM knowledge_items ki
    JOIN projects p ON p.id = ki.project_id
    LEFT JOIN knowledge_sources ks ON ks.id = ki.source_id
  `;
}

function candidateSelect(source: string, scoreExpression: string, graphPathsExpression?: string): string {
  return `
    SELECT
      ki.id AS knowledge_id,
      kc.id AS chunk_id,
      ki.title,
      ki.summary,
      kc.content,
      kc.contextual_content,
      ki.item_type,
      p.name AS project,
      ki.trust_level,
      kc.token_estimate,
      ki.freshness_at,
      ${graphPathsExpression
        ? `ki.metadata || jsonb_build_object('graphPaths', ${graphPathsExpression})`
        : 'ki.metadata'} AS metadata,
      ki.created_at,
      '${source}'::text AS source,
      ${scoreExpression}::real AS raw_score,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('type', l.label_type, 'value', l.value, 'weight', kl.weight))
        FROM knowledge_labels kl
        JOIN labels l ON l.id = kl.label_id
        WHERE kl.knowledge_id = ki.id
      ), '[]'::jsonb) AS labels,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'type', r.ref_type,
          'uri', r.uri,
          'lineStart', r.line_start,
          'lineEnd', r.line_end,
          'commitSha', r.commit_sha,
          'metadata', r.metadata
        ))
        FROM knowledge_references r
        WHERE r.knowledge_id = ki.id
      ), '[]'::jsonb) AS references
    FROM knowledge_chunks kc
    JOIN knowledge_items ki ON ki.id = kc.knowledge_id
    JOIN projects p ON p.id = ki.project_id
  `;
}

function relationSelect(): string {
  return `
    SELECT
      kr.id,
      p.name AS project,
      kr.from_knowledge_id,
      kr.relation_type,
      kr.target_kind,
      kr.target_knowledge_id,
      kr.target_value,
      kr.confidence,
      kr.inferred,
      kr.metadata,
      kr.created_at,
      kr.updated_at
    FROM knowledge_relations kr
    LEFT JOIN projects p ON p.id = kr.project_id
  `;
}

function conflictSelect(): string {
  return `
    SELECT
      kc.id,
      p.name AS project,
      kc.left_knowledge_id,
      kc.right_knowledge_id,
      kc.conflict_type,
      kc.status,
      kc.shared_evidence,
      kc.reason,
      kc.metadata,
      kc.created_at,
      kc.updated_at,
      kc.resolved_at
    FROM knowledge_conflicts kc
    LEFT JOIN projects p ON p.id = kc.project_id
  `;
}

function knowledgeGapSelect(): string {
  return `
    SELECT
      kg.id,
      p.name AS project,
      kg.status,
      kg.source_feedback_id,
      kg.source_session_id,
      kg.context_pack_id,
      kg.prompt,
      kg.classified,
      kg.missing_signals,
      kg.reason,
      kg.metadata,
      kg.created_at,
      kg.updated_at,
      kg.reviewed_at
    FROM knowledge_gaps kg
    LEFT JOIN projects p ON p.id = kg.project_id
  `;
}

function learningProposalSelect(): string {
  return `
    SELECT
      lp.id,
      p.name AS project,
      lp.proposal_type,
      lp.status,
      lp.source_feedback_id,
      lp.source_session_id,
      lp.context_pack_id,
      lp.affected_knowledge_id,
      lp.candidate_knowledge_id,
      lp.reason,
      lp.evidence,
      lp.metadata,
      lp.created_at,
      lp.updated_at,
      lp.reviewed_at
    FROM learning_proposals lp
    LEFT JOIN projects p ON p.id = lp.project_id
  `;
}

function mapKnowledgeRow(row: Record<string, unknown>): StoredKnowledge {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const rawLabels = (row.labels ?? []) as LabelInput[];
  const project = String(row.project);
  const itemType = row.item_type as StoredKnowledge['itemType'];
  const namespace = readNamespaceFromMetadata(metadata)
    ?? deriveNamespace({ project, itemType, metadata });
  return {
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    project,
    sourceType: row.source_type ? String(row.source_type) : undefined,
    sourceUri: row.source_uri ? String(row.source_uri) : undefined,
    status: row.status as StoredKnowledge['status'],
    itemType,
    title: String(row.title),
    summary: String(row.summary ?? ''),
    content: String(row.content),
    trustLevel: Number(row.trust_level ?? 50),
    metadata,
    labels: hydrateLabelProvenance(rawLabels, metadata),
    references: (row.references ?? []) as ReferenceInput[],
    freshnessAt: row.freshness_at ? toIso(row.freshness_at) : undefined,
    createdAt: toIso(row.created_at),
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
    namespace,
  };
}

function mapRelationRow(row: Record<string, unknown>): KnowledgeRelation {
  return {
    id: String(row.id),
    project: row.project ? String(row.project) : undefined,
    fromKnowledgeId: String(row.from_knowledge_id),
    relationType: row.relation_type as KnowledgeRelation['relationType'],
    targetKind: row.target_kind as KnowledgeRelation['targetKind'],
    targetKnowledgeId: row.target_knowledge_id ? String(row.target_knowledge_id) : undefined,
    targetValue: row.target_value ? String(row.target_value) : undefined,
    confidence: Number(row.confidence ?? 0.7),
    inferred: Boolean(row.inferred),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toIso(row.created_at),
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
  };
}

function mapConflictRow(row: Record<string, unknown>): KnowledgeConflict {
  return {
    id: String(row.id),
    project: row.project ? String(row.project) : undefined,
    leftKnowledgeId: String(row.left_knowledge_id),
    rightKnowledgeId: String(row.right_knowledge_id),
    conflictType: row.conflict_type as KnowledgeConflict['conflictType'],
    status: row.status as KnowledgeConflict['status'],
    sharedEvidence: Array.isArray(row.shared_evidence) ? row.shared_evidence.map(String) : [],
    reason: String(row.reason ?? ''),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toIso(row.created_at),
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
    resolvedAt: row.resolved_at ? toIso(row.resolved_at) : undefined,
  };
}

function mapKnowledgeGapRow(row: Record<string, unknown>): KnowledgeGap {
  return {
    id: String(row.id),
    project: row.project ? String(row.project) : undefined,
    status: row.status as KnowledgeGap['status'],
    sourceFeedbackId: row.source_feedback_id ? String(row.source_feedback_id) : undefined,
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : undefined,
    contextPackId: row.context_pack_id ? String(row.context_pack_id) : undefined,
    prompt: String(row.prompt),
    classified: row.classified ? row.classified as ClassifiedQuery : undefined,
    missingSignals: Array.isArray(row.missing_signals) ? row.missing_signals.map(String) : [],
    reason: row.reason ? String(row.reason) : undefined,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toIso(row.created_at),
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
    reviewedAt: row.reviewed_at ? toIso(row.reviewed_at) : undefined,
  };
}

function mapLearningProposalRow(row: Record<string, unknown>): LearningProposal {
  return {
    id: String(row.id),
    project: row.project ? String(row.project) : undefined,
    proposalType: row.proposal_type as LearningProposal['proposalType'],
    status: row.status as LearningProposal['status'],
    sourceFeedbackId: row.source_feedback_id ? String(row.source_feedback_id) : undefined,
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : undefined,
    contextPackId: row.context_pack_id ? String(row.context_pack_id) : undefined,
    affectedKnowledgeId: row.affected_knowledge_id ? String(row.affected_knowledge_id) : undefined,
    candidateKnowledgeId: row.candidate_knowledge_id ? String(row.candidate_knowledge_id) : undefined,
    reason: String(row.reason ?? ''),
    evidence: Array.isArray(row.evidence) ? row.evidence.map(String) : [],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toIso(row.created_at),
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
    reviewedAt: row.reviewed_at ? toIso(row.reviewed_at) : undefined,
  };
}

function knowledgeReviewSql(
  review: ListKnowledgeOptions['review'],
): string | undefined {
  if (!review) {
    return undefined;
  }

  const unsafe = `
    (
      ki.metadata->'safety'->>'status' IN ('suspicious', 'blocked')
      OR COALESCE((ki.metadata->'safety'->>'redactionCount')::int, 0) > 0
    )
  `;
  const lowTrust = 'ki.trust_level < 50';
  const stale = feedbackExistsSql('stale');
  const rejected = feedbackExistsSql('rejected');
  const irrelevant = feedbackExistsSql('irrelevant');
  const autoMemory = "(ki.metadata->>'source' = 'agent_session_finish' OR ki.metadata->>'learningMode' = 'auto')";
  const noGroundedReference = `
    NOT EXISTS (
      SELECT 1
      FROM knowledge_references kr
      WHERE kr.knowledge_id = ki.id
        AND kr.ref_type <> 'conversation'
    )
  `;
  const noConcreteLabel = `
    NOT EXISTS (
      SELECT 1
      FROM knowledge_labels kl
      JOIN labels l ON l.id = kl.label_id
      WHERE kl.knowledge_id = ki.id
        AND l.label_type IN ('task_type', 'file', 'symbol', 'error')
    )
  `;
  const orphaned = `
    (
      NOT EXISTS (SELECT 1 FROM knowledge_references kr WHERE kr.knowledge_id = ki.id)
      AND NOT EXISTS (SELECT 1 FROM knowledge_labels kl WHERE kl.knowledge_id = ki.id)
    )
  `;

  if (review === 'questionable') {
    return `(${unsafe} OR ${lowTrust} OR ${stale} OR ${rejected} OR ${irrelevant} OR ki.status <> 'approved')`;
  }

  if (review === 'auto_memory') {
    return autoMemory;
  }

  if (review === 'risky_auto_memory') {
    return `(${autoMemory} AND (${unsafe} OR ${lowTrust} OR ${stale} OR ${rejected} OR ${irrelevant} OR ki.status <> 'approved' OR ${noGroundedReference} OR ${noConcreteLabel}))`;
  }

  if (review === 'unsafe') {
    return unsafe;
  }

  if (review === 'low_trust') {
    return lowTrust;
  }

  if (review === 'stale') {
    return stale;
  }

  if (review === 'rejected') {
    return rejected;
  }

  if (review === 'irrelevant') {
    return irrelevant;
  }

  return orphaned;
}

function packStatusForFeedback(feedbackType: FeedbackInput['feedbackType']): ContextPack['status'] | undefined {
  if (feedbackType === 'selected' || feedbackType === 'selected_but_noisy') {
    return 'selected';
  }

  if (feedbackType === 'rejected' || feedbackType === 'irrelevant' || feedbackType === 'stale') {
    return 'rejected';
  }

  return undefined;
}

function feedbackExistsSql(type: FeedbackEvent['feedbackType']): string {
  return `
    EXISTS (
      SELECT 1
      FROM feedback_events fe
      WHERE fe.feedback_type = '${type}'
        AND ki.id = ANY(fe.rejected_knowledge_ids)
    )
  `;
}

function mapCandidateRow(row: Record<string, unknown>, index: number): SearchCandidate {
  return {
    knowledgeId: String(row.knowledge_id),
    chunkId: row.chunk_id ? String(row.chunk_id) : undefined,
    title: String(row.title),
    summary: String(row.summary ?? ''),
    content: String(row.content),
    contextualContent: String(row.contextual_content),
    itemType: row.item_type as SearchCandidate['itemType'],
    project: String(row.project),
    labels: (row.labels ?? []) as LabelInput[],
    references: (row.references ?? []) as ReferenceInput[],
    tokenEstimate: Number(row.token_estimate ?? estimateTokens(String(row.contextual_content))),
    trustLevel: Number(row.trust_level ?? 50),
    source: row.source as SearchCandidate['source'],
    rawScore: Number(row.raw_score ?? 0),
    rank: index + 1,
    createdAt: row.created_at ? toIso(row.created_at) : undefined,
    freshnessAt: row.freshness_at ? toIso(row.freshness_at) : undefined,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

function mapKnowledgeChunkRow(row: Record<string, unknown>): KnowledgeChunkRecord {
  return {
    id: String(row.id),
    knowledgeId: String(row.knowledge_id),
    chunkIndex: Number(row.chunk_index ?? 0),
    content: String(row.content),
    contextualContent: String(row.contextual_content),
    tokenEstimate: Number(row.token_estimate ?? estimateTokens(String(row.contextual_content))),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.created_at ? toIso(row.created_at) : undefined,
  };
}

function mapReflectionDraftRow(row: Record<string, unknown>, project?: string): ReflectionDraft {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;

  return {
    id: String(row.id),
    project: project ?? (row.project ? String(row.project) : undefined),
    title: String(row.title),
    summary: String(row.summary),
    content: String(row.content),
    itemType: row.item_type as ReflectionDraft['itemType'],
    triggerType: row.trigger_type as ReflectionDraft['triggerType'],
    status: row.status as ReflectionDraft['status'],
    suggestedLabels: (row.suggested_labels ?? []) as LabelInput[],
    references: Array.isArray(metadata.references) ? metadata.references as ReferenceInput[] : [],
    metadata,
    duplicateCandidates: (row.duplicate_candidates ?? []) as ReflectionDraft['duplicateCandidates'],
    createdAt: toIso(row.created_at),
  };
}

function mapAgentSessionRow(row: Record<string, unknown>, project?: string): AgentSession {
  return {
    id: String(row.id),
    project: project ?? (row.project ? String(row.project) : undefined),
    cwd: row.cwd ? String(row.cwd) : undefined,
    prompt: String(row.prompt),
    agentName: row.agent_name ? String(row.agent_name) : undefined,
    agentTool: row.agent_tool ? String(row.agent_tool) : undefined,
    status: row.status as AgentSession['status'],
    initialContextPackId: row.initial_context_pack_id ? String(row.initial_context_pack_id) : undefined,
    outcome: row.outcome ? row.outcome as AgentSession['outcome'] : undefined,
    summary: row.summary ? String(row.summary) : undefined,
    reflectionDraftIds: (row.reflection_draft_ids ?? []) as string[],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toIso(row.created_at),
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
    finishedAt: row.finished_at ? toIso(row.finished_at) : undefined,
  };
}

function mapSessionReplayRow(row: Record<string, unknown>): SessionReplayBundle {
  return {
    sessionId: String(row.session_id),
    recordedAt: row.recorded_at ? toIso(row.recorded_at) : undefined,
    classifier: (row.classifier ?? {}) as Record<string, unknown>,
    sourceCandidates: (row.source_candidates ?? {}) as SessionReplayBundle['sourceCandidates'],
    fusionOrder: (row.fusion_order ?? []) as SessionReplayBundle['fusionOrder'],
    rerankDeltas: (row.rerank_deltas ?? []) as SessionReplayBundle['rerankDeltas'],
    adjustments: (row.adjustments ?? []) as SessionReplayBundle['adjustments'],
    contextFit: row.context_fit as SessionReplayBundle['contextFit'],
    pack: row.pack as SessionReplayBundle['pack'],
    timings: row.timings as SessionReplayBundle['timings'],
  };
}

function mapAgentContextDecisionRow(row: Record<string, unknown>): AgentContextDecision {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    contextPackId: row.context_pack_id ? String(row.context_pack_id) : undefined,
    decision: row.decision as AgentContextDecision['decision'],
    reason: row.reason ? String(row.reason) : undefined,
    rejectedKnowledgeIds: (row.rejected_knowledge_ids ?? []) as string[],
    retryContextPackId: row.retry_context_pack_id ? String(row.retry_context_pack_id) : undefined,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toIso(row.created_at),
  };
}

function rowToAtom(row: Record<string, unknown>, project: string): KnowledgeAtom {
  const scope = (row.scope as KnowledgeAtom['scope']) ?? 'project';
  const userId = row.user_id ? String(row.user_id) : undefined;
  const teamId = row.team_id ? String(row.team_id) : undefined;
  // Concern F: user-scope atoms have null project_id and a sentinel project name
  // for the in-memory side of the store contract. Synthesise the sentinel here
  // so downstream consumers see a stable `project` string.
  const resolvedProject =
    scope === 'user' ? `__user:${userId ?? ''}`
    : scope === 'team' ? `__team:${teamId ?? ''}`
    : project;
  return {
    id: String(row.id),
    project: resolvedProject,
    parentKnowledgeId: row.parent_knowledge_id ? String(row.parent_knowledge_id) : undefined,
    claim: String(row.claim),
    type: row.type as KnowledgeAtom['type'],
    evidence: (row.evidence ?? []) as KnowledgeAtom['evidence'],
    trigger: (row.trigger ?? {}) as KnowledgeAtom['trigger'],
    verification: (row.verification ?? undefined) as KnowledgeAtom['verification'],
    pitfalls: (row.pitfalls ?? undefined) as KnowledgeAtom['pitfalls'],
    links: (row.links ?? undefined) as KnowledgeAtom['links'],
    tier: row.tier as KnowledgeAtom['tier'],
    reuseCount: Number(row.reuse_count ?? 0),
    lastReusedAt: row.last_reused_at ? new Date(row.last_reused_at as string).toISOString() : undefined,
    status: row.status as KnowledgeAtom['status'],
    audit: {
      producedBy: row.produced_by as KnowledgeAtom['audit']['producedBy'],
      producedAtSessionId: row.produced_session_id ? String(row.produced_session_id) : undefined,
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
    },
    scope,
    userId,
    teamId,
    priority: (row.priority as KnowledgeAtom['priority']) ?? undefined,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

function rowToGateEvent(row: Record<string, unknown>, project: string): AtomGateEvent {
  return {
    id: String(row.id),
    project: project || undefined,
    sessionId: row.session_id ? String(row.session_id) : undefined,
    atomId: row.atom_id ? String(row.atom_id) : undefined,
    candidateClaim: String(row.candidate_claim),
    candidateType: String(row.candidate_type),
    stage: row.stage as AtomGateEvent['stage'],
    outcome: row.outcome as AtomGateEvent['outcome'],
    reasons: (row.reasons ?? []) as string[],
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => Number(value.toFixed(8))).join(',')}]`;
}

/**
 * Phase 4 — emit a CASE expression that maps `kr.relation_type` to the configured
 * per-relation-kind multiplier. Defaults to 1.0 when no entry is provided. Values are
 * embedded directly because they originate from server-side config (no user input).
 */
function buildRelationKindMultiplierSql(
  multipliers: Partial<Record<KnowledgeRelationType, number>>,
): string {
  const cases: string[] = [];
  for (const [relationType, multiplier] of Object.entries(multipliers)) {
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) continue;
    cases.push(`WHEN kr.relation_type = ${formatSqlString(relationType)} THEN ${multiplier.toFixed(4)}::real`);
  }
  if (cases.length === 0) return '1.0';
  return `CASE ${cases.join(' ')} ELSE 1.0 END`;
}

function formatSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rowToAtomImportConflict(row: Record<string, unknown>): AtomImportConflict {
  return {
    id: String(row.id),
    project: String(row.project_name ?? ''),
    atomId: String(row.atom_id),
    localSnapshot: row.local_snapshot as AtomImportConflict['localSnapshot'],
    importedSnapshot: row.imported_snapshot as AtomImportConflict['importedSnapshot'],
    bundleSource: String(row.bundle_source),
    status: row.status as AtomImportConflict['status'],
    resolutionNotes: row.resolution_notes ? String(row.resolution_notes) : undefined,
    createdAt: toIso(row.created_at),
    resolvedAt: row.resolved_at ? toIso(row.resolved_at) : undefined,
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

const LABEL_PROVENANCE_METADATA_KEY = 'labelProvenance';


function labelProvenanceKey(label: { type: string; value: string }): string {
  return `${label.type}:${normalizeLabel(label.value)}`;
}

function buildLabelProvenanceMap(labels: LabelInput[]): Record<string, LabelInput['provenance']> {
  const map: Record<string, LabelInput['provenance']> = {};
  for (const label of labels) {
    if (label.provenance) {
      map[labelProvenanceKey(label)] = label.provenance;
    }
  }
  return map;
}

function mergeLabelProvenanceIntoMetadata(
  metadata: Record<string, unknown>,
  labels: LabelInput[],
): Record<string, unknown> {
  const provenanceMap = buildLabelProvenanceMap(labels);
  if (Object.keys(provenanceMap).length === 0) {
    if (!(LABEL_PROVENANCE_METADATA_KEY in metadata)) {
      return metadata;
    }
    const next = { ...metadata };
    delete next[LABEL_PROVENANCE_METADATA_KEY];
    return next;
  }
  return { ...metadata, [LABEL_PROVENANCE_METADATA_KEY]: provenanceMap };
}

function withLabelProvenanceMetadata(input: KnowledgeInput): KnowledgeInput {
  if (!input.labels || input.labels.length === 0) {
    return input;
  }
  const baseMetadata = input.metadata ?? {};
  const next = mergeLabelProvenanceIntoMetadata(baseMetadata, input.labels);
  if (next === baseMetadata) {
    return input;
  }
  return { ...input, metadata: next };
}

/**
 * Phase 6a — stamp the derived namespace into metadata.namespace before persisting.
 * Mirrors {@link withLabelProvenanceMetadata}: a thin pre-write step on the JSONB
 * column, no schema migration. Read-side hydration uses {@link readNamespaceFromMetadata}.
 */
function withNamespaceMetadata(input: KnowledgeInput): KnowledgeInput {
  const namespace = deriveNamespace({
    project: input.project,
    itemType: input.itemType,
    metadata: input.metadata,
    namespace: input.namespace,
  });
  const next = writeNamespaceToMetadata(input.metadata, namespace);
  return { ...input, metadata: next, namespace };
}

function hydrateLabelProvenance(
  labels: LabelInput[],
  metadata: Record<string, unknown>,
): LabelInput[] {
  const stored = metadata[LABEL_PROVENANCE_METADATA_KEY];
  if (!stored || typeof stored !== 'object') {
    return labels;
  }
  const map = stored as Record<string, LabelInput['provenance']>;
  return labels.map((label) => {
    if (label.provenance) return label;
    const provenance = map[labelProvenanceKey(label)];
    return provenance ? { ...label, provenance } : label;
  });
}
