import type { StoredKnowledge } from '../types.js';

/** Order a knowledge-id pair deterministically (for symmetric relation keys). */
export function canonicalKnowledgePair(left: string, right: string): [string, string] {
  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}

/** Inferred relations are dropped for knowledge that is archived or blocked. */
export function shouldDropInferredRelationsForStatus(status: StoredKnowledge['status'] | undefined): boolean {
  return status === 'archived' || status === 'blocked';
}
