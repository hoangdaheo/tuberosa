import type { Pool, PoolClient } from 'pg';

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
