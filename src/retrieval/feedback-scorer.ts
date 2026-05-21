import type { KnowledgeFeedbackSummary } from '../types.js';

/**
 * Phase 2 — Feedback → ranking translation.
 *
 * `computeFeedbackPenalty` returns a multiplicative factor in `[FEEDBACK_FACTOR_FLOOR, 1]`
 * that should be applied to a candidate's fused score BEFORE rerank. Output:
 *   - `1.0` → no penalty (no feedback or only positive feedback).
 *   - `< 1` → damp the score; more negative feedback → smaller factor.
 *   - clamped at `FEEDBACK_FACTOR_FLOOR` so cumulative penalties asymptote rather than
 *     spiral to zero (avoids the order-dependent additive-subtraction bug noted in the
 *     plan: `service.ts:1457-1592`).
 *
 * The factor is computed from `KnowledgeFeedbackSummary`. We don't have per-event
 * timestamps in the summary, only `latestFeedbackAt`, so the decay uses the summary's
 * latest-recorded time as an age proxy. Older summaries decay toward the no-penalty
 * limit; recent feedback weighs harder.
 *
 *   weight = exp(-Δdays / FEEDBACK_DECAY_HALF_LIFE_DAYS_ANCHOR)
 *
 * Distinct contributions per type:
 *   - `rejected`, `stale`         → strong negative
 *   - `irrelevant`                → moderate negative
 *   - `selected_but_noisy`        → weak negative (signal is mixed)
 *   - `selected`                  → weak positive (lifts the factor back toward 1)
 *   - `too_much_adjacent_context` → not in the summary (recorded but doesn't show up here)
 */
export const FEEDBACK_FACTOR_FLOOR = 0.3;
export const FEEDBACK_FACTOR_CEILING = 1.0;
export const FEEDBACK_DECAY_HALF_LIFE_DAYS_ANCHOR = 60;

interface TypeWeights {
  rejected: number;
  stale: number;
  irrelevant: number;
  selectedNoisy: number;
  selected: number;
}

const DEFAULT_WEIGHTS: TypeWeights = {
  rejected: 0.18,
  stale: 0.22,
  irrelevant: 0.08,
  selectedNoisy: 0.04,
  selected: -0.06, // positive feedback reduces the cumulative penalty
};

export function computeFeedbackPenalty(
  summary: KnowledgeFeedbackSummary | undefined,
  now: Date = new Date(),
): number {
  if (!summary) return FEEDBACK_FACTOR_CEILING;

  const recency = recencyMultiplier(summary.latestFeedbackAt, now);
  const negativeMass =
    DEFAULT_WEIGHTS.rejected * summary.rejectedCount +
    DEFAULT_WEIGHTS.stale * summary.staleCount +
    DEFAULT_WEIGHTS.irrelevant * summary.irrelevantCount +
    DEFAULT_WEIGHTS.selectedNoisy * summary.selectedNoisyCount +
    DEFAULT_WEIGHTS.selected * summary.selectedCount;

  if (negativeMass <= 0) {
    return FEEDBACK_FACTOR_CEILING;
  }

  // Smoothly damp the score toward the floor as negative mass × recency grows.
  // exp(-x) is monotone, asymptotic, and never crosses zero.
  const damping = Math.exp(-negativeMass * recency);
  const factor = FEEDBACK_FACTOR_FLOOR + (FEEDBACK_FACTOR_CEILING - FEEDBACK_FACTOR_FLOOR) * damping;
  return clampFactor(factor);
}

function recencyMultiplier(latestFeedbackAt: string | undefined, now: Date): number {
  if (!latestFeedbackAt) return 0.6; // conservative default when timestamp missing
  const ts = Date.parse(latestFeedbackAt);
  if (Number.isNaN(ts)) return 0.6;
  const deltaDays = Math.max(0, (now.getTime() - ts) / 86_400_000);
  return Math.exp(-deltaDays / FEEDBACK_DECAY_HALF_LIFE_DAYS_ANCHOR);
}

function clampFactor(value: number): number {
  if (!Number.isFinite(value)) return FEEDBACK_FACTOR_CEILING;
  return Math.max(FEEDBACK_FACTOR_FLOOR, Math.min(FEEDBACK_FACTOR_CEILING, value));
}

/**
 * Convert a multiplicative damping factor into the additive delta that
 * downstream code currently expects when applying penalties. Floors the
 * post-damping score at `floor` so cumulative penalties never push a
 * positive score below the floor.
 */
export function multiplicativeDeltaWithFloor(
  baseScore: number,
  factor: number,
  floor: number,
): number {
  const damped = baseScore * factor;
  const target = baseScore > floor ? Math.max(damped, floor) : damped;
  return target - baseScore;
}
