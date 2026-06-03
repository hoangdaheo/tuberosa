import type { ContextPack, FeedbackInput, StoredKnowledge } from '../types.js';

/** Order a knowledge-id pair deterministically (for symmetric relation keys). */
export function canonicalKnowledgePair(left: string, right: string): [string, string] {
  return left.localeCompare(right) <= 0 ? [left, right] : [right, left];
}

/** Inferred relations are dropped for knowledge that is archived or blocked. */
export function shouldDropInferredRelationsForStatus(status: StoredKnowledge['status'] | undefined): boolean {
  return status === 'archived' || status === 'blocked';
}

/** Map a feedback type to the context-pack status it should drive (or undefined to leave unchanged). */
export function packStatusForFeedback(feedbackType: FeedbackInput['feedbackType']): ContextPack['status'] | undefined {
  if (feedbackType === 'selected' || feedbackType === 'selected_but_noisy') {
    return 'selected';
  }

  if (feedbackType === 'rejected' || feedbackType === 'irrelevant' || feedbackType === 'stale') {
    return 'rejected';
  }

  return undefined;
}
