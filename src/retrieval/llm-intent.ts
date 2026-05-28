import { createHash } from 'node:crypto';
import type { Cache } from '../cache.js';
import type { ModelProvider } from '../model/provider.js';
import { getRetrievalPolicy } from './policy.js';
import type { PromptIntentVerdict } from '../types/preprocessor.js';

export class LlmIntentExtractor {
  constructor(
    private readonly models: ModelProvider,
    private readonly cache: Cache,
  ) {}

  async extract(input: {
    prompt: string;
    cwd?: string;
    files?: string[];
    symbols?: string[];
  }): Promise<(PromptIntentVerdict & { cacheHit: boolean }) | undefined> {
    if (!this.models.extractPromptIntent) return undefined;
    const ttl = getRetrievalPolicy().promptPreprocessing.intent.cacheTtlSeconds;
    const key = `prompt_intent:${createHash('sha256').update(input.prompt).digest('hex')}`;
    const cached = await this.cache.getJson<PromptIntentVerdict>(key);
    if (cached) return { ...cached, cacheHit: true };
    const verdict = await this.models.extractPromptIntent(input);
    await this.cache.setJson(key, verdict, ttl);
    return { ...verdict, cacheHit: false };
  }
}
