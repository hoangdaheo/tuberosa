import type { ModelProvider } from '../model/provider.js';
import type { DocumentAtom } from './document-atomizer.js';

/**
 * Phase 4 — optional contextual prefix summarizer.
 *
 * Heuristic breadcrumbs (the mandatory Phase 4 deliverable) cover the cheap
 * case. When `TUBEROSA_CONTEXTUAL_PREFIX_LLM=true` AND the configured
 * `ModelProvider` exposes `summarizeSection`, this module asks the provider
 * for a 1-sentence "what is this section about" summary keyed by the atom's
 * heading chain, returns it for inclusion in `contextualContent`.
 *
 * Default behavior: returns `undefined` — the ingestion path keeps the
 * heuristic breadcrumb only. This module is the future seam, not an active
 * code path; no LLM provider exposes `summarizeSection` yet.
 */
export interface ContextualSummary {
  text: string;
  source: 'provider' | 'heuristic';
}

export function isContextualSummarizerEnabled(): boolean {
  return process.env.TUBEROSA_CONTEXTUAL_PREFIX_LLM === 'true';
}

export async function summarizeAtomContext(
  provider: ModelProvider,
  atom: DocumentAtom,
  sourceUri: string,
): Promise<ContextualSummary | undefined> {
  if (!isContextualSummarizerEnabled()) {
    return undefined;
  }
  if (typeof provider.summarizeSection !== 'function') {
    return undefined;
  }
  const text = await provider.summarizeSection({
    sectionPath: atom.sectionPath,
    content: atom.content,
    sourceUri,
  });
  if (!text || text.trim().length === 0) {
    return undefined;
  }
  return { text: text.trim(), source: 'provider' };
}
