import type { AppConfig } from '../config.js';
import { HashModelProvider, OpenAiModelProvider, type ModelProvider } from './provider.js';
import { buildOllamaRegistry, buildProviderRegistry } from './registry.js';

export function createModelProvider(config: AppConfig): ModelProvider {
  if (config.modelProvider === 'openai' && config.openAiApiKey) {
    return new OpenAiModelProvider(config);
  }

  if (config.modelProvider === 'local') {
    const registry = buildProviderRegistry(config);
    if (registry) return registry;
  }

  if (config.modelProvider === 'ollama') {
    const registry = buildOllamaRegistry(config);
    if (registry) return registry;
  }

  return new HashModelProvider(config.embeddingDimensions);
}
