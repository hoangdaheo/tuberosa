import type {
  ContextFitStatus,
  ContextPack,
  ContextPackActionItem,
  ContextSearchInput,
  FeedbackInput,
  KnowledgeInput,
  KnowledgeRelation,
  KnowledgeRelationInput,
  RankedCandidate,
  StoredKnowledge,
  TaskType,
} from '../types.js';

/**
 * Phase 0 — Context-mapping evaluator.
 *
 * Complements RetrievalEvaluator with Ragas-style metrics that measure
 * **knowledge quality**, not just hit rate:
 *
 *  - Context Precision @ k
 *  - Context Recall
 *  - Context Entities Recall (files + symbols present in pack)
 *  - Noise Sensitivity (distractors stay out of top-K)
 *  - Direct-evidence placement (golden IDs land in `essential`)
 *  - Fit calibration (expected vs actual fitStatus)
 *  - Forbidden-item rate (false-positive leakage)
 *  - CoIR-style per-taxon breakdowns
 *
 * Deterministic — no LLM calls. Designed to run against the hash provider so
 * future phases can measure deltas without API keys.
 */

// ────────────────────────────────────────────────────────────────────────
// Adapters reused from RetrievalEvaluator
// ────────────────────────────────────────────────────────────────────────

export interface KnowledgeIngestor {
  ingestKnowledge(input: KnowledgeInput): Promise<StoredKnowledge>;
}

export interface ContextSearcher {
  searchContext(input: ContextSearchInput): Promise<ContextPack>;
}

export interface FeedbackRecorder {
  recordFeedback(input: FeedbackInput): Promise<unknown>;
}

export interface KnowledgeRelationCreator {
  createKnowledgeRelation(input: KnowledgeRelationInput): Promise<KnowledgeRelation>;
}

// ────────────────────────────────────────────────────────────────────────
// Fixture types
// ────────────────────────────────────────────────────────────────────────

export type ContextMappingTaxon =
  | 'nl_to_code'
  | 'code_to_code'
  | 'text_to_text_doc'
  | 'hybrid';

export type ContextMappingKnowledge = Omit<KnowledgeInput, 'project'> & {
  evalId: string;
  project?: string;
};

export interface ContextMappingFeedbackEvent {
  feedbackType: FeedbackInput['feedbackType'];
  prompt?: string;
  project?: string;
  knowledgeIds?: string[];
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextMappingRelation {
  fromEvalId: string;
  relationType: string;
  targetKind: 'knowledge';
  toEvalId: string;
  confidence?: number;
  inferred?: boolean;
}

export interface ContextMappingExpectedEntities {
  files?: string[];
  symbols?: string[];
}

export interface ContextMappingCase {
  id: string;
  prompt: string;
  taxon: ContextMappingTaxon;
  project?: string;
  taskType?: TaskType;
  files?: string[];
  symbols?: string[];
  errors?: string[];
  tokenBudget?: number;

  // Golden — at least one of these should be non-empty per case.
  expectedRelevantKnowledgeIds?: string[];
  directEvidenceKnowledgeIds?: string[];
  adjacentEvidenceKnowledgeIds?: string[];
  forbiddenKnowledgeIds?: string[];
  noiseDistractorIds?: string[];

  expectedEntities?: ContextMappingExpectedEntities;
  expectedFitStatus?: ContextFitStatus;
}

export interface ContextMappingFixture {
  name: string;
  project: string;
  knowledge: ContextMappingKnowledge[];
  distractors?: ContextMappingKnowledge[];
  feedbackEvents?: ContextMappingFeedbackEvent[];
  relations?: ContextMappingRelation[];
  cases: ContextMappingCase[];
}

export interface ContextMappingEvalOptions {
  topK?: number;
}

// ────────────────────────────────────────────────────────────────────────
// Result types
// ────────────────────────────────────────────────────────────────────────

export interface ContextMappingCaseResult {
  id: string;
  prompt: string;
  taxon: ContextMappingTaxon;
  passed: boolean;
  fitStatus: ContextFitStatus | undefined;
  expectedFitStatus: ContextFitStatus | undefined;
  fitStatusPassed: boolean;

  contextPrecisionAtK: number | null;
  contextRecall: number | null;
  contextEntitiesRecall: number | null;
  directEvidencePlacement: number | null;
  forbiddenLeakageCount: number;
  distractorLeakageCount: number;
  noiseSensitivity: number | null;
  /**
   * Phase 8 — % of taskBrief.actionItems that pass the brief-groundedness invariant.
   * `null` when the case has no grounding-eligible actions (only policy-only items).
   * Target: 1.0 post-guard. Tracks regressions in the brief-groundedness pipeline.
   */
  briefGroundedness: number | null;

  topKnowledgeIds: string[];
  essentialKnowledgeIds: string[];
  expectedRelevantKnowledgeIds: string[];
  directEvidenceKnowledgeIds: string[];
  forbiddenKnowledgeIds: string[];
  missingEntities: string[];
  /** Phase 8 — brief-groundedness warnings surfaced via fitDiagnostics.notes. */
  briefWarnings: string[];
}

export interface ContextMappingTaxonMetrics {
  taxon: ContextMappingTaxon;
  caseCount: number;
  contextPrecisionAtK: number | null;
  contextRecall: number | null;
  contextEntitiesRecall: number | null;
  noiseSensitivity: number | null;
  directEvidencePlacement: number | null;
  fitCalibration: number | null;
  forbiddenItemRate: number | null;
  briefGroundedness: number | null;
}

export interface ContextMappingMetrics {
  contextPrecisionAtK: number | null;
  contextRecall: number | null;
  contextEntitiesRecall: number | null;
  noiseSensitivity: number | null;
  directEvidencePlacement: number | null;
  fitCalibration: number | null;
  forbiddenItemRate: number | null;
  briefGroundedness: number | null;
  perTaxon: ContextMappingTaxonMetrics[];
}

export interface ContextMappingReport {
  fixtureName: string;
  project: string;
  evaluatedAt: string;
  topK: number;
  totalCases: number;
  metrics: ContextMappingMetrics;
  cases: ContextMappingCaseResult[];
}

// ────────────────────────────────────────────────────────────────────────
// Evaluator
// ────────────────────────────────────────────────────────────────────────

interface SeededIndex {
  byEvalId: Map<string, string>;
  byStoreId: Map<string, string>;
  distractorIds: Set<string>;
}

const DEFAULT_TOP_K = 5;

export class ContextMappingEvaluator {
  constructor(
    private readonly ingestor: KnowledgeIngestor,
    private readonly searcher: ContextSearcher,
    private readonly feedbackRecorder: FeedbackRecorder | undefined = isFeedbackRecorder(searcher) ? searcher : undefined,
    private readonly relationCreator: KnowledgeRelationCreator | undefined = undefined,
  ) {}

  async run(
    fixture: ContextMappingFixture,
    options: ContextMappingEvalOptions = {},
  ): Promise<ContextMappingReport> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const index = await this.seedKnowledge(fixture);
    await this.seedFeedback(fixture, index);
    await this.seedRelations(fixture, index);

    const cases: ContextMappingCaseResult[] = [];
    for (const testCase of fixture.cases) {
      cases.push(await this.evaluateCase(fixture, testCase, index, topK));
    }

    return {
      fixtureName: fixture.name,
      project: fixture.project,
      evaluatedAt: new Date().toISOString(),
      topK,
      totalCases: cases.length,
      metrics: buildMetrics(cases),
      cases,
    };
  }

  // ── Seeding ────────────────────────────────────────────────────────────

  private async seedKnowledge(fixture: ContextMappingFixture): Promise<SeededIndex> {
    const byEvalId = new Map<string, string>();
    const byStoreId = new Map<string, string>();
    const distractorIds = new Set<string>();

    for (const item of fixture.knowledge) {
      const stored = await this.ingestOne(fixture.project, item, false);
      byEvalId.set(item.evalId, stored.id);
      byStoreId.set(stored.id, item.evalId);
    }

    for (const item of fixture.distractors ?? []) {
      const stored = await this.ingestOne(fixture.project, item, true);
      byEvalId.set(item.evalId, stored.id);
      byStoreId.set(stored.id, item.evalId);
      distractorIds.add(stored.id);
    }

    return { byEvalId, byStoreId, distractorIds };
  }

  private async ingestOne(
    fixtureProject: string,
    item: ContextMappingKnowledge,
    isDistractor: boolean,
  ): Promise<StoredKnowledge> {
    const { evalId, project, ...rest } = item;
    return this.ingestor.ingestKnowledge({
      ...rest,
      project: project ?? fixtureProject,
      metadata: {
        ...(rest.metadata ?? {}),
        evalId,
        contextMappingDistractor: isDistractor || undefined,
      },
    });
  }

  private async seedFeedback(fixture: ContextMappingFixture, index: SeededIndex): Promise<void> {
    if (!fixture.feedbackEvents?.length) return;
    if (!this.feedbackRecorder) {
      throw new Error('Context-mapping fixture defines feedbackEvents but no feedback recorder is configured.');
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

  private async seedRelations(fixture: ContextMappingFixture, index: SeededIndex): Promise<void> {
    if (!fixture.relations?.length) return;
    if (!this.relationCreator) {
      throw new Error('Context-mapping fixture defines relations but no relation creator is configured.');
    }

    for (const rel of fixture.relations) {
      const fromId = index.byEvalId.get(rel.fromEvalId);
      const toId = index.byEvalId.get(rel.toEvalId);
      if (!fromId || !toId) {
        throw new Error(`Unknown context-mapping relation evalIds: ${rel.fromEvalId} → ${rel.toEvalId}`);
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

  // ── Per-case evaluation ───────────────────────────────────────────────

  private async evaluateCase(
    fixture: ContextMappingFixture,
    testCase: ContextMappingCase,
    index: SeededIndex,
    topK: number,
  ): Promise<ContextMappingCaseResult> {
    const expectedRelevant = resolveEvalIds(index, testCase.expectedRelevantKnowledgeIds ?? []);
    const directEvidence = resolveEvalIds(index, testCase.directEvidenceKnowledgeIds ?? []);
    const forbidden = resolveEvalIds(index, testCase.forbiddenKnowledgeIds ?? []);
    const noiseDistractors = resolveEvalIds(index, testCase.noiseDistractorIds ?? []);

    // Pack request mirrors RetrievalEvaluator so the metrics measure the same
    // pipeline path.
    const pack = await this.searcher.searchContext({
      prompt: testCase.prompt,
      project: testCase.project ?? fixture.project,
      taskType: testCase.taskType,
      files: testCase.files,
      symbols: testCase.symbols,
      errors: testCase.errors,
      tokenBudget: testCase.tokenBudget,
      bypassCache: true,
    });

    const allItems = flattenPack(pack);
    const topItems = allItems.slice(0, topK);
    const essentialItems = pack.sections.find((section) => section.name === 'essential')?.items ?? [];

    const topIds = new Set(topItems.map((item) => item.knowledgeId));
    const essentialIds = new Set(essentialItems.map((item) => item.knowledgeId));
    const allIds = new Set(allItems.map((item) => item.knowledgeId));

    // ── Metrics per case ───────────────────────────────────────────────

    // Context Precision @ k:  |topK ∩ expectedRelevant| / k.
    // Null when no expected set is declared.
    const contextPrecisionAtK = expectedRelevant.size === 0
      ? null
      : round(intersectionSize(topIds, expectedRelevant) / topK);

    // Context Recall: |expectedRelevant retrieved anywhere| / |expectedRelevant|.
    const contextRecall = expectedRelevant.size === 0
      ? null
      : round(intersectionSize(allIds, expectedRelevant) / expectedRelevant.size);

    // Context Entities Recall: of expected files+symbols, how many appear
    // somewhere in the pack candidates (content, labels, references)?
    const { recall: contextEntitiesRecall, missing: missingEntities } = evaluateEntityRecall(
      testCase.expectedEntities,
      allItems,
    );

    // Direct-evidence placement: of direct IDs, how many landed in essential?
    const directEvidencePlacement = directEvidence.size === 0
      ? null
      : round(intersectionSize(essentialIds, directEvidence) / directEvidence.size);

    // Forbidden-item leakage count (in top-K) — used for forbidden-item rate
    // at the aggregate level.
    const forbiddenLeakageCount = intersectionSize(topIds, forbidden);

    // Noise-sensitivity scope: case-declared distractors take priority,
    // otherwise fall back to the global distractor pool so a fixture with no
    // per-case noise still gets a meaningful metric.
    const noiseScope = noiseDistractors.size > 0
      ? noiseDistractors
      : index.distractorIds;
    const distractorLeakageCount = intersectionSize(topIds, noiseScope);
    const noiseSensitivity = noiseScope.size === 0
      ? null
      : round(1 - distractorLeakageCount / noiseScope.size);

    // Fit calibration: per-case binary; aggregated into a rate below.
    const fitStatus = pack.contextFit?.fitStatus;
    const fitStatusPassed = testCase.expectedFitStatus === undefined
      ? true
      : fitStatus === testCase.expectedFitStatus;

    // Phase 8 — brief groundedness: every grounding-eligible action item in the assembled
    // brief must carry a non-empty evidenceIds list resolving to a pack candidate (or to
    // the action's own targetId for self-grounded review targets). Policy-only actions are
    // exempt. Target: 1.0 post-guard.
    const { score: briefGroundedness } = evaluateBriefGroundedness(pack, allItems);
    const briefWarnings = collectBriefWarnings(pack);
    const briefOk = briefGroundedness === null || briefGroundedness === 1;

    // Pass criteria for the case overall — used for human-readable PASS/FAIL.
    // A case passes when all *declared* expectations are satisfied. We don't
    // fail a case for an undeclared expectation.
    const precisionOk = contextPrecisionAtK === null || contextPrecisionAtK > 0;
    const recallOk = contextRecall === null || contextRecall === 1;
    const placementOk = directEvidencePlacement === null || directEvidencePlacement === 1;
    const noLeak = forbiddenLeakageCount === 0;
    const noDistractor = distractorLeakageCount === 0 || noiseDistractors.size === 0;
    const entityOk = contextEntitiesRecall === null || contextEntitiesRecall === 1;
    const passed = precisionOk && recallOk && placementOk && noLeak && noDistractor && entityOk && fitStatusPassed && briefOk;

    return {
      id: testCase.id,
      prompt: testCase.prompt,
      taxon: testCase.taxon,
      passed,
      fitStatus,
      expectedFitStatus: testCase.expectedFitStatus,
      fitStatusPassed,
      contextPrecisionAtK,
      contextRecall,
      contextEntitiesRecall,
      directEvidencePlacement,
      forbiddenLeakageCount,
      distractorLeakageCount,
      noiseSensitivity,
      briefGroundedness,
      topKnowledgeIds: toEvalIds(index, topItems.map((item) => item.knowledgeId)),
      essentialKnowledgeIds: toEvalIds(index, essentialItems.map((item) => item.knowledgeId)),
      expectedRelevantKnowledgeIds: toEvalIds(index, [...expectedRelevant]),
      directEvidenceKnowledgeIds: toEvalIds(index, [...directEvidence]),
      forbiddenKnowledgeIds: toEvalIds(index, [...forbidden]),
      missingEntities,
      briefWarnings,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Metrics + helpers
// ────────────────────────────────────────────────────────────────────────

function buildMetrics(cases: ContextMappingCaseResult[]): ContextMappingMetrics {
  const taxons: ContextMappingTaxon[] = ['nl_to_code', 'code_to_code', 'text_to_text_doc', 'hybrid'];
  const perTaxon = taxons
    .map((taxon) => buildTaxonMetrics(taxon, cases.filter((testCase) => testCase.taxon === taxon)))
    .filter((entry): entry is ContextMappingTaxonMetrics => entry !== null);

  return {
    contextPrecisionAtK: average(cases.map((testCase) => testCase.contextPrecisionAtK)),
    contextRecall: average(cases.map((testCase) => testCase.contextRecall)),
    contextEntitiesRecall: average(cases.map((testCase) => testCase.contextEntitiesRecall)),
    noiseSensitivity: average(cases.map((testCase) => testCase.noiseSensitivity)),
    directEvidencePlacement: average(cases.map((testCase) => testCase.directEvidencePlacement)),
    fitCalibration: average(fitCalibrationCases(cases)),
    forbiddenItemRate: forbiddenItemRate(cases),
    briefGroundedness: average(cases.map((testCase) => testCase.briefGroundedness)),
    perTaxon,
  };
}

function buildTaxonMetrics(
  taxon: ContextMappingTaxon,
  cases: ContextMappingCaseResult[],
): ContextMappingTaxonMetrics | null {
  if (cases.length === 0) return null;
  return {
    taxon,
    caseCount: cases.length,
    contextPrecisionAtK: average(cases.map((testCase) => testCase.contextPrecisionAtK)),
    contextRecall: average(cases.map((testCase) => testCase.contextRecall)),
    contextEntitiesRecall: average(cases.map((testCase) => testCase.contextEntitiesRecall)),
    noiseSensitivity: average(cases.map((testCase) => testCase.noiseSensitivity)),
    directEvidencePlacement: average(cases.map((testCase) => testCase.directEvidencePlacement)),
    fitCalibration: average(fitCalibrationCases(cases)),
    forbiddenItemRate: forbiddenItemRate(cases),
    briefGroundedness: average(cases.map((testCase) => testCase.briefGroundedness)),
  };
}

// Phase 8 — policy-only actions that are exempt from the groundedness guard. Keep in sync
// with the same set in `src/retrieval/context-pack.ts`.
const POLICY_ONLY_ACTIONS = new Set(['run_verification', 'ask_clarification', 'inspect_shortlist']);

function evaluateBriefGroundedness(
  pack: ContextPack,
  allItems: RankedCandidate[],
): { score: number | null; failingActions: string[] } {
  const actionItems = pack.taskBrief?.actionItems ?? [];
  const eligible = actionItems.filter((action) => !POLICY_ONLY_ACTIONS.has(action.action));
  if (eligible.length === 0) {
    return { score: null, failingActions: [] };
  }

  const packIds = new Set(allItems.map((item) => item.knowledgeId));
  const failingActions: string[] = [];
  let grounded = 0;

  for (const action of eligible) {
    if (isActionGrounded(action, packIds)) {
      grounded += 1;
    } else {
      failingActions.push(`${action.action}:${action.targetPath ?? action.targetTitle ?? action.label}`);
    }
  }

  return {
    score: round(grounded / eligible.length),
    failingActions,
  };
}

function isActionGrounded(action: ContextPackActionItem, packIds: Set<string>): boolean {
  if (POLICY_ONLY_ACTIONS.has(action.action)) {
    return true;
  }
  const evidenceIds = action.evidenceIds ?? [];
  if (evidenceIds.length === 0) {
    return false;
  }
  // Either every evidence id points to a pack candidate, or it points to the action's own
  // `targetId` (self-grounded review target — workbench resolves via the id directly).
  return evidenceIds.every((id) => packIds.has(id) || id === action.targetId);
}

function collectBriefWarnings(pack: ContextPack): string[] {
  const notes = pack.contextFit?.fitDiagnostics?.notes ?? [];
  return notes.filter((note) => note.startsWith('brief_warning:'));
}

function fitCalibrationCases(cases: ContextMappingCaseResult[]): Array<number | null> {
  return cases.map((testCase) => {
    if (testCase.expectedFitStatus === undefined) return null;
    return testCase.fitStatusPassed ? 1 : 0;
  });
}

function forbiddenItemRate(cases: ContextMappingCaseResult[]): number | null {
  const withForbidden = cases.filter((testCase) => testCase.forbiddenKnowledgeIds.length > 0);
  if (withForbidden.length === 0) return null;
  const leaks = withForbidden.filter((testCase) => testCase.forbiddenLeakageCount > 0).length;
  return round(leaks / withForbidden.length);
}

function evaluateEntityRecall(
  expected: ContextMappingExpectedEntities | undefined,
  items: RankedCandidate[],
): { recall: number | null; missing: string[] } {
  if (!expected) return { recall: null, missing: [] };
  const entities = [...(expected.files ?? []), ...(expected.symbols ?? [])];
  if (entities.length === 0) return { recall: null, missing: [] };

  const haystack = items
    .map((item) => candidateHaystack(item))
    .join('\n')
    .toLowerCase();

  const missing: string[] = [];
  let matched = 0;
  for (const entity of entities) {
    if (haystack.includes(entity.toLowerCase())) {
      matched += 1;
    } else {
      missing.push(entity);
    }
  }

  return { recall: round(matched / entities.length), missing };
}

function candidateHaystack(item: RankedCandidate): string {
  const labelText = item.labels.map((label) => `${label.type}:${label.value}`).join(' ');
  const refText = item.references.map((ref) => `${ref.type}:${ref.uri}`).join(' ');
  return [
    item.title,
    item.summary,
    item.content,
    item.contextualContent,
    labelText,
    refText,
  ].join(' ');
}

function flattenPack(pack: ContextPack): RankedCandidate[] {
  return pack.sections.flatMap((section) => section.items);
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  if (right.size === 0) return 0;
  let count = 0;
  for (const value of right) {
    if (left.has(value)) count += 1;
  }
  return count;
}

function resolveEvalIds(index: SeededIndex, evalIds: string[]): Set<string> {
  return new Set(evalIds.map((evalId) => {
    const storeId = index.byEvalId.get(evalId);
    if (!storeId) {
      throw new Error(`Unknown context-mapping eval knowledge id: ${evalId}`);
    }
    return storeId;
  }));
}

function toEvalIds(index: SeededIndex, storeIds: string[]): string[] {
  return [...new Set(storeIds.map((storeId) => index.byStoreId.get(storeId) ?? storeId))];
}

function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return round(present.reduce((sum, value) => sum + value, 0) / present.length);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function isFeedbackRecorder(value: unknown): value is FeedbackRecorder {
  return Boolean(value && typeof value === 'object' && 'recordFeedback' in value);
}
