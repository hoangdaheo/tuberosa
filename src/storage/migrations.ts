import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

export interface RunMigrationsOptions {
  migrationsDir?: string;
  onApplied?: (filename: string) => void;
}

const MIGRATION_LOCK_NAMESPACE = 338452971;
const MIGRATION_LOCK_KEY = 195935983;

export async function runMigrations(pool: Pool, options: RunMigrationsOptions = {}): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const migrationsDir = options.migrationsDir ?? join(process.cwd(), 'migrations');
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

      for (const file of files) {
        const existing = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
        if (existing.rowCount) {
          continue;
        }

        await applyMigration(client, migrationsDir, file);
        options.onApplied?.(file);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function applyMigration(client: PoolClient, migrationsDir: string, file: string): Promise<void> {
  const sql = await readFile(join(migrationsDir, file), 'utf8');

  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
