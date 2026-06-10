/**
 * Spec A — backfill embeddings after migration 014 cleared them (or after any
 * provider/model change). Idempotent: only touches rows where embedding IS NULL,
 * so it is safe to interrupt and re-run.
 */

export interface ReembedQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<{ id: string; text: string }> }>;
}

export interface ReembedOptions {
  batchSize?: number;
  onProgress?: (table: string, done: number) => void;
}

export interface ReembedResult {
  knowledge_chunks: number;
  knowledge_atoms: number;
}

const TARGETS = [
  { table: 'knowledge_chunks', textExpr: "coalesce(nullif(contextual_content, ''), content)" },
  { table: 'knowledge_atoms', textExpr: 'claim' },
] as const;

export async function reembedMissing(
  db: ReembedQueryable,
  embed: (text: string) => Promise<number[]>,
  options: ReembedOptions = {},
): Promise<ReembedResult> {
  const batchSize = options.batchSize ?? 50;
  const result: ReembedResult = { knowledge_chunks: 0, knowledge_atoms: 0 };

  for (const target of TARGETS) {
    while (true) {
      const batch = await db.query(
        `SELECT id, ${target.textExpr} AS text FROM ${target.table} WHERE embedding IS NULL ORDER BY id LIMIT $1`,
        [batchSize],
      );
      if (batch.rows.length === 0) break;
      for (const row of batch.rows) {
        const vector = await embed(row.text ?? '');
        await db.query(
          `UPDATE ${target.table} SET embedding = $1::vector WHERE id = $2`,
          [`[${vector.join(',')}]`, row.id],
        );
        result[target.table as keyof ReembedResult] += 1;
      }
      options.onProgress?.(target.table, result[target.table as keyof ReembedResult]);
    }
  }
  return result;
}
