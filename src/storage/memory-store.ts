import { randomUUID } from 'node:crypto';
import type {
  KnowledgeAtom,
  KnowledgeAtomInput,
  KnowledgeAtomPatch,
  ListAtomsOptions,
} from '../types/atoms.js';
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
  KnowledgeFeedbackSummary,
  KnowledgeGraphJsonlExport,
  KnowledgeInput,
  KnowledgeChunkRecord,
  KnowledgePatchInput,
  LearningProposal,
  LearningProposalInput,
  LearningProposalPatchInput,
  KnowledgeRelation,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  LabelInput,
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
  ReferenceInput,
  ReflectionDraft,
  ReflectionDraftPatchInput,
  ReflectionDraftInput,
  SearchCandidate,
  SearchOptions,
  StoredKnowledge,
} from '../types.js';
import { estimateTokens, normalizeLabel, uniqueStrings } from '../util/text.js';
import { cosineSimilarity } from '../util/vector.js';
import { getRetrievalPolicy, graphHopMultiplier } from '../retrieval/policy.js';
import {
  deriveNamespace,
  namespaceMatchesFilter,
  readNamespaceFromMetadata,
  writeNamespaceToMetadata,
} from './knowledge-namespace.js';
import type { SessionReplayBundle } from '../operations/session-replay.js';
import type {
  AtomGateEvent,
  AtomGateEventInput,
  AtomGraphHit,
  AtomGraphPathStep,
  AtomRelationInput,
  AtomRelationRow,
  ChunkInput,
  InferenceSource,
  KnowledgeStore,
  ListAtomRelationsOptions,
  PruneStaleAtomRelationsOptions,
  StaleFileAtomCleanupInput,
  UpsertSourceFileInput,
  ListSourceFilesOptions,
  RenameSourceFileInput,
  CreateSyncRunInput,
  WalkAtomGraphOptions,
  AtlasRunInput,
  AtlasRunRecord,
} from './store.js';
import type {
  AtomImportConflict,
  AtomImportConflictAction,
} from '../types/export-bundle.js';
import { importedSnapshotToPatch } from './atom-import-patch.js';
import { canonicalKnowledgePair, shouldDropInferredRelationsForStatus } from './shared.js';
import type {
  SourceFileRecord,
  SourceFileStatus,
  SyncRunRecord,
} from '../source-sync/types.js';

interface MemoryChunk extends ChunkInput {
  id: string;
  knowledgeId: string;
}

export class MemoryKnowledgeStore implements KnowledgeStore {
  private readonly knowledge = new Map<string, StoredKnowledge>();
  private readonly chunks = new Map<string, MemoryChunk>();
  private readonly knowledgeSourceUris = new Map<string, string>();
  private readonly packs = new Map<string, ContextPack>();
  private readonly drafts = new Map<string, ReflectionDraft>();
  private readonly relations = new Map<string, KnowledgeRelation>();
  private readonly conflicts = new Map<string, KnowledgeConflict>();
  private readonly gaps = new Map<string, KnowledgeGap>();
  private readonly proposals = new Map<string, LearningProposal>();
  private readonly agentSessions = new Map<string, AgentSession>();
  private readonly agentDecisions = new Map<string, AgentContextDecision>();
  private readonly sessionReplays = new Map<string, SessionReplayBundle>();
  private readonly feedback: FeedbackEvent[] = [];
  private readonly atoms = new Map<string, KnowledgeAtom>();
  // Embeddings are kept in a side map (keyed by atom id) rather than on the
  // public KnowledgeAtom shape so getAtom/deepEqual storage tests stay green.
  private readonly atomEmbeddings = new Map<string, number[]>();
  private readonly atomGateEvents = new Map<string, AtomGateEvent>();
  private readonly atomRelations = new Map<string, AtomRelationRow>();
  private readonly atomImportConflicts = new Map<string, AtomImportConflict>();
  private readonly sourceFiles = new Map<string, SourceFileRecord>(); // key: `${project} ${path}`
  private readonly syncRuns = new Map<string, SyncRunRecord>();
  private readonly atlasRuns: AtlasRunRecord[] = [];

  async withTransaction<T>(fn: (tx: KnowledgeStore) => Promise<T>): Promise<T> {
    const snapshot = this.snapshotState();
    try {
      return await fn(this);
    } catch (error) {
      this.restoreState(snapshot);
      throw error;
    }
  }

  /**
   * Deep-copy every mutable collection so a failed transaction can be rolled
   * back. All collections hold plain-data records (no class instances), so
   * `structuredClone` reproduces them faithfully, independent of the live maps.
   */
  private snapshotState() {
    const cloneMap = <K, V>(map: Map<K, V>): Map<K, V> =>
      new Map(structuredClone([...map.entries()]));
    return {
      knowledge: cloneMap(this.knowledge),
      chunks: cloneMap(this.chunks),
      knowledgeSourceUris: cloneMap(this.knowledgeSourceUris),
      packs: cloneMap(this.packs),
      drafts: cloneMap(this.drafts),
      relations: cloneMap(this.relations),
      conflicts: cloneMap(this.conflicts),
      gaps: cloneMap(this.gaps),
      proposals: cloneMap(this.proposals),
      agentSessions: cloneMap(this.agentSessions),
      agentDecisions: cloneMap(this.agentDecisions),
      sessionReplays: cloneMap(this.sessionReplays),
      feedback: structuredClone(this.feedback),
      atoms: cloneMap(this.atoms),
      atomEmbeddings: cloneMap(this.atomEmbeddings),
      atomGateEvents: cloneMap(this.atomGateEvents),
      atomRelations: cloneMap(this.atomRelations),
      atomImportConflicts: cloneMap(this.atomImportConflicts),
      sourceFiles: cloneMap(this.sourceFiles),
      syncRuns: cloneMap(this.syncRuns),
      atlasRuns: structuredClone(this.atlasRuns),
    };
  }

  private restoreState(s: ReturnType<MemoryKnowledgeStore['snapshotState']>): void {
    // Collections are `readonly` (cannot be reassigned), so restore in place by
    // clearing each and repopulating from the snapshot's cloned entries.
    const resetMap = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
      target.clear();
      for (const [k, v] of source) target.set(k, v);
    };
    const resetArray = <V>(target: V[], source: V[]): void => {
      target.length = 0;
      target.push(...source);
    };
    resetMap(this.knowledge, s.knowledge);
    resetMap(this.chunks, s.chunks);
    resetMap(this.knowledgeSourceUris, s.knowledgeSourceUris);
    resetMap(this.packs, s.packs);
    resetMap(this.drafts, s.drafts);
    resetMap(this.relations, s.relations);
    resetMap(this.conflicts, s.conflicts);
    resetMap(this.gaps, s.gaps);
    resetMap(this.proposals, s.proposals);
    resetMap(this.agentSessions, s.agentSessions);
    resetMap(this.agentDecisions, s.agentDecisions);
    resetMap(this.sessionReplays, s.sessionReplays);
    resetArray(this.feedback, s.feedback);
    resetMap(this.atoms, s.atoms);
    resetMap(this.atomEmbeddings, s.atomEmbeddings);
    resetMap(this.atomGateEvents, s.atomGateEvents);
    resetMap(this.atomRelations, s.atomRelations);
    resetMap(this.atomImportConflicts, s.atomImportConflicts);
    resetMap(this.sourceFiles, s.sourceFiles);
    resetMap(this.syncRuns, s.syncRuns);
    resetArray(this.atlasRuns, s.atlasRuns);
  }

  async upsertKnowledge(input: KnowledgeInput, chunks: ChunkInput[]): Promise<StoredKnowledge> {
    const now = new Date().toISOString();
    const existing = this.findKnowledgeBySourceUri(input.project, input.sourceUri);
    const id = existing?.id ?? randomUUID();
    const namespace = deriveNamespace({
      project: input.project,
      itemType: input.itemType,
      metadata: input.metadata,
      namespace: input.namespace,
    });
    const metadataWithNamespace = writeNamespaceToMetadata(input.metadata, namespace);
    const stored: StoredKnowledge = {
      id,
      project: input.project,
      sourceType: input.sourceType,
      sourceUri: input.sourceUri,
      status: existing?.status ?? 'approved',
      itemType: input.itemType,
      title: input.title,
      summary: input.summary ?? '',
      content: input.content,
      trustLevel: input.trustLevel ?? 50,
      metadata: metadataWithNamespace,
      labels: input.labels ?? [],
      references: input.references ?? [],
      freshnessAt: input.freshnessAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      namespace,
    };
    this.knowledge.set(id, stored);
    this.knowledgeSourceUris.set(id, input.sourceUri);
    this.deleteChunksForKnowledge(id);

    chunks.forEach((chunk) => {
      const chunkId = randomUUID();
      this.chunks.set(chunkId, { ...chunk, id: chunkId, knowledgeId: id });
    });

    return stored;
  }

  async deleteStaleFileAtoms(input: StaleFileAtomCleanupInput): Promise<number> {
    const keep = new Set(input.keepSourceUris);
    let deleted = 0;

    for (const [id, item] of this.knowledge.entries()) {
      if (!this.isStaleFileAtom(id, item, input, keep)) {
        continue;
      }

      this.knowledge.delete(id);
      this.knowledgeSourceUris.delete(id);
      this.deleteChunksForKnowledge(id);
      this.deleteRelationsForKnowledge(id);
      deleted += 1;
    }

    return deleted;
  }

  private sourceKey(project: string, path: string): string {
    return `${project} ${path}`;
  }

  async upsertSourceFile(input: UpsertSourceFileInput): Promise<SourceFileRecord> {
    const key = this.sourceKey(input.project, input.path);
    const now = new Date().toISOString();
    const existing = this.sourceFiles.get(key);
    const record: SourceFileRecord = existing
      ? {
          ...existing,
          contentHash: input.contentHash,
          status: input.status ?? existing.status,
          lastSyncedSha: input.lastSyncedSha ?? existing.lastSyncedSha,
          metadata: input.metadata ?? existing.metadata,
          lastSeenAt: now,
        }
      : {
          id: randomUUID(),
          project: input.project,
          path: input.path,
          contentHash: input.contentHash,
          status: input.status ?? 'tracked',
          lastSyncedSha: input.lastSyncedSha ?? null,
          priorPaths: [],
          knowledgeCount: 0,
          firstSeenAt: now,
          lastSeenAt: now,
          archivedAt: null,
          metadata: input.metadata ?? {},
        };
    this.sourceFiles.set(key, record);
    return { ...record };
  }

  async getSourceFile(options: { project: string; path: string }): Promise<SourceFileRecord | undefined> {
    const record = this.sourceFiles.get(this.sourceKey(options.project, options.path));
    return record ? { ...record } : undefined;
  }

  async listSourceFiles(options: ListSourceFilesOptions): Promise<SourceFileRecord[]> {
    return [...this.sourceFiles.values()]
      .filter((record) => (!options.project || record.project === options.project) && (!options.status || record.status === options.status))
      .slice(0, options.limit)
      .map((record) => ({ ...record }));
  }

  async renameSourceFile(input: RenameSourceFileInput): Promise<SourceFileRecord | undefined> {
    const fromKey = this.sourceKey(input.project, input.from);
    const record = this.sourceFiles.get(fromKey);
    if (!record) {
      return undefined;
    }
    this.sourceFiles.delete(fromKey);
    const moved: SourceFileRecord = {
      ...record,
      path: input.to,
      priorPaths: [...record.priorPaths, input.from],
      lastSeenAt: new Date().toISOString(),
    };
    this.sourceFiles.set(this.sourceKey(input.project, input.to), moved);
    return { ...moved };
  }

  async setSourceFileStatus(options: { project: string; path: string; status: SourceFileStatus }): Promise<SourceFileRecord | undefined> {
    const key = this.sourceKey(options.project, options.path);
    const record = this.sourceFiles.get(key);
    if (!record) {
      return undefined;
    }
    const updated: SourceFileRecord = {
      ...record,
      status: options.status,
      archivedAt: options.status === 'archived' ? new Date().toISOString() : record.archivedAt,
    };
    this.sourceFiles.set(key, updated);
    return { ...updated };
  }

  async listKnowledgeBySourcePath(options: { project: string; path: string }): Promise<StoredKnowledge[]> {
    return [...this.knowledge.values()]
      .filter((item) => item.project === options.project)
      .filter((item) => (item.metadata as Record<string, unknown> | undefined)?.['sourcePath'] === options.path)
      .map((item) => ({ ...item }));
  }

  async createSyncRun(input: CreateSyncRunInput): Promise<SyncRunRecord> {
    const run: SyncRunRecord = {
      id: randomUUID(),
      project: input.project,
      mode: input.mode,
      fromSha: input.fromSha ?? null,
      toSha: input.toSha ?? null,
      plan: input.plan,
      applied: false,
      trigger: input.trigger,
      createdAt: new Date().toISOString(),
      appliedAt: null,
    };
    this.syncRuns.set(run.id, run);
    return { ...run };
  }

  async getSyncRun(id: string): Promise<SyncRunRecord | undefined> {
    const run = this.syncRuns.get(id);
    return run ? { ...run } : undefined;
  }

  async markSyncRunApplied(id: string): Promise<SyncRunRecord | undefined> {
    const run = this.syncRuns.get(id);
    if (!run) {
      return undefined;
    }
    const updated: SyncRunRecord = { ...run, applied: true, appliedAt: new Date().toISOString() };
    this.syncRuns.set(id, updated);
    return { ...updated };
  }

  async createAtlasRun(input: AtlasRunInput): Promise<AtlasRunRecord> {
    const record: AtlasRunRecord = { ...input, id: randomUUID() };
    this.atlasRuns.push(record);
    return { ...record };
  }

  async getLatestAtlasRun(project: string): Promise<AtlasRunRecord | undefined> {
    const forProject = this.atlasRuns.filter((r) => r.project === project);
    const latest = forProject[forProject.length - 1];
    return latest ? { ...latest } : undefined;
  }

  async listKnowledge(options: ListKnowledgeOptions): Promise<StoredKnowledge[]> {
    const query = options.query?.toLowerCase();
    return [...this.knowledge.values()]
      .filter((item) => !options.project || item.project === options.project)
      .filter((item) => !options.status || item.status === options.status)
      .filter((item) => knowledgeMatchesReview(item, options.review, this.feedback))
      .filter((item) => {
        if (!query) {
          return true;
        }

        return `${item.title} ${item.summary} ${item.content}`.toLowerCase().includes(query);
      })
      .slice(0, options.limit);
  }

  async getKnowledge(id: string): Promise<StoredKnowledge | undefined> {
    return this.knowledge.get(id);
  }

  async updateKnowledge(id: string, patch: KnowledgePatchInput): Promise<StoredKnowledge | undefined> {
    const current = this.knowledge.get(id);
    if (!current) {
      return undefined;
    }

    const mergedMetadata = patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata;
    const namespace = patch.namespace ?? current.namespace ?? deriveNamespace({
      project: current.project,
      itemType: current.itemType,
      metadata: mergedMetadata,
    });
    const metadataWithNamespace = writeNamespaceToMetadata(mergedMetadata, namespace);
    const updated: StoredKnowledge = {
      ...current,
      status: patch.status ?? current.status,
      title: patch.title ?? current.title,
      summary: patch.summary ?? current.summary,
      trustLevel: patch.trustLevel ?? current.trustLevel,
      freshnessAt: patch.freshnessAt === null ? undefined : patch.freshnessAt ?? current.freshnessAt,
      metadata: metadataWithNamespace,
      labels: patch.labels ?? current.labels,
      references: patch.references ?? current.references,
      updatedAt: new Date().toISOString(),
      namespace,
    };
    this.knowledge.set(id, updated);
    if (shouldDropInferredRelationsForStatus(patch.status)) {
      this.deleteRelationsForKnowledge(id, { inferredOnly: true });
    }

    return updated;
  }

  async replaceInferredKnowledgeRelations(
    knowledgeId: string,
    relations: KnowledgeRelationInput[],
  ): Promise<KnowledgeRelation[]> {
    for (const [id, relation] of this.relations.entries()) {
      if (relation.fromKnowledgeId === knowledgeId && relation.inferred) {
        this.relations.delete(id);
      }
    }

    const created: KnowledgeRelation[] = [];
    for (const relation of relations) {
      created.push(await this.createKnowledgeRelation({ ...relation, inferred: true }));
    }

    return created;
  }

  async listKnowledgeRelations(options: ListKnowledgeRelationsOptions): Promise<KnowledgeRelation[]> {
    return [...this.relations.values()]
      .filter((relation) => !options.project || relation.project === options.project)
      .filter((relation) => !options.fromKnowledgeId || relation.fromKnowledgeId === options.fromKnowledgeId)
      .filter((relation) => !options.targetKnowledgeId || relation.targetKnowledgeId === options.targetKnowledgeId)
      .filter((relation) => !options.targetValue || relation.targetValue === options.targetValue)
      .filter((relation) => !options.relationType || relation.relationType === options.relationType)
      .filter((relation) => options.inferred === undefined || relation.inferred === options.inferred)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit);
  }

  async getKnowledgeRelation(id: string): Promise<KnowledgeRelation | undefined> {
    return this.relations.get(id);
  }

  async createKnowledgeRelation(input: KnowledgeRelationInput): Promise<KnowledgeRelation> {
    const from = this.knowledge.get(input.fromKnowledgeId);
    const now = new Date().toISOString();
    const baseMetadata = input.metadata ?? {};
    const metadata = typeof baseMetadata.validFrom === 'string'
      ? baseMetadata
      : { validFrom: now, ...baseMetadata };
    const relation: KnowledgeRelation = {
      ...input,
      id: randomUUID(),
      project: input.project ?? from?.project,
      confidence: input.confidence ?? 0.7,
      inferred: input.inferred ?? false,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
    this.relations.set(relation.id, relation);

    // Phase 6c — when memory A `supersedes` memory B, mark B's other inferred
    // outgoing relations as expired so graph expansion does not revive stale
    // edges from the superseded node. The supersedes relation itself is the
    // dominant edge and stays valid; only the *other* relations from the
    // superseded knowledge become invalid.
    if (relation.relationType === 'supersedes' && relation.targetKnowledgeId) {
      this.expireRelationsFromKnowledge(relation.targetKnowledgeId, now, relation.id);
    }
    return relation;
  }

  private expireRelationsFromKnowledge(
    knowledgeId: string,
    expiredAt: string,
    excludeRelationId?: string,
  ): void {
    for (const [id, existing] of this.relations.entries()) {
      if (id === excludeRelationId) continue;
      if (existing.fromKnowledgeId !== knowledgeId) continue;
      if (!existing.inferred) continue;
      if (typeof existing.metadata?.validUntil === 'string') continue;
      this.relations.set(id, {
        ...existing,
        metadata: { ...(existing.metadata ?? {}), validUntil: expiredAt },
        updatedAt: expiredAt,
      });
    }
  }

  async updateKnowledgeRelation(id: string, patch: KnowledgeRelationPatchInput): Promise<KnowledgeRelation | undefined> {
    const current = this.relations.get(id);
    if (!current) {
      return undefined;
    }

    const updated: KnowledgeRelation = {
      ...current,
      relationType: patch.relationType ?? current.relationType,
      targetKind: patch.targetKind ?? current.targetKind,
      targetKnowledgeId: patch.targetKnowledgeId === null ? undefined : patch.targetKnowledgeId ?? current.targetKnowledgeId,
      targetValue: patch.targetValue === null ? undefined : patch.targetValue ?? current.targetValue,
      confidence: patch.confidence ?? current.confidence,
      inferred: patch.inferred ?? current.inferred,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: new Date().toISOString(),
    };
    this.relations.set(id, updated);
    return updated;
  }

  async deleteKnowledgeRelation(id: string): Promise<boolean> {
    return this.relations.delete(id);
  }

  async listKnowledgeConflicts(options: ListKnowledgeConflictsOptions): Promise<KnowledgeConflict[]> {
    return [...this.conflicts.values()]
      .filter((conflict) => !options.project || conflict.project === options.project)
      .filter((conflict) => !options.status || conflict.status === options.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit);
  }

  async createKnowledgeConflict(input: KnowledgeConflictInput): Promise<KnowledgeConflict> {
    const [leftKnowledgeId, rightKnowledgeId] = canonicalKnowledgePair(input.leftKnowledgeId, input.rightKnowledgeId);
    const existing = [...this.conflicts.values()].find((conflict) => (
      conflict.leftKnowledgeId === leftKnowledgeId &&
      conflict.rightKnowledgeId === rightKnowledgeId &&
      conflict.conflictType === input.conflictType
    ));
    if (existing) {
      return existing;
    }

    const left = this.knowledge.get(leftKnowledgeId);
    const now = new Date().toISOString();
    const conflict: KnowledgeConflict = {
      ...input,
      id: randomUUID(),
      project: input.project ?? left?.project,
      leftKnowledgeId,
      rightKnowledgeId,
      status: 'open',
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.conflicts.set(conflict.id, conflict);
    return conflict;
  }

  async updateKnowledgeConflict(id: string, patch: KnowledgeConflictPatchInput): Promise<KnowledgeConflict | undefined> {
    const current = this.conflicts.get(id);
    if (!current) {
      return undefined;
    }

    const status = patch.status ?? current.status;
    const updated: KnowledgeConflict = {
      ...current,
      status,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: new Date().toISOString(),
      resolvedAt: status === 'open' ? undefined : current.resolvedAt ?? new Date().toISOString(),
    };
    this.conflicts.set(id, updated);
    return updated;
  }

  async createKnowledgeGap(input: KnowledgeGapInput): Promise<KnowledgeGap> {
    const existing = input.sourceFeedbackId
      ? [...this.gaps.values()].find((gap) => gap.sourceFeedbackId === input.sourceFeedbackId)
      : undefined;
    const now = new Date().toISOString();
    const gap: KnowledgeGap = {
      ...input,
      id: existing?.id ?? randomUUID(),
      status: existing?.status ?? 'open',
      missingSignals: uniqueStrings(input.missingSignals),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      reviewedAt: existing?.reviewedAt,
    };
    this.gaps.set(gap.id, gap);
    return gap;
  }

  async listKnowledgeGaps(options: ListKnowledgeGapsOptions): Promise<KnowledgeGap[]> {
    return [...this.gaps.values()]
      .filter((gap) => !options.project || gap.project === options.project)
      .filter((gap) => !options.status || gap.status === options.status)
      .filter((gap) => !options.sourceSessionId || gap.sourceSessionId === options.sourceSessionId)
      .filter((gap) => !options.contextPackId || gap.contextPackId === options.contextPackId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit);
  }

  async getKnowledgeGap(id: string): Promise<KnowledgeGap | undefined> {
    return this.gaps.get(id);
  }

  async updateKnowledgeGap(id: string, patch: KnowledgeGapPatchInput): Promise<KnowledgeGap | undefined> {
    const current = this.gaps.get(id);
    if (!current) {
      return undefined;
    }

    const updated: KnowledgeGap = {
      ...current,
      status: patch.status ?? current.status,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: new Date().toISOString(),
      reviewedAt: patch.status && patch.status !== 'open' ? new Date().toISOString() : current.reviewedAt,
    };
    this.gaps.set(id, updated);
    return updated;
  }

  async createLearningProposal(input: LearningProposalInput): Promise<LearningProposal> {
    const existing = input.sourceFeedbackId
      ? [...this.proposals.values()].find((proposal) => (
        proposal.sourceFeedbackId === input.sourceFeedbackId
        && proposal.proposalType === input.proposalType
        && proposal.affectedKnowledgeId === input.affectedKnowledgeId
      ))
      : undefined;
    const now = new Date().toISOString();
    const proposal: LearningProposal = {
      ...input,
      id: existing?.id ?? randomUUID(),
      status: existing?.status ?? 'open',
      evidence: uniqueStrings(input.evidence),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      reviewedAt: existing?.reviewedAt,
    };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  async listLearningProposals(options: ListLearningProposalsOptions): Promise<LearningProposal[]> {
    return [...this.proposals.values()]
      .filter((proposal) => !options.project || proposal.project === options.project)
      .filter((proposal) => !options.status || proposal.status === options.status)
      .filter((proposal) => !options.proposalType || proposal.proposalType === options.proposalType)
      .filter((proposal) => !options.sourceSessionId || proposal.sourceSessionId === options.sourceSessionId)
      .filter((proposal) => !options.contextPackId || proposal.contextPackId === options.contextPackId)
      .filter((proposal) => !options.affectedKnowledgeId || proposal.affectedKnowledgeId === options.affectedKnowledgeId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit);
  }

  async getLearningProposal(id: string): Promise<LearningProposal | undefined> {
    return this.proposals.get(id);
  }

  async updateLearningProposal(id: string, patch: LearningProposalPatchInput): Promise<LearningProposal | undefined> {
    const current = this.proposals.get(id);
    if (!current) {
      return undefined;
    }

    const updated: LearningProposal = {
      ...current,
      status: patch.status ?? current.status,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: new Date().toISOString(),
      reviewedAt: patch.status && patch.status !== 'open' ? new Date().toISOString() : current.reviewedAt,
    };
    this.proposals.set(id, updated);
    return updated;
  }

  async listLabels(options: { project?: string; limit: number }): Promise<LabelRecord[]> {
    const counts = new Map<string, LabelRecord>();
    for (const item of this.knowledge.values()) {
      if (options.project && item.project !== options.project) {
        continue;
      }

      for (const label of item.labels) {
        const key = `${label.type}:${normalizeLabel(label.value)}`;
        const existing = counts.get(key);
        if (existing) {
          existing.knowledgeCount += 1;
        } else {
          counts.set(key, { ...label, knowledgeCount: 1 });
        }
      }
    }

    return [...counts.values()]
      .sort((left, right) => right.knowledgeCount - left.knowledgeCount || left.value.localeCompare(right.value))
      .slice(0, options.limit);
  }

  async searchLexical(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]> {
    const terms = new Set(classified.lexicalQuery.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? []);
    return this.rankByText(terms, 'lexical', options);
  }

  async searchVector(embedding: number[], options: SearchOptions): Promise<SearchCandidate[]> {
    const candidates = [...this.chunks.values()]
      .map((chunk) => {
        const item = this.knowledge.get(chunk.knowledgeId);
        if (!item || !this.allowed(item, options)) {
          return undefined;
        }

        return this.toCandidate(item, chunk, 'vector', cosine(embedding, chunk.embedding));
      })
      .filter((candidate): candidate is SearchCandidate => Boolean(candidate))
      .sort((left, right) => right.rawScore - left.rawScore)
      .slice(0, options.limit);

    return withRanks(candidates);
  }

  async searchMetadata(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]> {
    const terms = [
      ...classified.files,
      ...classified.symbols,
      ...classified.errors,
      ...classified.technologies,
      ...classified.businessAreas,
      ...classified.exactTerms,
    ].map(normalizeLabel);
    return this.rankByText(new Set(terms), 'metadata', options);
  }

  async listKnowledgeChunks(knowledgeIds: string[]): Promise<KnowledgeChunkRecord[]> {
    const order = new Map(knowledgeIds.map((id, index) => [id, index]));
    return [...this.chunks.values()]
      .filter((chunk) => order.has(chunk.knowledgeId))
      .sort((left, right) => (
        (order.get(left.knowledgeId) ?? 0) - (order.get(right.knowledgeId) ?? 0)
        || left.index - right.index
      ))
      .map((chunk) => ({
        id: chunk.id,
        knowledgeId: chunk.knowledgeId,
        chunkIndex: chunk.index,
        content: chunk.content,
        contextualContent: chunk.contextualContent,
        tokenEstimate: chunk.tokenEstimate,
        metadata: chunk.metadata ?? {},
      }));
  }

  async searchMemories(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]> {
    const memoryTypes = new Set(['memory', 'workflow', 'rule', 'bugfix']);
    const terms = new Set(classified.lexicalQuery.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? []);
    return this.rankByText(terms, 'memory', options, (item) => memoryTypes.has(item.itemType));
  }

  async searchGraphRelations(
    classified: ClassifiedQuery,
    options: SearchOptions & { seedKnowledgeIds?: string[] },
  ): Promise<SearchCandidate[]> {
    const directTargets = graphTargetTerms(classified);
    // Phase 6d — the upstream seeds (metadata/lexical/memory/vector/worktree)
    // are each capped at SEARCH_LIMIT, so the union is naturally bounded; the
    // load-bearing fan-out limit is GRAPH_DEPTH2_CAP on the depth-2 expansion
    // pass below. The original Phase 6d spec called for a ≤8 cap here too,
    // but that regressed 3 retrieval-eval confidence thresholds (deviation
    // documented in the plan file).
    const seedKnowledgeIds = new Set(options.seedKnowledgeIds ?? []);
    const scored = new Map<string, GraphScore>();
    const policy = getRetrievalPolicy();
    const depth2Frontier = new Set<string>();
    // Phase 6c — evaluate validity once per query so the filter is consistent
    // across the multi-pass scan below.
    const validityCutoff = Date.now();

    for (const relation of this.relations.values()) {
      if (isRelationExpired(relation, validityCutoff)) continue;
      const item = this.knowledge.get(relation.fromKnowledgeId);
      if (!item || !this.allowed(item, options)) {
        continue;
      }

      const directScore = directTargets.has(graphRelationKey(relation.targetKind, relation.targetValue));
      if (directScore) {
        const score = graphHopMultiplier(policy, 'target', relation.relationType) * relation.confidence;
        keepBestGraphScore(scored, item.id, score, relation, 'target_signal');
        depth2Frontier.add(item.id);
      }

      if (seedKnowledgeIds.has(relation.fromKnowledgeId) && relation.targetKnowledgeId) {
        const score = graphHopMultiplier(policy, 'seed', relation.relationType) * relation.confidence;
        keepBestGraphScore(scored, relation.targetKnowledgeId, score, relation, 'seed_outbound');
        depth2Frontier.add(relation.targetKnowledgeId);
      }

      if (relation.targetKnowledgeId && seedKnowledgeIds.has(relation.targetKnowledgeId)) {
        const score = graphHopMultiplier(policy, 'seed', relation.relationType) * relation.confidence;
        keepBestGraphScore(scored, relation.fromKnowledgeId, score, relation, 'seed_inbound');
        depth2Frontier.add(relation.fromKnowledgeId);
      }
    }

    if (policy.graphMaxHops >= 2 && depth2Frontier.size > 0) {
      // Phase 6d — bound depth-2 expansion to GRAPH_DEPTH2_CAP relations.
      let depth2Count = 0;
      for (const relation of this.relations.values()) {
        if (depth2Count >= GRAPH_DEPTH2_CAP) break;
        if (isRelationExpired(relation, validityCutoff)) continue;
        if (!relation.targetKnowledgeId) continue;
        const fromInFrontier = depth2Frontier.has(relation.fromKnowledgeId);
        const toInFrontier = depth2Frontier.has(relation.targetKnowledgeId);
        if (fromInFrontier === toInFrontier) continue;
        const expandTo = fromInFrontier ? relation.targetKnowledgeId : relation.fromKnowledgeId;
        if (!expandTo || scored.has(expandTo) || depth2Frontier.has(expandTo)) continue;
        const target = this.knowledge.get(expandTo);
        if (!target || !this.allowed(target, options)) continue;
        const score = graphHopMultiplier(policy, 'depth2', relation.relationType) * relation.confidence;
        keepBestGraphScore(scored, expandTo, score, relation, 'depth2_expansion');
        depth2Count += 1;
      }
    }

    const candidates = [...scored.entries()]
      .map((entry): SearchCandidate | undefined => {
        const [knowledgeId, graphScore] = entry;
        const item = this.knowledge.get(knowledgeId);
        const chunk = [...this.chunks.values()].find((candidate) => candidate.knowledgeId === knowledgeId);
        if (!item || !chunk || !this.allowed(item, options)) {
          return undefined;
        }

        const candidate = this.toCandidate(item, chunk, 'graph', graphScore.score);
        return {
          ...candidate,
          metadata: {
            ...(candidate.metadata ?? {}),
            graphPaths: graphScore.paths,
          },
        };
      })
      .filter((candidate): candidate is SearchCandidate => Boolean(candidate))
      .sort((left, right) => right.rawScore - left.rawScore)
      .slice(0, options.limit);

    return withRanks(candidates);
  }

  async createContextQuery(): Promise<string> {
    return randomUUID();
  }

  async saveContextPack(pack: ContextPack): Promise<void> {
    this.packs.set(pack.id, pack);
  }

  async listContextPacks(options: ListRecordsOptions): Promise<ContextPack[]> {
    return [...this.packs.values()]
      .filter((pack) => !options.project || pack.project === options.project)
      .filter((pack) => !options.status || pack.status === options.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit);
  }

  async getContextPack(id: string): Promise<ContextPack | undefined> {
    return this.packs.get(id);
  }

  async recordFeedback(input: FeedbackInput): Promise<FeedbackEvent> {
    const event: FeedbackEvent = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.feedback.push(event);
    if (input.contextPackId) {
      const pack = this.packs.get(input.contextPackId);
      const nextStatus = packStatusForFeedback(input.feedbackType);
      if (pack && nextStatus) {
        pack.status = nextStatus;
      }
    }
    // Phase 6c — when feedback marks specific knowledge IDs as stale, expire
    // their outgoing inferred relations so graph expansion drops their edges.
    if (input.feedbackType === 'stale' && input.rejectedKnowledgeIds?.length) {
      for (const knowledgeId of input.rejectedKnowledgeIds) {
        this.expireRelationsFromKnowledge(knowledgeId, event.createdAt);
      }
    }
    return event;
  }

  async listFeedbackEvents(options: ListRecordsOptions): Promise<FeedbackEvent[]> {
    return this.feedback
      .filter((feedback) => !options.project || feedback.project === options.project || this.packs.get(feedback.contextPackId ?? '')?.project === options.project)
      .filter((feedback) => !options.status || feedback.feedbackType === options.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit);
  }

  async getFeedbackSummaries(
    knowledgeIds: string[],
    options: { project?: string } = {},
  ): Promise<Map<string, KnowledgeFeedbackSummary>> {
    const targetIds = new Set(knowledgeIds);
    const summaries = new Map<string, KnowledgeFeedbackSummary>();

    this.feedback.forEach((feedback) => {
      if (!feedbackMatchesProject(feedback, this.packs.get(feedback.contextPackId ?? ''), options.project)) {
        return;
      }

      for (const knowledgeId of feedbackKnowledgeIds(feedback, this.packs.get(feedback.contextPackId ?? ''))) {
        if (!targetIds.has(knowledgeId)) {
          continue;
        }

        const summary = ensureFeedbackSummary(summaries, knowledgeId);
        applyFeedbackToSummary(summary, feedback.feedbackType, feedback.createdAt);
      }
    });

    return summaries;
  }

  async createAgentSession(input: {
    prompt: string;
    project?: string;
    cwd?: string;
    agentName?: string;
    agentTool?: string;
    initialContextPackId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentSession> {
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: randomUUID(),
      project: input.project,
      cwd: input.cwd,
      prompt: input.prompt,
      agentName: input.agentName,
      agentTool: input.agentTool,
      status: 'active',
      initialContextPackId: input.initialContextPackId,
      reflectionDraftIds: [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.agentSessions.set(session.id, session);
    return session;
  }

  async listAgentSessions(options: ListRecordsOptions): Promise<AgentSession[]> {
    return [...this.agentSessions.values()]
      .filter((session) => !options.project || session.project === options.project)
      .filter((session) => !options.status || session.status === options.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit);
  }

  async getAgentSession(id: string): Promise<AgentSession | undefined> {
    return this.agentSessions.get(id);
  }

  async recordAgentContextDecision(input: RecordAgentContextDecisionInput & {
    retryContextPackId?: string;
  }): Promise<AgentContextDecision> {
    const decision: AgentContextDecision = {
      id: randomUUID(),
      sessionId: input.sessionId,
      contextPackId: input.contextPackId,
      decision: input.feedbackType,
      reason: input.reason,
      rejectedKnowledgeIds: input.rejectedKnowledgeIds ?? [],
      retryContextPackId: input.retryContextPackId,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    this.agentDecisions.set(decision.id, decision);
    this.touchAgentSession(input.sessionId);
    return decision;
  }

  async listAgentContextDecisions(options: { sessionId?: string; limit: number }): Promise<AgentContextDecision[]> {
    return [...this.agentDecisions.values()]
      .filter((decision) => !options.sessionId || decision.sessionId === options.sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit);
  }

  async finishAgentSession(input: FinishAgentSessionInput & {
    reflectionDraftIds?: string[];
  }): Promise<AgentSession | undefined> {
    const session = this.agentSessions.get(input.sessionId);
    if (!session) {
      return undefined;
    }

    const now = new Date().toISOString();
    const updated: AgentSession = {
      ...session,
      status: 'finished',
      outcome: input.outcome,
      summary: input.summary,
      reflectionDraftIds: [
        ...session.reflectionDraftIds,
        ...(input.reflectionDraftIds ?? []),
      ],
      metadata: {
        ...session.metadata,
        ...(input.metadata ?? {}),
      },
      updatedAt: now,
      finishedAt: now,
    };
    this.agentSessions.set(updated.id, updated);
    return updated;
  }

  async appendAgentSessionNote(input: {
    sessionId: string;
    note: AgentSessionNote;
  }): Promise<AgentSession | undefined> {
    const session = this.agentSessions.get(input.sessionId);
    if (!session) {
      return undefined;
    }

    const existingNotes = Array.isArray(session.metadata.notes)
      ? (session.metadata.notes as AgentSessionNote[])
      : [];

    const updated: AgentSession = {
      ...session,
      metadata: {
        ...session.metadata,
        notes: [...existingNotes, input.note],
      },
      updatedAt: new Date().toISOString(),
    };
    this.agentSessions.set(updated.id, updated);
    return updated;
  }

  async writeSessionReplay(bundle: SessionReplayBundle): Promise<void> {
    this.sessionReplays.set(bundle.sessionId, cloneJson(bundle));
  }

  async readSessionReplay(sessionId: string): Promise<SessionReplayBundle | null> {
    const bundle = this.sessionReplays.get(sessionId);
    return bundle ? cloneJson(bundle) : null;
  }

  async createReflectionDraft(input: ReflectionDraftInput, duplicateCandidates: unknown[]): Promise<ReflectionDraft> {
    const draft: ReflectionDraft = {
      id: randomUUID(),
      project: input.project,
      title: input.title,
      summary: input.summary,
      content: input.content,
      itemType: input.itemType ?? 'memory',
      triggerType: input.triggerType,
      status: 'pending',
      suggestedLabels: input.labels ?? [],
      references: input.references ?? [],
      metadata: input.metadata ?? {},
      duplicateCandidates: duplicateCandidates as ReflectionDraft['duplicateCandidates'],
      createdAt: new Date().toISOString(),
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  async listReflectionDrafts(options: ListRecordsOptions): Promise<ReflectionDraft[]> {
    return [...this.drafts.values()]
      .filter((draft) => !options.project || draft.project === options.project)
      .filter((draft) => !options.status || draft.status === options.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit);
  }

  async getReflectionDraft(id: string): Promise<ReflectionDraft | undefined> {
    return this.drafts.get(id);
  }

  async updateReflectionDraft(id: string, patch: ReflectionDraftPatchInput): Promise<ReflectionDraft | undefined> {
    const draft = this.drafts.get(id);
    if (!draft) {
      return undefined;
    }

    const updated: ReflectionDraft = {
      ...draft,
      status: patch.status ?? draft.status,
      suggestedLabels: patch.suggestedLabels ?? draft.suggestedLabels,
      references: patch.references ?? draft.references,
      metadata: patch.metadata ? { ...draft.metadata, ...patch.metadata } : draft.metadata,
    };
    this.drafts.set(id, updated);
    return updated;
  }

  async approveReflectionDraft(id: string): Promise<ReflectionDraft | undefined> {
    const draft = this.drafts.get(id);
    if (!draft) {
      return undefined;
    }

    draft.status = 'approved';
    return draft;
  }

  async exportProjectMap(options: { project?: string; limit: number }): Promise<ProjectMapExport> {
    const knowledge = await this.listKnowledge({ project: options.project, limit: options.limit });
    const relations = await this.listKnowledgeRelations({ project: options.project, limit: options.limit });
    const labels = await this.listLabels({ project: options.project, limit: options.limit });
    const sources = new Map<string, { uri?: string; title: string; itemCount: number }>();
    const relationCounts = new Map<KnowledgeRelation['relationType'], number>();

    for (const item of knowledge) {
      const key = item.sourceUri ?? item.title;
      const source = sources.get(key) ?? { uri: item.sourceUri, title: item.sourceUri ?? item.title, itemCount: 0 };
      source.itemCount += 1;
      sources.set(key, source);
    }

    for (const relation of relations) {
      relationCounts.set(relation.relationType, (relationCounts.get(relation.relationType) ?? 0) + 1);
    }

    return {
      project: options.project,
      generatedAt: new Date().toISOString(),
      knowledgeCount: knowledge.length,
      relationCount: relations.length,
      labelCount: labels.length,
      sources: [...sources.values()].sort((left, right) => right.itemCount - left.itemCount || left.title.localeCompare(right.title)),
      relationTypes: [...relationCounts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)),
    };
  }

  async exportKnowledgeGraphJsonl(options: { project?: string; limit: number }): Promise<KnowledgeGraphJsonlExport> {
    const knowledge = await this.listKnowledge({ project: options.project, limit: options.limit });
    const relations = await this.listKnowledgeRelations({ project: options.project, limit: options.limit });
    const lines = [
      ...knowledge.map((item) => JSON.stringify({
        kind: 'knowledge',
        id: item.id,
        project: item.project,
        title: item.title,
        itemType: item.itemType,
        sourceUri: item.sourceUri,
        labels: item.labels,
      })),
      ...relations.map((relation) => JSON.stringify({ kind: 'relation', ...relation })),
    ];

    return {
      project: options.project,
      generatedAt: new Date().toISOString(),
      content: lines.join('\n'),
    };
  }

  async exportReadableSummary(options: { project?: string; limit: number }): Promise<ReadableSummaryExport> {
    const map = await this.exportProjectMap(options);
    const lines = [
      `# ${options.project ?? 'All Projects'} Knowledge Summary`,
      '',
      `Generated: ${map.generatedAt}`,
      `Knowledge items: ${map.knowledgeCount}`,
      `Relations: ${map.relationCount}`,
      `Labels: ${map.labelCount}`,
      '',
      '## Sources',
      ...map.sources.map((source) => `- ${source.title}: ${source.itemCount}`),
      '',
      '## Relation Types',
      ...map.relationTypes.map((relation) => `- ${relation.type}: ${relation.count}`),
    ];

    return {
      project: options.project,
      generatedAt: map.generatedAt,
      content: lines.join('\n'),
    };
  }

  async cleanupOperations(input: CleanupOperationsInput): Promise<CleanupOperationsResult> {
    const olderThanDays = input.olderThanDays ?? 30;
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const stalePackIds = new Set([...this.packs.values()]
      .filter((pack) => pack.status === 'proposed' && Date.parse(pack.createdAt) < cutoff)
      .map((pack) => pack.id));
    const staleFeedback = this.feedback.filter((feedback) => Date.parse(feedback.createdAt) < cutoff && (!feedback.contextPackId || stalePackIds.has(feedback.contextPackId)));
    const unusedSourceIds = [...this.knowledgeSourceUris.keys()]
      .filter((id) => !this.knowledge.has(id));

    const result: CleanupOperationsResult = {
      dryRun: Boolean(input.dryRun),
      olderThanDays,
      deleted: {
        contextQueries: 0,
        contextPacks: stalePackIds.size,
        feedbackEvents: staleFeedback.length,
        knowledgeSources: unusedSourceIds.length,
      },
    };

    if (!input.dryRun) {
      for (const id of stalePackIds) {
        this.packs.delete(id);
      }
      for (const feedback of staleFeedback) {
        const index = this.feedback.findIndex((item) => item.id === feedback.id);
        if (index >= 0) {
          this.feedback.splice(index, 1);
        }
      }
      for (const id of unusedSourceIds) {
        this.knowledgeSourceUris.delete(id);
      }
    }

    return result;
  }

  async exportBackup(): Promise<BackupExportData> {
    return {
      tables: [
        { name: 'projects', rows: uniqueProjectRows([...this.knowledge.values()], [...this.packs.values()], [...this.agentSessions.values()], [...this.drafts.values()], [...this.gaps.values()], [...this.proposals.values()]) },
        { name: 'knowledge_sources', rows: [...this.knowledge.values()].map((item) => ({ knowledgeId: item.id, uri: this.knowledgeSourceUris.get(item.id) ?? item.sourceUri, sourceType: item.sourceType })) },
        { name: 'knowledge_items', rows: [...this.knowledge.values()].map((item) => ({ ...item })) },
        { name: 'labels', rows: [] },
        { name: 'knowledge_labels', rows: [] },
        { name: 'knowledge_references', rows: [] },
        { name: 'knowledge_relations', rows: [...this.relations.values()].map((relation) => ({ ...relation })) },
        { name: 'knowledge_conflicts', rows: [...this.conflicts.values()].map((conflict) => ({ ...conflict })) },
        { name: 'knowledge_chunks', rows: [...this.chunks.values()].map((chunk) => ({ ...chunk })) },
        { name: 'reflection_drafts', rows: [...this.drafts.values()].map((draft) => ({ ...draft })) },
        { name: 'context_queries', rows: [] },
        { name: 'context_packs', rows: [...this.packs.values()].map((pack) => ({ ...pack })) },
        { name: 'feedback_events', rows: this.feedback.map((feedback) => ({ ...feedback })) },
        { name: 'agent_sessions', rows: [...this.agentSessions.values()].map((session) => ({ ...session })) },
        { name: 'agent_context_decisions', rows: [...this.agentDecisions.values()].map((decision) => ({ ...decision })) },
        { name: 'knowledge_gaps', rows: [...this.gaps.values()].map((gap) => ({ ...gap })) },
        { name: 'learning_proposals', rows: [...this.proposals.values()].map((proposal) => ({ ...proposal })) },
      ],
    };
  }

  async restoreBackup(input: { tables: BackupTableData[]; dryRun?: boolean; replace?: boolean }): Promise<Record<string, number>> {
    if (!input.dryRun && !input.replace) {
      throw new Error('Memory restore requires replace=true unless dryRun=true.');
    }

    const counts = Object.fromEntries(input.tables.map((table) => [table.name, table.rows.length]));
    if (input.dryRun) {
      return counts;
    }

    this.knowledge.clear();
    this.chunks.clear();
    this.knowledgeSourceUris.clear();
    this.packs.clear();
    this.drafts.clear();
    this.relations.clear();
    this.conflicts.clear();
    this.gaps.clear();
    this.proposals.clear();
    this.agentSessions.clear();
    this.agentDecisions.clear();
    this.feedback.length = 0;

    for (const row of tableRows(input.tables, 'knowledge_items')) {
      const item = row as unknown as StoredKnowledge;
      this.knowledge.set(item.id, item);
      if (typeof item.sourceUri === 'string') {
        this.knowledgeSourceUris.set(item.id, item.sourceUri);
      }
    }
    for (const row of tableRows(input.tables, 'knowledge_sources')) {
      const knowledgeId = String(row.knowledgeId ?? '');
      const uri = typeof row.uri === 'string' ? row.uri : undefined;
      if (knowledgeId && uri) {
        this.knowledgeSourceUris.set(knowledgeId, uri);
      }
    }
    for (const row of tableRows(input.tables, 'knowledge_chunks')) {
      const chunk = row as unknown as MemoryChunk;
      this.chunks.set(chunk.id, chunk);
    }
    for (const row of tableRows(input.tables, 'knowledge_relations')) {
      const relation = row as unknown as KnowledgeRelation;
      this.relations.set(relation.id, relation);
    }
    for (const row of tableRows(input.tables, 'knowledge_conflicts')) {
      const conflict = row as unknown as KnowledgeConflict;
      this.conflicts.set(conflict.id, conflict);
    }
    for (const row of tableRows(input.tables, 'knowledge_gaps')) {
      const gap = row as unknown as KnowledgeGap;
      this.gaps.set(gap.id, gap);
    }
    for (const row of tableRows(input.tables, 'learning_proposals')) {
      const proposal = row as unknown as LearningProposal;
      this.proposals.set(proposal.id, proposal);
    }
    for (const row of tableRows(input.tables, 'context_packs')) {
      const pack = row as unknown as ContextPack;
      this.packs.set(pack.id, pack);
    }
    for (const row of tableRows(input.tables, 'feedback_events')) {
      this.feedback.push(row as unknown as FeedbackEvent);
    }
    for (const row of tableRows(input.tables, 'reflection_drafts')) {
      const draft = row as unknown as ReflectionDraft;
      this.drafts.set(draft.id, draft);
    }
    for (const row of tableRows(input.tables, 'agent_sessions')) {
      const session = row as unknown as AgentSession;
      this.agentSessions.set(session.id, session);
    }
    for (const row of tableRows(input.tables, 'agent_context_decisions')) {
      const decision = row as unknown as AgentContextDecision;
      this.agentDecisions.set(decision.id, decision);
    }

    return counts;
  }

  async createAtom(input: KnowledgeAtomInput): Promise<KnowledgeAtom> {
    const now = new Date().toISOString();
    const scope: KnowledgeAtom['scope'] = input.scope ?? 'project';
    const atom: KnowledgeAtom = {
      id: input.id ?? randomUUID(),
      project: input.project,
      parentKnowledgeId: input.parentKnowledgeId,
      claim: input.claim,
      type: input.type,
      evidence: input.evidence,
      trigger: input.trigger,
      verification: input.verification,
      pitfalls: input.pitfalls,
      links: input.links,
      tier: 'draft',
      reuseCount: 0,
      lastReusedAt: undefined,
      status: 'active',
      audit: {
        producedBy: input.producedBy,
        producedAtSessionId: input.producedAtSessionId,
        createdAt: now,
        updatedAt: now,
      },
      scope,
      userId: scope === 'user' ? input.userId : undefined,
      priority: scope === 'user' ? input.priority : undefined,
      metadata: input.metadata ?? {},
    };
    this.atoms.set(atom.id, atom);
    if (input.embedding) {
      this.atomEmbeddings.set(atom.id, input.embedding);
    }
    return atom;
  }

  async getAtom(id: string): Promise<KnowledgeAtom | undefined> {
    return this.atoms.get(id);
  }

  async listAtoms(options: ListAtomsOptions): Promise<KnowledgeAtom[]> {
    return [...this.atoms.values()]
      .filter((atom) => !options.project || atom.project === options.project)
      .filter((atom) => !options.tier || atom.tier === options.tier)
      .filter((atom) => !options.status || atom.status === options.status)
      .filter((atom) => !options.parentKnowledgeId || atom.parentKnowledgeId === options.parentKnowledgeId)
      .filter((atom) => !options.scope || atom.scope === options.scope)
      .filter((atom) => !options.userId || atom.userId === options.userId)
      .slice(0, options.limit);
  }

  async updateAtom(id: string, patch: KnowledgeAtomPatch): Promise<KnowledgeAtom | undefined> {
    const existing = this.atoms.get(id);
    if (!existing) return undefined;
    // Only apply defined patch keys so an explicit `undefined` (e.g. an optional
    // field a caller didn't set) cannot clobber an existing value. Matches the
    // Postgres store, which builds its SET clause from defined fields only.
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as KnowledgeAtomPatch;
    const updated: KnowledgeAtom = {
      ...existing,
      ...definedPatch,
      audit: { ...existing.audit, updatedAt: new Date().toISOString() },
    };
    this.atoms.set(id, updated);
    return updated;
  }

  async deleteAtom(id: string): Promise<boolean> {
    this.atomEmbeddings.delete(id);
    return this.atoms.delete(id);
  }

  async incrementAtomReuse(id: string, when: string): Promise<KnowledgeAtom | undefined> {
    const existing = this.atoms.get(id);
    if (!existing) return undefined;
    return this.updateAtom(id, {
      reuseCount: existing.reuseCount + 1,
      lastReusedAt: when,
    });
  }

  async searchAtomsByEmbedding(
    queryEmbedding: number[],
    options: { project?: string; limit: number; threshold?: number; scope?: 'project' | 'user'; userId?: string },
  ): Promise<Array<{ atom: KnowledgeAtom; cosine: number }>> {
    const threshold = options.threshold ?? 0.92;
    return [...this.atoms.values()]
      .filter((atom) => !options.project || atom.project === options.project)
      .filter((atom) => !options.scope || atom.scope === options.scope)
      .filter((atom) => !options.userId || atom.userId === options.userId)
      .map((atom) => {
        const stored = this.atomEmbeddings.get(atom.id);
        // Atoms without a stored embedding fall back to cosine 1.0 so existing
        // threshold-0.0 dedup checks (which seed atoms with no embedding) work.
        const cosine = stored ? cosineSimilarity(queryEmbedding, stored) : 1.0;
        return { atom, cosine };
      })
      .filter((entry) => entry.cosine >= threshold)
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, options.limit);
  }

  async searchAtomsByTrigger(
    trigger: { errors?: string[]; files?: string[]; symbols?: string[]; taskTypes?: string[] },
    options: { project?: string; limit: number; scope?: 'project' | 'user'; userId?: string },
  ): Promise<KnowledgeAtom[]> {
    const wantErrors = (trigger.errors ?? []).map((s) => s.toLowerCase());
    const wantFiles = (trigger.files ?? []).map((s) => s.toLowerCase());
    const wantSymbols = (trigger.symbols ?? []).map((s) => s.toLowerCase());
    const wantTaskTypes = (trigger.taskTypes ?? []).map((s) => s.toLowerCase());

    const matchesAny = (haystack: string[] | undefined, needles: string[]): boolean => {
      if (needles.length === 0) return false;
      const lowered = (haystack ?? []).map((s) => s.toLowerCase());
      return needles.some((n) => lowered.some((h) => h.includes(n) || n.includes(h)));
    };

    return [...this.atoms.values()]
      .filter((atom) => atom.status === 'active')
      .filter((atom) => !options.project || atom.project === options.project)
      .filter((atom) => !options.scope || atom.scope === options.scope)
      .filter((atom) => !options.userId || atom.userId === options.userId)
      .filter((atom) =>
        matchesAny(atom.trigger.errors, wantErrors)
        || matchesAny(atom.trigger.files, wantFiles)
        || matchesAny(atom.trigger.symbols, wantSymbols)
        || matchesAny(atom.trigger.taskTypes, wantTaskTypes),
      )
      .slice(0, options.limit);
  }

  async replaceAtomRelations(
    fromAtomId: string,
    inputs: AtomRelationInput[],
    options: { source: InferenceSource },
  ): Promise<AtomRelationRow[]> {
    for (const [id, row] of this.atomRelations.entries()) {
      if (row.fromAtomId === fromAtomId && row.inferenceSource === options.source) {
        this.atomRelations.delete(id);
      }
    }
    const written: AtomRelationRow[] = [];
    for (const input of inputs) {
      const row: AtomRelationRow = {
        id: randomUUID(),
        fromAtomId: input.fromAtomId,
        targetKind: input.targetKind ?? 'atom',
        targetAtomId: input.targetAtomId,
        relationType: input.relationType,
        confidence: input.confidence,
        inferenceSource: options.source,
        createdAt: new Date().toISOString(),
      };
      this.atomRelations.set(row.id, row);
      written.push(row);
    }
    return written;
  }

  async listAtomRelations(options: ListAtomRelationsOptions): Promise<AtomRelationRow[]> {
    const wantProject = options.project;
    return [...this.atomRelations.values()]
      .filter((r) => !options.fromAtomId || r.fromAtomId === options.fromAtomId)
      .filter((r) => !options.targetAtomId || r.targetAtomId === options.targetAtomId)
      .filter((r) => !options.relationType || r.relationType === options.relationType)
      .filter((r) => !options.inferenceSource || r.inferenceSource === options.inferenceSource)
      .filter((r) => !wantProject || this.atoms.get(r.fromAtomId)?.project === wantProject)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit);
  }

  async walkAtomGraph(options: WalkAtomGraphOptions): Promise<AtomGraphHit[]> {
    const excludeArchived = options.excludeArchived ?? true;
    if (options.depth < 1 || options.seedAtomIds.length === 0) return [];

    const visited = new Set<string>(options.seedAtomIds);
    const results: AtomGraphHit[] = [];

    interface Frontier {
      atomId: string;
      path: AtomGraphPathStep[];
      score: number;
    }

    let frontier: Frontier[] = options.seedAtomIds.map((id) => ({ atomId: id, path: [], score: 1 }));

    for (let hop = 1; hop <= options.depth && frontier.length > 0; hop += 1) {
      const next: Frontier[] = [];
      for (const node of frontier) {
        const edges = [...this.atomRelations.values()].filter(
          (r) => r.fromAtomId === node.atomId && (r.targetKind ?? 'atom') === 'atom',
        );
        for (const edge of edges) {
          if (visited.has(edge.targetAtomId)) continue;
          const target = this.atoms.get(edge.targetAtomId);
          if (!target) continue;
          if (excludeArchived && (target.status === 'archived' || target.status === 'legacy_archived')) continue;
          if (options.project && target.project !== options.project) continue;
          const weight = options.edgeWeights[edge.relationType] ?? 0;
          if (weight <= 0) continue;

          const hopMultiplier = hop === 1 ? 1 : Math.pow(options.decayPerHop, hop - 1);
          const score = node.score * weight * hopMultiplier;
          if (score <= 0) continue;

          const step: AtomGraphPathStep = {
            atomId: edge.targetAtomId,
            edgeKind: edge.relationType,
            edgeConfidence: edge.confidence,
          };
          const path = [...node.path, step];

          visited.add(edge.targetAtomId);
          const clamped = Math.min(1, score);
          results.push({ atomId: edge.targetAtomId, path, pathScore: clamped });
          next.push({ atomId: edge.targetAtomId, path, score });
        }
      }
      frontier = next;
    }

    return results
      .sort((a, b) => b.pathScore - a.pathScore)
      .slice(0, options.limit);
  }

  async pruneStaleAtomRelations(
    options: PruneStaleAtomRelationsOptions,
  ): Promise<{ removed: number }> {
    let removed = 0;
    for (const [id, row] of [...this.atomRelations.entries()]) {
      if (options.project && this.atoms.get(row.fromAtomId)?.project !== options.project) continue;
      if (row.confidence < options.floorConfidence) {
        if (!options.dryRun) this.atomRelations.delete(id);
        removed += 1;
      }
    }
    return { removed };
  }

  async searchKnowledgeByEmbedding(
    _embedding: number[],
    options: {
      project?: string;
      limit: number;
      threshold?: number;
      itemTypes?: string[];
      excludeLegacyStatuses?: Array<'legacy_replaced' | 'legacy_archived'>;
    },
  ): Promise<Array<{ knowledge: StoredKnowledge; cosine: number }>> {
    const items = await this.listKnowledge({ project: options.project, limit: 1000 });
    const itemTypeFilter = options.itemTypes ? new Set(options.itemTypes) : undefined;
    const excludeLegacy = new Set(options.excludeLegacyStatuses ?? []);
    return items
      .filter((item) => !itemTypeFilter || itemTypeFilter.has(item.itemType))
      .filter((item) => {
        const legacy = (item.metadata as { legacyStatus?: string } | undefined)?.legacyStatus;
        return !legacy || !excludeLegacy.has(legacy as 'legacy_replaced' | 'legacy_archived');
      })
      // The memory store has no real embeddings; cross-type dedup fixtures
      // assert presence/absence under a 0.0 threshold rather than exact cosine,
      // so we report a constant high similarity for every surviving candidate.
      .map((knowledge) => ({ knowledge, cosine: 0.95 }))
      .filter(({ cosine }) => cosine >= (options.threshold ?? 0))
      .slice(0, options.limit);
  }

  async countNegativeFeedback(knowledgeId: string, withinDays: number): Promise<number> {
    const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
    const negativeTypes = new Set(['rejected', 'stale', 'irrelevant']);
    return this.feedback
      .filter((event) => negativeTypes.has(event.feedbackType))
      .filter((event) => new Date(event.createdAt).getTime() >= cutoff)
      .filter((event) =>
        (event.rejectedKnowledgeIds ?? []).includes(knowledgeId)
        || (event.metadata as { affectedKnowledgeId?: string } | undefined)?.affectedKnowledgeId === knowledgeId,
      )
      .length;
  }

  async recordAtomGateEvent(input: AtomGateEventInput): Promise<AtomGateEvent> {
    const event: AtomGateEvent = {
      id: randomUUID(),
      ...input,
      createdAt: new Date().toISOString(),
    };
    this.atomGateEvents.set(event.id, event);
    return event;
  }

  async listAtomGateEvents(
    options: { project?: string; windowDays: number; limit: number },
  ): Promise<AtomGateEvent[]> {
    const cutoff = Date.now() - options.windowDays * 24 * 60 * 60 * 1000;
    return [...this.atomGateEvents.values()]
      .filter((e) => !options.project || e.project === options.project)
      .filter((e) => new Date(e.createdAt).getTime() >= cutoff)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit);
  }

  async createAtomImportConflict(input: {
    project: string;
    atomId: string;
    localSnapshot: unknown;
    importedSnapshot: unknown;
    bundleSource: string;
  }): Promise<AtomImportConflict> {
    const row: AtomImportConflict = {
      id: randomUUID(),
      project: input.project,
      atomId: input.atomId,
      localSnapshot: input.localSnapshot as AtomImportConflict['localSnapshot'],
      importedSnapshot: input.importedSnapshot as AtomImportConflict['importedSnapshot'],
      bundleSource: input.bundleSource,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.atomImportConflicts.set(row.id, row);
    return row;
  }

  async listAtomImportConflicts(options: {
    project?: string;
    status?: string;
    limit: number;
  }): Promise<AtomImportConflict[]> {
    return [...this.atomImportConflicts.values()]
      .filter((c) => !options.project || c.project === options.project)
      .filter((c) => !options.status || c.status === options.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit);
  }

  async getAtomImportConflict(id: string): Promise<AtomImportConflict | undefined> {
    return this.atomImportConflicts.get(id);
  }

  async resolveAtomImportConflict(
    id: string,
    action: AtomImportConflictAction,
    mergedSnapshot?: unknown,
    notes?: string,
  ): Promise<AtomImportConflict | undefined> {
    const row = this.atomImportConflicts.get(id);
    if (!row) return undefined;
    const status: AtomImportConflict['status'] =
      action === 'keep_local' ? 'resolved_keep_local'
      : action === 'take_imported' ? 'resolved_take_imported'
      : action === 'merged' ? 'resolved_merged'
      : 'dismissed';
    const next: AtomImportConflict = {
      ...row,
      status,
      resolutionNotes: notes,
      resolvedAt: new Date().toISOString(),
    };
    this.atomImportConflicts.set(id, next);

    if (action === 'take_imported') {
      await this.updateAtom(next.atomId, importedSnapshotToPatch(next.importedSnapshot));
    } else if (action === 'merged' && mergedSnapshot) {
      const m = mergedSnapshot as KnowledgeAtomPatch;
      await this.updateAtom(next.atomId, m);
    }
    return next;
  }

  async close(): Promise<void> {}

  private findKnowledgeBySourceUri(project: string, sourceUri: string): StoredKnowledge | undefined {
    for (const [id, item] of this.knowledge.entries()) {
      if (item.project === project && this.knowledgeSourceUris.get(id) === sourceUri) {
        return item;
      }
    }

    return undefined;
  }

  private isStaleFileAtom(
    id: string,
    item: StoredKnowledge,
    input: StaleFileAtomCleanupInput,
    keep: Set<string>,
  ): boolean {
    const sourceUri = this.knowledgeSourceUris.get(id);
    return (
      item.project === input.project &&
      item.metadata.ingestionMode === 'atomic' &&
      item.metadata.sourcePath === input.sourcePath &&
      (!sourceUri || !keep.has(sourceUri))
    );
  }

  private deleteChunksForKnowledge(knowledgeId: string): void {
    for (const [chunkId, chunk] of this.chunks.entries()) {
      if (chunk.knowledgeId === knowledgeId) {
        this.chunks.delete(chunkId);
      }
    }
  }

  private deleteRelationsForKnowledge(knowledgeId: string, options: { inferredOnly?: boolean } = {}): void {
    for (const [relationId, relation] of this.relations.entries()) {
      if (options.inferredOnly && !relation.inferred) {
        continue;
      }

      if (relation.fromKnowledgeId === knowledgeId || relation.targetKnowledgeId === knowledgeId) {
        this.relations.delete(relationId);
      }
    }
  }

  private touchAgentSession(sessionId: string): void {
    const session = this.agentSessions.get(sessionId);
    if (session) {
      this.agentSessions.set(sessionId, {
        ...session,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private rankByText(
    terms: Set<string>,
    source: SearchCandidate['source'],
    options: SearchOptions,
    itemFilter: (item: StoredKnowledge) => boolean = () => true,
  ): SearchCandidate[] {
    const candidates = [...this.chunks.values()]
      .map((chunk) => {
        const item = this.knowledge.get(chunk.knowledgeId);
        if (!item || !this.allowed(item, options) || !itemFilter(item)) {
          return undefined;
        }

        const haystack = `${item.title} ${item.summary} ${chunk.contextualContent} ${JSON.stringify(item.metadata)} ${item.labels
          .map((label) => label.value)
          .join(' ')} ${item.references.map((reference) => reference.uri).join(' ')}`.toLowerCase();
        const matches = [...terms].filter((term) => haystack.includes(term.toLowerCase()));
        if (matches.length === 0) {
          return undefined;
        }

        return this.toCandidate(item, chunk, source, matches.length / Math.max(1, terms.size));
      })
      .filter((candidate): candidate is SearchCandidate => Boolean(candidate))
      .sort((left, right) => right.rawScore - left.rawScore)
      .slice(0, options.limit);

    return withRanks(candidates);
  }

  private allowed(item: StoredKnowledge, options: SearchOptions): boolean {
    return (
      item.status === 'approved' &&
      (!options.project || item.project === options.project) &&
      !(options.rejectedKnowledgeIds ?? []).includes(item.id)
    );
  }

  private toCandidate(
    item: StoredKnowledge,
    chunk: MemoryChunk,
    source: SearchCandidate['source'],
    rawScore: number,
  ): SearchCandidate {
    return {
      knowledgeId: item.id,
      chunkId: chunk.id,
      title: item.title,
      summary: item.summary,
      content: chunk.content,
      contextualContent: chunk.contextualContent,
      itemType: item.itemType,
      project: item.project,
      labels: item.labels,
      references: item.references,
      tokenEstimate: chunk.tokenEstimate || estimateTokens(chunk.contextualContent),
      trustLevel: item.trustLevel,
      source,
      rawScore,
      rank: 0,
      createdAt: item.createdAt,
      freshnessAt: item.freshnessAt,
      metadata: item.metadata,
    };
  }
}

function tableRows(tables: BackupTableData[], name: BackupTableData['name']): Array<Record<string, unknown>> {
  return tables.find((table) => table.name === name)?.rows ?? [];
}

function uniqueProjectRows(
  knowledge: StoredKnowledge[],
  packs: ContextPack[],
  sessions: AgentSession[],
  drafts: ReflectionDraft[],
  gaps: KnowledgeGap[],
  proposals: LearningProposal[],
): Array<Record<string, unknown>> {
  const names = new Set([
    ...knowledge.map((item) => item.project),
    ...packs.map((pack) => pack.project).filter((project): project is string => Boolean(project)),
    ...sessions.map((session) => session.project).filter((project): project is string => Boolean(project)),
    ...drafts.map((draft) => draft.project).filter((project): project is string => Boolean(project)),
    ...gaps.map((gap) => gap.project).filter((project): project is string => Boolean(project)),
    ...proposals.map((proposal) => proposal.project).filter((project): project is string => Boolean(project)),
  ]);

  return [...names].map((name) => ({ name }));
}

function knowledgeMatchesReview(
  item: StoredKnowledge,
  review: ListKnowledgeOptions['review'],
  feedback: FeedbackEvent[],
): boolean {
  if (!review) {
    return true;
  }

  const safety = item.metadata.safety as { status?: string; redactionCount?: number } | undefined;
  const rejected = feedback.some((event) => event.rejectedKnowledgeIds?.includes(item.id) && event.feedbackType === 'rejected');
  const irrelevant = feedback.some((event) => event.rejectedKnowledgeIds?.includes(item.id) && event.feedbackType === 'irrelevant');
  const stale = feedback.some((event) => event.rejectedKnowledgeIds?.includes(item.id) && event.feedbackType === 'stale');
  const unsafe = safety?.status === 'suspicious' || safety?.status === 'blocked' || Number(safety?.redactionCount ?? 0) > 0;
  const lowTrust = item.trustLevel < 50;
  const orphaned = item.references.length === 0 && item.labels.length === 0;
  const autoMemory = item.metadata.source === 'agent_session_finish' || item.metadata.learningMode === 'auto';
  const weakAutoMemory = autoMemory && (
    !item.references.some((reference) => reference.type !== 'conversation')
    || !item.labels.some((label) => ['task_type', 'file', 'symbol', 'error'].includes(label.type))
  );

  if (review === 'questionable') {
    return unsafe || lowTrust || stale || rejected || irrelevant || item.status !== 'approved';
  }

  if (review === 'auto_memory') {
    return autoMemory;
  }

  if (review === 'risky_auto_memory') {
    return autoMemory && (unsafe || lowTrust || stale || rejected || irrelevant || item.status !== 'approved' || weakAutoMemory);
  }

  if (review === 'unsafe') {
    return unsafe;
  }

  if (review === 'low_trust') {
    return lowTrust;
  }

  if (review === 'stale') {
    return stale;
  }

  if (review === 'rejected') {
    return rejected;
  }

  if (review === 'irrelevant') {
    return irrelevant;
  }

  return orphaned;
}

function withRanks(candidates: SearchCandidate[]): SearchCandidate[] {
  return candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/**
 * Phase 6d — cap on the number of depth-2 edges actually expanded per query.
 * The upstream seed union is naturally bounded by SEARCH_LIMIT (each source
 * caps at 18), so this is the load-bearing fan-out limit.
 */
const GRAPH_DEPTH2_CAP = 16;

/**
 * Phase 6c — return true when the relation has expired (metadata.validUntil is
 * a parseable ISO timestamp at or before `nowEpochMs`). Treats absent or
 * unparseable validUntil as valid — backwards-compatible default.
 */
function isRelationExpired(relation: KnowledgeRelation, nowEpochMs: number): boolean {
  const value = relation.metadata?.validUntil;
  if (typeof value !== 'string') return false;
  const expiresAtMs = Date.parse(value);
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs <= nowEpochMs;
}

interface GraphScore {
  score: number;
  paths: GraphPath[];
}

interface GraphPath {
  relationId: string;
  relationType: KnowledgeRelation['relationType'];
  fromKnowledgeId: string;
  targetKind: KnowledgeRelation['targetKind'];
  targetKnowledgeId?: string;
  targetValue?: string;
  confidence: number;
  reason: 'target_signal' | 'seed_outbound' | 'seed_inbound' | 'depth2_expansion';
}

function keepBestGraphScore(
  scored: Map<string, GraphScore>,
  knowledgeId: string,
  score: number,
  relation: KnowledgeRelation,
  reason: GraphPath['reason'],
): void {
  const path: GraphPath = {
    relationId: relation.id,
    relationType: relation.relationType,
    fromKnowledgeId: relation.fromKnowledgeId,
    targetKind: relation.targetKind,
    targetKnowledgeId: relation.targetKnowledgeId,
    targetValue: relation.targetValue,
    confidence: relation.confidence,
    reason,
  };
  const existing = scored.get(knowledgeId);
  if (!existing) {
    scored.set(knowledgeId, { score, paths: [path] });
    return;
  }

  if (score > existing.score) {
    scored.set(knowledgeId, { score, paths: [path, ...existing.paths].slice(0, 3) });
    return;
  }

  if (score === existing.score) {
    scored.set(knowledgeId, { ...existing, paths: [...existing.paths, path].slice(0, 3) });
  }
}

function graphTargetTerms(classified: ClassifiedQuery): Set<string> {
  return new Set([
    ...classified.files.map((file) => graphRelationKey('file', file)),
    ...classified.symbols.map((symbol) => graphRelationKey('symbol', symbol)),
    ...classified.errors.map((error) => graphRelationKey('error', error)),
  ]);
}

function graphRelationKey(kind: string, value: string | undefined): string {
  return `${kind}:${normalizeLabel(value ?? '')}`;
}

function feedbackMatchesProject(
  feedback: FeedbackInput,
  pack: ContextPack | undefined,
  project: string | undefined,
): boolean {
  return !project || feedback.project === project || pack?.project === project;
}

function feedbackKnowledgeIds(feedback: FeedbackInput, pack: ContextPack | undefined): string[] {
  if (!FEEDBACK_TYPES_THAT_AFFECT_RANKING.has(feedback.feedbackType)) {
    return [];
  }

  const positive = feedback.feedbackType === 'selected' || feedback.feedbackType === 'selected_but_noisy';
  if (!positive && feedback.rejectedKnowledgeIds?.length) {
    return feedback.rejectedKnowledgeIds;
  }

  return pack?.sections.flatMap((section) => section.items.map((item) => item.knowledgeId)) ?? [];
}

const FEEDBACK_TYPES_THAT_AFFECT_RANKING = new Set<FeedbackInput['feedbackType']>([
  'selected',
  'selected_but_noisy',
  'rejected',
  'irrelevant',
  'stale',
]);

function packStatusForFeedback(feedbackType: FeedbackInput['feedbackType']): ContextPack['status'] | undefined {
  if (feedbackType === 'selected' || feedbackType === 'selected_but_noisy') {
    return 'selected';
  }

  if (feedbackType === 'rejected' || feedbackType === 'irrelevant' || feedbackType === 'stale') {
    return 'rejected';
  }

  return undefined;
}

function ensureFeedbackSummary(
  summaries: Map<string, KnowledgeFeedbackSummary>,
  knowledgeId: string,
): KnowledgeFeedbackSummary {
  const existing = summaries.get(knowledgeId);
  if (existing) {
    return existing;
  }

  const created: KnowledgeFeedbackSummary = {
    knowledgeId,
    selectedCount: 0,
    selectedNoisyCount: 0,
    rejectedCount: 0,
    irrelevantCount: 0,
    staleCount: 0,
  };
  summaries.set(knowledgeId, created);

  return created;
}

function applyFeedbackToSummary(
  summary: KnowledgeFeedbackSummary,
  feedbackType: FeedbackInput['feedbackType'],
  timestamp: string,
): void {
  switch (feedbackType) {
    case 'selected':
      summary.selectedCount += 1;
      break;
    case 'selected_but_noisy':
      summary.selectedNoisyCount += 1;
      break;
    case 'rejected':
      summary.rejectedCount += 1;
      break;
    case 'irrelevant':
      summary.irrelevantCount += 1;
      break;
    case 'stale':
      summary.staleCount += 1;
      break;
  }

  if (FEEDBACK_TYPES_THAT_AFFECT_RANKING.has(feedbackType)) {
    summary.latestFeedbackType = feedbackType;
    summary.latestFeedbackAt = timestamp;
  }
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const l = left[index]!;
    const r = right[index]!;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }

  if (!leftNorm || !rightNorm) {
    return 0;
  }

  return dot / Math.sqrt(leftNorm * rightNorm);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
