import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { createModelProvider } from '../src/model/factory.js';
import { LocalCrossEncoderProvider } from '../src/model/local-provider.js';
import { reembedMissing } from '../src/storage/reembed.js';

const config = loadConfig();
if (config.storage.store !== 'postgres') {
  process.stderr.write('[tuberosa] reembed skipped: TUBEROSA_STORE is not postgres.\n');
  process.exit(0);
}

// Carry-over D: gate against irreversible hash backfill when provider=local and model is unavailable.
if (config.model.provider === 'local' && process.env.TUBEROSA_REEMBED_ALLOW_HASH !== 'true') {
  const probe = new LocalCrossEncoderProvider({
    embeddingDimensions: config.model.embeddingDimensions,
    embeddingModelId: config.model.embeddingModel,
  });
  if (!(await probe.hasLocalEmbedder())) {
    process.stderr.write(
      '[tuberosa] reembed aborted: the local embedding model is unavailable and backfilling with hash vectors '
      + 'would be irreversible. Fix the model (run `npx tuberosa init`) or set TUBEROSA_REEMBED_ALLOW_HASH=true to override.\n',
    );
    process.exit(1);
  }
}

const pool = new Pool({ connectionString: config.storage.databaseUrl });
const provider = createModelProvider(config);

// Carry-over E: catch framing so a failure prints one guided line before rethrowing.
try {
  const result = await reembedMissing(pool, (text) => provider.embed(text), {
    onProgress: (table, done) => process.stderr.write(`[tuberosa] reembed ${table}: ${done}\n`),
  });
  process.stderr.write(
    `[tuberosa] reembed complete: ${result.knowledge_chunks} chunk(s), ${result.knowledge_atoms} atom(s).\n`,
  );
} catch (error) {
  process.stderr.write(`[tuberosa] reembed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  throw error;
} finally {
  await pool.end();
}
