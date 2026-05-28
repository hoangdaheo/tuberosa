import type { Cache } from '../cache.js';
import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtomInput } from '../types/atoms.js';
import { DEFAULT_TRIVIALITY_RULES, evaluateTriviality, type TrivialityRule } from './triviality-rules.js';
import { PERSONAL_PRONOUN_ONLY_RULE } from '../user-style/triviality-rules.js';
import { GateTelemetry } from './gate-telemetry.js';
import { LlmCritic } from './llm-critic.js';

/**
 * Canonical text used both as the critic's semantic-dedup query and as the
 * text embedded and stored alongside each atom. Keeping a single definition
 * guarantees the stored embedding matches future critic queries so dedup is
 * consistent.
 */
export function atomEmbeddingText(input: { claim: string; trigger: { errors?: string[] } }): string {
  return `${input.claim}\n${(input.trigger.errors ?? []).join(' ')}`;
}

export interface AtomCriticConfig {
  trivialityRules?: TrivialityRule[];
  /** atom↔atom dedup cosine threshold (default 0.92) */
  dedupCosineThreshold?: number;
  /** atom↔legacy-knowledge dedup cosine threshold (default 0.88) */
  legacyDedupThreshold?: number;
  maxClaimLength?: number;
  cache?: Cache;
  /**
   * Enable the stage-4 LLM critic. Defaults to whether the provider exposes
   * judgeAtomUtility. The stage also needs a cache to be wired.
   */
  llmCriticEnabled?: boolean;
}

export type AtomCriticOutcome = 'accepted' | 'rejected' | 'pending' | 'queue_legacy_migration';

export interface AtomCriticResult {
  ok: boolean;
  reasons: string[];
  outcome: AtomCriticOutcome;
  legacyKnowledgeIdForMigration?: string;
}

/**
 * The atom write gate (Concern D). Four stages run in fixed order, each emitting
 * one telemetry row:
 *   1. triviality  — deterministic stop-list (cheapest, most certain rejects)
 *   2. floor       — schema floor inherited from Concern B
 *   3. dedup       — atom↔atom (reject) and atom↔legacy (queue migration)
 *   4. llm_critic  — optional, borderline atoms only
 */
export class AtomCritic {
  private readonly rules: TrivialityRule[];
  private readonly atomDedupThreshold: number;
  private readonly legacyDedupThreshold: number;
  private readonly maxClaimLength: number;
  private readonly telemetry: GateTelemetry;
  private readonly llmCritic?: LlmCritic;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly models: ModelProvider,
    config: AtomCriticConfig = {},
  ) {
    this.rules = config.trivialityRules ?? DEFAULT_TRIVIALITY_RULES;
    this.atomDedupThreshold = config.dedupCosineThreshold ?? 0.92;
    this.legacyDedupThreshold = config.legacyDedupThreshold ?? 0.88;
    this.maxClaimLength = config.maxClaimLength ?? 240;
    this.telemetry = new GateTelemetry(store);
    const llmCriticEnabled = config.llmCriticEnabled ?? Boolean(this.models.judgeAtomUtility);
    if (llmCriticEnabled && config.cache && this.models.judgeAtomUtility) {
      this.llmCritic = new LlmCritic(this.models, config.cache);
    }
  }

  async evaluate(input: KnowledgeAtomInput, sessionId?: string): Promise<AtomCriticResult> {
    // Stage 1: triviality
    const triviality = evaluateTriviality(input, this.rulesForInput(input));
    if (!triviality.ok) {
      const reasons = triviality.matched.map((m) => `triviality:${m}`);
      await this.telemetry.record({
        project: input.project, sessionId,
        candidateClaim: input.claim, candidateType: input.type,
        stage: 'triviality', outcome: 'rejected', reasons,
      });
      return { ok: false, reasons, outcome: 'rejected' };
    }

    // Stage 2: schema floor
    const floorReasons = this.evaluateFloor(input);
    if (floorReasons.length > 0) {
      await this.telemetry.record({
        project: input.project, sessionId,
        candidateClaim: input.claim, candidateType: input.type,
        stage: 'floor', outcome: 'rejected', reasons: floorReasons,
      });
      return { ok: false, reasons: floorReasons, outcome: 'rejected' };
    }

    // Stage 3: cross-type dedup
    const dedup = await this.evaluateDedup(input);
    if (dedup.outcome !== 'pass') {
      const reasons = dedup.reason ? [dedup.reason] : [];
      await this.telemetry.record({
        project: input.project, sessionId,
        candidateClaim: input.claim, candidateType: input.type,
        stage: 'dedup', outcome: dedup.outcome, reasons,
      });
      return {
        ok: false,
        reasons,
        outcome: dedup.outcome,
        legacyKnowledgeIdForMigration: dedup.legacyKnowledgeId,
      };
    }

    // Stage 4: optional LLM critic for borderline atoms
    if (this.llmCritic && this.llmCritic.isBorderline(input, triviality)) {
      const verdict = await this.llmCritic.judge({
        claim: input.claim, type: input.type, trigger: input.trigger,
      });
      if (verdict && !verdict.generalizable) {
        const reasons = [`llm_critic:not_generalizable:${verdict.reason}`];
        await this.telemetry.record({
          project: input.project, sessionId,
          candidateClaim: input.claim, candidateType: input.type,
          stage: 'llm_critic', outcome: 'rejected', reasons,
        });
        return { ok: false, reasons, outcome: 'rejected' };
      }
      if (!verdict) {
        // Provider could not judge; keep the atom but mark it pending so the
        // extractor can record the unresolved state rather than silently passing.
        await this.telemetry.record({
          project: input.project, sessionId,
          candidateClaim: input.claim, candidateType: input.type,
          stage: 'llm_critic', outcome: 'pending', reasons: ['provider_missing_judgeAtomUtility'],
        });
        return { ok: true, reasons: [], outcome: 'pending' };
      }
    }

    await this.telemetry.record({
      project: input.project, sessionId,
      candidateClaim: input.claim, candidateType: input.type,
      stage: 'floor', outcome: 'accepted', reasons: [],
    });
    return { ok: true, reasons: [], outcome: 'accepted' };
  }

  /**
   * Concern F — user-style atoms get one extra triviality rule that rejects
   * bare-ego claims. Project atoms keep the default rule set unchanged.
   */
  private rulesForInput(input: KnowledgeAtomInput): TrivialityRule[] {
    if (input.scope === 'user') return [...this.rules, PERSONAL_PRONOUN_ONLY_RULE];
    return this.rules;
  }

  private evaluateFloor(input: KnowledgeAtomInput): string[] {
    const reasons: string[] = [];
    if (!input.claim?.trim()) {
      reasons.push('claim is empty');
    } else if (input.claim.length > this.maxClaimLength) {
      reasons.push(`claim exceeds ${this.maxClaimLength} chars`);
    }
    if (!input.evidence?.length) reasons.push('evidence is empty (≥1 required)');
    const claimLower = (input.claim ?? '').trim().toLowerCase();
    const triggerTokens = [
      ...(input.trigger.errors ?? []),
      ...(input.trigger.files ?? []),
      ...(input.trigger.symbols ?? []),
      ...(input.trigger.taskTypes ?? []),
    ].map((s) => s.trim().toLowerCase());
    if (claimLower && triggerTokens.some((t) => t === claimLower)) {
      reasons.push('claim restates a trigger token verbatim');
    }
    return reasons;
  }

  private async evaluateDedup(
    input: KnowledgeAtomInput,
  ): Promise<{ outcome: 'pass' | 'rejected' | 'queue_legacy_migration'; reason?: string; legacyKnowledgeId?: string }> {
    const embedding = await this.models.embed(atomEmbeddingText(input));

    // Concern F — user-style atoms only dedup against other atoms belonging to
    // the same user. The legacy-knowledge migration check is skipped entirely:
    // project-scope legacy memories cannot supersede a personal preference.
    if (input.scope === 'user') {
      const atomMatches = await this.store.searchAtomsByEmbedding(embedding, {
        project: undefined,
        limit: 5,
        threshold: this.atomDedupThreshold,
        scope: 'user',
        userId: input.userId,
      });
      if (atomMatches.length > 0) {
        return {
          outcome: 'rejected',
          reason: `duplicate of user-style atom ${atomMatches[0].atom.id} (cosine ${atomMatches[0].cosine.toFixed(2)})`,
        };
      }
      return { outcome: 'pass' };
    }

    const atomMatches = await this.store.searchAtomsByEmbedding(embedding, {
      project: input.project, limit: 5, threshold: this.atomDedupThreshold,
    });
    if (atomMatches.length > 0) {
      return {
        outcome: 'rejected',
        reason: `duplicate of existing atom ${atomMatches[0].atom.id} (cosine ${atomMatches[0].cosine.toFixed(2)})`,
      };
    }
    // The legacy-knowledge check exists to migrate near-duplicate vague memories
    // into atoms. Migration-produced atoms are intentionally derived from a legacy
    // item, so flagging them as legacy near-duplicates would block the migration
    // itself — skip that check for migration_llm producers.
    if (input.producedBy === 'migration_llm') {
      return { outcome: 'pass' };
    }
    const legacyMatches = await this.store.searchKnowledgeByEmbedding(embedding, {
      project: input.project, limit: 5, threshold: this.legacyDedupThreshold,
      itemTypes: ['memory', 'bugfix', 'rule'],
      excludeLegacyStatuses: ['legacy_replaced', 'legacy_archived'],
    });
    if (legacyMatches.length > 0) {
      return {
        outcome: 'queue_legacy_migration',
        reason: `near-duplicate of legacy knowledge_items.${legacyMatches[0].knowledge.id}`,
        legacyKnowledgeId: legacyMatches[0].knowledge.id,
      };
    }
    return { outcome: 'pass' };
  }
}
