import type { ClassifiedQuery, KnowledgeInput, SearchOptions, SearchCandidate } from '../../src/types.js';
import type { ChunkInput, KnowledgeStore } from '../../src/storage/store.js';

export interface ParityKnowledgeSeed {
  /** Mark this seed as approved (default) or transition to a non-approved status after insert. */
  status?: 'approved' | 'needs_review' | 'archived' | 'blocked';
  input: Omit<KnowledgeInput, 'project'>;
  /** Embedding override. Default: a constant unit-like vector so vector search ranks insertion-order. */
  embedding?: number[];
}

export interface ParityFixture {
  name: string;
  /** Which store method to exercise. */
  searchKind: 'searchLexical' | 'searchMetadata' | 'searchMemories' | 'searchVector';
  seeds: ParityKnowledgeSeed[];
  /** Override the project of the candidates to be returned. Default: matches the seed project. */
  classifiedOverrides?: Partial<ClassifiedQuery>;
  optionsOverrides?: Partial<SearchOptions>;
  /** sourceUris of seeds that MUST appear in the result. */
  expectedSourceUris: string[];
  /** sourceUris of seeds that MUST NOT appear in the result. */
  forbiddenSourceUris?: string[];
}

const DIMS = 1536;

function baseEmbedding(seed = 0.001): number[] {
  return new Array(DIMS).fill(seed);
}

function baseClassified(query: string): ClassifiedQuery {
  return {
    taskType: 'exploration',
    confidence: 0.9,
    lexicalQuery: query,
    files: [],
    symbols: [],
    errors: [],
    technologies: [],
    businessAreas: [],
    exactTerms: [],
    intent: {
      taskGoal: query,
      workflowStage: 'exploration',
      impliedFiles: [],
      impliedSymbols: [],
      impliedDomains: [],
      recentSessionReferences: [],
      requiredEvidenceTypes: [],
      uncertaintyReasons: [],
    },
  };
}

export const PARITY_FIXTURES: ParityFixture[] = [
  {
    name: 'searchLexical surfaces approved item by body keyword',
    searchKind: 'searchLexical',
    seeds: [
      {
        input: {
          sourceType: 'file', sourceUri: 'docs/parity-lex-hit.md',
          itemType: 'wiki', title: 'Parity lexical hit',
          content: 'parityLexicalKeyword body content',
          labels: [], references: [],
        },
      },
      {
        input: {
          sourceType: 'file', sourceUri: 'docs/parity-lex-miss.md',
          itemType: 'wiki', title: 'Different topic',
          content: 'unrelated body about cats',
          labels: [], references: [],
        },
      },
    ],
    classifiedOverrides: { lexicalQuery: 'parityLexicalKeyword', exactTerms: ['parityLexicalKeyword'] },
    expectedSourceUris: ['docs/parity-lex-hit.md'],
    forbiddenSourceUris: ['docs/parity-lex-miss.md'],
  },

  {
    name: 'searchLexical excludes non-approved item even when body matches',
    searchKind: 'searchLexical',
    seeds: [
      {
        input: {
          sourceType: 'file', sourceUri: 'docs/parity-approved.md',
          itemType: 'wiki', title: 'Approved doc',
          content: 'paritySharedKeyword approved',
          labels: [], references: [],
        },
      },
      {
        status: 'needs_review',
        input: {
          sourceType: 'file', sourceUri: 'docs/parity-pending.md',
          itemType: 'wiki', title: 'Pending doc',
          content: 'paritySharedKeyword pending',
          labels: [], references: [],
        },
      },
    ],
    classifiedOverrides: { lexicalQuery: 'paritySharedKeyword', exactTerms: ['paritySharedKeyword'] },
    expectedSourceUris: ['docs/parity-approved.md'],
    forbiddenSourceUris: ['docs/parity-pending.md'],
  },

  {
    name: 'searchLexical respects rejectedKnowledgeIds exclusion',
    searchKind: 'searchLexical',
    seeds: [
      {
        input: {
          sourceType: 'file', sourceUri: 'docs/parity-rej-a.md',
          itemType: 'wiki', title: 'A doc',
          content: 'parityRejToken alpha',
          labels: [], references: [],
        },
      },
      {
        input: {
          sourceType: 'file', sourceUri: 'docs/parity-rej-b.md',
          itemType: 'wiki', title: 'B doc',
          content: 'parityRejToken beta',
          labels: [], references: [],
        },
      },
    ],
    classifiedOverrides: { lexicalQuery: 'parityRejToken', exactTerms: ['parityRejToken'] },
    // We will inject `rejectedKnowledgeIds` at runtime to point at the first seed's id.
    optionsOverrides: { rejectedKnowledgeIds: ['__SEED_0__'] },
    expectedSourceUris: ['docs/parity-rej-b.md'],
    forbiddenSourceUris: ['docs/parity-rej-a.md'],
  },

  {
    name: 'searchMemories surfaces approved rule/memory items by lexical query',
    searchKind: 'searchMemories',
    seeds: [
      {
        input: {
          sourceType: 'file', sourceUri: 'docs/parity-rule-hit.md',
          itemType: 'rule', title: 'Memory hit rule',
          content: 'parityMemoryKeyword applies to this rule',
          labels: [], references: [],
        },
      },
      {
        input: {
          sourceType: 'file', sourceUri: 'docs/parity-wiki-skip.md',
          itemType: 'wiki', title: 'Wiki item',
          content: 'parityMemoryKeyword should not match memories scope',
          labels: [], references: [],
        },
      },
    ],
    classifiedOverrides: { lexicalQuery: 'parityMemoryKeyword', exactTerms: ['parityMemoryKeyword'] },
    expectedSourceUris: ['docs/parity-rule-hit.md'],
    forbiddenSourceUris: ['docs/parity-wiki-skip.md'],
  },

  {
    name: 'searchVector returns approved items only',
    searchKind: 'searchVector',
    seeds: [
      {
        input: {
          sourceType: 'file', sourceUri: 'docs/parity-vec-approved.md',
          itemType: 'wiki', title: 'Vector approved',
          content: 'vector body approved',
          labels: [], references: [],
        },
      },
      {
        status: 'needs_review',
        input: {
          sourceType: 'file', sourceUri: 'docs/parity-vec-pending.md',
          itemType: 'wiki', title: 'Vector pending',
          content: 'vector body pending',
          labels: [], references: [],
        },
      },
    ],
    expectedSourceUris: ['docs/parity-vec-approved.md'],
    forbiddenSourceUris: ['docs/parity-vec-pending.md'],
  },
];

export interface ParitySeedResult {
  knowledgeId: string;
  sourceUri: string;
}

export async function seedFixture(
  store: KnowledgeStore,
  project: string,
  fixture: ParityFixture,
): Promise<ParitySeedResult[]> {
  const results: ParitySeedResult[] = [];
  for (const seed of fixture.seeds) {
    const embedding = seed.embedding ?? baseEmbedding();
    const chunk: ChunkInput = {
      index: 0,
      content: seed.input.content,
      contextualContent: seed.input.content,
      tokenEstimate: Math.ceil(seed.input.content.length / 4),
      embedding,
    };
    const stored = await store.upsertKnowledge({ ...seed.input, project }, [chunk]);
    if (seed.status && seed.status !== 'approved') {
      await store.updateKnowledge(stored.id, { status: seed.status });
    }
    results.push({ knowledgeId: stored.id, sourceUri: stored.sourceUri ?? seed.input.sourceUri });
  }
  return results;
}

export async function runFixture(
  store: KnowledgeStore,
  project: string,
  fixture: ParityFixture,
): Promise<{ ids: Set<string>; uris: Set<string>; seeds: ParitySeedResult[] }> {
  const seeds = await seedFixture(store, project, fixture);

  const classified: ClassifiedQuery = {
    ...baseClassified(fixture.classifiedOverrides?.lexicalQuery ?? ''),
    ...fixture.classifiedOverrides,
    project,
  };

  const options: SearchOptions = {
    project,
    limit: 25,
    ...fixture.optionsOverrides,
    // Resolve __SEED_N__ placeholders to actual ids
    rejectedKnowledgeIds: (fixture.optionsOverrides?.rejectedKnowledgeIds ?? [])
      .map((token) => resolveSeedPlaceholder(token, seeds)),
  };

  let candidates: SearchCandidate[];
  switch (fixture.searchKind) {
    case 'searchLexical':
      candidates = await store.searchLexical(classified, options);
      break;
    case 'searchMetadata':
      candidates = await store.searchMetadata(classified, options);
      break;
    case 'searchMemories':
      candidates = await store.searchMemories(classified, options);
      break;
    case 'searchVector':
      candidates = await store.searchVector(baseEmbedding(), options);
      break;
  }

  const ids = new Set(candidates.map((c) => c.knowledgeId));
  const uriByKnowledgeId = new Map(seeds.map((s) => [s.knowledgeId, s.sourceUri]));
  const uris = new Set([...ids]
    .map((id) => uriByKnowledgeId.get(id))
    .filter((u): u is string => Boolean(u)));
  return { ids, uris, seeds };
}

function resolveSeedPlaceholder(token: string, seeds: ParitySeedResult[]): string {
  const match = token.match(/^__SEED_(\d+)__$/);
  if (!match) return token;
  const index = Number(match[1]);
  const seed = seeds[index];
  if (!seed) throw new Error(`parity-fixture: seed index ${index} not found (have ${seeds.length})`);
  return seed.knowledgeId;
}
