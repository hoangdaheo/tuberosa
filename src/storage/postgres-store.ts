import { Pool, type PoolClient } from 'pg';
import type {
  ClassifiedQuery,
  ContextPack,
  FeedbackInput,
  KnowledgeInput,
  LabelInput,
  ReferenceInput,
  ReflectionDraft,
  ReflectionDraftInput,
  SearchCandidate,
  SearchOptions,
  StoredKnowledge,
} from '../types.js';
import { sha256 } from '../util/hash.js';
import { estimateTokens, normalizeLabel } from '../util/text.js';
import type { ChunkInput, KnowledgeStore } from './store.js';

type Queryable = Pool | PoolClient;

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

      const knowledgeResult = await client.query<{ id: string }>(
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

      const knowledgeId = knowledgeResult.rows[0].id;
      await this.attachLabels(client, knowledgeId, input.labels ?? []);
      await this.attachReferences(client, knowledgeId, input.references ?? []);
      await this.insertChunks(client, knowledgeId, projectId, chunks);
      await client.query('COMMIT');

      const stored = await this.getKnowledge(knowledgeId);
      if (!stored) {
        throw new Error(`Knowledge item ${knowledgeId} was created but could not be read back.`);
      }

      return stored;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listKnowledge(options: { project?: string; query?: string; limit: number }): Promise<StoredKnowledge[]> {
    const params: unknown[] = [options.limit];
    const filters: string[] = ['ki.status = $2'];
    params.push('approved');

    if (options.project) {
      params.push(options.project);
      filters.push(`p.name = $${params.length}`);
    }

    if (options.query) {
      params.push(`%${options.query.toLowerCase()}%`);
      filters.push(`(lower(ki.title) LIKE $${params.length} OR lower(ki.summary) LIKE $${params.length} OR lower(ki.content) LIKE $${params.length})`);
    }

    const result = await this.pool.query(
      `
        ${knowledgeSelect()}
        WHERE ${filters.join(' AND ')}
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
          suggested_labels, duplicate_candidates, created_at
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
          updated.suggested_labels, updated.duplicate_candidates, updated.created_at
        FROM updated
        LEFT JOIN projects p ON p.id = updated.project_id
      `,
      [id],
    );

    return result.rows[0] ? mapReflectionDraftRow(result.rows[0]) : undefined;
  }

  async close(): Promise<void> {
    await this.pool.end();
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
}

function knowledgeSelect(): string {
  return `
    SELECT
      ki.id,
      p.id AS project_id,
      p.name AS project,
      ki.item_type,
      ki.title,
      ki.summary,
      ki.content,
      ki.trust_level,
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
  `;
}

function candidateSelect(source: string, scoreExpression: string): string {
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
      ki.metadata,
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

function mapKnowledgeRow(row: Record<string, unknown>): StoredKnowledge {
  return {
    id: String(row.id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    project: String(row.project),
    itemType: row.item_type as StoredKnowledge['itemType'],
    title: String(row.title),
    summary: String(row.summary ?? ''),
    content: String(row.content),
    trustLevel: Number(row.trust_level ?? 50),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    labels: (row.labels ?? []) as LabelInput[],
    references: (row.references ?? []) as ReferenceInput[],
    createdAt: toIso(row.created_at),
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
  };
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
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

function mapReflectionDraftRow(row: Record<string, unknown>, project?: string): ReflectionDraft {
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
    duplicateCandidates: (row.duplicate_candidates ?? []) as ReflectionDraft['duplicateCandidates'],
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
