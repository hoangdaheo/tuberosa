import type {
  ClassifiedQuery,
  ContextPack,
  ContextFitStatus,
  ContextSearchInput,
  FeedbackInput,
  KnowledgeGap,
  KnowledgeInput,
  KnowledgeRelation,
  KnowledgeRelationInput,
  LearningReviewStatus,
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

export interface KnowledgeGapReader {
  listKnowledgeGaps(options: {
    project?: string;
    status?: LearningReviewStatus;
    contextPackId?: string;
    limit: number;
  }): Promise<KnowledgeGap[]>;
}

export interface KnowledgeRelationCreator {
  createKnowledgeRelation(input: KnowledgeRelationInput): Promise<KnowledgeRelation>;
}

export interface RetrievalEvalRelation {
  fromEvalId: string;
  relationType: string;
  targetKind: 'knowledge';
  toEvalId: string;
  confidence?: number;
  inferred?: boolean;
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
  expectedSelectedKnowledgeIds?: string[];
  unexpectedKnowledgeIds?: string[];
  rejectedKnowledgeIds?: string[];
  minConfidence?: number;
  expectedContextFitStatus?: ContextFitStatus;
  minContextFitScore?: number;
  expectedClassification?: RetrievalEvalClassificationExpectation;
}

export interface RetrievalEvalFeedbackEvent {
  feedbackType: FeedbackInput['feedbackType'];
  prompt?: string;
  project?: string;
  knowledgeIds?: string[];
  reason?: string;
  metadata?: Record<string, unknown>;
  expectedKnowledgeGap?: RetrievalEvalExpectedKnowledgeGap;
}

export interface RetrievalEvalExpectedKnowledgeGap {
  status?: LearningReviewStatus;
  promptIncludes?: string;
  reasonIncludes?: string;
  missingSignals?: string[];
  contextPackIdRequired?: boolean;
}

export interface RetrievalEvalFixture {
  name: string;
  project: string;
  knowledge: RetrievalEvalKnowledge[];
  feedbackEvents?: RetrievalEvalFeedbackEvent[];
  relations?: RetrievalEvalRelation[];
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
  minConfidence?: number;
  confidencePassed?: boolean;
  contextFitStatus?: ContextFitStatus;
  expectedContextFitStatus?: ContextFitStatus;
  contextFitStatusPassed?: boolean;
  contextFitScore?: number;
  minContextFitScore?: number;
  contextFitScorePassed?: boolean;
  reciprocalRank: number | null;
  precisionAtK: number | null;
  firstExpectedRank: number | null;
  expectedKnowledgeIds: string[];
  matchedExpectedKnowledgeIds: string[];
  expectedSelectedKnowledgeIds: string[];
  matchedSelectedKnowledgeIds: string[];
  unexpectedKnowledgeIds: string[];
  returnedUnexpectedKnowledgeIds: string[];
  rejectedKnowledgeIds: string[];
  returnedRejectedKnowledgeIds: string[];
  selectedKnowledgeIds: string[];
  topKnowledgeIds: string[];
  classificationChecks: RetrievalEvalClassificationCheck[];
}

export interface RetrievalEvalMetrics {
  hitRate: number | null;
  meanReciprocalRank: number | null;
  precisionAtK: number | null;
  selectedCoverageRate: number | null;
  staleRejectionRate: number | null;
  unexpectedAvoidanceRate: number | null;
  confidenceThresholdRate: number | null;
  contextFitStatusRate: number | null;
  contextFitScoreRate: number | null;
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
    private readonly relationCreator: KnowledgeRelationCreator | undefined = undefined,
    private readonly gapReader: KnowledgeGapReader | undefined = isKnowledgeGapReader(relationCreator) ? relationCreator : undefined,
  ) {}

  async run(fixture: RetrievalEvalFixture, options: RetrievalEvalOptions = {}): Promise<RetrievalEvalReport> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const index = await this.seedKnowledge(fixture);
    await this.seedFeedback(fixture, index);
    await this.seedRelations(fixture, index);
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

      if (event.expectedKnowledgeGap) {
        await this.assertExpectedKnowledgeGap(fixture, event, contextPackId);
      }
    }
  }

  private async assertExpectedKnowledgeGap(
    fixture: RetrievalEvalFixture,
    event: RetrievalEvalFeedbackEvent,
    contextPackId: string | undefined,
  ): Promise<void> {
    if (!this.gapReader) {
      throw new Error('Retrieval eval fixture expects knowledge gaps but no gap reader is configured.');
    }

    const expected = event.expectedKnowledgeGap;
    if (!expected) {
      return;
    }

    const gaps = await this.gapReader.listKnowledgeGaps({
      project: event.project ?? fixture.project,
      status: expected.status ?? 'open',
      contextPackId,
      limit: 20,
    });
    const matchingGap = gaps.find((gap) => knowledgeGapMatches(gap, expected, contextPackId));
    if (!matchingGap) {
      throw new Error(`Expected missing_context feedback to create a matching knowledge gap for prompt: ${event.prompt ?? event.reason ?? fixture.name}`);
    }
  }

  private async seedRelations(fixture: RetrievalEvalFixture, index: SeededKnowledgeIndex): Promise<void> {
    if (!fixture.relations?.length) {
      return;
    }

    if (!this.relationCreator) {
      throw new Error('Retrieval eval fixture defines relations but no relation creator is configured.');
    }

    for (const rel of fixture.relations) {
      const fromId = index.byEvalId.get(rel.fromEvalId);
      const toId = index.byEvalId.get(rel.toEvalId);
      if (!fromId || !toId) {
        throw new Error(`Unknown eval relation evalIds: ${rel.fromEvalId} → ${rel.toEvalId}`);
      }

      await this.relationCreator.createKnowledgeRelation({
        project: fixture.project,
        fromKnowledgeId: fromId,
        relationType: rel.relationType as KnowledgeRelationInput['relationType'],
        targetKind: rel.targetKind,
        targetKnowledgeId: toId,
        confidence: rel.confidence ?? 0.8,
        inferred: rel.inferred ?? false,
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
    const expectedSelectedIds = resolveEvalIds(index, testCase.expectedSelectedKnowledgeIds ?? []);
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
    const selectedIds = rankedItems.map((item) => item.knowledgeId);
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
    const matchedSelectedIds = selectedIds.filter((knowledgeId) => expectedSelectedIds.has(knowledgeId));
    const classificationChecks = evaluateClassification(testCase.expectedClassification, pack.classified);
    const hitPassed = expectedIds.size === 0 || (firstExpectedRank !== null && firstExpectedRank <= topK);
    const selectedPassed = expectedSelectedIds.size === 0 || matchedSelectedIds.length === expectedSelectedIds.size;
    const confidencePassed = testCase.minConfidence === undefined || pack.confidence >= testCase.minConfidence;
    const contextFitStatusPassed = testCase.expectedContextFitStatus === undefined
      || pack.contextFit?.fitStatus === testCase.expectedContextFitStatus;
    const contextFitScorePassed = testCase.minContextFitScore === undefined
      || (pack.contextFit?.fitScore ?? 0) >= testCase.minContextFitScore;
    const classificationPassed = classificationChecks.every((check) => check.passed);
    const passed = hitPassed
      && selectedPassed
      && returnedUnexpectedIds.length === 0
      && returnedRejectedIds.length === 0
      && confidencePassed
      && contextFitStatusPassed
      && contextFitScorePassed
      && classificationPassed;

    return {
      id: testCase.id,
      prompt: testCase.prompt,
      passed,
      confidence: pack.confidence,
      minConfidence: testCase.minConfidence,
      confidencePassed,
      contextFitStatus: pack.contextFit?.fitStatus,
      expectedContextFitStatus: testCase.expectedContextFitStatus,
      contextFitStatusPassed,
      contextFitScore: pack.contextFit?.fitScore,
      minContextFitScore: testCase.minContextFitScore,
      contextFitScorePassed,
      reciprocalRank: firstExpectedRank === null ? null : round(1 / firstExpectedRank),
      precisionAtK: expectedIds.size === 0 ? null : round(matchedExpectedIds.length / topK),
      firstExpectedRank,
      expectedKnowledgeIds: toEvalIds(index, [...expectedIds]),
      matchedExpectedKnowledgeIds: toEvalIds(index, matchedExpectedIds),
      expectedSelectedKnowledgeIds: toEvalIds(index, [...expectedSelectedIds]),
      matchedSelectedKnowledgeIds: toEvalIds(index, matchedSelectedIds),
      unexpectedKnowledgeIds: toEvalIds(index, [...unexpectedIds]),
      returnedUnexpectedKnowledgeIds: toEvalIds(index, returnedUnexpectedIds),
      rejectedKnowledgeIds: toEvalIds(index, [...rejectedIds]),
      returnedRejectedKnowledgeIds: toEvalIds(index, returnedRejectedIds),
      selectedKnowledgeIds: toEvalIds(index, selectedIds),
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
  if (expected === undefined) {
    return undefined;
  }

  return {
    field,
    expected,
    actual,
    passed: expected.length === 0 ? actual.length === 0 : containsAll(actual, expected),
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
  const casesWithSelected = cases.filter((testCase) => testCase.expectedSelectedKnowledgeIds.length > 0);
  const casesWithRejected = cases.filter((testCase) => testCase.rejectedKnowledgeIds.length > 0);
  const casesWithUnexpected = cases.filter((testCase) => testCase.unexpectedKnowledgeIds.length > 0);
  const confidenceCases = cases.filter((testCase) => testCase.minConfidence !== undefined);
  const contextFitStatusCases = cases.filter((testCase) => testCase.expectedContextFitStatus !== undefined);
  const contextFitScoreCases = cases.filter((testCase) => testCase.minContextFitScore !== undefined);
  const classificationCases = cases.filter((testCase) => testCase.classificationChecks.length > 0);

  return {
    hitRate: average(casesWithExpected.map((testCase) => (
      testCase.firstExpectedRank !== null && testCase.firstExpectedRank <= topK ? 1 : 0
    ))),
    meanReciprocalRank: average(casesWithExpected.map((testCase) => testCase.reciprocalRank ?? 0)),
    precisionAtK: average(casesWithExpected.map((testCase) => testCase.precisionAtK ?? 0)),
    selectedCoverageRate: average(casesWithSelected.map((testCase) => (
      testCase.matchedSelectedKnowledgeIds.length === testCase.expectedSelectedKnowledgeIds.length ? 1 : 0
    ))),
    staleRejectionRate: average(casesWithRejected.map((testCase) => (
      testCase.returnedRejectedKnowledgeIds.length === 0 ? 1 : 0
    ))),
    unexpectedAvoidanceRate: average(casesWithUnexpected.map((testCase) => (
      testCase.returnedUnexpectedKnowledgeIds.length === 0 ? 1 : 0
    ))),
    confidenceThresholdRate: average(confidenceCases.map((testCase) => (testCase.confidencePassed ? 1 : 0))),
    contextFitStatusRate: average(contextFitStatusCases.map((testCase) => (
      testCase.contextFitStatusPassed ? 1 : 0
    ))),
    contextFitScoreRate: average(contextFitScoreCases.map((testCase) => (
      testCase.contextFitScorePassed ? 1 : 0
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

function isKnowledgeGapReader(value: unknown): value is KnowledgeGapReader {
  return Boolean(value && typeof value === 'object' && 'listKnowledgeGaps' in value);
}

function knowledgeGapMatches(
  gap: KnowledgeGap,
  expected: RetrievalEvalExpectedKnowledgeGap,
  contextPackId: string | undefined,
): boolean {
  if (expected.contextPackIdRequired !== false && (!contextPackId || gap.contextPackId !== contextPackId)) {
    return false;
  }

  if (expected.promptIncludes && !gap.prompt.toLowerCase().includes(expected.promptIncludes.toLowerCase())) {
    return false;
  }

  if (expected.reasonIncludes && !gap.reason?.toLowerCase().includes(expected.reasonIncludes.toLowerCase())) {
    return false;
  }

  if (expected.missingSignals && !containsAll(gap.missingSignals, expected.missingSignals)) {
    return false;
  }

  return true;
}
