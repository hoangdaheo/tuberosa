import { randomUUID } from 'node:crypto';
import type {
  AgentContextDecision,
  AgentSession,
  BackupExportData,
  BackupTableData,
  ClassifiedQuery,
  CleanupOperationsInput,
  CleanupOperationsResult,
  ContextPack,
  FeedbackEvent,
  FeedbackInput,
  FinishAgentSessionInput,
  KnowledgeFeedbackSummary,
  KnowledgeGraphJsonlExport,
  KnowledgeInput,
  KnowledgeChunkRecord,
  KnowledgePatchInput,
  KnowledgeRelation,
  KnowledgeRelationInput,
  KnowledgeRelationPatchInput,
  LabelInput,
  LabelRecord,
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
import { estimateTokens, normalizeLabel } from '../util/text.js';
import type { ChunkInput, KnowledgeStore, StaleFileAtomCleanupInput } from './store.js';

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
  private readonly agentSessions = new Map<string, AgentSession>();
  private readonly agentDecisions = new Map<string, AgentContextDecision>();
  private readonly feedback: FeedbackEvent[] = [];

  async upsertKnowledge(input: KnowledgeInput, chunks: ChunkInput[]): Promise<StoredKnowledge> {
    const now = new Date().toISOString();
    const existing = this.findKnowledgeBySourceUri(input.project, input.sourceUri);
    const id = existing?.id ?? randomUUID();
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
      metadata: input.metadata ?? {},
      labels: input.labels ?? [],
      references: input.references ?? [],
      freshnessAt: input.freshnessAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
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

    const updated: StoredKnowledge = {
      ...current,
      status: patch.status ?? current.status,
      title: patch.title ?? current.title,
      summary: patch.summary ?? current.summary,
      trustLevel: patch.trustLevel ?? current.trustLevel,
      freshnessAt: patch.freshnessAt === null ? undefined : patch.freshnessAt ?? current.freshnessAt,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      labels: patch.labels ?? current.labels,
      references: patch.references ?? current.references,
      updatedAt: new Date().toISOString(),
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
    const relation: KnowledgeRelation = {
      ...input,
      id: randomUUID(),
      project: input.project ?? from?.project,
      confidence: input.confidence ?? 0.7,
      inferred: input.inferred ?? false,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.relations.set(relation.id, relation);
    return relation;
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
    const seedKnowledgeIds = new Set(options.seedKnowledgeIds ?? []);
    const scored = new Map<string, GraphScore>();

    for (const relation of this.relations.values()) {
      const item = this.knowledge.get(relation.fromKnowledgeId);
      if (!item || !this.allowed(item, options) || item.status !== 'approved') {
        continue;
      }

      const directScore = directTargets.has(graphRelationKey(relation.targetKind, relation.targetValue));
      if (directScore) {
        const score = 0.95 * relation.confidence;
        keepBestGraphScore(scored, item.id, score, relation, 'target_signal');
      }

      if (seedKnowledgeIds.has(relation.fromKnowledgeId) && relation.targetKnowledgeId) {
        const score = 0.68 * relation.confidence;
        keepBestGraphScore(scored, relation.targetKnowledgeId, score, relation, 'seed_outbound');
      }

      if (relation.targetKnowledgeId && seedKnowledgeIds.has(relation.targetKnowledgeId)) {
        const score = 0.68 * relation.confidence;
        keepBestGraphScore(scored, relation.fromKnowledgeId, score, relation, 'seed_inbound');
      }
    }

    const candidates = [...scored.entries()]
      .map((entry): SearchCandidate | undefined => {
        const [knowledgeId, graphScore] = entry;
        const item = this.knowledge.get(knowledgeId);
        const chunk = [...this.chunks.values()].find((candidate) => candidate.knowledgeId === knowledgeId);
        if (!item || !chunk || !this.allowed(item, options) || item.status !== 'approved') {
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

  async recordFeedback(input: FeedbackInput): Promise<void> {
    this.feedback.push({
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    if (input.contextPackId) {
      const pack = this.packs.get(input.contextPackId);
      if (pack) {
        pack.status = input.feedbackType === 'selected' ? 'selected' : 'rejected';
      }
    }
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
        { name: 'projects', rows: uniqueProjectRows([...this.knowledge.values()], [...this.packs.values()], [...this.agentSessions.values()], [...this.drafts.values()]) },
        { name: 'knowledge_sources', rows: [...this.knowledge.values()].map((item) => ({ knowledgeId: item.id, uri: this.knowledgeSourceUris.get(item.id) ?? item.sourceUri, sourceType: item.sourceType })) },
        { name: 'knowledge_items', rows: [...this.knowledge.values()].map((item) => ({ ...item })) },
        { name: 'labels', rows: [] },
        { name: 'knowledge_labels', rows: [] },
        { name: 'knowledge_references', rows: [] },
        { name: 'knowledge_relations', rows: [...this.relations.values()].map((relation) => ({ ...relation })) },
        { name: 'knowledge_chunks', rows: [...this.chunks.values()].map((chunk) => ({ ...chunk })) },
        { name: 'reflection_drafts', rows: [...this.drafts.values()].map((draft) => ({ ...draft })) },
        { name: 'context_queries', rows: [] },
        { name: 'context_packs', rows: [...this.packs.values()].map((pack) => ({ ...pack })) },
        { name: 'feedback_events', rows: this.feedback.map((feedback) => ({ ...feedback })) },
        { name: 'agent_sessions', rows: [...this.agentSessions.values()].map((session) => ({ ...session })) },
        { name: 'agent_context_decisions', rows: [...this.agentDecisions.values()].map((decision) => ({ ...decision })) },
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
): Array<Record<string, unknown>> {
  const names = new Set([
    ...knowledge.map((item) => item.project),
    ...packs.map((pack) => pack.project).filter((project): project is string => Boolean(project)),
    ...sessions.map((session) => session.project).filter((project): project is string => Boolean(project)),
    ...drafts.map((draft) => draft.project).filter((project): project is string => Boolean(project)),
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

  if (review === 'questionable') {
    return unsafe || lowTrust || stale || rejected || irrelevant || item.status !== 'approved';
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
  reason: 'target_signal' | 'seed_outbound' | 'seed_inbound';
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

function shouldDropInferredRelationsForStatus(status: StoredKnowledge['status'] | undefined): boolean {
  return status === 'archived' || status === 'blocked';
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
  if (feedback.feedbackType !== 'selected' && feedback.rejectedKnowledgeIds?.length) {
    return feedback.rejectedKnowledgeIds;
  }

  return pack?.sections.flatMap((section) => section.items.map((item) => item.knowledgeId)) ?? [];
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
  if (feedbackType === 'selected') {
    summary.selectedCount += 1;
  } else if (feedbackType === 'rejected') {
    summary.rejectedCount += 1;
  } else if (feedbackType === 'irrelevant') {
    summary.irrelevantCount += 1;
  } else if (feedbackType === 'stale') {
    summary.staleCount += 1;
  }

  if (feedbackType !== 'missing_context') {
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
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (!leftNorm || !rightNorm) {
    return 0;
  }

  return dot / Math.sqrt(leftNorm * rightNorm);
}
