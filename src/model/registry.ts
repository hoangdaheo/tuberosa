import type { AppConfig } from '../config.js';
import type {
  QueryRewriteInput,
  QueryRewriteResult,
  RerankInput,
  RerankResult,
} from '../types.js';
import { HashModelProvider } from './provider.js';
import type { ModelProvider } from './provider.js';
import { LocalCrossEncoderProvider } from './local-provider.js';
import { OllamaRerankProvider } from './ollama-provider.js';

export type ModelCapability = 'embed' | 'rewriteQuery' | 'rerank';

export interface CapabilityProvider extends ModelProvider {
  /** Capabilities the provider can fulfil natively. Missing capabilities defer to the fallback. */
  capabilities: ModelCapability[];
  /** Stable identifier used in `RerankResult.model` and logs. */
  name: string;
}

export interface RegistryEntry {
  capability: ModelCapability;
  providerName: string;
}

/**
 * Phase 4 — Provider registry that composes capabilities across providers.
 *
 * Goal: let a user run `hash embeddings + local cross-encoder rerank` (i.e., no OpenAI key
 * but with the ~150MB BGE reranker download) without writing new wiring. The composed
 * provider implements `ModelProvider` so it drops into `RetrievalService` unchanged.
 */
export class ProviderRegistry implements ModelProvider {
  private readonly entries = new Map<ModelCapability, CapabilityProvider>();
  private readonly fallback: ModelProvider;

  constructor(fallback: ModelProvider) {
    this.fallback = fallback;
  }

  register(provider: CapabilityProvider): void {
    for (const capability of provider.capabilities) {
      if (!this.entries.has(capability)) {
        this.entries.set(capability, provider);
      }
    }
  }

  describe(): RegistryEntry[] {
    return [...this.entries.entries()].map(([capability, provider]) => ({
      capability,
      providerName: provider.name,
    }));
  }

  async embed(text: string): Promise<number[]> {
    return (this.entries.get('embed') ?? this.fallback).embed(text);
  }

  async rewriteQuery(input: QueryRewriteInput): Promise<QueryRewriteResult | undefined> {
    return (this.entries.get('rewriteQuery') ?? this.fallback).rewriteQuery(input);
  }

  async rerank(input: RerankInput): Promise<RerankResult> {
    return (this.entries.get('rerank') ?? this.fallback).rerank(input);
  }
}

/**
 * Build a composed ModelProvider from AppConfig. Selection rules:
 *
 * - `TUBEROSA_MODEL_PROVIDER=hash` (default): pure hash provider, no registry needed.
 * - `TUBEROSA_MODEL_PROVIDER=openai`: keep current OpenAI behaviour (handled by createModelProvider).
 * - `TUBEROSA_MODEL_PROVIDER=local`: hash embeddings + local cross-encoder rerank.
 *
 * Returns the underlying `ModelProvider` so callers don't need to import the registry type.
 */
export function buildProviderRegistry(config: AppConfig): ModelProvider | null {
  if (config.modelProvider !== 'local') return null;

  const hash = new HashModelProvider(config.embeddingDimensions);
  const registry = new ProviderRegistry(hash);
  registry.register(asCapabilityProvider({
    name: 'hash',
    provider: hash,
    capabilities: ['embed', 'rewriteQuery'],
  }));
  registry.register(asCapabilityProvider({
    name: 'local-cross-encoder',
    provider: new LocalCrossEncoderProvider({ embeddingDimensions: config.embeddingDimensions, fallback: hash }),
    capabilities: ['rerank'],
  }));
  return registry;
}

/**
 * Build a composed ModelProvider that uses Ollama's `/api/rerank` for reranking and
 * the hash provider for embeddings + query rewrite. The OllamaRerankProvider falls
 * back to hash rerank if the HTTP call fails, so this path is safe even without a
 * running Ollama server.
 */
export function buildOllamaRegistry(config: AppConfig): ModelProvider | null {
  if (config.modelProvider !== 'ollama') return null;

  const hash = new HashModelProvider(config.embeddingDimensions);
  const registry = new ProviderRegistry(hash);
  registry.register(asCapabilityProvider({
    name: 'hash',
    provider: hash,
    capabilities: ['embed', 'rewriteQuery'],
  }));
  registry.register(asCapabilityProvider({
    name: 'ollama-reranker',
    provider: new OllamaRerankProvider({
      modelId: config.ollamaRerankModel,
      ollamaUrl: config.ollamaUrl,
      timeoutMs: config.ollamaTimeoutMs,
      embeddingDimensions: config.embeddingDimensions,
      fallback: hash,
    }),
    capabilities: ['rerank'],
  }));
  return registry;
}

function asCapabilityProvider(input: { name: string; provider: ModelProvider; capabilities: ModelCapability[] }): CapabilityProvider {
  return {
    name: input.name,
    capabilities: input.capabilities,
    embed: input.provider.embed.bind(input.provider),
    rewriteQuery: input.provider.rewriteQuery.bind(input.provider),
    rerank: input.provider.rerank.bind(input.provider),
  };
}
