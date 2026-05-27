import type { AtomTier, KnowledgeAtom } from '../types/atoms.js';

const VERIFIED_REUSE_MIN = 2;
const VERIFIED_RECENCY_DAYS = 90;
const DEMOTE_INACTIVITY_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso: string | undefined, now: Date): number {
  if (!iso) return Infinity;
  return (now.getTime() - new Date(iso).getTime()) / DAY_MS;
}

export function evaluateTierTransition(atom: KnowledgeAtom, now: Date = new Date()): AtomTier {
  // Canonical is a human-approval state. Demotion from canonical requires
  // explicit feedback (handled elsewhere — review queue), never time-based.
  if (atom.tier === 'canonical') return 'canonical';

  const hasVerification = Boolean(atom.verification?.command || atom.verification?.testRef || atom.verification?.assertion);
  const recentlyReused = daysSince(atom.lastReusedAt, now) <= VERIFIED_RECENCY_DAYS;
  const meetsReuseFloor = atom.reuseCount >= VERIFIED_REUSE_MIN;

  if (atom.tier === 'verified') {
    // Demote to draft if no reuse in 180 days
    if (daysSince(atom.lastReusedAt, now) > DEMOTE_INACTIVITY_DAYS) {
      return 'draft';
    }
    return 'verified';
  }

  // tier === 'draft'
  if (hasVerification && meetsReuseFloor && recentlyReused) {
    return 'verified';
  }
  return 'draft';
}

export const TIER_RANK_MULTIPLIERS: Record<AtomTier, number> = {
  draft: 0.6,
  verified: 1.0,
  canonical: 1.4,
};
