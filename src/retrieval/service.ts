import type { Cache } from '../cache.js';
import type { AppConfig } from '../config.js';
import type { ModelProvider } from '../model/provider.js';
import type {
  AgentContextDecision,
  ClassifiedQuery,
  ContextFit,
  ContextPack,
  ContextSearchInput,
  DeepContext,
  DeepContextItem,
  DeepContextSection,
  FeedbackInput,
  KnowledgeChunkRecord,
  KnowledgeFeedbackSummary,
  KnowledgeRelation,
  KnowledgeSearchResult,
  QueryRewriteResult,
  RetrievalEvidenceType,
  RankedCandidate,
  SearchOptions,
} from '../types.js';
import { sha256, stableJson } from '../util/hash.js';
import { normalizeLabel, uniqueStrings } from '../util/text.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import type { KnowledgeStore } from '../storage/store.js';
import { assembleContextPack, normalizeDeepContextBudget } from './context-pack.js';
import { classifyQuery } from './classifier.js';
import { RetrievalDebugBuilder, stripDebugTrace, timed } from './debug.js';
import { ContextFitEvaluator } from './context-fit.js';
import { fuseCandidates } from './fusion.js';

const DEFAULT_TOKEN_BUDGET = 4000;
const SEARCH_LIMIT = 18;
const RERANK_LIMIT = 24;
const CONTINUATION_SESSION_LIMIT = 6;
const CONTINUATION_FILE_LIMIT = 8;
const CONTINUATION_SYMBOL_LIMIT = 8;
const CONTINUATION_ERROR_LIMIT = 6;
const RETRY_FEEDBACK_TYPES = new Set<FeedbackInput['feedbackType']>(['rejected', 'irrelevant', 'stale']);

type NormalizedContextSearchInput = ContextSearchInput & {
  tokenBudget: number;
  contextMode: 'compact' | 'layered';
  deepContextBudget: number;
  rejectedKnowledgeIds: string[];
  debug: boolean;
};

export class RetrievalService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly cache: Cache,
    private readonly models: ModelProvider,
    private readonly config: AppConfig,
    private readonly safety: KnowledgeSafetyService = new KnowledgeSafetyService(),
    private readonly fitEvaluator: ContextFitEvaluator = new ContextFitEvaluator(),
  ) {}

  async searchContext(input: ContextSearchInput): Promise<ContextPack> {
    const normalized = await this.addContinuationProvenance(
      normalizeSearchInput(redactSearchInput(input, this.safety), this.config),
    );
    const totalStartedAt = Date.now();
    const classificationStartedAt = Date.now();
    const classified = classifyQuery(normalized);
    const classificationElapsedMs = Date.now() - classificationStartedAt;
    const rewriteStartedAt = Date.now();
    const rewrite = await this.models.rewriteQuery({ prompt: normalized.prompt, classified });
    const rewriteElapsedMs = Date.now() - rewriteStartedAt;
    const rewriteResult = applyQueryRewrite(classified, rewrite, this.safety);
    const fingerprint = fingerprintSearch(normalized, rewriteResult.classified, this.config, rewrite);
    const cacheKey = `context:${fingerprint}`;
    const debug = normalized.debug
      ? new RetrievalDebugBuilder({
        fingerprint,
        cacheKey,
        cacheHit: false,
        cacheBypassed: true,
        searchLimit: SEARCH_LIMIT,
        rerankLimit: RERANK_LIMIT,
        tokenBudget: normalized.tokenBudget,
        rejectedKnowledgeIds: normalized.rejectedKnowledgeIds,
      })
      : undefined;
    debug?.recordElapsed('classification', classificationElapsedMs);
    debug?.recordElapsed('rewrite', rewriteElapsedMs);
    debug?.recordQueryRewrite({
      originalLexicalQuery: classified.lexicalQuery,
      rewrite: rewriteResult.rewrite,
      addedExactTerms: rewriteResult.addedExactTerms,
    });

    const cached = await this.getCachedContextPack(cacheKey, normalized);
    if (cached) {
      return this.safety.sanitizeContextPack(cached);
    }

    const project = normalized.project ?? rewriteResult.classified.project;
    const queryId = await timed(
      'contextQuery',
      this.createContextQuery(normalized, rewriteResult.classified, fingerprint, project),
      debug,
    );
    const candidates = await this.findCandidates(normalized, rewriteResult.classified, project, debug);
    const rankedCandidates = await this.rankCandidates(normalized.prompt, candidates, rewriteResult.classified, project, debug);
    const fitStartedAt = Date.now();
    const fitEvaluation = this.fitEvaluator.evaluate({
      project,
      classified: rewriteResult.classified,
      candidates: rankedCandidates,
      rejectedKnowledgeIds: normalized.rejectedKnowledgeIds,
    });
    debug?.recordTiming('fit', fitStartedAt);
    debug?.recordStage('fit', fitEvaluation.candidates);
    const assemblyStartedAt = Date.now();
    const pack = this.buildContextPack({
      queryId,
      project,
      classified: rewriteResult.classified,
      candidates: fitEvaluation.candidates,
      contextFit: fitEvaluation.contextFit,
      input: normalized,
    });
    if (normalized.contextMode === 'layered') {
      pack.deepContext = await this.buildDeepContext(pack, normalized.deepContextBudget);
    }
    debug?.recordTiming('assembly', assemblyStartedAt);
    await this.saveContextPack(cacheKey, pack, debug);
    debug?.recordTiming('total', totalStartedAt);

    if (debug) {
      pack.debug = debug.buildTrace(pack);
    }

    return pack;
  }

  async getContextPack(id: string): Promise<ContextPack | undefined> {
    const pack = await this.store.getContextPack(id);
    return pack ? this.safety.sanitizeContextPack(pack) : undefined;
  }

  async recordFeedback(input: FeedbackInput): Promise<{ retry?: ContextPack }> {
    await this.store.recordFeedback(input);

    if (!shouldRetry(input.feedbackType) || !input.contextPackId) {
      return {};
    }

    const pack = await this.store.getContextPack(input.contextPackId);
    if (!pack) {
      return {};
    }

    const retry = await this.searchContext(buildRetryInput(pack, input));
    return { retry };
  }

  private async getCachedContextPack(
    cacheKey: string,
    input: NormalizedContextSearchInput,
  ): Promise<ContextPack | undefined> {
    return input.bypassCache || input.debug ? undefined : this.cache.getJson<ContextPack>(cacheKey);
  }

  private async createContextQuery(
    input: NormalizedContextSearchInput,
    classified: ClassifiedQuery,
    fingerprint: string,
    project?: string,
  ): Promise<string> {
    return this.store.createContextQuery({
      project,
      prompt: input.prompt,
      fingerprint,
      classified,
      tokenBudget: input.tokenBudget,
    });
  }

  private async findCandidates(
    input: NormalizedContextSearchInput,
    classified: ClassifiedQuery,
    project?: string,
    debug?: RetrievalDebugBuilder,
  ): Promise<KnowledgeSearchResult> {
    const options: SearchOptions = {
      project,
      limit: SEARCH_LIMIT,
      rejectedKnowledgeIds: input.rejectedKnowledgeIds,
    };

    const embedding = timed(
      'embedding',
      this.models.embed(`${classified.lexicalQuery}\n\n${input.prompt}`),
      debug,
    );
    const vectorResults = embedding
      .then((embedding) => timed('vector', this.store.searchVector(embedding, options), debug));

    const [metadata, lexical, memory, vector] = await Promise.all([
      timed('metadata', this.store.searchMetadata(classified, options), debug),
      timed('lexical', this.store.searchLexical(classified, options), debug),
      timed('memory', this.store.searchMemories(classified, options), debug),
      vectorResults,
    ]);
    const safeResults = {
      metadata: this.safety.sanitizeSearchCandidates(metadata),
      lexical: this.safety.sanitizeSearchCandidates(lexical),
      memory: this.safety.sanitizeSearchCandidates(memory),
      vector: this.safety.sanitizeSearchCandidates(vector),
      graph: [] as KnowledgeSearchResult['graph'],
    };
    const seedKnowledgeIds = uniqueStrings([
      ...safeResults.metadata,
      ...safeResults.lexical,
      ...safeResults.memory,
      ...safeResults.vector,
    ].map((candidate) => candidate.knowledgeId));
    const graph = await timed(
      'graph',
      this.store.searchGraphRelations(classified, { ...options, seedKnowledgeIds }),
      debug,
    );
    safeResults.graph = enrichGraphCandidates(
      this.safety.sanitizeSearchCandidates(graph),
      classified,
      [
        ...safeResults.metadata,
        ...safeResults.lexical,
        ...safeResults.memory,
        ...safeResults.vector,
      ],
    );
    debug?.recordStage('metadata', safeResults.metadata);
    debug?.recordStage('lexical', safeResults.lexical);
    debug?.recordStage('memory', safeResults.memory);
    debug?.recordStage('vector', safeResults.vector);
    debug?.recordStage('graph', safeResults.graph);

    return safeResults;
  }

  private async rankCandidates(
    prompt: string,
    candidates: KnowledgeSearchResult,
    classified: ClassifiedQuery,
    project?: string,
    debug?: RetrievalDebugBuilder,
  ): Promise<RankedCandidate[]> {
    const fusionStartedAt = Date.now();
    const fused = fuseCandidates(
      [candidates.metadata, candidates.lexical, candidates.memory, candidates.vector, candidates.graph],
      classified,
    ).slice(0, RERANK_LIMIT);
    debug?.recordTiming('fusion', fusionStartedAt);
    debug?.recordStage('fusion', fused);

    const rerankResult = await timed(
      'rerank',
      this.models.rerank({ prompt, classified, candidates: fused }),
      debug,
    );
    debug?.recordProviderRerank({
      model: rerankResult.model,
      inputKnowledgeIds: fused.map((candidate) => candidate.knowledgeId),
      decisions: rerankResult.decisions,
    });
    const reranked = this.safety.sanitizeSearchCandidates(rerankResult.candidates);
    const adjusted = await this.applyRankingAdjustments(reranked, classified, project ?? classified.project);
    debug?.recordStage('rerank', adjusted);
    return adjusted;
  }

  private async applyRankingAdjustments(
    candidates: RankedCandidate[],
    classified: ClassifiedQuery,
    project?: string,
  ): Promise<RankedCandidate[]> {
    const summaries = await this.store.getFeedbackSummaries(
      [...new Set(candidates.map((candidate) => candidate.knowledgeId))],
      { project },
    );
    const supersededBy = await this.supersededByRelations(candidates, project);

    return candidates
      .map((candidate) => applyFeedbackSummary(candidate, summaries.get(candidate.knowledgeId)))
      .map((candidate) => applyIntentSuppression(candidate, classified, supersededBy.get(candidate.knowledgeId) ?? []))
      .sort((left, right) => right.finalScore - left.finalScore || left.rank - right.rank)
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }

  private async supersededByRelations(candidates: RankedCandidate[], project?: string): Promise<Map<string, KnowledgeRelation[]>> {
    const knowledgeIds = uniqueStrings(candidates.map((candidate) => candidate.knowledgeId));
    const entries = await Promise.all(knowledgeIds.map(async (knowledgeId) => {
      const relations = await this.store.listKnowledgeRelations({
        project,
        targetKnowledgeId: knowledgeId,
        relationType: 'supersedes',
        limit: 8,
      });
      return [knowledgeId, relations.filter((relation) => relation.fromKnowledgeId !== knowledgeId && relation.confidence >= 0.5)] as const;
    }));

    return new Map(entries.filter(([, relations]) => relations.length > 0));
  }

  private buildContextPack(input: {
    queryId: string;
    project?: string;
    classified: ClassifiedQuery;
    candidates: RankedCandidate[];
    contextFit: ContextFit;
    input: NormalizedContextSearchInput;
  }): ContextPack {
    return assembleContextPack({
      queryId: input.queryId,
      project: input.project,
      prompt: input.input.prompt,
      classified: input.classified,
      candidates: input.candidates,
      tokenBudget: input.input.tokenBudget,
      rejectedKnowledgeIds: input.input.rejectedKnowledgeIds,
      contextFit: input.contextFit,
    });
  }

  private async buildDeepContext(pack: ContextPack, budget: number): Promise<DeepContext> {
    const selectedItems = pack.sections.flatMap((section) => section.items);
    const knowledgeIds = uniqueStrings(selectedItems.map((item) => item.knowledgeId));
    const chunksByKnowledgeId = groupChunks(await this.store.listKnowledgeChunks(knowledgeIds));
    let remaining = budget;
    const sections: DeepContextSection[] = [];

    for (const section of pack.sections) {
      const deepItems: DeepContextItem[] = [];

      for (const item of section.items) {
        if (remaining <= 0) {
          break;
        }

        const chunks = chunksByKnowledgeId.get(item.knowledgeId) ?? [];
        const selectedChunks = takeChunksWithinBudget(chunks, remaining);
        const deepItem = buildDeepContextItem(item, selectedChunks.length ? selectedChunks : undefined, remaining);
        if (!deepItem) {
          continue;
        }

        deepItems.push(deepItem);
        remaining -= deepItem.tokenEstimate;
      }

      sections.push({
        name: section.name,
        items: deepItems,
        tokenEstimate: deepItems.reduce((sum, item) => sum + item.tokenEstimate, 0),
      });
    }

    return {
      mode: 'layered',
      budget,
      tokenEstimate: sections.reduce((sum, section) => sum + section.tokenEstimate, 0),
      sections,
    };
  }

  private async saveContextPack(
    cacheKey: string,
    pack: ContextPack,
    debug?: RetrievalDebugBuilder,
  ): Promise<void> {
    const compactPack = stripDebugTrace(pack);
    await timed(
      'save',
      saveCompactContextPack(this.store, this.cache, cacheKey, compactPack, this.config.contextCacheTtlSeconds),
      debug,
    );
  }

  private async addContinuationProvenance(input: NormalizedContextSearchInput): Promise<NormalizedContextSearchInput> {
    if (!isContinuationPrompt(input.prompt)) {
      return input;
    }

    const project = input.project ?? projectFromInput(input);
    const sessions = await this.store.listAgentSessions({ project, limit: CONTINUATION_SESSION_LIMIT });
    const recentSignals = emptyContinuationSignals();

    for (const session of sessions) {
      const decisions = await this.store.listAgentContextDecisions({ sessionId: session.id, limit: 20 });
      const selectedDecisions = decisions.filter((decision) => decision.decision === 'selected');
      if (selectedDecisions.length === 0) {
        continue;
      }

      mergeSignals(recentSignals, extractPromptSignals(`${session.prompt}\n${session.summary ?? ''}`));
      for (const decision of selectedDecisions) {
        mergeSignals(recentSignals, extractDecisionSignals(decision));
      }

      for (const packId of selectedContextPackIds(selectedDecisions)) {
        const pack = await this.store.getContextPack(packId);
        if (pack) {
          mergeSignals(recentSignals, extractContextPackSignals(pack));
        }
      }
    }

    const enriched = {
      files: mergeExplicitAndInferred(input.files, recentSignals.files, CONTINUATION_FILE_LIMIT),
      symbols: mergeExplicitAndInferred(input.symbols, recentSignals.symbols, CONTINUATION_SYMBOL_LIMIT),
      errors: mergeExplicitAndInferred(input.errors, recentSignals.errors, CONTINUATION_ERROR_LIMIT),
    };
    if (
      sameSignals(input.files, enriched.files)
      && sameSignals(input.symbols, enriched.symbols)
      && sameSignals(input.errors, enriched.errors)
    ) {
      return input;
    }

    return { ...input, ...enriched };
  }
}

async function saveCompactContextPack(
  store: KnowledgeStore,
  cache: Cache,
  cacheKey: string,
  pack: ContextPack,
  ttlSeconds: number,
): Promise<void> {
  await store.saveContextPack(pack);
  await cache.setJson(cacheKey, pack, ttlSeconds);
}

function redactSearchInput(input: ContextSearchInput, safety: KnowledgeSafetyService): ContextSearchInput {
  return {
    ...input,
    prompt: safety.redactSecrets(input.prompt),
    errors: input.errors?.map((error) => safety.redactSecrets(error)),
  };
}

function selectedContextPackIds(decisions: AgentContextDecision[]): string[] {
  return uniqueStrings([
    ...decisions.flatMap((decision) => [decision.contextPackId, decision.retryContextPackId]),
  ].filter((value): value is string => Boolean(value)));
}

interface ContinuationSignals {
  files: string[];
  symbols: string[];
  errors: string[];
}

function emptyContinuationSignals(): ContinuationSignals {
  return { files: [], symbols: [], errors: [] };
}

function mergeSignals(target: ContinuationSignals, source: ContinuationSignals): void {
  target.files.push(...source.files);
  target.symbols.push(...source.symbols);
  target.errors.push(...source.errors);
}

function extractContextPackSignals(pack: ContextPack): ContinuationSignals {
  return {
    files: uniqueStrings([
      ...pack.classified.files,
      ...pack.sections.flatMap((section) => section.items.flatMap((item) => [
        ...item.labels.filter((label) => label.type === 'file').map((label) => label.value),
        ...item.references.filter((reference) => reference.type === 'file').map((reference) => reference.uri),
      ])),
    ].filter(isLikelyProjectFile)),
    symbols: uniqueStrings([
      ...pack.classified.symbols,
      ...pack.sections.flatMap((section) => section.items.flatMap((item) => (
        item.labels.filter((label) => label.type === 'symbol').map((label) => label.value)
      ))),
    ].filter(isUsefulContinuationSymbol)),
    errors: uniqueStrings([
      ...pack.classified.errors,
      ...pack.sections.flatMap((section) => section.items.flatMap((item) => (
        item.labels.filter((label) => label.type === 'error').map((label) => label.value)
      ))),
    ].filter(isUsefulContinuationError)),
  };
}

function extractPromptSignals(prompt: string): ContinuationSignals {
  return {
    files: prompt.match(/(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+|[\w.-]+\.[jt]sx?|[\w.-]+\.py|[\w.-]+\.go|[\w.-]+\.rs|[\w.-]+\.md/g)?.filter(isLikelyProjectFile) ?? [],
    symbols: uniqueStrings([
      ...(prompt.match(/\b[A-Z][A-Za-z0-9_]*(?:Service|Controller|Repository|Provider|Handler|Store|Model|Schema|Config|Client)\b/g) ?? []),
      ...(prompt.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? []),
    ].filter(isUsefulContinuationSymbol)),
    errors: uniqueStrings([
      ...(prompt.match(/\b[A-Z][A-Z0-9_]*(?:Error|Exception|Failure)\b/g) ?? []),
      ...(prompt.match(/\b[A-Z]{2,}[-_][A-Z0-9_-]+\b/g) ?? []),
      ...(prompt.match(/\b(?:TS|ERR|E)[-_]?\d{3,6}\b/g) ?? []),
    ].filter(isUsefulContinuationError)),
  };
}

function extractDecisionSignals(decision: AgentContextDecision): ContinuationSignals {
  return {
    files: metadataStringArray(decision.metadata.files).filter(isLikelyProjectFile),
    symbols: metadataStringArray(decision.metadata.symbols).filter(isUsefulContinuationSymbol),
    errors: metadataStringArray(decision.metadata.errors).filter(isUsefulContinuationError),
  };
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isLikelyProjectFile(value: string): boolean {
  return /^[\w./-]+\.[a-zA-Z0-9]+$/.test(value) && !value.includes('://');
}

function isUsefulContinuationSymbol(value: string): boolean {
  return /^[A-Za-z_$][\w$.:#-]{2,}$/.test(value) && !CONTINUATION_SYMBOL_STOP_WORDS.has(value);
}

function isUsefulContinuationError(value: string): boolean {
  return /^[A-Za-z0-9_-]{3,}$/.test(value);
}

function mergeExplicitAndInferred(
  explicit: string[] | undefined,
  inferred: string[],
  inferredLimit: number,
): string[] | undefined {
  const explicitValues = explicit ?? [];
  const availableInferred = Math.max(0, inferredLimit - explicitValues.length);
  const merged = uniqueStrings([
    ...explicitValues,
    ...uniqueStrings(inferred).slice(0, availableInferred),
  ]);
  return merged.length ? merged : undefined;
}

function sameSignals(left: string[] | undefined, right: string[] | undefined): boolean {
  return (left ?? []).join('\0') === (right ?? []).join('\0');
}

function projectFromInput(input: ContextSearchInput): string | undefined {
  const hint = input.repoHint ?? input.cwd;
  return hint ? normalizeLabel(hint.split('/').filter(Boolean).at(-1) ?? hint) : undefined;
}

function isContinuationPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return /\b(continue|resume|handoff|handover)\b|\bpick up\b|\bwhere we left off\b|\bcurrent work\b/.test(lower);
}

const CONTINUATION_SYMBOL_STOP_WORDS = new Set([
  'Continue',
  'Continuation',
  'Current',
  'Phase',
  'Roadmap',
  'The',
  'For',
  'Keep',
  'Strip',
]);

function normalizeSearchInput(input: ContextSearchInput, config: AppConfig): NormalizedContextSearchInput {
  return {
    ...input,
    tokenBudget: input.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    contextMode: input.contextMode ?? config.contextMode ?? 'layered',
    deepContextBudget: normalizeDeepContextBudget(input.deepContextBudget ?? config.deepContextBudget),
    rejectedKnowledgeIds: input.rejectedKnowledgeIds ?? [],
    debug: input.debug ?? false,
  };
}

function groupChunks(chunks: KnowledgeChunkRecord[]): Map<string, KnowledgeChunkRecord[]> {
  const grouped = new Map<string, KnowledgeChunkRecord[]>();
  for (const chunk of chunks) {
    const list = grouped.get(chunk.knowledgeId) ?? [];
    list.push(chunk);
    grouped.set(chunk.knowledgeId, list);
  }

  for (const list of grouped.values()) {
    list.sort((left, right) => left.chunkIndex - right.chunkIndex);
  }

  return grouped;
}

function takeChunksWithinBudget(chunks: KnowledgeChunkRecord[], budget: number): KnowledgeChunkRecord[] {
  const selected: KnowledgeChunkRecord[] = [];
  let tokens = 0;

  for (const chunk of chunks) {
    if (selected.length > 0 && tokens + chunk.tokenEstimate > budget) {
      break;
    }

    if (chunk.tokenEstimate > budget && selected.length === 0) {
      break;
    }

    selected.push(chunk);
    tokens += chunk.tokenEstimate;
  }

  return selected;
}

function buildDeepContextItem(
  candidate: RankedCandidate,
  chunks: KnowledgeChunkRecord[] | undefined,
  budget: number,
): DeepContextItem | undefined {
  const chunkIds = chunks?.map((chunk) => chunk.id) ?? (candidate.chunkId ? [candidate.chunkId] : []);
  const content = chunks?.map((chunk) => chunk.content).join('\n\n') ?? candidate.content;
  const contextualContent = chunks?.map((chunk) => chunk.contextualContent).join('\n\n---\n\n') ?? candidate.contextualContent;
  const tokenEstimate = chunks?.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0) ?? candidate.tokenEstimate;

  if (tokenEstimate > budget) {
    return undefined;
  }

  return {
    knowledgeId: candidate.knowledgeId,
    title: candidate.title,
    summary: candidate.summary,
    itemType: candidate.itemType,
    project: candidate.project,
    labels: candidate.labels,
    references: candidate.references,
    source: candidate.source,
    rank: candidate.rank,
    finalScore: candidate.finalScore,
    matchReasons: candidate.matchReasons,
    chunkIds,
    content,
    contextualContent,
    tokenEstimate,
  };
}

function enrichGraphCandidates(
  graphCandidates: KnowledgeSearchResult['graph'],
  classified: ClassifiedQuery,
  seedCandidates: KnowledgeSearchResult['graph'],
): KnowledgeSearchResult['graph'] {
  if (graphCandidates.length === 0) {
    return [];
  }

  const connectedSignals = compactRecord({
    files: signalsCoveredBySeeds(classified.files, seedCandidates),
    symbols: signalsCoveredBySeeds(classified.symbols, seedCandidates),
    errors: signalsCoveredBySeeds(classified.errors, seedCandidates),
  });

  if (Object.keys(connectedSignals).length === 0) {
    return graphCandidates;
  }

  return graphCandidates.map((candidate) => ({
    ...candidate,
    metadata: {
      ...(candidate.metadata ?? {}),
      graphContextFit: connectedSignals,
    },
  }));
}

function signalsCoveredBySeeds(signals: string[], seedCandidates: KnowledgeSearchResult['graph']): string[] {
  return uniqueStrings(signals.filter((signal) => seedCandidates.some((candidate) => candidateContainsSignal(candidate, signal))));
}

function candidateContainsSignal(candidate: KnowledgeSearchResult['graph'][number], signal: string): boolean {
  const text = [
    candidate.title,
    candidate.summary,
    candidate.content,
    candidate.contextualContent,
    candidate.labels.map((label) => `${label.type}:${label.value}`).join(' '),
    candidate.references.map((reference) => reference.uri).join(' '),
    JSON.stringify(candidate.metadata ?? {}),
  ].join(' ').toLowerCase();

  return text.includes(signal.toLowerCase());
}

function compactRecord<T extends Record<string, string[]>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, values]) => values.length > 0)) as Partial<T>;
}

function fingerprintSearch(
  input: NormalizedContextSearchInput,
  classified: ClassifiedQuery,
  config: AppConfig,
  rewrite?: QueryRewriteResult,
): string {
  return sha256(stableJson({
    prompt: input.prompt,
    project: input.project,
    repoHint: input.repoHint,
    cwd: input.cwd,
    taskType: input.taskType,
    files: input.files ?? [],
    symbols: input.symbols ?? [],
    errors: input.errors ?? [],
    tokenBudget: input.tokenBudget,
    contextMode: input.contextMode,
    deepContextBudget: input.deepContextBudget,
    rejectedKnowledgeIds: input.rejectedKnowledgeIds,
    lexicalQuery: classified.lexicalQuery,
    exactTerms: classified.exactTerms,
    queryRewriteModel: rewrite?.model,
    rerankModel: config.openAiRerankModel,
  }));
}

function applyQueryRewrite(
  classified: ClassifiedQuery,
  rewrite: QueryRewriteResult | undefined,
  safety: KnowledgeSafetyService,
): { classified: ClassifiedQuery; addedExactTerms: string[]; rewrite?: QueryRewriteResult } {
  if (!rewrite?.lexicalQuery.trim()) {
    return { classified, addedExactTerms: [] };
  }

  const sanitizedRewriteQuery = safety.redactSecrets(rewrite.lexicalQuery);
  const sanitizedRewriteTerms = uniqueStrings((rewrite.exactTerms ?? [])
    .map((term) => safety.redactSecrets(term))
    .filter((term) => term.length <= 120));
  const exactTerms = uniqueStrings([...classified.exactTerms, ...sanitizedRewriteTerms]).slice(0, 48);
  const lexicalQuery = uniqueStrings([
    ...exactTerms,
    ...(sanitizedRewriteQuery.match(/[a-zA-Z0-9_./:-]{3,}/g) ?? []),
    ...(classified.lexicalQuery.match(/[a-zA-Z0-9_./:-]{3,}/g) ?? []),
  ]).slice(0, 64).join(' ');
  const addedExactTerms = exactTerms.filter((term) => !classified.exactTerms.includes(term));
  const sanitizedRewrite: QueryRewriteResult = {
    lexicalQuery,
    exactTerms: sanitizedRewriteTerms,
    reasons: (rewrite.reasons ?? []).map((reason) => safety.redactSecrets(reason)),
    model: rewrite.model,
  };

  return {
    classified: {
      ...classified,
      exactTerms,
      lexicalQuery,
      confidence: Math.min(0.98, classified.confidence + (addedExactTerms.length > 0 ? 0.06 : 0.03)),
    },
    addedExactTerms,
    rewrite: sanitizedRewrite,
  };
}

function shouldRetry(feedbackType: FeedbackInput['feedbackType']): boolean {
  return RETRY_FEEDBACK_TYPES.has(feedbackType);
}

function buildRetryInput(pack: ContextPack, feedback: FeedbackInput): ContextSearchInput {
  return {
    prompt: pack.prompt,
    project: feedback.project ?? pack.project,
    tokenBudget: contextPackTokenBudget(pack),
    rejectedKnowledgeIds: rejectedKnowledgeIds(pack, feedback),
    bypassCache: true,
  };
}

function contextPackTokenBudget(pack: ContextPack): number {
  return pack.sections.reduce((sum, section) => sum + section.tokenEstimate, 0) || DEFAULT_TOKEN_BUDGET;
}

function rejectedKnowledgeIds(pack: ContextPack, feedback: FeedbackInput): string[] {
  return [
    ...new Set([
      ...pack.sections.flatMap((section) => section.items.map((item) => item.knowledgeId)),
      ...(feedback.rejectedKnowledgeIds ?? []),
    ]),
  ];
}

function applyFeedbackSummary(
  candidate: RankedCandidate,
  summary: KnowledgeFeedbackSummary | undefined,
): RankedCandidate {
  if (!summary) {
    return candidate;
  }

  const adjustment = feedbackScoreAdjustment(summary);
  const status = feedbackStatus(summary);
  const feedbackMetadata = {
    status,
    selectedCount: summary.selectedCount,
    rejectedCount: summary.rejectedCount,
    irrelevantCount: summary.irrelevantCount,
    staleCount: summary.staleCount,
    latestFeedbackType: summary.latestFeedbackType,
    latestFeedbackAt: summary.latestFeedbackAt,
    scoreAdjustment: adjustment,
  };

  return {
    ...candidate,
    finalScore: clampScore(candidate.finalScore + adjustment),
    matchReasons: [
      ...candidate.matchReasons,
      ...feedbackMatchReasons(summary, adjustment),
    ],
    metadata: {
      ...(candidate.metadata ?? {}),
      feedback: feedbackMetadata,
    },
  };
}

function applyIntentSuppression(
  candidate: RankedCandidate,
  classified: ClassifiedQuery,
  supersededBy: KnowledgeRelation[],
): RankedCandidate {
  const adjustment = intentSuppressionAdjustment(candidate, classified, supersededBy);
  if (adjustment.score === 0) {
    return candidate;
  }

  return {
    ...candidate,
    finalScore: clampScore(candidate.finalScore + adjustment.score),
    matchReasons: [
      ...candidate.matchReasons,
      ...adjustment.reasons,
    ],
    metadata: {
      ...(candidate.metadata ?? {}),
      retrievalSuppression: {
        scoreAdjustment: roundFeedbackAdjustment(adjustment.score),
        reasons: adjustment.reasons,
        supersededBy: supersededBy.map((relation) => relation.fromKnowledgeId),
      },
    },
  };
}

function intentSuppressionAdjustment(
  candidate: RankedCandidate,
  classified: ClassifiedQuery,
  supersededBy: KnowledgeRelation[],
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const hasHardEvidence = hasHardSignalEvidence(candidate, classified);

  if (supersededBy.length > 0) {
    const strongest = Math.max(...supersededBy.map((relation) => relation.confidence));
    score -= Math.min(0.28, 0.18 + strongest * 0.08);
    reasons.push(`suppression:superseded:${supersededBy[0].fromKnowledgeId}`);
  }

  if (isStaleCandidate(candidate) && !hasHardEvidence) {
    score -= 0.14;
    reasons.push('suppression:freshness:stale');
  }

  const feedback = feedbackStatusFromCandidate(candidate);
  if ((feedback === 'stale' || feedback === 'rejected' || feedback === 'irrelevant') && !hasHardEvidence) {
    score -= feedback === 'stale' ? 0.1 : 0.08;
    reasons.push(`suppression:prior feedback:${feedback}`);
  }

  if (!hasHardEvidence && !requiredEvidenceMatches(candidate, classified.intent.requiredEvidenceTypes)) {
    score -= 0.1;
    reasons.push('suppression:evidence_mismatch');
  }

  return { score: roundFeedbackAdjustment(score), reasons };
}

function hasHardSignalEvidence(candidate: RankedCandidate, classified: ClassifiedQuery): boolean {
  return [
    ...classified.files,
    ...classified.symbols,
    ...classified.errors,
  ].some((signal) => candidateText(candidate).includes(signal.toLowerCase()));
}

function isStaleCandidate(candidate: RankedCandidate): boolean {
  const metadataStale = candidate.metadata?.stale === true || feedbackStatusFromCandidate(candidate) === 'stale';
  if (metadataStale) {
    return true;
  }

  const freshnessAt = candidate.freshnessAt ?? metadataString(candidate.metadata, 'freshnessAt');
  if (!freshnessAt) {
    return false;
  }

  const timestamp = Date.parse(freshnessAt);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  return Date.now() - timestamp > 365 * 86_400_000;
}

function requiredEvidenceMatches(candidate: RankedCandidate, evidenceTypes: RetrievalEvidenceType[]): boolean {
  if (evidenceTypes.length === 0) {
    return true;
  }

  return evidenceTypes.some((type) => candidateSupportsEvidence(candidate, type));
}

function candidateSupportsEvidence(candidate: RankedCandidate, evidenceType: RetrievalEvidenceType): boolean {
  switch (evidenceType) {
    case 'spec':
      return candidate.itemType === 'spec' || hasMetadataTaxonomy(candidate, 'domain_rule');
    case 'workflow':
      return candidate.itemType === 'workflow' || candidate.itemType === 'rule' || hasMetadataTaxonomy(candidate, 'workflow');
    case 'code_reference':
      return candidate.itemType === 'code_ref'
        || candidate.references.some((reference) => reference.type === 'file')
        || candidate.labels.some((label) => label.type === 'file' || label.type === 'symbol');
    case 'bugfix':
      return candidate.itemType === 'bugfix'
        || candidate.labels.some((label) => label.type === 'error' || (label.type === 'task_type' && label.value === 'debugging'));
    case 'incident_lesson':
      return hasMetadataTaxonomy(candidate, 'incident_lesson')
        || metadataString(candidate.metadata, 'triggerType') === 'error_recovery'
        || candidate.references.some((reference) => reference.uri.startsWith('tuberosa://error-logs/'));
    case 'reflection_memory':
      return candidate.itemType === 'memory' || Boolean(metadataString(candidate.metadata, 'triggerType'));
    case 'session_history':
      return Boolean(metadataString(candidate.metadata, 'agentSessionId'))
        || candidate.references.some((reference) => reference.type === 'conversation');
    case 'handoff':
      return candidate.references.some((reference) => reference.uri === 'handoff.md')
        || candidate.labels.some((label) => label.type === 'file' && label.value === 'handoff.md');
    case 'docs':
      return candidate.itemType === 'wiki'
        || candidate.references.some((reference) => reference.type === 'file' && reference.uri.endsWith('.md'));
    case 'tests':
      return candidate.references.some((reference) => /(^|\/|-)test(s)?[/.]|\.test\./.test(reference.uri))
        || candidate.labels.some((label) => label.type === 'file' && /(^|\/|-)test(s)?[/.]|\.test\./.test(label.value));
  }
}

function hasMetadataTaxonomy(candidate: RankedCandidate, taxonomy: string): boolean {
  return metadataString(candidate.metadata, 'taxonomy') === taxonomy;
}

function candidateText(candidate: RankedCandidate): string {
  return [
    candidate.title,
    candidate.summary,
    candidate.content,
    candidate.contextualContent,
    candidate.labels.map((label) => `${label.type}:${label.value}`).join(' '),
    candidate.references.map((reference) => reference.uri).join(' '),
    JSON.stringify(candidate.metadata ?? {}),
  ].join(' ').toLowerCase();
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function feedbackStatusFromCandidate(candidate: RankedCandidate): string | undefined {
  const direct = metadataString(candidate.metadata, 'feedbackStatus') ?? metadataString(candidate.metadata, 'priorFeedback');
  if (direct) {
    return direct;
  }

  const feedback = candidate.metadata?.feedback;
  if (!feedback || typeof feedback !== 'object') {
    return undefined;
  }

  const status = (feedback as Record<string, unknown>).status;
  return typeof status === 'string' ? status : undefined;
}

function feedbackScoreAdjustment(summary: KnowledgeFeedbackSummary): number {
  const selectedBoost = Math.min(0.1, summary.selectedCount * 0.04);
  const stalePenalty = Math.min(0.24, summary.staleCount * 0.2);
  const rejectionPenalty = Math.min(0.18, (summary.rejectedCount + summary.irrelevantCount) * 0.09);

  return roundFeedbackAdjustment(selectedBoost - stalePenalty - rejectionPenalty);
}

function feedbackStatus(summary: KnowledgeFeedbackSummary): string {
  if (summary.latestFeedbackType && summary.latestFeedbackType !== 'missing_context') {
    return summary.latestFeedbackType;
  }

  if (summary.staleCount > 0) {
    return 'stale';
  }

  if (summary.rejectedCount > 0) {
    return 'rejected';
  }

  if (summary.irrelevantCount > 0) {
    return 'irrelevant';
  }

  return 'selected';
}

function feedbackMatchReasons(summary: KnowledgeFeedbackSummary, adjustment: number): string[] {
  const reasons: string[] = [];

  if (summary.selectedCount > 0) {
    reasons.push(`feedback:selected:${summary.selectedCount}`);
  }
  if (summary.rejectedCount > 0) {
    reasons.push(`feedback:rejected:${summary.rejectedCount}`);
  }
  if (summary.irrelevantCount > 0) {
    reasons.push(`feedback:irrelevant:${summary.irrelevantCount}`);
  }
  if (summary.staleCount > 0) {
    reasons.push(`feedback:stale:${summary.staleCount}`);
  }
  if (adjustment !== 0) {
    reasons.push(`feedback adjustment:${adjustment > 0 ? '+' : ''}${adjustment.toFixed(3)}`);
  }

  return reasons;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundFeedbackAdjustment(value: number): number {
  return Math.round(value * 1000) / 1000;
}
