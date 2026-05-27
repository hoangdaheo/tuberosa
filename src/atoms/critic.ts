import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtomInput } from '../types/atoms.js';

export interface AtomCriticConfig {
  dedupCosineThreshold?: number;     // default 0.92
  maxClaimLength?: number;           // default 240
}

export interface AtomCriticResult {
  ok: boolean;
  reasons: string[];
}

export class AtomCritic {
  private readonly dedupThreshold: number;
  private readonly maxClaimLength: number;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly models: ModelProvider,
    config: AtomCriticConfig = {},
  ) {
    this.dedupThreshold = config.dedupCosineThreshold ?? 0.92;
    this.maxClaimLength = config.maxClaimLength ?? 240;
  }

  async evaluate(input: KnowledgeAtomInput): Promise<AtomCriticResult> {
    const reasons: string[] = [];

    // Floor: claim
    if (!input.claim || !input.claim.trim()) {
      reasons.push('claim is empty');
    } else if (input.claim.length > this.maxClaimLength) {
      reasons.push(`claim exceeds ${this.maxClaimLength} chars`);
    }

    // Floor: evidence
    if (!input.evidence || input.evidence.length === 0) {
      reasons.push('evidence is empty (≥1 required)');
    }

    // Floor: trigger non-trivial
    const triggerNonEmpty =
      (input.trigger.errors?.length ?? 0) > 0
      || (input.trigger.files?.length ?? 0) > 0
      || (input.trigger.symbols?.length ?? 0) > 0
      || (input.trigger.taskTypes?.length ?? 0) > 0;
    if (!triggerNonEmpty) {
      reasons.push('trigger has no concrete error/file/symbol/taskType');
    }

    // Claim must not be a verbatim restatement of any trigger token
    const claimLower = (input.claim ?? '').trim().toLowerCase();
    const triggerTokens = [
      ...(input.trigger.errors ?? []),
      ...(input.trigger.files ?? []),
      ...(input.trigger.symbols ?? []),
      ...(input.trigger.taskTypes ?? []),
    ].map((s) => s.trim().toLowerCase());
    if (claimLower && triggerTokens.some((token) => token === claimLower)) {
      reasons.push('claim restates a trigger token verbatim');
    }

    // Semantic dedup against existing atoms in the project
    if (reasons.length === 0) {
      const candidate = `${input.claim}\n${(input.trigger.errors ?? []).join(' ')}`;
      const embedding = await this.models.embed(candidate);
      const matches = await this.store.searchAtomsByEmbedding(embedding, {
        project: input.project,
        limit: 5,
        threshold: this.dedupThreshold,
      });
      if (matches.length > 0) {
        reasons.push(`duplicate of existing atom ${matches[0].atom.id} (cosine ${matches[0].cosine.toFixed(2)})`);
      }
    }

    return { ok: reasons.length === 0, reasons };
  }
}
