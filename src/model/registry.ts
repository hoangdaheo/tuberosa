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
import { OllamaGenerationProvider } from './ollama-generation.js';

export type ModelCapability = 'embed' | 'rewriteQuery' | 'rerank' | 'extractAtoms' | 'judgeAtomUtility';

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
 * Goal: let a user run `local embeddings + local cross-encoder rerank (hash as fallback)` (i.e., no OpenAI key
 * but with the ~150MB BGE reranker download) without writing new wiring. The composed
 * provider implements `ModelProvider` so it drops into `RetrievalService` unchanged.
 */
export class ProviderRegistry implements ModelProvider {
  /**
   * SP2 — extraction capabilities are instance properties assigned only when
   * a provider supplies them. A registry without an extraction provider has
   * NO extractAtoms property, which is what AtomExtractor's capability
   * check requires.
   */
  extractAtoms?: ModelProvider['extractAtoms'];
  judgeAtomUtility?: ModelProvider['judgeAtomUtility'];

  private readonly entries = new Map<ModelCapability, CapabilityProvider>();
  private readonly extractionEntries: RegistryEntry[] = [];
  private readonly fallback: ModelProvider;
  private healthProvider?: { verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }> };

  constructor(fallback: ModelProvider) {
    this.fallback = fallback;
  }

  setHealthProvider(provider: { verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }> }): void {
    this.healthProvider = provider;
  }

  async verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }> {
    if (!this.healthProvider) return { embedder: true, reranker: true, dims: null };
    return this.healthProvider.verifyReady();
  }

  register(provider: CapabilityProvider): void {
    for (const capability of provider.capabilities) {
      if (!this.entries.has(capability)) {
        this.entries.set(capability, provider);
      }
    }
  }

  registerExtraction(
    name: string,
    provider: Pick<ModelProvider, 'extractAtoms' | 'judgeAtomUtility'>,
  ): void {
    if (provider.extractAtoms && !this.extractAtoms) {
      this.extractAtoms = provider.extractAtoms.bind(provider);
      this.extractionEntries.push({ capability: 'extractAtoms', providerName: name });
    }
    if (provider.judgeAtomUtility && !this.judgeAtomUtility) {
      this.judgeAtomUtility = provider.judgeAtomUtility.bind(provider);
      this.extractionEntries.push({ capability: 'judgeAtomUtility', providerName: name });
    }
  }

  describe(): RegistryEntry[] {
    return [
      ...[...this.entries.entries()].map(([capability, provider]) => ({
        capability,
        providerName: provider.name,
      })),
      ...this.extractionEntries,
    ];
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
 * - `TUBEROSA_MODEL_PROVIDER=hash`: pure hash provider, no registry needed.
 * - `TUBEROSA_MODEL_PROVIDER=openai`: keep current OpenAI behaviour (handled by createModelProvider).
 * - `TUBEROSA_MODEL_PROVIDER=local` (default): local embeddings (bge-small) + local cross-encoder rerank.
 *
 * Returns the underlying `ModelProvider` so callers don't need to import the registry type.
 */
export function buildProviderRegistry(config: AppConfig): ModelProvider | null {
  if (config.model.provider !== 'local') return null;

  const hash = new HashModelProvider(config.model.embeddingDimensions);
  const registry = new ProviderRegistry(hash);
  const local = new LocalCrossEncoderProvider({
    embeddingDimensions: config.model.embeddingDimensions,
    embeddingModelId: config.model.embeddingModel,
    fallback: hash,
    strict: !config.model.allowHashFallback,
  });
  registry.register(asCapabilityProvider({
    name: 'hash',
    provider: hash,
    capabilities: ['rewriteQuery'],
  }));
  registry.register(asCapabilityProvider({
    name: 'local-cross-encoder',
    provider: local,
    capabilities: ['embed', 'rerank'],
  }));
  registry.setHealthProvider(local);
  if (config.model.ollamaExtractModel) {
    registry.registerExtraction('ollama-generation', new OllamaGenerationProvider({
      modelId: config.model.ollamaExtractModel,
      ollamaUrl: config.model.ollamaUrl,
    }));
  }
  return registry;
}

/**
 * Build a composed ModelProvider that uses Ollama's `/api/rerank` for reranking and
 * the hash provider for embeddings + query rewrite. The OllamaRerankProvider falls
 * back to hash rerank if the HTTP call fails, so this path is safe even without a
 * running Ollama server.
 */
export function buildOllamaRegistry(config: AppConfig): ModelProvider | null {
  if (config.model.provider !== 'ollama') return null;

  const hash = new HashModelProvider(config.model.embeddingDimensions);
  const registry = new ProviderRegistry(hash);
  registry.register(asCapabilityProvider({
    name: 'hash',
    provider: hash,
    capabilities: ['embed', 'rewriteQuery'],
  }));
  registry.register(asCapabilityProvider({
    name: 'ollama-reranker',
    provider: new OllamaRerankProvider({
      modelId: config.model.ollamaRerankModel,
      ollamaUrl: config.model.ollamaUrl,
      timeoutMs: config.model.ollamaTimeoutMs,
      embeddingDimensions: config.model.embeddingDimensions,
      fallback: hash,
    }),
    capabilities: ['rerank'],
  }));

  if (config.model.ollamaExtractModel) {
    registry.registerExtraction('ollama-generation', new OllamaGenerationProvider({
      modelId: config.model.ollamaExtractModel,
      ollamaUrl: config.model.ollamaUrl,
    }));
  } else {
    noteExtractionDisabledOnce();
  }

  return registry;
}

let hasLoggedExtractionDisabled = false;

function noteExtractionDisabledOnce(): void {
  if (hasLoggedExtractionDisabled) return;
  hasLoggedExtractionDisabled = true;
  if ((process.env.NODE_ENV ?? '') === 'test' || process.env.TUBEROSA_SILENT_OLLAMA_PROVIDER === 'true') return;
  process.stderr.write(
    '[tuberosa] atom extraction disabled under ollama; set TUBEROSA_OLLAMA_EXTRACT_MODEL (e.g. qwen2.5:3b-instruct) to enable the LEARN pillar.\n',
  );
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
