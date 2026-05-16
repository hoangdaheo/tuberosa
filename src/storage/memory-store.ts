import { randomUUID } from 'node:crypto';
import type {
  ClassifiedQuery,
  ContextPack,
  FeedbackInput,
  KnowledgeInput,
  LabelInput,
  ReferenceInput,
  ReflectionDraft,
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
  private readonly feedback: FeedbackInput[] = [];

  async upsertKnowledge(input: KnowledgeInput, chunks: ChunkInput[]): Promise<StoredKnowledge> {
    const now = new Date().toISOString();
    const existing = this.findKnowledgeBySourceUri(input.project, input.sourceUri);
    const id = existing?.id ?? randomUUID();
    const stored: StoredKnowledge = {
      id,
      project: input.project,
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
      deleted += 1;
    }

    return deleted;
  }

  async listKnowledge(options: { project?: string; query?: string; limit: number }): Promise<StoredKnowledge[]> {
    const query = options.query?.toLowerCase();
    return [...this.knowledge.values()]
      .filter((item) => !options.project || item.project === options.project)
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

  async searchMemories(classified: ClassifiedQuery, options: SearchOptions): Promise<SearchCandidate[]> {
    const memoryTypes = new Set(['memory', 'workflow', 'rule', 'bugfix']);
    const terms = new Set(classified.lexicalQuery.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? []);
    return this.rankByText(terms, 'memory', options, (item) => memoryTypes.has(item.itemType));
  }

  async createContextQuery(): Promise<string> {
    return randomUUID();
  }

  async saveContextPack(pack: ContextPack): Promise<void> {
    this.packs.set(pack.id, pack);
  }

  async getContextPack(id: string): Promise<ContextPack | undefined> {
    return this.packs.get(id);
  }

  async recordFeedback(input: FeedbackInput): Promise<void> {
    this.feedback.push(input);
    if (input.contextPackId) {
      const pack = this.packs.get(input.contextPackId);
      if (pack) {
        pack.status = input.feedbackType === 'selected' ? 'selected' : 'rejected';
      }
    }
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
      duplicateCandidates: duplicateCandidates as ReflectionDraft['duplicateCandidates'],
      createdAt: new Date().toISOString(),
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  async approveReflectionDraft(id: string): Promise<ReflectionDraft | undefined> {
    const draft = this.drafts.get(id);
    if (!draft) {
      return undefined;
    }

    draft.status = 'approved';
    return draft;
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

function withRanks(candidates: SearchCandidate[]): SearchCandidate[] {
  return candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
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
