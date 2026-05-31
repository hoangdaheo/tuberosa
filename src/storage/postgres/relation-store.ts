import type { Pool } from 'pg';
import { isPersistedKnowledgeId } from '../../util/uuid.js';
import type {
  KnowledgeRelation,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  ListKnowledgeRelationsOptions,
} from '../../types.js';
import {
  insertKnowledgeRelation,
  mapRelationRow,
  relationSelect,
} from './shared-helpers.js';

/**
 * Standalone knowledge-relation CRUD extracted from `PostgresKnowledgeStore`.
 * The insert/expire helpers live in shared-helpers.ts because the main store's
 * createKnowledge / replaceInferredKnowledgeRelations / recordFeedback paths
 * also use them. None of these methods participate in `withTransaction`.
 */
export class PostgresRelationStore {
  constructor(private readonly pool: Pool) {}

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
    return insertKnowledgeRelation(this.pool, input);
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
}
