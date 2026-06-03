import type { AppConfig } from '../config.js';
import { HashModelProvider, OpenAiModelProvider, type ModelProvider } from './provider.js';
import { buildOllamaRegistry, buildProviderRegistry } from './registry.js';

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

  return new HashModelProvider(config.model.embeddingDimensions);
}
