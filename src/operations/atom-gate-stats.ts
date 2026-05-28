import type { KnowledgeStore } from '../storage/store.js';

export interface AtomGateStats {
  windowDays: number;
  totalCandidates: number;
  accepted: number;
  acceptedPct: number;
  rejected: { triviality: number; floor: number; dedup: number; llm_critic: number };
  queuedLegacyMigration: number;
  topTrivialityPatterns: Array<{ pattern: string; count: number }>;
  pendingLlmCritic: number;
  alertHints: Array<{ level: 'info' | 'warn'; text: string }>;
}

/**
 * Aggregate atom write-gate telemetry (Concern D) into observable health stats:
 * acceptance rate, per-stage rejection counts, the most common triviality
 * patterns, and a coarse "too strict / too permissive" hint band.
 */
export async function computeAtomGateStats(
  store: KnowledgeStore,
  options: { project?: string; windowDays: number },
): Promise<AtomGateStats> {
  const events = await store.listAtomGateEvents({
    project: options.project,
    windowDays: options.windowDays,
    limit: 10000,
  });

  const totalCandidates = events.length;
  let accepted = 0;
  let queuedLegacyMigration = 0;
  let pendingLlmCritic = 0;
  const rejected = { triviality: 0, floor: 0, dedup: 0, llm_critic: 0 };
  const trivialityCounts = new Map<string, number>();

  for (const event of events) {
    if (event.outcome === 'accepted') {
      accepted += 1;
    } else if (event.outcome === 'queue_legacy_migration') {
      queuedLegacyMigration += 1;
    } else if (event.outcome === 'pending') {
      pendingLlmCritic += 1;
    } else if (event.outcome === 'rejected') {
      rejected[event.stage] += 1;
      if (event.stage === 'triviality') {
        for (const reason of event.reasons) {
          const match = reason.match(/^triviality:(\w+)$/);
          if (match) trivialityCounts.set(match[1], (trivialityCounts.get(match[1]) ?? 0) + 1);
        }
      }
    }
  }

  const topTrivialityPatterns = [...trivialityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pattern, count]) => ({ pattern, count }));

  const acceptedPct = totalCandidates === 0 ? 0 : accepted / totalCandidates;
  const alertHints: AtomGateStats['alertHints'] = [];
  if (totalCandidates > 0) {
    if (acceptedPct < 0.3) {
      alertHints.push({ level: 'warn', text: 'Critic may be too strict — review top rejection reasons.' });
    } else if (acceptedPct > 0.8) {
      alertHints.push({ level: 'warn', text: 'Critic may be too permissive — consider adding triviality patterns.' });
    } else {
      alertHints.push({ level: 'info', text: 'Acceptance rate within healthy range (30–80%).' });
    }
  }

  return {
    windowDays: options.windowDays,
    totalCandidates,
    accepted,
    acceptedPct,
    rejected,
    queuedLegacyMigration,
    topTrivialityPatterns,
    pendingLlmCritic,
    alertHints,
  };
}
