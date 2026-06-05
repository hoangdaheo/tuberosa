import { ModelProviderError } from '../errors.js';
import type { ExtractedAtomCandidate, ModelProvider } from './provider.js';
import {
  ATOM_EXTRACTION_SYSTEM_PROMPT,
  ATOM_UTILITY_SYSTEM_PROMPT,
  atomExtractionSchema,
  atomUtilitySchema,
  parseAtomUtilityVerdict,
  parseExtractedAtoms,
} from './atom-extraction.js';

/**
 * SP2 — Ollama generation provider for the LEARN pillar.
 *
 * Separate from OllamaRerankProvider: the rerank model is a cross-encoder
 * that cannot generate text. This provider calls `/api/chat` with a JSON
 * schema `format` (Ollama structured outputs) using a generation model
 * (TUBEROSA_OLLAMA_EXTRACT_MODEL, e.g. qwen3.5:latest).
 *
 * Failures throw ModelProviderError — there is no meaningful fallback for
 * extraction. AgentSessionService.extractSessionAtoms converts failures into
 * observable knowledge gaps, so session finish never breaks.
 */
export interface OllamaGenerationOptions {
  /** Ollama generation model id (required — the caller gates on config). */
  modelId: string;
  /** Base URL of the Ollama server. Defaults to `http://localhost:11434`. */
  ollamaUrl?: string;
  /** Request timeout. Generation is slow on local models; defaults to 120 000 ms. */
  timeoutMs?: number;
  /** Optional fetch override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 120_000;

export class OllamaGenerationProvider implements Pick<ModelProvider, 'extractAtoms' | 'judgeAtomUtility'> {
  readonly name = 'ollama-generation';

  private readonly modelId: string;
  private readonly ollamaUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: OllamaGenerationOptions) {
    this.modelId = options.modelId;
    this.ollamaUrl = trimTrailingSlash(options.ollamaUrl ?? DEFAULT_OLLAMA_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async extractAtoms(input: {
    project: string;
    sessionPrompt: string;
    summary?: string;
    changedFiles?: string[];
    decisions?: Array<{ decision: string; reason?: string; knowledgeIds?: string[] }>;
    verificationCommands?: string[];
  }): Promise<ExtractedAtomCandidate[]> {
    const content = await this.chatJson(ATOM_EXTRACTION_SYSTEM_PROMPT, input, atomExtractionSchema());
    return parseExtractedAtoms(content);
  }

  async judgeAtomUtility(input: {
    claim: string;
    type: 'fact' | 'procedure' | 'decision' | 'gotcha' | 'convention';
    trigger: { errors?: string[]; files?: string[]; symbols?: string[]; taskTypes?: string[] };
  }): Promise<{ generalizable: boolean; reason: string; confidence: number }> {
    const content = await this.chatJson(ATOM_UTILITY_SYSTEM_PROMPT, input, atomUtilitySchema());
    return parseAtomUtilityVerdict(content);
  }

  private async chatJson(systemPrompt: string, input: unknown, schema: Record<string, unknown>): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) },
          ],
          format: schema,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ModelProviderError('Ollama generation request failed.', error);
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new ModelProviderError(`Ollama generation request failed: ${response.status} ${detail}`);
    }

    const body = (await response.json()) as { message?: { content?: string } };
    const content = body.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ModelProviderError('Ollama generation response did not include message content.');
    }
    return content;
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
