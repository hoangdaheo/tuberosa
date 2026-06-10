import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { createModelProvider } from '../src/model/factory.js';
import { reembedMissing } from '../src/storage/reembed.js';

const config = loadConfig();
if (config.storage.store !== 'postgres') {
  process.stderr.write('[tuberosa] reembed skipped: TUBEROSA_STORE is not postgres.\n');
  process.exit(0);
}

const pool = new Pool({ connectionString: config.storage.databaseUrl });
const provider = createModelProvider(config);

try {
  const result = await reembedMissing(pool, (text) => provider.embed(text), {
    onProgress: (table, done) => process.stderr.write(`[tuberosa] reembed ${table}: ${done}\n`),
  });
  process.stderr.write(
    `[tuberosa] reembed complete: ${result.knowledge_chunks} chunk(s), ${result.knowledge_atoms} atom(s).\n`,
  );
} finally {
  await pool.end();
}
