import type { ClassifiedQuery } from './retrieval.js';
import type { LearningReviewStatus } from './operations.js';

export type KnowledgeItemType =
  | 'spec'
  | 'workflow'
  | 'memory'
  | 'bugfix'
  | 'code_ref'
  | 'rule'
  | 'wiki'
  | 'conversation';

export type TriggerType =
  | 'complex_task_success'
  | 'error_recovery'
  | 'user_correction'
  | 'non_trivial_workflow'
  | 'manual';

export type LabelType =
  | 'project'
  | 'repo'
  | 'domain'
  | 'business_area'
  | 'task_type'
  | 'technology'
  | 'workflow_stage'
  | 'severity'
  | 'file'
  | 'symbol'
  | 'error'
  | 'user_preference';

export type KnowledgeTaxonomy =
  | 'project_fact'
  | 'domain_rule'
  | 'workflow'
  | 'user_preference'
  | 'incident_lesson'
  | 'code_reference';

export type LabelProvenanceSource = 'prompt' | 'classifier' | 'ontology' | 'reviewer' | 'llm' | 'ast' | 'heuristic';

export interface LabelProvenance {
  source: LabelProvenanceSource;
  confidence: number;
}

export interface LabelInput {
  type: LabelType;
  value: string;
  weight?: number;
  provenance?: LabelProvenance;
}

export interface ReferenceInput {
  type: 'file' | 'url' | 'commit' | 'tool' | 'conversation' | 'external';
  uri: string;
  lineStart?: number;
  lineEnd?: number;
  commitSha?: string;
  metadata?: Record<string, unknown>;
}

export type KnowledgeRelationType =
  | 'contains'
  | 'references'
  | 'mentions_file'
  | 'mentions_symbol'
  | 'resolves_error'
  | 'supersedes'
  | 'depends_on'
  | 'related_to'
  | 'derived_from_session';

export type KnowledgeRelationTargetKind =
  | 'knowledge'
  | 'file'
  | 'symbol'
  | 'error'
  | 'session'
  | 'reference';

export interface KnowledgeRelationInput {
  project?: string;
  fromKnowledgeId: string;
  relationType: KnowledgeRelationType;
  targetKind: KnowledgeRelationTargetKind;
  targetKnowledgeId?: string;
  targetValue?: string;
  confidence?: number;
  inferred?: boolean;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeRelationPatchInput {
  relationType?: KnowledgeRelationType;
  targetKind?: KnowledgeRelationTargetKind;
  targetKnowledgeId?: string | null;
  targetValue?: string | null;
  confidence?: number;
  inferred?: boolean;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeRelation extends KnowledgeRelationInput {
  id: string;
  project?: string;
  confidence: number;
  inferred: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface ListKnowledgeRelationsOptions {
  project?: string;
  fromKnowledgeId?: string;
  targetKnowledgeId?: string;
  targetValue?: string;
  relationType?: KnowledgeRelationType;
  inferred?: boolean;
  limit: number;
}

export type KnowledgeConflictType = 'summary_contradiction' | 'freshness_conflict';

export type KnowledgeConflictStatus = 'open' | 'resolved' | 'dismissed';

export interface KnowledgeConflictInput {
  project?: string;
  leftKnowledgeId: string;
  rightKnowledgeId: string;
  conflictType: KnowledgeConflictType;
  sharedEvidence: string[];
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeConflictPatchInput {
  status?: KnowledgeConflictStatus;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeConflict extends KnowledgeConflictInput {
  id: string;
  project?: string;
  status: KnowledgeConflictStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
}

export interface ListKnowledgeConflictsOptions {
  project?: string;
  status?: KnowledgeConflictStatus;
  limit: number;
}

export interface KnowledgeGapInput {
  project?: string;
  sourceFeedbackId?: string;
  sourceSessionId?: string;
  contextPackId?: string;
  prompt: string;
  classified?: ClassifiedQuery;
  missingSignals: string[];
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeGapPatchInput {
  status?: LearningReviewStatus;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeGap extends KnowledgeGapInput {
  id: string;
  status: LearningReviewStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  reviewedAt?: string;
}

export interface ListKnowledgeGapsOptions {
  project?: string;
  status?: LearningReviewStatus;
  sourceSessionId?: string;
  contextPackId?: string;
  limit: number;
}

/**
 * Phase 6a — Namespaced memory scope (LangGraph pattern).
 * Identifies the slot a memory occupies. `project` mirrors `KnowledgeInput.project`;
 * `kind` is derived from `itemType` when not supplied (e.g. `memory|bugfix|rule` → `reflection`);
 * `agent` is set only when a memory is written from an agent-session learning path.
 */
export interface KnowledgeNamespace {
  project: string;
  kind: string;
  agent?: string;
}

export interface KnowledgeInput {
  project: string;
  sourceType: string;
  sourceUri: string;
  sourceTitle?: string;
  itemType: KnowledgeItemType;
  title: string;
  summary?: string;
  content: string;
  trustLevel?: number;
  labels?: LabelInput[];
  references?: ReferenceInput[];
  metadata?: Record<string, unknown>;
  freshnessAt?: string;
  /** Phase 6a — optional, defaults to {project, kind: kindFromItemType(itemType)}. */
  namespace?: KnowledgeNamespace;
}

export interface StoredKnowledge {
  id: string;
  projectId?: string;
  project: string;
  sourceType?: string;
  sourceUri?: string;
  status?: KnowledgeStatus;
  itemType: KnowledgeItemType;
  title: string;
  summary: string;
  content: string;
  trustLevel: number;
  metadata: Record<string, unknown>;
  labels: LabelInput[];
  references: ReferenceInput[];
  freshnessAt?: string;
  createdAt: string;
  updatedAt?: string;
  /** Phase 6a — populated by the storage layer on read. */
  namespace?: KnowledgeNamespace;
}

export type KnowledgeStatus = 'approved' | 'needs_review' | 'archived' | 'blocked';

export type KnowledgeReviewFilter =
  | 'questionable'
  | 'unsafe'
  | 'low_trust'
  | 'stale'
  | 'rejected'
  | 'irrelevant'
  | 'orphaned'
  | 'auto_memory'
  | 'risky_auto_memory';

export interface ListKnowledgeOptions {
  project?: string;
  query?: string;
  status?: KnowledgeStatus;
  review?: KnowledgeReviewFilter;
  limit: number;
}

export interface KnowledgePatchInput {
  status?: KnowledgeStatus;
  title?: string;
  summary?: string;
  trustLevel?: number;
  freshnessAt?: string | null;
  metadata?: Record<string, unknown>;
  labels?: LabelInput[];
  references?: ReferenceInput[];
  /** Phase 6a — when supplied, overrides the derived namespace. */
  namespace?: KnowledgeNamespace;
}

export interface LabelRecord extends LabelInput {
  knowledgeCount: number;
}
