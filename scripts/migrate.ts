import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/storage/migrations.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

try {
  await runMigrations(pool, {
    onApplied: (file) => console.log(`Applied ${file}`),
  });
} finally {
  await pool.end();
}
