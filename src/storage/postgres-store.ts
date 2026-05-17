import { Pool, type PoolClient } from 'pg';
import { StoreError } from '../errors.js';
import type {
  AgentContextDecision,
  AgentSession,
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
  KnowledgeGraphJsonlExport,
  KnowledgePatchInput,
  KnowledgeChunkRecord,
  KnowledgeFeedbackSummary,
  KnowledgeInput,
  KnowledgeRelation,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  LabelInput,
  LabelRecord,
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
import { sha256 } from '../util/hash.js';
import { estimateTokens, normalizeLabel } from '../util/text.js';
import type { ChunkInput, KnowledgeStore, StaleFileAtomCleanupInput } from './store.js';

type Queryable = Pool | PoolClient;

interface BackupTableDefinition {
  name: BackupTableName;
  columns: string[];
  selectSql: string;
  casts?: Record<string, string>;
}

const BACKUP_TABLES: BackupTableDefinition[] = [
  {
    name: 'projects',
    columns: ['id', 'name', 'root_path_hash', 'remote_hash', 'languages', 'status', 'metadata', 'created_at', 'updated_at'],
    selectSql: 'SELECT id, name, root_path_hash, remote_hash, languages, status, metadata, created_at, updated_at FROM projects ORDER BY created_at, id',
  },
  {
    name: 'knowledge_sources',
    columns: ['id', 'project_id', 'source_type', 'uri', 'title', 'content_hash', 'trust_level', 'metadata', 'created_at', 'updated_at'],
    selectSql: 'SELECT id, project_id, source_type, uri, title, content_hash, trust_level, metadata, created_at, updated_at FROM knowledge_sources ORDER BY created_at, id',
  },
  {
    name: 'knowledge_items',
    columns: ['id', 'project_id', 'source_id', 'item_type', 'title', 'summary', 'content', 'status', 'trust_level', 'freshness_at', 'metadata', 'created_at', 'updated_at'],
    selectSql: 'SELECT id, project_id, source_id, item_type, title, summary, content, status, trust_level, freshness_at, metadata, created_at, updated_at FROM knowledge_items ORDER BY created_at, id',
  },
  {
    name: 'labels',
    columns: ['id', 'label_type', 'value', 'normalized_value', 'created_at'],
    selectSql: 'SELECT id, label_type, value, normalized_value, created_at FROM labels ORDER BY created_at, id',
  },
  {
    name: 'knowledge_labels',
    columns: ['knowledge_id', 'label_id', 'weight'],
    selectSql: 'SELECT knowledge_id, label_id, weight FROM knowledge_labels ORDER BY knowledge_id, label_id',
  },
  {
    name: 'knowledge_references',
    columns: ['id', 'knowledge_id', 'ref_type', 'uri', 'line_start', 'line_end', 'commit_sha', 'metadata', 'created_at'],
    selectSql: 'SELECT id, knowledge_id, ref_type, uri, line_start, line_end, commit_sha, metadata, created_at FROM knowledge_references ORDER BY created_at, id',
  },
  {
    name: 'knowledge_relations',
    columns: ['id', 'project_id', 'from_knowledge_id', 'relation_type', 'target_kind', 'target_knowledge_id', 'target_value', 'confidence', 'inferred', 'metadata', 'created_at', 'updated_at'],
    selectSql: 'SELECT id, project_id, from_knowledge_id, relation_type, target_kind, target_knowledge_id, target_value, confidence, inferred, metadata, created_at, updated_at FROM knowledge_relations ORDER BY created_at, id',
  },
  {
    name: 'knowledge_chunks',
    columns: ['id', 'knowledge_id', 'project_id', 'chunk_index', 'content', 'contextual_content', 'token_estimate', 'embedding', 'metadata', 'created_at'],
    selectSql: 'SELECT id, knowledge_id, project_id, chunk_index, content, contextual_content, token_estimate, embedding::text AS embedding, metadata, created_at FROM knowledge_chunks ORDER BY created_at, id',
    casts: { embedding: 'vector' },
  },
  {
    name: 'reflection_drafts',
    columns: ['id', 'project_id', 'title', 'summary', 'content', 'item_type', 'trigger_type', 'status', 'suggested_labels', 'duplicate_candidates', 'metadata', 'created_at', 'reviewed_at'],
    selectSql: 'SELECT id, project_id, title, summary, content, item_type, trigger_type, status, suggested_labels, duplicate_candidates, metadata, created_at, reviewed_at FROM reflection_drafts ORDER BY created_at, id',
  },
  {
    name: 'context_queries',
    columns: ['id', 'project_id', 'prompt', 'query_fingerprint', 'classified', 'token_budget', 'created_at'],
    selectSql: 'SELECT id, project_id, prompt, query_fingerprint, classified, token_budget, created_at FROM context_queries ORDER BY created_at, id',
  },
  {
    name: 'context_packs',
    columns: ['id', 'query_id', 'project_id', 'confidence', 'status', 'pack', 'created_at', 'selected_at', 'rejected_at'],
    selectSql: 'SELECT id, query_id, project_id, confidence, status, pack, created_at, selected_at, rejected_at FROM context_packs ORDER BY created_at, id',
  },
  {
    name: 'feedback_events',
    columns: ['id', 'context_pack_id', 'project_id', 'feedback_type', 'reason', 'rejected_knowledge_ids', 'metadata', 'created_at'],
    selectSql: 'SELECT id, context_pack_id, project_id, feedback_type, reason, rejected_knowledge_ids, metadata, created_at FROM feedback_events ORDER BY created_at, id',
  },
  {
    name: 'agent_sessions',
    columns: ['id', 'project_id', 'prompt', 'cwd', 'agent_name', 'agent_tool', 'status', 'initial_context_pack_id', 'outcome', 'summary', 'reflection_draft_ids', 'metadata', 'created_at', 'updated_at', 'finished_at'],
    selectSql: 'SELECT id, project_id, prompt, cwd, agent_name, agent_tool, status, initial_context_pack_id, outcome, summary, reflection_draft_ids, metadata, created_at, updated_at, finished_at FROM agent_sessions ORDER BY created_at, id',
  },
  {
    name: 'agent_context_decisions',
    columns: ['id', 'session_id', 'context_pack_id', 'decision', 'reason', 'rejected_knowledge_ids', 'retry_context_pack_id', 'metadata', 'created_at'],
    selectSql: 'SELECT id, session_id, context_pack_id, decision, reason, rejected_knowledge_ids, retry_context_pack_id, metadata, created_at FROM agent_context_decisions ORDER BY created_at, id',
  },
];

export class PostgresKnowledgeStore implements KnowledgeStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async upsertKnowledge(input: KnowledgeInput, chunks: ChunkInput[]): Promise<StoredKnowledge> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const projectId = await this.ensureProject(client, input.project);
      const sourceId = await this.upsertSource(client, projectId, input);
      const knowledgeId = await this.saveKnowledgeItem(client, projectId, sourceId, input);
      await this.attachLabels(client, knowledgeId, input.labels ?? []);
      await this.attachReferences(client, knowledgeId, input.references ?? []);
      await this.insertChunks(client, knowledgeId, projectId, chunks);
      await client.query('COMMIT');

      const stored = await this.getKnowledge(knowledgeId);
      if (!stored) {
        throw new StoreError(`Knowledge item ${knowledgeId} was created but could not be read back.`);
      }

      return stored;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
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
          patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
        ],
      );

      if (patch.labels) {
        await client.query('DELETE FROM knowledge_labels WHERE knowledge_id = $1', [id]);
        await this.attachLabels(client, id, patch.labels);
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
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
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
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listKnowledgeRelations(options: ListKnowledgeRelationsOptions): Promise<KnowledgeRelation[]> {
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
    const result = await this.pool.query('DELETE FROM knowledge_relations WHERE id = $1', [id]);
    return Boolean(result.rowCount);
  }

  async listLabels(options: { project?: string; limit: number }): Promise<LabelRecord[]> {
    const result = await this.pool.query(
      `
        SELECT l.label_type, l.value, avg(kl.weight)::real AS weight, count(*)::int AS knowledge_count
        FROM labels l
        JOIN knowledge_labels kl ON kl.label_id = l.id
        JOIN knowledge_items ki ON ki.id = kl.knowledge_id
        JOIN projects p ON p.id = ki.project_id
        WHERE ($2::text IS NULL OR p.name = $2)
        GROUP BY l.id, l.label_type, l.value
        ORDER BY knowledge_count DESC, l.value ASC
        LIMIT $1
      `,
      [options.limit, options.project ?? null],
    );

    return result.rows.map((row) => ({
      type: row.label_type as LabelRecord['type'],
      value: String(row.value),
      weight: Number(row.weight ?? 1),
      knowledgeCount: Number(row.knowledge_count ?? 0),
    }));
  }

  async listKnowledgeChunks(knowledgeIds: string[]): Promise<KnowledgeChunkRecord[]> {
    if (knowledgeIds.length === 0) {
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
      [knowledgeIds],
    );

    return result.rows.map(mapKnowledgeChunkRow);
  }

  async searchLexical(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]> {
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
      [classified.lexicalQuery || classified.exactTerms.join(' '), options.project ?? null, options.rejectedKnowledgeIds ?? [], options.limit],
    );

    return result.rows.map((row, index) => mapCandidateRow(row, index));
  }

  async searchVector(embedding: number[], options: SearchOptions): Promise<SearchCandidate[]> {
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
      [vectorLiteral(embedding), options.project ?? null, options.rejectedKnowledgeIds ?? [], options.limit],
    );

    return result.rows.map((row, index) => mapCandidateRow(row, index));
  }

  async searchMetadata(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]> {
    const terms = [
      ...classified.files,
      ...classified.symbols,
      ...classified.errors,
      ...classified.technologies,
      ...classified.businessAreas,
      ...classified.exactTerms,
    ].map(normalizeLabel).filter(Boolean);
    const likes = terms.map((term) => `%${term.toLowerCase()}%`);

    if (terms.length === 0) {
      return [];
    }

    const result = await this.pool.query(
      `
        ${candidateSelect('metadata', '0.92')}
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
              WHERE kl.knowledge_id = ki.id AND l.normalized_value = ANY($2::text[])
            )
          )
        ORDER BY ki.trust_level DESC, ki.updated_at DESC
        LIMIT $5
      `,
      [likes, terms, options.project ?? null, options.rejectedKnowledgeIds ?? [], options.limit],
    );

    return result.rows.map((row, index) => mapCandidateRow(row, index));
  }

  async searchMemories(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]> {
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
        options.rejectedKnowledgeIds ?? [],
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
    const seedKnowledgeIds = options.seedKnowledgeIds ?? [];

    if (graphTargets.length === 0 && seedKnowledgeIds.length === 0) {
      return [];
    }

    const result = await this.pool.query(
      `
        WITH graph_targets AS (
          SELECT target->>'kind' AS kind, target->>'value' AS value
          FROM jsonb_array_elements($1::jsonb) target
        ),
        graph_matches AS (
          SELECT
            kr.from_knowledge_id AS knowledge_id,
            0.95 * kr.confidence AS graph_score,
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
          UNION ALL
          SELECT
            kr.target_knowledge_id AS knowledge_id,
            0.68 * kr.confidence AS graph_score,
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
          UNION ALL
          SELECT
            kr.from_knowledge_id AS knowledge_id,
            0.68 * kr.confidence AS graph_score,
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
        options.rejectedKnowledgeIds ?? [],
        options.limit,
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
    const projectId = input.project ? await this.projectIdByName(this.pool, input.project) : null;
    const result = await this.pool.query<{ id: string }>(
      `
        INSERT INTO context_queries (project_id, prompt, query_fingerprint, classified, token_budget)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [projectId, input.prompt, input.fingerprint, input.classified, input.tokenBudget],
    );

    return result.rows[0].id;
  }

  async saveContextPack(pack: ContextPack): Promise<void> {
    const projectId = pack.project ? await this.projectIdByName(this.pool, pack.project) : null;
    await this.pool.query(
      `
        INSERT INTO context_packs (id, query_id, project_id, confidence, status, pack)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          confidence = EXCLUDED.confidence,
          status = EXCLUDED.status,
          pack = EXCLUDED.pack
      `,
      [pack.id, pack.queryId ?? null, projectId, pack.confidence, pack.status, pack],
    );
  }

  async listContextPacks(options: ListRecordsOptions): Promise<ContextPack[]> {
    const result = await this.pool.query<{ pack: ContextPack; status: ContextPack['status'] }>(
      `
        SELECT cp.pack, cp.status
        FROM context_packs cp
        LEFT JOIN projects p ON p.id = cp.project_id
        WHERE ($2::text IS NULL OR p.name = $2)
          AND ($3::text IS NULL OR cp.status = $3)
        ORDER BY cp.created_at DESC
        LIMIT $1
      `,
      [options.limit, options.project ?? null, options.status ?? null],
    );

    return result.rows.map((row) => ({ ...row.pack, status: row.status }));
  }

  async getContextPack(id: string): Promise<ContextPack | undefined> {
    const result = await this.pool.query<{ pack: ContextPack; status: ContextPack['status'] }>(
      'SELECT pack, status FROM context_packs WHERE id = $1',
      [id],
    );

    const row = result.rows[0];
    return row ? { ...row.pack, status: row.status } : undefined;
  }

  async recordFeedback(input: FeedbackInput): Promise<void> {
    const projectId = input.project ? await this.projectIdByName(this.pool, input.project) : null;
    await this.pool.query(
      `
        INSERT INTO feedback_events (
          context_pack_id, project_id, feedback_type, reason, rejected_knowledge_ids, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        input.contextPackId ?? null,
        projectId,
        input.feedbackType,
        input.reason ?? null,
        input.rejectedKnowledgeIds ?? [],
        input.metadata ?? {},
      ],
    );

    if (input.contextPackId) {
      const status = input.feedbackType === 'selected' ? 'selected' : 'rejected';
      const timestampColumn = status === 'selected' ? 'selected_at' : 'rejected_at';
      await this.pool.query(
        `UPDATE context_packs SET status = $1, ${timestampColumn} = now() WHERE id = $2`,
        [status, input.contextPackId],
      );
    }
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
    if (knowledgeIds.length === 0) {
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
          WHERE fe.feedback_type <> 'missing_context'
            AND (
              fe.feedback_type = 'selected'
              OR cardinality(fe.rejected_knowledge_ids) = 0
            )
            AND ($2::text IS NULL OR fp.name = $2 OR pp.name = $2)
        ),
        relevant_feedback AS (
          SELECT * FROM explicit_feedback
          UNION ALL
          SELECT * FROM pack_feedback
        )
        SELECT
          rf.knowledge_id,
          COUNT(*) FILTER (WHERE rf.feedback_type = 'selected')::int AS selected_count,
          COUNT(*) FILTER (WHERE rf.feedback_type = 'rejected')::int AS rejected_count,
          COUNT(*) FILTER (WHERE rf.feedback_type = 'irrelevant')::int AS irrelevant_count,
          COUNT(*) FILTER (WHERE rf.feedback_type = 'stale')::int AS stale_count,
          (array_agg(rf.feedback_type ORDER BY rf.created_at DESC))[1] AS latest_feedback_type,
          max(rf.created_at) AS latest_feedback_at
        FROM relevant_feedback rf
        WHERE rf.knowledge_id = ANY($1::uuid[])
        GROUP BY rf.knowledge_id
      `,
      [knowledgeIds, options.project ?? null],
    );

    return new Map(result.rows.map((row) => {
      const summary: KnowledgeFeedbackSummary = {
        knowledgeId: String(row.knowledge_id),
        selectedCount: Number(row.selected_count ?? 0),
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
        input.rejectedKnowledgeIds ?? [],
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

    const result = await this.pool.query(
      `
        UPDATE reflection_drafts d
        SET status = $2,
          metadata = $3
        WHERE d.id = $1
        RETURNING d.id, d.title, d.summary, d.content, d.item_type, d.trigger_type,
          d.status, d.suggested_labels, d.duplicate_candidates, d.metadata,
          d.created_at,
          (SELECT p.name FROM projects p WHERE p.id = d.project_id) AS project
      `,
      [
        id,
        patch.status ?? current.status,
        patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
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
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async exportBackup(): Promise<BackupExportData> {
    const tables = await Promise.all(BACKUP_TABLES.map(async (table) => {
      const result = await this.pool.query<Record<string, unknown>>(table.selectSql);
      return {
        name: table.name,
        rows: result.rows.map(normalizeBackupRow),
      };
    }));

    return { tables };
  }

  async restoreBackup(input: { tables: BackupTableData[]; dryRun?: boolean; replace?: boolean }): Promise<Record<BackupTableName, number>> {
    const counts = Object.fromEntries(
      BACKUP_TABLES.map((table) => [table.name, tableRows(input.tables, table.name).length]),
    ) as Record<BackupTableName, number>;

    if (input.dryRun) {
      return counts;
    }

    if (!input.replace) {
      throw new StoreError('Backup restore requires replace=true unless dryRun=true.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`TRUNCATE ${BACKUP_TABLES.map((table) => table.name).join(', ')} RESTART IDENTITY CASCADE`);

      for (const table of BACKUP_TABLES) {
        for (const row of tableRows(input.tables, table.name)) {
          await insertBackupRow(client, table, row);
        }
      }

      await client.query('COMMIT');
      return counts;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

  private async attachLabels(client: PoolClient, knowledgeId: string, labels: LabelInput[]): Promise<void> {
    for (const label of labels) {
      const result = await client.query<{ id: string }>(
        `
          INSERT INTO labels (label_type, value, normalized_value)
          VALUES ($1, $2, $3)
          ON CONFLICT (label_type, normalized_value) DO UPDATE SET value = EXCLUDED.value
          RETURNING id
        `,
        [label.type, label.value, normalizeLabel(label.value)],
      );

      await client.query(
        `
          INSERT INTO knowledge_labels (knowledge_id, label_id, weight)
          VALUES ($1, $2, $3)
          ON CONFLICT (knowledge_id, label_id) DO UPDATE SET weight = EXCLUDED.weight
        `,
        [knowledgeId, result.rows[0].id, label.weight ?? 1],
      );
    }
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
        input.metadata ?? {},
      ],
    );
    return mapRelationRow(result.rows[0]);
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

function mapKnowledgeRow(row: Record<string, unknown>): StoredKnowledge {
  return {
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    project: String(row.project),
    sourceType: row.source_type ? String(row.source_type) : undefined,
    sourceUri: row.source_uri ? String(row.source_uri) : undefined,
    status: row.status as StoredKnowledge['status'],
    itemType: row.item_type as StoredKnowledge['itemType'],
    title: String(row.title),
    summary: String(row.summary ?? ''),
    content: String(row.content),
    trustLevel: Number(row.trust_level ?? 50),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    labels: (row.labels ?? []) as LabelInput[],
    references: (row.references ?? []) as ReferenceInput[],
    freshnessAt: row.freshness_at ? toIso(row.freshness_at) : undefined,
    createdAt: toIso(row.created_at),
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
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
  const orphaned = `
    (
      NOT EXISTS (SELECT 1 FROM knowledge_references kr WHERE kr.knowledge_id = ki.id)
      AND NOT EXISTS (SELECT 1 FROM knowledge_labels kl WHERE kl.knowledge_id = ki.id)
    )
  `;

  if (review === 'questionable') {
    return `(${unsafe} OR ${lowTrust} OR ${stale} OR ${rejected} OR ${irrelevant} OR ki.status <> 'approved')`;
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

function shouldDropInferredRelationsForStatus(status: StoredKnowledge['status'] | undefined): boolean {
  return status === 'archived' || status === 'blocked';
}

function normalizeBackupRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
  );
}

function tableRows(tables: BackupTableData[], name: BackupTableName): Array<Record<string, unknown>> {
  return tables.find((table) => table.name === name)?.rows ?? [];
}

async function insertBackupRow(
  client: PoolClient,
  table: BackupTableDefinition,
  row: Record<string, unknown>,
): Promise<void> {
  const placeholders = table.columns.map((column, index) => {
    const cast = table.casts?.[column];
    return cast ? `$${index + 1}::${cast}` : `$${index + 1}`;
  });
  const values = table.columns.map((column) => row[column] ?? null);

  await client.query(
    `
      INSERT INTO ${table.name} (${table.columns.join(', ')})
      VALUES (${placeholders.join(', ')})
    `,
    values,
  );
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

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => Number(value.toFixed(8))).join(',')}]`;
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}
