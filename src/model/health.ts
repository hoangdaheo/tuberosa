import type { AppConfig } from '../config.js';
import { ModelProviderError } from '../errors.js';
import type { ModelProvider } from './provider.js';

interface ReadinessProbe { verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }>; }

function hasVerifyReady(models: ModelProvider): models is ModelProvider & ReadinessProbe {
  return typeof (models as Partial<ReadinessProbe>).verifyReady === 'function';
}

/**
 * Real-world guard: when running the local provider in strict mode, refuse to
 * start unless the local embedding model AND cross-encoder actually load. This
 * is the boundary that stops Tuberosa silently serving fake (hash) search.
 */
export async function assertModelsReady(models: ModelProvider, config: AppConfig): Promise<void> {
  if (config.model.provider !== 'local' || config.model.allowHashFallback) return;
  if (config.env === 'test') return; // unit/integration tests construct providers directly
  if (!hasVerifyReady(models)) return;

  const report = await models.verifyReady();
  const remedy = 'Run `npx tuberosa setup-models` to download the local models, or set TUBEROSA_ALLOW_HASH_FALLBACK=true for degraded mode.';
  if (!report.embedder) {
    throw new ModelProviderError(`Local embedding model is unavailable — refusing to start with fake search. ${remedy}`);
  }
  if (!report.reranker) {
    throw new ModelProviderError(`Local cross-encoder is unavailable — refusing to start with fake search. ${remedy}`);
  }
}
