import type { Pool } from 'pg';
import type { ClassifiedQuery, ContextPack, ListRecordsOptions } from '../../types.js';
import { isPersistedKnowledgeId } from '../../util/uuid.js';

export class PostgresContextStore {
  constructor(private readonly pool: Pool) {}

  async createContextQuery(input: {
    project?: string;
    prompt: string;
    fingerprint: string;
    classified: ClassifiedQuery;
    tokenBudget: number;
  }): Promise<string> {
    const projectId = input.project ? await this.projectIdByName(input.project) : null;
    const result = await this.pool.query<{ id: string }>(
      `
        INSERT INTO context_queries (project_id, prompt, query_fingerprint, classified, token_budget)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [projectId, input.prompt, input.fingerprint, input.classified, input.tokenBudget],
    );

    return result.rows[0]!.id;
  }

  async saveContextPack(pack: ContextPack): Promise<void> {
    const projectId = pack.project ? await this.projectIdByName(pack.project) : null;
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
    if (!isPersistedKnowledgeId(id)) return undefined;
    const result = await this.pool.query<{ pack: ContextPack; status: ContextPack['status'] }>(
      'SELECT pack, status FROM context_packs WHERE id = $1',
      [id],
    );

    const row = result.rows[0];
    return row ? { ...row.pack, status: row.status } : undefined;
  }

  private async projectIdByName(name: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>('SELECT id FROM projects WHERE name = $1', [name]);
    return result.rows[0]?.id ?? null;
  }
}
