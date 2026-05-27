import { createHash } from 'node:crypto';
import type { Cache } from '../cache.js';
import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeAtomInput } from '../types/atoms.js';
import type { TrivialityResult } from './triviality-rules.js';

const SPARSE_THRESHOLD = 5;
const BORDERLINE_MARGIN = 2;
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface LlmCriticVerdict {
  generalizable: boolean;
  reason: string;
  confidence: number;
}

/**
 * Stage 4 of the write gate (Concern D). Only borderline atoms — those just
 * above the sparse-claim floor or triggered solely by a taskType — pay for an
 * LLM judgment. Verdicts are cached (keyed by claim+type) so repeated
 * extractions of the same lesson don't re-bill the model.
 */
export class LlmCritic {
  constructor(
    private readonly models: ModelProvider,
    private readonly cache: Cache,
    private readonly ttlSeconds: number = CACHE_TTL_SECONDS,
  ) {}

  isBorderline(input: KnowledgeAtomInput, triviality: TrivialityResult): boolean {
    if (triviality.marginContentWords <= SPARSE_THRESHOLD + BORDERLINE_MARGIN) return true;
    const trigger = input.trigger;
    const onlyTaskTypes =
      (trigger.errors?.length ?? 0) === 0
      && (trigger.files?.length ?? 0) === 0
      && (trigger.symbols?.length ?? 0) === 0
      && (trigger.taskTypes?.length ?? 0) > 0;
    return onlyTaskTypes;
  }

  async judge(input: {
    claim: string;
    type: KnowledgeAtomInput['type'];
    trigger: KnowledgeAtomInput['trigger'];
  }): Promise<LlmCriticVerdict | undefined> {
    if (!this.models.judgeAtomUtility) return undefined;
    const key = `atom_critic:${this.cacheKey(input)}`;
    const cached = await this.cache.getJson<LlmCriticVerdict>(key);
    if (cached) return cached;
    const verdict = await this.models.judgeAtomUtility(input);
    await this.cache.setJson(key, verdict, this.ttlSeconds);
    return verdict;
  }

  private cacheKey(input: { claim: string; type: string }): string {
    return createHash('sha256').update(`${input.type}\n${input.claim}`).digest('hex');
  }
}
