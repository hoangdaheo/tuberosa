import type { ModelProvider } from '../model/provider.js';
import type { DocumentAtom } from './document-atomizer.js';

/**
 * Phase 4 — optional late-chunking path (Jina pattern).
 *
 * When the configured `ModelProvider` declares `supportsLongContextEmbed() === true`
 * AND the source document is large enough (`>= LATE_CHUNK_MIN_TOKEN_ESTIMATE`),
 * embed the whole document once, then pool the per-section ranges into per-atom
 * vectors. This preserves cross-reference context that per-atom embedding loses.
 *
 * Default behavior: returns `undefined` — the standard `buildChunks` path runs.
 * No provider implements `supportsLongContextEmbed` yet, so this stays inert until
 * a long-context embedder (e.g., Ollama with `nomic-embed-text-v1.5` long context)
 * is wired in. Gate with `TUBEROSA_LATE_CHUNKING_ENABLED=true` to opt in.
 */
export interface LateChunkingResult {
  atomVectors: Map<string, number[]>;
  /** Token estimate that gated this chunking decision. */
  documentTokenEstimate: number;
}

export const LATE_CHUNK_MIN_TOKEN_ESTIMATE = 2_000;

export function isLateChunkingEnabled(): boolean {
  return process.env.TUBEROSA_LATE_CHUNKING_ENABLED === 'true';
}

export function isLateChunkingSupported(provider: ModelProvider): boolean {
  if (!isLateChunkingEnabled()) {
    return false;
  }
  return typeof provider.supportsLongContextEmbed === 'function' && provider.supportsLongContextEmbed();
}

export async function lateChunkDocument(
  provider: ModelProvider,
  document: { path: string; content: string; atoms: DocumentAtom[] },
): Promise<LateChunkingResult | undefined> {
  if (!isLateChunkingSupported(provider)) {
    return undefined;
  }
  const tokens = Math.ceil(document.content.length / 4);
  if (tokens < LATE_CHUNK_MIN_TOKEN_ESTIMATE) {
    return undefined;
  }
  // Phase 4 carry-over: when a real long-context embedder lands, replace this stub
  // with: (1) embed the whole document once via provider.embed; (2) for each atom,
  // pool the embedder's token vectors across [lineStart..lineEnd]; (3) emit per-atom
  // vectors via the returned Map. Until then, return undefined and let the existing
  // chunk-and-embed path run unchanged.
  return undefined;
}
