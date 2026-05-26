import demo from './demo/acme-billing.json' with { type: 'json' };
import type { KnowledgeInput, KnowledgeStatus, LabelInput, ReferenceInput } from '../../types.js';

export type BranchTag =
  | 'fit:ready' | 'fit:needs_confirmation' | 'fit:insufficient'
  | 'source:labels' | 'source:fts' | 'source:vector' | 'source:memory' | 'source:graph'
  | 'adjust:memory_boost' | 'adjust:stale_penalty' | 'adjust:superseded'
  | 'mode:strict_noise' | 'mode:layered_deep_context'
  | 'classifier:symbols' | 'classifier:errors' | 'classifier:business_areas' | 'classifier:empty';

// Only the itemTypes the live store accepts (KnowledgeItemType union).
export type SeedItemType = KnowledgeInput['itemType'];

// Knowledge status values the live store accepts (KnowledgeStatus union).
// Note: 'stale' / 'superseded' are NOT KnowledgeStatus values.
// Staleness is represented via freshnessAt / metadata.stale or a supersedes relation.
export type SeedStatus = KnowledgeStatus;

export type SeedLabelInput = LabelInput;

export type SeedReferenceInput = ReferenceInput;

export interface SeedKnowledgeItem {
  id: string;
  itemType: SeedItemType;
  title: string;
  content: string;
  sourceUri: string;
  labels: SeedLabelInput[];
  references: SeedReferenceInput[];
  /** Optional: 'stale' semantics are expressed via freshnessAt (old date) or metadata.stale. */
  freshnessAt?: string;
  /** If provided, stored as metadata.stale = true on the upserted item. */
  metadataStale?: boolean;
  /** Purely informational — the store always defaults status to 'approved'. */
  status?: SeedStatus;
}

export interface SeedRelation {
  fromId: string;
  toId: string;
  kind: 'depends_on' | 'related_to' | 'supersedes';
}

export interface SeedPrompt {
  id: string;
  text: string;
  branches: BranchTag[];
  taskType?: string;
}

export interface SeedFixture {
  project: string;
  items: SeedKnowledgeItem[];
  /** Graph relations declared between items by their seed id. */
  relations: SeedRelation[];
  prompts: SeedPrompt[];
}

export const acmeBilling = demo as unknown as SeedFixture;
