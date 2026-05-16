import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

export interface RunMigrationsOptions {
  migrationsDir?: string;
  onApplied?: (filename: string) => void;
}

export async function runMigrations(pool: Pool, options: RunMigrationsOptions = {}): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = options.migrationsDir ?? join(process.cwd(), 'migrations');
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    const existing = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (existing.rowCount) {
      continue;
    }

    await applyMigration(pool, migrationsDir, file);
    options.onApplied?.(file);
  }
}

async function applyMigration(pool: Pool, migrationsDir: string, file: string): Promise<void> {
  const sql = await readFile(join(migrationsDir, file), 'utf8');

  await pool.query('BEGIN');
  try {
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}
