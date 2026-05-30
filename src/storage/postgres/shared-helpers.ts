import type { Pool, PoolClient } from 'pg';
import type { KnowledgeRelation, KnowledgeRelationInput } from '../../types.js';

/**
 * Query target shared by the main store and its sub-stores. Simple (non-connect)
 * queries run against either the pool or a single transaction-bound client.
 */
export type Queryable = Pool | PoolClient;

/**
 * Insert (or touch) a project by name and return its id. Shared by the main
 * `PostgresKnowledgeStore` and the extracted sub-stores so the project upsert
 * stays byte-identical across both.
 */
export async function ensureProject(client: Queryable, name: string): Promise<string> {
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

/** Look up a project id by name, or null when it does not exist. */
export async function projectIdByName(client: Queryable, name: string): Promise<string | null> {
  const result = await client.query<{ id: string }>('SELECT id FROM projects WHERE name = $1', [name]);
  return result.rows[0]?.id ?? null;
}

/** Normalize a Postgres timestamp value to an ISO-8601 string. */
export function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

export function relationSelect(): string {
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

export function mapRelationRow(row: Record<string, unknown>): KnowledgeRelation {
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

/**
 * Insert a knowledge relation (shared by the main store's createKnowledge /
 * replaceInferredKnowledgeRelations paths and the standalone RelationStore CRUD).
 * Takes a Queryable so it works inside `withTransaction` (PoolClient) and outside
 * it (Pool) without behavior change.
 */
export async function insertKnowledgeRelation(
  client: Queryable,
  input: KnowledgeRelationInput,
): Promise<KnowledgeRelation> {
  const projectId = input.project
    ? await ensureProject(client, input.project)
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
    await expireRelationsFromKnowledge(
      client,
      created.targetKnowledgeId,
      new Date().toISOString(),
      created.id,
    );
  }
  return created;
}

export async function expireRelationsFromKnowledge(
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
