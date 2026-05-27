import type { BranchTag } from './fixtures.js';

export const BRANCH_LABELS: Record<BranchTag, string> = {
  'fit:ready': 'Fit: ready',
  'fit:needs_confirmation': 'Fit: needs confirmation',
  'fit:insufficient': 'Fit: insufficient',
  'source:labels': 'Label/metadata hit',
  'source:fts': 'Full-text search hit',
  'source:vector': 'Vector search hit',
  'source:memory': 'Reviewed-memory hit',
  'source:graph': 'Graph-relation expansion',
  'adjust:memory_boost': 'Memory boost applied',
  'adjust:stale_penalty': 'Stale penalty applied',
  'adjust:superseded': 'Superseded penalty applied',
  'mode:strict_noise': 'Strict noise tolerance',
  'mode:layered_deep_context': 'Layered deep context',
  'classifier:symbols': 'Symbols extracted',
  'classifier:errors': 'Errors extracted',
  'classifier:business_areas': 'Business areas extracted',
  'classifier:empty': 'No signals extracted',
};

export function branchLabel(tag: BranchTag): string {
  return BRANCH_LABELS[tag] ?? (tag as string);
}
