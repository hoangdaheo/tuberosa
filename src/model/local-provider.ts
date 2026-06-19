import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  QueryRewriteInput,
  QueryRewriteResult,
  RerankInput,
  RerankResult,
} from '../types.js';
import { clamp, truncate } from '../util/text.js';
import { HashModelProvider } from './provider.js';
import type { ModelProvider } from './provider.js';
import { ModelProviderError } from '../errors.js';

/**
 * Phase 4 — Local cross-encoder reranker.
 *
 * Default behaviour: lazily import `@xenova/transformers`, instantiate the
 * `bge-reranker-base` (or configured) cross-encoder, and rescore the top-N
 * candidates. The package is intentionally NOT a hard dependency — when the
 * import fails (offline test env, package not installed, model not in cache),
 * we fall back to the `HashModelProvider` rerank so the rest of the pipeline
 * continues to function. This keeps the project install-light and the eval
 * harness deterministic.
 *
 * Embeddings run on a lazily-loaded local model (`Xenova/bge-small-en-v1.5` by
 * default, 384-dim). Query rewrite delegates to the fallback hash provider.
 * When the model cannot load (offline, TUBEROSA_DISABLE_LOCAL_MODELS=true),
 * embed() falls back to hash with ONE stderr warning — never silently.
 */
export interface LocalRerankerOptions {
  /** Pretrained reranker model id. Defaults to `Xenova/bge-reranker-base`. */
  modelId?: string;
  /** Maximum candidates passed to the cross-encoder per request. */
  topK?: number;
  /** Optional cache directory override. Falls back to `~/.cache/tuberosa/models/`. */
  cacheDir?: string;
  /**
   * Optional injected scorer. When provided, the provider uses it instead of
   * loading the ONNX pipeline. Tests rely on this to keep the rerank step
   * deterministic and offline.
   */
  scorer?: LocalCrossEncoderScorer;
  /** Backing provider for embed / rewriteQuery / fallback rerank. Defaults to HashModelProvider. */
  fallback?: ModelProvider;
  /** Embedding dimension (only used when constructing the default hash fallback). */
  embeddingDimensions?: number;
  /** Pretrained embedding model id. Defaults to `Xenova/bge-small-en-v1.5` (384-dim). */
  embeddingModelId?: string;
  /**
   * Optional injected embedder. When provided, the provider uses it instead of
   * loading the ONNX pipeline. Tests rely on this to stay deterministic/offline.
   */
  embedder?: LocalEmbedder;
  /** When true, embed/rerank throw ModelProviderError instead of silently using hash. */
  strict?: boolean;
}

export interface LocalCrossEncoderScorer {
  /** Return a parallel array of relevance scores in [0, 1] for each candidate. */
  score(prompt: string, candidates: Array<{ knowledgeId: string; text: string }>): Promise<number[]>;
  /** Optional dispose hook for the underlying pipeline. */
  dispose?(): Promise<void> | void;
}

export interface LocalEmbedder {
  /** Return one embedding vector for the text. */
  embed(text: string): Promise<number[]>;
  /** Optional dispose hook for the underlying pipeline. */
  dispose?(): Promise<void> | void;
}

const DEFAULT_MODEL_ID = 'onnx-community/bge-reranker-v2-m3-ONNX';
const DEFAULT_TOP_K = 16;
const DEFAULT_EMBEDDING_MODEL_ID = 'Xenova/bge-small-en-v1.5';
const DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'tuberosa', 'models');

export class LocalCrossEncoderProvider implements ModelProvider {
  readonly name = 'local-cross-encoder';

  private readonly fallback: ModelProvider;
  private readonly modelId: string;
  private readonly topK: number;
  private readonly cacheDir: string;
  private readonly embeddingModelId: string;
  private readonly expectedDimensions?: number;
  private readonly strict: boolean;
  private scorerPromise: Promise<LocalCrossEncoderScorer | null> | null = null;
  private embedderPromise: Promise<LocalEmbedder | null> | null = null;
  private hasLoggedLoadFailure = false;
  private hasLoggedEmbedFailure = false;

  constructor(options: LocalRerankerOptions = {}) {
    this.fallback = options.fallback ?? new HashModelProvider(options.embeddingDimensions ?? 384);
    this.modelId = options.modelId ?? process.env.TUBEROSA_RERANKER_MODEL ?? DEFAULT_MODEL_ID;
    this.topK = options.topK ?? Number(process.env.TUBEROSA_RERANKER_TOPK ?? DEFAULT_TOP_K);
    this.cacheDir = options.cacheDir ?? process.env.TUBEROSA_MODEL_CACHE_DIR ?? DEFAULT_CACHE_DIR;
    this.embeddingModelId = options.embeddingModelId ?? process.env.TUBEROSA_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL_ID;
    this.expectedDimensions = options.embeddingDimensions;
    this.strict = options.strict ?? false;
    if (options.scorer) {
      this.scorerPromise = Promise.resolve(options.scorer);
    }
    if (options.embedder) {
      this.embedderPromise = Promise.resolve(options.embedder);
    }
  }

  async embed(text: string): Promise<number[]> {
    const embedder = await this.loadEmbedder();
    if (!embedder) {
      if (this.strict) throw new ModelProviderError('local embedding model unavailable; run `npx tuberosa setup-models`');
      return this.fallback.embed(text);
    }
    try {
      const vector = await embedder.embed(text);
      if (this.expectedDimensions !== undefined && vector.length !== this.expectedDimensions) {
        const message = `local embedder returned ${vector.length} dims, expected ${this.expectedDimensions}; check TUBEROSA_EMBEDDING_MODEL vs EMBEDDING_DIMENSIONS`;
        if (this.strict) throw new ModelProviderError(message);
        this.logEmbedFailure(message);
        this.embedderPromise = Promise.resolve(null);
        return this.fallback.embed(text);
      }
      return vector;
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (this.strict) throw new ModelProviderError(`local embedder threw: ${error instanceof Error ? error.message : String(error)}`);
      this.logEmbedFailure(`local embedder threw: ${error instanceof Error ? error.message : String(error)}`);
      return this.fallback.embed(text);
    }
  }

  /** True when the real local embedding pipeline is loadable (used by the init warm-up). */
  async hasLocalEmbedder(): Promise<boolean> {
    return (await this.loadEmbedder()) !== null;
  }

  /**
   * Probe the REAL local embedder (no hash fallback): returns the raw dimension
   * count it produces, or null when the model is unavailable. Used by the init
   * warm-up to hard-fail on dimension mismatch instead of silently degrading.
   */
  async probeEmbeddingDimensions(): Promise<number | null> {
    const embedder = await this.loadEmbedder();
    if (!embedder) return null;
    try {
      const vector = await embedder.embed('tuberosa warmup probe');
      return vector.length;
    } catch {
      return null;
    }
  }

  /** True when the real local cross-encoder is loadable. */
  async hasLocalReranker(): Promise<boolean> {
    return (await this.loadScorer()) !== null;
  }

  /** Probe both models without falling back. Used by setup-models and the startup health check. */
  async verifyReady(): Promise<{ embedder: boolean; reranker: boolean; dims: number | null }> {
    const dims = await this.probeEmbeddingDimensions();
    const reranker = await this.hasLocalReranker();
    return { embedder: dims !== null, reranker, dims };
  }

  async rewriteQuery(input: QueryRewriteInput): Promise<QueryRewriteResult | undefined> {
    return this.fallback.rewriteQuery(input);
  }

  async rerank(input: RerankInput): Promise<RerankResult> {
    if (input.candidates.length === 0) {
      return { candidates: [] };
    }
    const scorer = await this.loadScorer();
    if (!scorer) {
      if (this.strict) throw new ModelProviderError('local cross-encoder unavailable; run `npx tuberosa setup-models`');
      return this.fallback.rerank(input);
    }

    const windowSize = Math.min(this.topK, input.candidates.length);
    const window = input.candidates.slice(0, windowSize);
    const tail = input.candidates.slice(windowSize);
    const payload = window.map((candidate) => ({
      knowledgeId: candidate.knowledgeId,
      text: truncate(candidate.contextualContent || candidate.content || candidate.summary || candidate.title, 1024),
    }));

    let scores: number[] = [];
    try {
      scores = await scorer.score(input.prompt, payload);
    } catch (error) {
      if (this.strict) throw new ModelProviderError(`local reranker scoring threw: ${error instanceof Error ? error.message : String(error)}`);
      this.logLoadFailure(`local reranker scoring threw: ${error instanceof Error ? error.message : String(error)}`);
      return this.fallback.rerank(input);
    }

    const reranked = window.map((candidate, index) => {
      const localScore = clamp(scores[index] ?? 0, 0, 1);
      const trustScore = clamp(candidate.trustLevel / 100, 0, 1);
      // 0.70 to the local cross-encoder, 0.22 to the fused retrieval score, 0.08 to trust.
      const blended = clamp(localScore * 0.7 + candidate.fusedScore * 0.22 + trustScore * 0.08, 0, 1);
      return {
        ...candidate,
        rerankScore: blended,
        finalScore: blended,
        matchReasons: [...candidate.matchReasons, `local-rerank:${this.modelId}:${localScore.toFixed(3)}`],
        metadata: {
          ...(candidate.metadata ?? {}),
          localRerank: {
            model: this.modelId,
            score: localScore,
          },
        },
      };
    });

    const fallbackForTail = tail.length > 0
      ? (await this.fallback.rerank({ ...input, candidates: tail })).candidates
      : [];

    const merged = [...reranked, ...fallbackForTail]
      .sort((left, right) => right.finalScore - left.finalScore || left.rank - right.rank)
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

    return { candidates: merged, model: this.modelId };
  }

  private async loadEmbedder(): Promise<LocalEmbedder | null> {
    if (this.embedderPromise) return this.embedderPromise;
    this.embedderPromise = this.createDefaultEmbedder();
    return this.embedderPromise;
  }

  private async createDefaultEmbedder(): Promise<LocalEmbedder | null> {
    if (localModelsDisabled()) {
      this.logEmbedFailure('local models disabled (NODE_ENV=test or TUBEROSA_DISABLE_LOCAL_MODELS=true)');
      return null;
    }
    try {
      const result = await dynamicImport('@xenova/transformers');
      if ('error' in result) {
        const err = result.error;
        const isNotFound = err.message.includes('@xenova/transformers')
          && (err.message.includes('Cannot find') || (err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND');
        this.logEmbedFailure(
          isNotFound
            ? '@xenova/transformers is not installed; install it to enable local embeddings'
            : `import of '@xenova/transformers' failed: ${err.message}`,
        );
        return null;
      }
      const transformers = result.module as TransformersModule | null;
      if (!transformers || typeof transformers.pipeline !== 'function') {
        this.logEmbedFailure('@xenova/transformers is not installed; install it to enable local embeddings');
        return null;
      }
      if (transformers.env) {
        transformers.env.cacheDir = this.cacheDir;
      }
      const pipeline = await transformers.pipeline('feature-extraction', this.embeddingModelId, {
        quantized: true,
      });
      return new TransformersEmbedder(pipeline);
    } catch (error) {
      this.logEmbedFailure(`local embedder init failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private logEmbedFailure(reason: string): void {
    if (this.hasLoggedEmbedFailure) return;
    this.hasLoggedEmbedFailure = true;
    if ((process.env.NODE_ENV ?? '') === 'test' || process.env.TUBEROSA_SILENT_LOCAL_PROVIDER === 'true') return;
    process.stderr.write(`[tuberosa] local embedder unavailable; falling back to hash embeddings — ${reason}\n`);
  }

  private async loadScorer(): Promise<LocalCrossEncoderScorer | null> {
    if (this.scorerPromise) return this.scorerPromise;
    this.scorerPromise = this.createDefaultScorer();
    return this.scorerPromise;
  }

  private async createDefaultScorer(): Promise<LocalCrossEncoderScorer | null> {
    if (localModelsDisabled()) {
      this.logLoadFailure('local models disabled (NODE_ENV=test or TUBEROSA_DISABLE_LOCAL_MODELS=true)');
      return null;
    }
    try {
      const result = await dynamicImport('@xenova/transformers');
      if ('error' in result) {
        const err = result.error;
        const isNotFound = err.message.includes('@xenova/transformers')
          && (err.message.includes('Cannot find') || (err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND');
        this.logLoadFailure(
          isNotFound
            ? '@xenova/transformers is not installed; install it to enable local reranking'
            : `import of '@xenova/transformers' failed: ${err.message}`,
        );
        return null;
      }
      const transformers = result.module as TransformersModule | null;
      if (!transformers || typeof transformers.pipeline !== 'function') {
        this.logLoadFailure('@xenova/transformers is not installed; install it to enable local reranking');
        return null;
      }
      if (this.cacheDir && transformers.env) {
        transformers.env.cacheDir = this.cacheDir;
      }
      const pipeline = await transformers.pipeline('text-classification', this.modelId, {
        quantized: true,
      });
      return new TransformersScorer(pipeline);
    } catch (error) {
      this.logLoadFailure(`local reranker init failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private logLoadFailure(reason: string): void {
    if (this.hasLoggedLoadFailure) return;
    this.hasLoggedLoadFailure = true;
    if ((process.env.NODE_ENV ?? '') === 'test' || process.env.TUBEROSA_SILENT_LOCAL_PROVIDER === 'true') return;
    process.stderr.write(`[tuberosa] local cross-encoder unavailable; falling back to hash rerank — ${reason}\n`);
  }
}

interface TransformersPipeline {
  (input: unknown, options?: unknown): Promise<unknown>;
}

interface TransformersModule {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<TransformersPipeline>;
  env?: { cacheDir?: string };
}

class TransformersScorer implements LocalCrossEncoderScorer {
  constructor(private readonly pipeline: TransformersPipeline) {}

  async score(prompt: string, candidates: Array<{ knowledgeId: string; text: string }>): Promise<number[]> {
    if (candidates.length === 0) return [];
    const pairs = candidates.map((candidate) => ({ text: prompt, text_pair: candidate.text }));
    const raw = await this.pipeline(pairs, { topk: 1 });
    if (!Array.isArray(raw)) return candidates.map(() => 0);
    return raw.map((entry) => normalizeScore(entry));
  }
}

function localModelsDisabled(): boolean {
  return (process.env.NODE_ENV ?? '') === 'test' || process.env.TUBEROSA_DISABLE_LOCAL_MODELS === 'true';
}

class TransformersEmbedder implements LocalEmbedder {
  constructor(private readonly pipeline: TransformersPipeline) {}

  async embed(text: string): Promise<number[]> {
    const raw = await this.pipeline(text, { pooling: 'mean', normalize: true });
    return toVector(raw);
  }
}

/**
 * Transformers feature-extraction returns a Tensor ({ data: Float32Array }) or nested arrays.
 * @internal exported for tests — converts transformers feature-extraction output.
 */
export function toVector(raw: unknown): number[] {
  if (raw && typeof raw === 'object' && 'data' in raw) {
    const data = (raw as { data: ArrayLike<number> }).data;
    return Array.from(data, (value) => Number(value));
  }
  if (Array.isArray(raw)) {
    const flat = Array.isArray(raw[0]) ? (raw[0] as unknown[]) : raw;
    return flat.map((value) => Number(value));
  }
  throw new Error('unexpected feature-extraction output shape');
}

function normalizeScore(entry: unknown): number {
  if (Array.isArray(entry)) {
    return normalizeScore(entry[0]);
  }
  if (typeof entry === 'object' && entry !== null && 'score' in entry) {
    const value = (entry as { score?: unknown }).score;
    if (typeof value === 'number' && Number.isFinite(value)) return clamp(value, 0, 1);
  }
  if (typeof entry === 'number' && Number.isFinite(entry)) return clamp(entry, 0, 1);
  return 0;
}

/** Indirection so bundlers / tsc don't try to resolve the optional package statically. */
async function dynamicImport(specifier: string): Promise<{ module: unknown } | { error: Error }> {
  try {
    // eslint-disable-next-line no-new-func
    const importer = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
    return { module: await importer(specifier) };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}
