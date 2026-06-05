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
 * (TUBEROSA_OLLAMA_EXTRACT_MODEL, e.g. qwen2.5:3b-instruct; thinking models like qwen3.5 are impractical on CPU-only hosts).
 *
 * Requests are STREAMED (`stream: true`). This is not just an optimization:
 * with `stream: false` Ollama sends no response headers until the entire
 * generation finishes, and Node's undici fetch enforces a built-in
 * headersTimeout of 300 s that is independent of any AbortSignal. On a slow
 * CPU-only box a generation can take far longer than 300 s, so a
 * non-streaming request dies with UND_ERR_HEADERS_TIMEOUT regardless of
 * `timeoutMs`. Streaming makes headers arrive immediately and emits NDJSON
 * chunks per token, so neither undici's headersTimeout nor its inter-chunk
 * bodyTimeout ever trips. `AbortSignal.timeout(timeoutMs)` remains the
 * single overall deadline. We accumulate `message.content` across chunks
 * until `done === true`.
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
  /**
   * Overall request deadline (enforced via AbortSignal), defaults to
   * 600 000 ms. Generation on CPU-only boxes is slow, so the budget is
   * generous. The request is streamed so undici's 300 s headersTimeout —
   * which ignores AbortSignal and would otherwise kill any non-streaming
   * response before this deadline — never applies.
   */
  timeoutMs?: number;
  /** Optional fetch override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 600_000;

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
          stream: true,
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

    const content = await this.readStreamedContent(response);
    if (!content.trim()) {
      throw new ModelProviderError('Ollama generation response did not include message content.');
    }
    return content;
  }

  /**
   * Read an NDJSON `/api/chat` stream, accumulating `message.content` across
   * chunks until `done === true`. Each line is a JSON object; an `error`
   * string aborts the stream. Read/parse failures are wrapped in
   * ModelProviderError so no raw SyntaxError/TypeError escapes.
   *
   * The reader is always cancelled in `finally`: on any throw path (invalid
   * JSON, mid-stream error line) an undrained body would otherwise hold the
   * connection open against a real server still streaming a long generation.
   * `cancel()` is a no-op after natural exhaustion or the `done:true` early
   * return, so behavior is otherwise identical.
   */
  private async readStreamedContent(response: Response): Promise<string> {
    const body = response.body;
    if (!body) {
      throw new ModelProviderError('Ollama generation response had no readable body.');
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';

    const handleLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      let parsed: { message?: { content?: string }; done?: boolean; error?: string };
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new ModelProviderError('Ollama generation stream emitted invalid JSON.', error);
      }
      if (typeof parsed.error === 'string') {
        throw new ModelProviderError(`Ollama generation stream reported an error: ${parsed.error}`);
      }
      content += parsed.message?.content ?? '';
      return parsed.done === true;
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (handleLine(line)) return content;
        }
      }

      // Flush any trailing partial line that was not newline-terminated.
      buffer += decoder.decode();
      if (buffer.trim()) {
        handleLine(buffer);
      }
      return content;
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      throw new ModelProviderError('Ollama generation stream read failed.', error);
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
