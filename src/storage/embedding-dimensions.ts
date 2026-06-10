/**
 * Spec A — enforce the "embedding dimensions must be consistent" constraint
 * mechanically: the vector(N) columns must match EMBEDDING_DIMENSIONS, or we
 * fail fast at startup with a guided error instead of corrupting searches.
 */

export interface DimensionQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<{ type?: string }> }>;
}

const EMBEDDING_COLUMNS = [
  { table: 'knowledge_chunks', column: 'embedding' },
  { table: 'knowledge_atoms', column: 'embedding' },
] as const;

export function parseVectorDimension(formatted: string): number | null {
  const match = /^vector\((\d+)\)$/.exec(formatted.trim());
  return match ? Number(match[1]) : null;
}

export async function validateEmbeddingDimensions(db: DimensionQueryable, expected: number): Promise<void> {
  for (const target of EMBEDDING_COLUMNS) {
    const result = await db.query(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
       WHERE attrelid = to_regclass($1) AND attname = $2`,
      [target.table, target.column],
    );
    const formatted = result.rows[0]?.type;
    if (!formatted) continue; // table not created yet; migrations define the right dim
    const actual = parseVectorDimension(formatted);
    if (actual !== null && actual !== expected) {
      throw new Error(
        `Embedding dimension mismatch: ${target.table}.${target.column} is vector(${actual}) `
        + `but EMBEDDING_DIMENSIONS=${expected}. Run 'npx tuberosa init' to apply migrations, `
        + `or set EMBEDDING_DIMENSIONS=${actual} to match the database.`,
      );
    }
  }
}
