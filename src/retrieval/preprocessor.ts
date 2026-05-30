import type { Cache } from '../cache.js';
import type { ModelProvider } from '../model/provider.js';
import type { ContextSearchInput } from '../types.js';
import type {
  EmbeddingSource,
  LengthClass,
  PreprocessedInput,
} from '../types/preprocessor.js';
import { TOKEN_CHARS } from '../util/text.js';
import { pickAnchorWindow } from './anchor-window.js';
import { LlmIntentExtractor } from './llm-intent.js';
import { getRetrievalPolicy } from './policy.js';
import { sweepSignals } from './signal-sweep.js';

function estimateTokens(s: string): number {
  return Math.ceil(s.length / TOKEN_CHARS);
}

function classifyLength(tokens: number): LengthClass {
  const t = getRetrievalPolicy().promptPreprocessing.thresholds;
  if (tokens <= t.medium) return 'short';
  if (tokens <= t.long) return 'medium';
  return 'long';
}

export async function preprocessLongPrompt(
  input: ContextSearchInput,
  models: ModelProvider,
  cache: Cache,
): Promise<PreprocessedInput> {
  const tokens = estimateTokens(input.prompt);
  const lengthClass = classifyLength(tokens);

  if (lengthClass === 'short') {
    return {
      ...input,
      promptPreprocessing: {
        lengthClass,
        originalTokenEstimate: tokens,
        embeddingSource: 'original',
        structuralSignals: { files: [], symbols: [], errors: [], technologies: [], businessAreas: [] },
        continuationGated: false,
        cacheHits: { intent: false, signals: false },
      },
    };
  }

  const structuralSignals = sweepSignals(input.prompt, input.cwd);

  if (lengthClass === 'medium') {
    return {
      ...input,
      promptPreprocessing: {
        lengthClass,
        originalTokenEstimate: tokens,
        embeddingSource: 'original',
        structuralSignals,
        continuationGated: false,
        cacheHits: { intent: false, signals: false },
      },
    };
  }

  // Long path — try intent extractor first, fall back to anchor window. The
  // extractor is best-effort: any provider error (missing model config, API
  // failure, malformed response) degrades to the deterministic anchor-window
  // path so a misconfigured provider never breaks searchContext.
  const policy = getRetrievalPolicy().promptPreprocessing;
  let intent: Awaited<ReturnType<LlmIntentExtractor['extract']>> = undefined;
  if (policy.intent.enabled) {
    try {
      intent = await new LlmIntentExtractor(models, cache).extract({
        prompt: input.prompt,
        cwd: input.cwd,
        files: input.files,
        symbols: input.symbols,
      });
    } catch {
      intent = undefined;
    }
  }

  let embeddingSource: EmbeddingSource;
  let prompt: string;
  let primaryIntent: string | undefined;
  let subTasks: string[] | undefined;

  // Guard against providers returning an empty/whitespace primary — that would
  // hand an empty string to the embedder downstream.
  if (intent && typeof intent.primary === 'string' && intent.primary.trim().length > 0) {
    embeddingSource = 'primary_intent';
    prompt = intent.primary;
    primaryIntent = intent.primary;
    subTasks = intent.subTasks;
  } else {
    embeddingSource = 'anchor_window';
    const window = pickAnchorWindow(input.prompt, policy.anchorWindow.tokens);
    prompt = window.text;
  }

  return {
    ...input,
    prompt,
    promptPreprocessing: {
      lengthClass,
      originalTokenEstimate: tokens,
      embeddingSource,
      primaryIntent,
      subTasks,
      structuralSignals,
      // Continuation walker is always gated for long prompts (spec §7).
      continuationGated: true,
      cacheHits: {
        intent: intent?.cacheHit ?? false,
        signals: false,
      },
    },
  };
}
