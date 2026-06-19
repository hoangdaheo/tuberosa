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
  if (config.model.allowHashFallback) return;
  if (config.env === 'test') return; // unit/integration tests construct providers directly

  if (config.model.provider === 'ollama') {
    // The ollama provider gives real reranking but HASH (fake) embeddings — there is no
    // real ollama embedder wired. Refuse to start rather than silently serve fake search.
    throw new ModelProviderError(
      'The ollama provider uses fake hash embeddings (it only provides real reranking) — refusing to start with silent fake search. '
      + 'Use TUBEROSA_MODEL_PROVIDER=local (run `npx tuberosa setup-models`) or =openai for real embeddings, '
      + 'or set TUBEROSA_ALLOW_HASH_FALLBACK=true to accept hash embeddings with ollama reranking.',
    );
  }

  if (config.model.provider !== 'local') return;
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
