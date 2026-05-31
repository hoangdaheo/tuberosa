import type { Pool, PoolClient } from 'pg';
import type { LabelInput, LabelRecord } from '../../types.js';
import { normalizeLabel } from '../../util/text.js';

export class PostgresLabelStore {
  constructor(private readonly pool: Pool) {}

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

  async attachLabels(client: PoolClient, knowledgeId: string, labels: LabelInput[]): Promise<void> {
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
        [knowledgeId, result.rows[0]!.id, label.weight ?? 1],
      );
    }
  }
}
