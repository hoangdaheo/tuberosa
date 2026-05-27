import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';

const TIME_THRESHOLD_DAYS = 365;
const SIGNAL_THRESHOLD = 3;
const CANONICAL_SIGNAL_THRESHOLD = 5;
const SIGNAL_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArchivalReport {
  archivedByTime: string[];
  archivedBySignal: string[];
  scannedAt: string;
  scanned: number;
}

export interface ArchivalOptions {
  /** When true, compute the report but make no writes. */
  dryRun?: boolean;
}

function daysSince(iso: string | undefined, now: Date): number {
  if (!iso) return Infinity;
  return (now.getTime() - new Date(iso).getTime()) / DAY_MS;
}

/**
 * Archival sweep (Concern D). Archives — never deletes — atoms that have gone
 * inactive or are persistently unhelpful:
 *   - time: a draft atom with no reuse in >365 days
 *   - signal: any atom with ≥3 negative feedbacks in the last 90 days
 *     (canonical atoms need ≥5 before archiving, since they earned that tier)
 * Archived atoms stay fetchable by id but exit default retrieval.
 */
export async function runArchivalSweep(
  store: KnowledgeStore,
  now: Date = new Date(),
  options: ArchivalOptions = {},
): Promise<ArchivalReport> {
  const candidates: KnowledgeAtom[] = await store.listAtoms({ status: 'active', limit: 1000 });
  const archivedByTime: string[] = [];
  const archivedBySignal: string[] = [];

  for (const atom of candidates) {
    if (atom.tier === 'draft') {
      const reference = atom.lastReusedAt ?? atom.audit.createdAt;
      if (daysSince(reference, now) > TIME_THRESHOLD_DAYS) {
        if (!options.dryRun) await store.updateAtom(atom.id, { status: 'archived' });
        archivedByTime.push(atom.id);
        continue;
      }
    }
    const threshold = atom.tier === 'canonical' ? CANONICAL_SIGNAL_THRESHOLD : SIGNAL_THRESHOLD;
    const negativeCount = await store.countNegativeFeedback(atom.id, SIGNAL_WINDOW_DAYS);
    if (negativeCount >= threshold) {
      if (!options.dryRun) await store.updateAtom(atom.id, { status: 'archived' });
      archivedBySignal.push(atom.id);
    }
  }

  return {
    archivedByTime,
    archivedBySignal,
    scannedAt: now.toISOString(),
    scanned: candidates.length,
  };
}
