import type {
  ClassifiedQuery,
  ContextPack,
  ContextSearchInput,
  FeedbackInput,
  KnowledgeInput,
  RankedCandidate,
  StoredKnowledge,
  TaskType,
} from '../types.js';

export interface KnowledgeIngestor {
  ingestKnowledge(input: KnowledgeInput): Promise<StoredKnowledge>;
}

export interface ContextSearcher {
  searchContext(input: ContextSearchInput): Promise<ContextPack>;
}

export interface FeedbackRecorder {
  recordFeedback(input: FeedbackInput): Promise<unknown>;
}

export type RetrievalEvalKnowledge = Omit<KnowledgeInput, 'project'> & {
  evalId: string;
  project?: string;
};

export interface RetrievalEvalClassificationExpectation {
  files?: string[];
  symbols?: string[];
  errors?: string[];
  technologies?: string[];
  businessAreas?: string[];
  taskType?: TaskType;
}

export interface RetrievalEvalCase {
  id: string;
  prompt: string;
  project?: string;
  taskType?: TaskType;
  files?: string[];
  symbols?: string[];
  errors?: string[];
  tokenBudget?: number;
  expectedKnowledgeIds?: string[];
  unexpectedKnowledgeIds?: string[];
  rejectedKnowledgeIds?: string[];
  expectedClassification?: RetrievalEvalClassificationExpectation;
}

export interface RetrievalEvalFeedbackEvent {
  feedbackType: FeedbackInput['feedbackType'];
  prompt?: string;
  project?: string;
  knowledgeIds?: string[];
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface RetrievalEvalFixture {
  name: string;
  project: string;
  knowledge: RetrievalEvalKnowledge[];
  feedbackEvents?: RetrievalEvalFeedbackEvent[];
  cases: RetrievalEvalCase[];
}

export interface RetrievalEvalOptions {
  topK?: number;
}

export interface RetrievalEvalClassificationCheck {
  field: keyof RetrievalEvalClassificationExpectation;
  expected: string[];
  actual: string[];
  passed: boolean;
}

export interface RetrievalEvalCaseResult {
  id: string;
  prompt: string;
  passed: boolean;
  confidence: number;
  reciprocalRank: number | null;
  precisionAtK: number | null;
  firstExpectedRank: number | null;
  expectedKnowledgeIds: string[];
  matchedExpectedKnowledgeIds: string[];
  unexpectedKnowledgeIds: string[];
  returnedUnexpectedKnowledgeIds: string[];
  rejectedKnowledgeIds: string[];
  returnedRejectedKnowledgeIds: string[];
  topKnowledgeIds: string[];
  classificationChecks: RetrievalEvalClassificationCheck[];
}

export interface RetrievalEvalMetrics {
  hitRate: number | null;
  meanReciprocalRank: number | null;
  precisionAtK: number | null;
  staleRejectionRate: number | null;
  unexpectedAvoidanceRate: number | null;
  exactFileMatchRate: number | null;
  exactSymbolMatchRate: number | null;
  exactErrorMatchRate: number | null;
  exactClassificationMatchRate: number | null;
}

export interface RetrievalEvalReport {
  fixtureName: string;
  project: string;
  evaluatedAt: string;
  topK: number;
  totalCases: number;
  metrics: RetrievalEvalMetrics;
  cases: RetrievalEvalCaseResult[];
}

interface SeededKnowledgeIndex {
  byEvalId: Map<string, string>;
  byStoreId: Map<string, string>;
}

const DEFAULT_TOP_K = 5;

export class RetrievalEvaluator {
  constructor(
    private readonly ingestor: KnowledgeIngestor,
    private readonly searcher: ContextSearcher,
    private readonly feedbackRecorder: FeedbackRecorder | undefined = isFeedbackRecorder(searcher) ? searcher : undefined,
  ) {}

  async run(fixture: RetrievalEvalFixture, options: RetrievalEvalOptions = {}): Promise<RetrievalEvalReport> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const index = await this.seedKnowledge(fixture);
    await this.seedFeedback(fixture, index);
    const cases = [];

    for (const testCase of fixture.cases) {
      cases.push(await this.evaluateCase(fixture, testCase, index, topK));
    }

    return {
      fixtureName: fixture.name,
      project: fixture.project,
      evaluatedAt: new Date().toISOString(),
      topK,
      totalCases: cases.length,
      metrics: buildMetrics(cases, topK),
      cases,
    };
  }

  private async seedKnowledge(fixture: RetrievalEvalFixture): Promise<SeededKnowledgeIndex> {
    const byEvalId = new Map<string, string>();
    const byStoreId = new Map<string, string>();

    for (const item of fixture.knowledge) {
      const { evalId, project, ...knowledge } = item;
      const stored = await this.ingestor.ingestKnowledge({
        ...knowledge,
        project: project ?? fixture.project,
        metadata: {
          ...(knowledge.metadata ?? {}),
          evalId,
        },
      });

      byEvalId.set(evalId, stored.id);
      byStoreId.set(stored.id, evalId);
    }

    return { byEvalId, byStoreId };
  }

  private async seedFeedback(fixture: RetrievalEvalFixture, index: SeededKnowledgeIndex): Promise<void> {
    if (!fixture.feedbackEvents?.length) {
      return;
    }

    if (!this.feedbackRecorder) {
      throw new Error('Retrieval eval fixture defines feedbackEvents but no feedback recorder is configured.');
    }

    for (const event of fixture.feedbackEvents) {
      const rejectedKnowledgeIds = event.knowledgeIds
        ? [...resolveEvalIds(index, event.knowledgeIds)]
        : undefined;
      const contextPackId = event.prompt
        ? (await this.searcher.searchContext({
          prompt: event.prompt,
          project: event.project ?? fixture.project,
          bypassCache: true,
        })).id
        : undefined;

      await this.feedbackRecorder.recordFeedback({
        contextPackId,
        project: event.project ?? fixture.project,
        feedbackType: event.feedbackType,
        reason: event.reason,
        rejectedKnowledgeIds,
        metadata: event.metadata,
      });
    }
  }

  private async evaluateCase(
    fixture: RetrievalEvalFixture,
    testCase: RetrievalEvalCase,
    index: SeededKnowledgeIndex,
    topK: number,
  ): Promise<RetrievalEvalCaseResult> {
    const expectedIds = resolveEvalIds(index, testCase.expectedKnowledgeIds ?? []);
    const unexpectedIds = resolveEvalIds(index, testCase.unexpectedKnowledgeIds ?? []);
    const rejectedIds = resolveEvalIds(index, testCase.rejectedKnowledgeIds ?? []);
    const pack = await this.searcher.searchContext({
      prompt: testCase.prompt,
      project: testCase.project ?? fixture.project,
      taskType: testCase.taskType,
      files: testCase.files,
      symbols: testCase.symbols,
      errors: testCase.errors,
      tokenBudget: testCase.tokenBudget,
      rejectedKnowledgeIds: [...rejectedIds],
      bypassCache: true,
    });
    const rankedItems = flattenPack(pack);
    const topItems = rankedItems.slice(0, topK);
    const firstExpectedRank = firstRank(rankedItems, expectedIds);
    const matchedExpectedIds = topItems
      .filter((item) => expectedIds.has(item.knowledgeId))
      .map((item) => item.knowledgeId);
    const returnedUnexpectedIds = topItems
      .filter((item) => unexpectedIds.has(item.knowledgeId))
      .map((item) => item.knowledgeId);
    const returnedRejectedIds = rankedItems
      .filter((item) => rejectedIds.has(item.knowledgeId))
      .map((item) => item.knowledgeId);
    const classificationChecks = evaluateClassification(testCase.expectedClassification, pack.classified);
    const hitPassed = expectedIds.size === 0 || (firstExpectedRank !== null && firstExpectedRank <= topK);
    const classificationPassed = classificationChecks.every((check) => check.passed);
    const passed = hitPassed
      && returnedUnexpectedIds.length === 0
      && returnedRejectedIds.length === 0
      && classificationPassed;

    return {
      id: testCase.id,
      prompt: testCase.prompt,
      passed,
      confidence: pack.confidence,
      reciprocalRank: firstExpectedRank === null ? null : round(1 / firstExpectedRank),
      precisionAtK: expectedIds.size === 0 ? null : round(matchedExpectedIds.length / topK),
      firstExpectedRank,
      expectedKnowledgeIds: toEvalIds(index, [...expectedIds]),
      matchedExpectedKnowledgeIds: toEvalIds(index, matchedExpectedIds),
      unexpectedKnowledgeIds: toEvalIds(index, [...unexpectedIds]),
      returnedUnexpectedKnowledgeIds: toEvalIds(index, returnedUnexpectedIds),
      rejectedKnowledgeIds: toEvalIds(index, [...rejectedIds]),
      returnedRejectedKnowledgeIds: toEvalIds(index, returnedRejectedIds),
      topKnowledgeIds: toEvalIds(index, topItems.map((item) => item.knowledgeId)),
      classificationChecks,
    };
  }
}

function flattenPack(pack: ContextPack): RankedCandidate[] {
  return pack.sections.flatMap((section) => section.items);
}

function firstRank(items: RankedCandidate[], expectedIds: Set<string>): number | null {
  if (expectedIds.size === 0) {
    return null;
  }

  const index = items.findIndex((item) => expectedIds.has(item.knowledgeId));
  return index === -1 ? null : index + 1;
}

function resolveEvalIds(index: SeededKnowledgeIndex, evalIds: string[]): Set<string> {
  return new Set(evalIds.map((evalId) => {
    const storeId = index.byEvalId.get(evalId);
    if (!storeId) {
      throw new Error(`Unknown retrieval eval knowledge id: ${evalId}`);
    }

    return storeId;
  }));
}

function toEvalIds(index: SeededKnowledgeIndex, storeIds: string[]): string[] {
  return [...new Set(storeIds.map((storeId) => index.byStoreId.get(storeId) ?? storeId))];
}

function evaluateClassification(
  expected: RetrievalEvalClassificationExpectation | undefined,
  actual: ClassifiedQuery,
): RetrievalEvalClassificationCheck[] {
  if (!expected) {
    return [];
  }

  return [
    arrayCheck('files', expected.files, actual.files),
    arrayCheck('symbols', expected.symbols, actual.symbols),
    arrayCheck('errors', expected.errors, actual.errors),
    arrayCheck('technologies', expected.technologies, actual.technologies),
    arrayCheck('businessAreas', expected.businessAreas, actual.businessAreas),
    scalarCheck('taskType', expected.taskType, actual.taskType),
  ].filter((check): check is RetrievalEvalClassificationCheck => Boolean(check));
}

function arrayCheck(
  field: keyof RetrievalEvalClassificationExpectation,
  expected: string[] | undefined,
  actual: string[],
): RetrievalEvalClassificationCheck | undefined {
  if (!expected || expected.length === 0) {
    return undefined;
  }

  return {
    field,
    expected,
    actual,
    passed: containsAll(actual, expected),
  };
}

function scalarCheck(
  field: keyof RetrievalEvalClassificationExpectation,
  expected: string | undefined,
  actual: string,
): RetrievalEvalClassificationCheck | undefined {
  if (!expected) {
    return undefined;
  }

  return {
    field,
    expected: [expected],
    actual: [actual],
    passed: expected === actual,
  };
}

function containsAll(actual: string[], expected: string[]): boolean {
  const actualValues = new Set(actual);
  return expected.every((value) => actualValues.has(value));
}

function buildMetrics(cases: RetrievalEvalCaseResult[], topK: number): RetrievalEvalMetrics {
  const casesWithExpected = cases.filter((testCase) => testCase.expectedKnowledgeIds.length > 0);
  const casesWithRejected = cases.filter((testCase) => testCase.rejectedKnowledgeIds.length > 0);
  const casesWithUnexpected = cases.filter((testCase) => testCase.unexpectedKnowledgeIds.length > 0);
  const classificationCases = cases.filter((testCase) => testCase.classificationChecks.length > 0);

  return {
    hitRate: average(casesWithExpected.map((testCase) => (
      testCase.firstExpectedRank !== null && testCase.firstExpectedRank <= topK ? 1 : 0
    ))),
    meanReciprocalRank: average(casesWithExpected.map((testCase) => testCase.reciprocalRank ?? 0)),
    precisionAtK: average(casesWithExpected.map((testCase) => testCase.precisionAtK ?? 0)),
    staleRejectionRate: average(casesWithRejected.map((testCase) => (
      testCase.returnedRejectedKnowledgeIds.length === 0 ? 1 : 0
    ))),
    unexpectedAvoidanceRate: average(casesWithUnexpected.map((testCase) => (
      testCase.returnedUnexpectedKnowledgeIds.length === 0 ? 1 : 0
    ))),
    exactFileMatchRate: checkRate(cases, 'files'),
    exactSymbolMatchRate: checkRate(cases, 'symbols'),
    exactErrorMatchRate: checkRate(cases, 'errors'),
    exactClassificationMatchRate: average(classificationCases.map((testCase) => (
      testCase.classificationChecks.every((check) => check.passed) ? 1 : 0
    ))),
  };
}

function checkRate(cases: RetrievalEvalCaseResult[], field: RetrievalEvalClassificationCheck['field']): number | null {
  const checks = cases.flatMap((testCase) => testCase.classificationChecks.filter((check) => check.field === field));
  return average(checks.map((check) => (check.passed ? 1 : 0)));
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function isFeedbackRecorder(value: unknown): value is FeedbackRecorder {
  return Boolean(value && typeof value === 'object' && 'recordFeedback' in value);
}
