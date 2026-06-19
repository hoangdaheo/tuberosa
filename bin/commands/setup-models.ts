import type { CliInvocation, CommandIo, CommandResult } from './types.js';
import { LocalCrossEncoderProvider } from '../../src/model/local-provider.js';

export interface SetupModelsDeps {
  makeProbe?: () => { verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }> };
}

/**
 * `tuberosa setup-models` — download + verify the local embedding model and
 * cross-encoder so real-world runs never fall back to fake (hash) search.
 * Idempotent: re-running with a warm cache just re-verifies.
 */
export async function setupModelsCommand(
  _invocation: CliInvocation,
  io: CommandIo,
  deps: SetupModelsDeps = {},
): Promise<CommandResult> {
  const dims = io.env.EMBEDDING_DIMENSIONS ? Number(io.env.EMBEDDING_DIMENSIONS) : 384;
  const makeProbe = deps.makeProbe ?? (() => new LocalCrossEncoderProvider({ embeddingDimensions: dims }));
  io.out('Setting up local models (this downloads on first run; may take a few minutes)...');
  const report = await makeProbe().verifyReady();

  if (report.embedder) io.out(`✓ embedding model ready (${report.dims} dims)`);
  else io.err('✗ embedding model failed to load — check your network/proxy and disk space.');

  if (report.reranker) io.out('✓ cross-encoder reranker ready');
  else io.err('✗ cross-encoder reranker failed to load — check your network/proxy and disk space.');

  const ok = report.embedder && report.reranker;
  io.out(ok ? 'Local models are ready. Real search is enabled.' : 'Setup incomplete — see errors above.');
  return { exitCode: ok ? 0 : 1 };
}
