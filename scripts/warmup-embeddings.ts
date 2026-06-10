/**
 * Spec A — `tuberosa init` warm-up: download/load the local embedding model NOW
 * so the agent's first real call is fast, and FAIL the init if the default
 * install would silently degrade to hash.
 *
 * Exit codes: 0 = ready (or provider is not 'local' — nothing to warm),
 *             1 = local model failed to load or produced wrong dimensions.
 */
import { loadConfig } from '../src/config.js';
import { LocalCrossEncoderProvider } from '../src/model/local-provider.js';

const config = loadConfig();
if (config.model.provider !== 'local') {
  process.stderr.write(`[tuberosa] warmup skipped: model provider is '${config.model.provider}'.\n`);
  process.exit(0);
}

const provider = new LocalCrossEncoderProvider({
  embeddingDimensions: config.model.embeddingDimensions,
  embeddingModelId: config.model.embeddingModel,
});

if (!(await provider.hasLocalEmbedder())) {
  process.stderr.write(
    '[tuberosa] embedding model failed to load/download. Check network/proxy and disk space, '
    + 'or re-run `npx tuberosa init --embedded` for volatile trial mode.\n',
  );
  process.exit(1);
}

const vector = await provider.embed('tuberosa warmup');
if (vector.length !== config.model.embeddingDimensions) {
  process.stderr.write(
    `[tuberosa] embedding model produced ${vector.length} dims but EMBEDDING_DIMENSIONS=${config.model.embeddingDimensions}. `
    + 'Fix TUBEROSA_EMBEDDING_MODEL / EMBEDDING_DIMENSIONS so they agree.\n',
  );
  process.exit(1);
}
process.stderr.write(`[tuberosa] embedding model ready (${config.model.embeddingModel}, ${vector.length} dims).\n`);
