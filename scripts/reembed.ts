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

// Single provider instance: for local, use one LocalCrossEncoderProvider as both
// the availability gate and the embed source — avoids loading two ONNX sessions.
let embedSource: { embed(text: string): Promise<number[]> };
if (config.model.provider === 'local') {
  const local = new LocalCrossEncoderProvider({
    embeddingDimensions: config.model.embeddingDimensions,
    embeddingModelId: config.model.embeddingModel,
  });
  if (!(await local.hasLocalEmbedder()) && process.env.TUBEROSA_REEMBED_ALLOW_HASH !== 'true') {
    process.stderr.write(
      '[tuberosa] reembed aborted: the local embedding model is unavailable and backfilling with hash vectors '
      + 'would be irreversible. Fix the model (run `npx tuberosa init`) or set TUBEROSA_REEMBED_ALLOW_HASH=true to override.\n',
    );
    process.exit(1);
  }
  embedSource = local;
} else {
  embedSource = createModelProvider(config);
}

const pool = new Pool({ connectionString: config.storage.databaseUrl });

// Catch prints one guided line and sets a flag; finally always closes the pool.
let failed = false;
try {
  const result = await reembedMissing(pool, (text) => embedSource.embed(text), {
    onProgress: (table, done) => process.stderr.write(`[tuberosa] reembed ${table}: ${done}\n`),
  });
  process.stderr.write(
    `[tuberosa] reembed complete: ${result.knowledge_chunks} chunk(s), ${result.knowledge_atoms} atom(s).\n`,
  );
} catch (error) {
  process.stderr.write(`[tuberosa] reembed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  failed = true;
} finally {
  await pool.end();
}
if (failed) process.exit(1);
