import type {
  KnowledgeAtom,
  KnowledgeAtomInput,
  KnowledgeAtomPatch,
  ListAtomsOptions,
} from '../types/atoms.js';
import type {
  AtomImportConflict,
  AtomImportConflictAction,
} from '../types/export-bundle.js';
import type {
  AgentContextDecision,
  AgentSession,
  AgentSessionNote,
  BackupExportData,
  BackupTableData,
  ClassifiedQuery,
  CleanupOperationsInput,
  CleanupOperationsResult,
  ContextPack,
  FeedbackEvent,
  FeedbackInput,
  FinishAgentSessionInput,
  KnowledgeConflict,
  KnowledgeConflictInput,
  KnowledgeConflictPatchInput,
  KnowledgeGap,
  KnowledgeGapInput,
  KnowledgeGapPatchInput,
  KnowledgePatchInput,
  KnowledgeChunkRecord,
  KnowledgeFeedbackSummary,
  KnowledgeInput,
  KnowledgeGraphJsonlExport,
  LearningProposal,
  LearningProposalInput,
  LearningProposalPatchInput,
  KnowledgeRelation,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  LabelRecord,
  ListKnowledgeConflictsOptions,
  ListKnowledgeGapsOptions,
  ListLearningProposalsOptions,
  ListKnowledgeRelationsOptions,
  ListKnowledgeOptions,
  ListRecordsOptions,
  ProjectMapExport,
  RecordAgentContextDecisionInput,
  ReadableSummaryExport,
  ReflectionDraft,
  ReflectionDraftPatchInput,
  ReflectionDraftInput,
  SearchCandidate,
  SearchOptions,
  StoredKnowledge,
} from '../types.js';
import type { SessionReplayBundle } from '../operations/session-replay.js';
import type {
  SourceFileRecord,
  SourceFileStatus,
  SyncMode,
  SyncPlan,
  SyncRunRecord,
  SyncTrigger,
} from '../source-sync/types.js';

export interface ChunkInput {
  index: number;
  content: string;
  contextualContent: string;
  tokenEstimate: number;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface StaleFileAtomCleanupInput {
  project: string;
  sourcePath: string;
  keepSourceUris: string[];
}

export interface UpsertSourceFileInput {
  project: string;
  path: string;
  contentHash: string | null;
  status?: SourceFileStatus;
  lastSyncedSha?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListSourceFilesOptions {
  project?: string;
  status?: SourceFileStatus;
  limit: number;
}

export interface RenameSourceFileInput {
  project: string;
  from: string;
  to: string;
}

export interface CreateSyncRunInput {
  project: string;
  mode: SyncMode;
  plan: SyncPlan;
  trigger: SyncTrigger;
  fromSha?: string | null;
  toSha?: string | null;
}

export interface AtlasRunInput {
  project: string;
  inputHash: string;
  files: { name: string; bytes: number }[];
  generatedAt: string;
}

export interface AtlasRunRecord extends AtlasRunInput {
  id: string;
}

/**
 * Concern C1 — provenance for an atom-edge row in `knowledge_relations`. The
 * column also serves as the dedup key for the JSONB ↔ relations mirror:
 * `replaceAtomRelations(fromAtomId, …, { source })` deletes only this source's
 * rows for the given atom before inserting the new ones.
 */
export type InferenceSource = 'migration' | 'semantic' | 'co_change' | 'refines_detector' | 'manual';

export type AtomRelationTargetKind = 'atom' | 'knowledge';

export interface AtomRelationInput {
  fromAtomId: string;
  /** When omitted, the target is treated as an atom (default). */
  targetKind?: AtomRelationTargetKind;
  /** Target atom id (when targetKind='atom') or knowledge_items id (when 'knowledge'). */
  targetAtomId: string;
  relationType: 'supersedes' | 'refines' | 'depends_on' | 'co_changes_with' | 'related_to';
  confidence: number;
  inferenceSource: InferenceSource;
}

export interface AtomRelationRow extends AtomRelationInput {
  id: string;
  createdAt: string;
}

export interface ListAtomRelationsOptions {
  fromAtomId?: string;
  targetAtomId?: string;
  project?: string;
  relationType?: AtomRelationInput['relationType'];
  inferenceSource?: InferenceSource;
  limit: number;
}

export interface PruneStaleAtomRelationsOptions {
  project?: string;
  floorConfidence: number;
  dryRun?: boolean;
}

/**
 * Concern C2 — one hop on the atom graph from a recursive walk. Path is
 * ordered seed → leaf. `pathScore` is the product of `edgeWeights[k]` along
 * each hop, multiplied by `decayPerHop^(hop-1)` for hops ≥ 2, clamped to 0..1.
 */
export type AtomGraphEdgeKind = AtomRelationInput['relationType'];

export interface AtomGraphPathStep {
  atomId: string;
  edgeKind: AtomGraphEdgeKind;
  edgeConfidence: number;
}

export interface AtomGraphHit {
  atomId: string;
  path: AtomGraphPathStep[];
  pathScore: number;
}

export interface WalkAtomGraphOptions {
  project: string;
  seedAtomIds: string[];
  depth: number;
  edgeWeights: Record<AtomGraphEdgeKind, number>;
  decayPerHop: number;
  limit: number;
  /** Default true — atoms whose status is archived/legacy_archived are filtered. */
  excludeArchived?: boolean;
}

export interface AtomGateEvent {
  id: string;
  project?: string;
  sessionId?: string;
  atomId?: string;
  candidateClaim: string;
  candidateType: string;
  stage: 'triviality' | 'floor' | 'dedup' | 'llm_critic';
  outcome: 'accepted' | 'rejected' | 'pending' | 'queue_legacy_migration';
  reasons: string[];
  createdAt: string;
}

export interface AtomGateEventInput {
  project?: string;
  sessionId?: string;
  atomId?: string;
  candidateClaim: string;
  candidateType: string;
  stage: AtomGateEvent['stage'];
  outcome: AtomGateEvent['outcome'];
  reasons: string[];
}

export interface KnowledgeStore {
  upsertKnowledge(input: KnowledgeInput, chunks: ChunkInput[]): Promise<StoredKnowledge>;
  deleteStaleFileAtoms(input: StaleFileAtomCleanupInput): Promise<number>;
  // --- Source lifecycle sync (P0) ---
  upsertSourceFile(input: UpsertSourceFileInput): Promise<SourceFileRecord>;
  getSourceFile(options: { project: string; path: string }): Promise<SourceFileRecord | undefined>;
  listSourceFiles(options: ListSourceFilesOptions): Promise<SourceFileRecord[]>;
  renameSourceFile(input: RenameSourceFileInput): Promise<SourceFileRecord | undefined>;
  setSourceFileStatus(options: { project: string; path: string; status: SourceFileStatus }): Promise<SourceFileRecord | undefined>;
  listKnowledgeBySourcePath(options: { project: string; path: string }): Promise<StoredKnowledge[]>;
  createSyncRun(input: CreateSyncRunInput): Promise<SyncRunRecord>;
  getSyncRun(id: string): Promise<SyncRunRecord | undefined>;
  markSyncRunApplied(id: string): Promise<SyncRunRecord | undefined>;
  createAtlasRun(input: AtlasRunInput): Promise<AtlasRunRecord>;
  getLatestAtlasRun(project: string): Promise<AtlasRunRecord | undefined>;
  listKnowledge(options: ListKnowledgeOptions): Promise<StoredKnowledge[]>;
  getKnowledge(id: string): Promise<StoredKnowledge | undefined>;
  updateKnowledge(id: string, patch: KnowledgePatchInput): Promise<StoredKnowledge | undefined>;
  replaceInferredKnowledgeRelations(knowledgeId: string, relations: KnowledgeRelationInput[]): Promise<KnowledgeRelation[]>;
  listKnowledgeRelations(options: ListKnowledgeRelationsOptions): Promise<KnowledgeRelation[]>;
  getKnowledgeRelation(id: string): Promise<KnowledgeRelation | undefined>;
  createAtom(input: KnowledgeAtomInput): Promise<KnowledgeAtom>;
  getAtom(id: string): Promise<KnowledgeAtom | undefined>;
  listAtoms(options: ListAtomsOptions): Promise<KnowledgeAtom[]>;
  updateAtom(id: string, patch: KnowledgeAtomPatch): Promise<KnowledgeAtom | undefined>;
  deleteAtom(id: string): Promise<boolean>;
  incrementAtomReuse(id: string, when: string): Promise<KnowledgeAtom | undefined>;
  searchAtomsByEmbedding(embedding: number[], options: { project?: string; limit: number; threshold?: number; scope?: 'project' | 'user' | 'team'; userId?: string; teamId?: string }): Promise<Array<{ atom: KnowledgeAtom; cosine: number }>>;
  searchAtomsByTrigger(trigger: { errors?: string[]; files?: string[]; symbols?: string[]; taskTypes?: string[] }, options: { project?: string; limit: number; scope?: 'project' | 'user' | 'team'; userId?: string; teamId?: string }): Promise<KnowledgeAtom[]>;
  replaceAtomRelations(
    fromAtomId: string,
    inputs: AtomRelationInput[],
    options: { source: InferenceSource },
  ): Promise<AtomRelationRow[]>;
  listAtomRelations(options: ListAtomRelationsOptions): Promise<AtomRelationRow[]>;
  pruneStaleAtomRelations(options: PruneStaleAtomRelationsOptions): Promise<{ removed: number }>;
  /** Concern C2 — recursive atom-graph walk with kind weights and hop decay. */
  walkAtomGraph(options: WalkAtomGraphOptions): Promise<AtomGraphHit[]>;
  searchKnowledgeByEmbedding(
    embedding: number[],
    options: {
      project?: string;
      limit: number;
      threshold?: number;
      itemTypes?: string[];
      excludeLegacyStatuses?: Array<'legacy_replaced' | 'legacy_archived'>;
    },
  ): Promise<Array<{ knowledge: StoredKnowledge; cosine: number }>>;
  countNegativeFeedback(knowledgeId: string, withinDays: number): Promise<number>;
  recordAtomGateEvent(input: AtomGateEventInput): Promise<AtomGateEvent>;
  listAtomGateEvents(options: { project?: string; windowDays: number; limit: number }): Promise<AtomGateEvent[]>;
  createKnowledgeRelation(input: KnowledgeRelationInput): Promise<KnowledgeRelation>;
  updateKnowledgeRelation(id: string, patch: KnowledgeRelationPatchInput): Promise<KnowledgeRelation | undefined>;
  deleteKnowledgeRelation(id: string): Promise<boolean>;
  listKnowledgeConflicts(options: ListKnowledgeConflictsOptions): Promise<KnowledgeConflict[]>;
  createKnowledgeConflict(input: KnowledgeConflictInput): Promise<KnowledgeConflict>;
  updateKnowledgeConflict(id: string, patch: KnowledgeConflictPatchInput): Promise<KnowledgeConflict | undefined>;
  createKnowledgeGap(input: KnowledgeGapInput): Promise<KnowledgeGap>;
  getKnowledgeGap(id: string): Promise<KnowledgeGap | undefined>;
  listKnowledgeGaps(options: ListKnowledgeGapsOptions): Promise<KnowledgeGap[]>;
  updateKnowledgeGap(id: string, patch: KnowledgeGapPatchInput): Promise<KnowledgeGap | undefined>;
  createLearningProposal(input: LearningProposalInput): Promise<LearningProposal>;
  getLearningProposal(id: string): Promise<LearningProposal | undefined>;
  listLearningProposals(options: ListLearningProposalsOptions): Promise<LearningProposal[]>;
  updateLearningProposal(id: string, patch: LearningProposalPatchInput): Promise<LearningProposal | undefined>;
  listLabels(options: { project?: string; limit: number }): Promise<LabelRecord[]>;
  listKnowledgeChunks(knowledgeIds: string[]): Promise<KnowledgeChunkRecord[]>;
  searchLexical(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]>;
  searchVector(embedding: number[], options: SearchOptions): Promise<SearchCandidate[]>;
  searchMetadata(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]>;
  searchMemories(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]>;
  searchGraphRelations(classified: ClassifiedQuery, options: SearchOptions & { seedKnowledgeIds?: string[] }): Promise<SearchCandidate[]>;
  exportProjectMap(options: { project?: string; limit: number }): Promise<ProjectMapExport>;
  exportKnowledgeGraphJsonl(options: { project?: string; limit: number }): Promise<KnowledgeGraphJsonlExport>;
  exportReadableSummary(options: { project?: string; limit: number }): Promise<ReadableSummaryExport>;
  createContextQuery(input: {
    project?: string;
    prompt: string;
    fingerprint: string;
    classified: ClassifiedQuery;
    tokenBudget: number;
  }): Promise<string>;
  saveContextPack(pack: ContextPack): Promise<void>;
  listContextPacks(options: ListRecordsOptions): Promise<ContextPack[]>;
  getContextPack(id: string): Promise<ContextPack | undefined>;
  recordFeedback(input: FeedbackInput): Promise<FeedbackEvent>;
  listFeedbackEvents(options: ListRecordsOptions): Promise<FeedbackEvent[]>;
  getFeedbackSummaries(knowledgeIds: string[], options?: { project?: string }): Promise<Map<string, KnowledgeFeedbackSummary>>;
  createAgentSession(input: {
    prompt: string;
    project?: string;
    cwd?: string;
    agentName?: string;
    agentTool?: string;
    initialContextPackId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentSession>;
  listAgentSessions(options: ListRecordsOptions): Promise<AgentSession[]>;
  getAgentSession(id: string): Promise<AgentSession | undefined>;
  recordAgentContextDecision(input: RecordAgentContextDecisionInput & {
    retryContextPackId?: string;
  }): Promise<AgentContextDecision>;
  listAgentContextDecisions(options: { sessionId?: string; limit: number }): Promise<AgentContextDecision[]>;
  finishAgentSession(input: FinishAgentSessionInput & {
    reflectionDraftIds?: string[];
  }): Promise<AgentSession | undefined>;
  appendAgentSessionNote(input: {
    sessionId: string;
    note: AgentSessionNote;
  }): Promise<AgentSession | undefined>;
  writeSessionReplay(bundle: SessionReplayBundle): Promise<void>;
  readSessionReplay(sessionId: string): Promise<SessionReplayBundle | null>;
  listReflectionDrafts(options: ListRecordsOptions): Promise<ReflectionDraft[]>;
  getReflectionDraft(id: string): Promise<ReflectionDraft | undefined>;
  createReflectionDraft(input: ReflectionDraftInput, duplicateCandidates: unknown[]): Promise<ReflectionDraft>;
  updateReflectionDraft(id: string, patch: ReflectionDraftPatchInput): Promise<ReflectionDraft | undefined>;
  approveReflectionDraft(id: string): Promise<ReflectionDraft | undefined>;
  cleanupOperations(input: CleanupOperationsInput): Promise<CleanupOperationsResult>;
  createAtomImportConflict(input: {
    project: string;
    atomId: string;
    localSnapshot: unknown;
    importedSnapshot: unknown;
    bundleSource: string;
  }): Promise<AtomImportConflict>;
  listAtomImportConflicts(options: {
    project?: string;
    status?: AtomImportConflict['status'] | string;
    limit: number;
  }): Promise<AtomImportConflict[]>;
  getAtomImportConflict(id: string): Promise<AtomImportConflict | undefined>;
  resolveAtomImportConflict(
    id: string,
    action: AtomImportConflictAction,
    mergedSnapshot?: unknown,
    notes?: string,
  ): Promise<AtomImportConflict | undefined>;
  exportBackup(): Promise<BackupExportData>;
  restoreBackup(input: { tables: BackupTableData[]; dryRun?: boolean; replace?: boolean }): Promise<Record<string, number>>;
  close(): Promise<void>;
}
