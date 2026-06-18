import type { AppConfig } from '../config.js';
import { HashModelProvider, OpenAiModelProvider, type ModelProvider } from './provider.js';
import { buildOllamaRegistry, buildProviderRegistry } from './registry.js';
import { ModelProviderError } from '../errors.js';

export function createModelProvider(config: AppConfig): ModelProvider {
  if (config.model.provider === 'openai' && config.model.openAiApiKey) {
    return new OpenAiModelProvider(config);
  }

  if (config.model.provider === 'local') {
    const registry = buildProviderRegistry(config);
    if (registry) return registry;
  }

  if (config.model.provider === 'ollama') {
    const registry = buildOllamaRegistry(config);
    if (registry) return registry;
  }

  if (config.model.provider === 'hash' || config.model.allowHashFallback) {
    return new HashModelProvider(config.model.embeddingDimensions);
  }

  throw new ModelProviderError(
    `model provider '${config.model.provider}' could not be initialized and hash fallback is disabled. `
    + 'Set the required credentials, run `npx tuberosa setup-models`, or set TUBEROSA_ALLOW_HASH_FALLBACK=true to opt into degraded mode.',
  );
}
