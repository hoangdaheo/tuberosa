import type {
  QueryRewriteInput,
  QueryRewriteResult,
  RerankInput,
  RerankResult,
} from '../types.js';
import { clamp, truncate } from '../util/text.js';
import { HashModelProvider } from './provider.js';
import type { ModelProvider } from './provider.js';

/**
 * Phase 4 — Ollama HTTP reranker.
 *
 * Calls Ollama's `/api/rerank` endpoint to rescore the top-N candidates with a
 * code-aware cross-encoder (default `dengcao/Qwen3-Reranker-0.6B`). Any network
 * failure, timeout, or non-200 response falls back to the injected `fallback`
 * (defaults to `HashModelProvider`) so the rest of the pipeline never breaks.
 *
 * Embed and rewriteQuery delegate to the fallback — same composition pattern as
 * `LocalCrossEncoderProvider`.
 */
export interface OllamaRerankerOptions {
  /** Ollama model id. Defaults to `dengcao/Qwen3-Reranker-0.6B`. */
  modelId?: string;
  /** Base URL of the Ollama server. Defaults to `http://localhost:11434`. */
  ollamaUrl?: string;
  /** Maximum candidates passed to Ollama per request. */
  topK?: number;
  /** Request timeout in milliseconds. Defaults to 10 000 ms. */
  timeoutMs?: number;
  /** Backing provider for embed / rewriteQuery / fallback rerank. Defaults to HashModelProvider. */
  fallback?: ModelProvider;
  /** Embedding dimension (only used when constructing the default hash fallback). */
  embeddingDimensions?: number;
  /** Optional fetch override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
}

const DEFAULT_MODEL_ID = 'dengcao/Qwen3-Reranker-0.6B';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_TOP_K = 16;
const DEFAULT_TIMEOUT_MS = 10_000;

interface OllamaRerankApiResult {
  index: number;
  relevance_score: number;
}

interface OllamaRerankApiResponse {
  results?: OllamaRerankApiResult[];
}

export class OllamaRerankProvider implements ModelProvider {
  readonly name = 'ollama-reranker';

  private readonly fallback: ModelProvider;
  private readonly modelId: string;
  private readonly ollamaUrl: string;
  private readonly topK: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private hasLoggedFailure = false;

  constructor(options: OllamaRerankerOptions = {}) {
    this.fallback = options.fallback ?? new HashModelProvider(options.embeddingDimensions ?? 1536);
    this.modelId = options.modelId ?? process.env.TUBEROSA_OLLAMA_RERANK_MODEL ?? DEFAULT_MODEL_ID;
    this.ollamaUrl = trimTrailingSlash(options.ollamaUrl ?? process.env.TUBEROSA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL);
    this.topK = options.topK ?? Number(process.env.TUBEROSA_RERANKER_TOPK ?? DEFAULT_TOP_K);
    this.timeoutMs = options.timeoutMs ?? Number(process.env.TUBEROSA_OLLAMA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async embed(text: string): Promise<number[]> {
    return this.fallback.embed(text);
  }

  async rewriteQuery(input: QueryRewriteInput): Promise<QueryRewriteResult | undefined> {
    return this.fallback.rewriteQuery(input);
  }

  async rerank(input: RerankInput): Promise<RerankResult> {
    if (input.candidates.length === 0) {
      return { candidates: [] };
    }

    const windowSize = Math.min(this.topK, input.candidates.length);
    const window = input.candidates.slice(0, windowSize);
    const tail = input.candidates.slice(windowSize);
    const documents = window.map((candidate) =>
      truncate(candidate.contextualContent || candidate.content || candidate.summary || candidate.title, 1024),
    );

    let scores: number[];
    try {
      scores = await this.callOllama(input.prompt, documents);
    } catch (error) {
      this.logFailure(`ollama rerank failed: ${error instanceof Error ? error.message : String(error)}`);
      return this.fallback.rerank(input);
    }

    const reranked = window.map((candidate, index) => {
      const ollamaScore = clamp(scores[index] ?? 0, 0, 1);
      const trustScore = clamp(candidate.trustLevel / 100, 0, 1);
      // 0.70 to the Ollama cross-encoder, 0.22 to the fused retrieval score, 0.08 to trust.
      const blended = clamp(ollamaScore * 0.7 + candidate.fusedScore * 0.22 + trustScore * 0.08, 0, 1);
      return {
        ...candidate,
        rerankScore: blended,
        finalScore: blended,
        matchReasons: [...candidate.matchReasons, `ollama-rerank:${this.modelId}:${ollamaScore.toFixed(3)}`],
        metadata: {
          ...(candidate.metadata ?? {}),
          ollamaRerank: {
            model: this.modelId,
            score: ollamaScore,
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

  private async callOllama(query: string, documents: string[]): Promise<number[]> {
    const response = await this.fetchFn(`${this.ollamaUrl}/api/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.modelId, query, documents }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as OllamaRerankApiResponse;
    const results = Array.isArray(body.results) ? body.results : [];

    const scores = new Array<number>(documents.length).fill(0);
    for (const entry of results) {
      if (
        typeof entry?.index === 'number' &&
        entry.index >= 0 &&
        entry.index < documents.length &&
        typeof entry.relevance_score === 'number' &&
        Number.isFinite(entry.relevance_score)
      ) {
        scores[entry.index] = clamp(entry.relevance_score, 0, 1);
      }
    }
    return scores;
  }

  private logFailure(reason: string): void {
    if (this.hasLoggedFailure) return;
    this.hasLoggedFailure = true;
    if ((process.env.NODE_ENV ?? '') === 'test' || process.env.TUBEROSA_SILENT_OLLAMA_PROVIDER === 'true') return;
    process.stderr.write(`[tuberosa] ollama reranker unavailable; falling back to hash rerank — ${reason}\n`);
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
