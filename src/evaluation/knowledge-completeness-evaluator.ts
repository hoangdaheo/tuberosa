import type {
  ContextPack,
  ContextSearchInput,
  LabelInput,
  LabelType,
  KnowledgeInput,
  RankedCandidate,
  ReferenceInput,
  StoredKnowledge,
  TaskType,
} from '../types.js';
import { clamp, normalizeLabel, truncate, uniqueStrings } from '../util/text.js';
import type { RetrievalEvalKnowledge } from './retrieval-evaluator.js';

export type KnowledgeCompletenessMode = 'fixture' | 'live';

export interface KnowledgeCompletenessIngestor {
  ingestKnowledge(input: KnowledgeInput): Promise<StoredKnowledge>;
}

export interface KnowledgeCompletenessSearcher {
  searchContext(input: ContextSearchInput): Promise<ContextPack>;
}

export interface KnowledgeCompletenessRequiredFact {
  id: string;
  description?: string;
  weight?: number;
  terms?: string[];
  sourceRefs?: string[];
}

export type KnowledgeCompletenessRequiredSourceType = 'file' | 'symbol' | 'label' | 'knowledge' | 'ref';

export interface KnowledgeCompletenessRequiredSource {
  type: KnowledgeCompletenessRequiredSourceType;
  value: string;
  labelType?: LabelType;
}

export type KnowledgeCompletenessForbiddenItemType = 'title' | 'id' | 'label' | 'ref' | 'any';

export interface KnowledgeCompletenessForbiddenItem {
  type: KnowledgeCompletenessForbiddenItemType;
  value: string;
  labelType?: LabelType;
}

export interface KnowledgeCompletenessCase {
  id: string;
  prompt: string;
  project?: string;
  taskType?: TaskType;
  files?: string[];
  symbols?: string[];
  errors?: string[];
  tokenBudget?: number;
  modes?: KnowledgeCompletenessMode[];
  requiredFacts: KnowledgeCompletenessRequiredFact[];
  requiredSources?: KnowledgeCompletenessRequiredSource[];
  forbiddenItems?: KnowledgeCompletenessForbiddenItem[];
  minCompleteness?: number;
  minSourceCoverage?: number;
  maxNoiseRate?: number;
  minKnowledgeGainScore?: number;
}

export interface KnowledgeCompletenessFixture {
  name: string;
  project: string;
  knowledge?: RetrievalEvalKnowledge[];
  cases: KnowledgeCompletenessCase[];
}

export interface KnowledgeCompletenessOptions {
  mode?: KnowledgeCompletenessMode;
}

export interface KnowledgeCompletenessFactResult {
  id: string;
  description?: string;
  weight: number;
  passed: boolean;
  matchedTerms: string[];
  missingTerms: string[];
  matchedSourceRefs: string[];
  missingSourceRefs: string[];
}

export interface KnowledgeCompletenessSourceResult {
  type: KnowledgeCompletenessRequiredSourceType;
  value: string;
  labelType?: LabelType;
  passed: boolean;
  directEvidence: boolean;
}

export interface KnowledgeCompletenessForbiddenHit {
  knowledgeId: string;
  title: string;
  section: string;
  forbiddenType: KnowledgeCompletenessForbiddenItemType;
  value: string;
}

export interface KnowledgeCompletenessCaseResult {
  id: string;
  prompt: string;
  passed: boolean;
  completeness: number;
  minCompleteness: number;
  completenessPassed: boolean;
  sourceCoverage: number;
  minSourceCoverage: number;
  sourceCoveragePassed: boolean;
  noiseRate: number;
  maxNoiseRate: number;
  noiseRatePassed: boolean;
  directEvidencePlacement: number;
  knowledgeGainScore: number;
  minKnowledgeGainScore?: number;
  knowledgeGainScorePassed?: boolean;
  factResults: KnowledgeCompletenessFactResult[];
  sourceResults: KnowledgeCompletenessSourceResult[];
  forbiddenHits: KnowledgeCompletenessForbiddenHit[];
  selectedKnowledgeIds: string[];
  selectedKnowledgeTitles: string[];
}

export interface KnowledgeCompletenessMetrics {
  passRate: number | null;
  averageCompleteness: number | null;
  averageSourceCoverage: number | null;
  averageNoiseRate: number | null;
  averageDirectEvidencePlacement: number | null;
  averageKnowledgeGainScore: number | null;
}

export interface KnowledgeCompletenessReport {
  fixtureName: string;
  project: string;
  evaluatedAt: string;
  mode: KnowledgeCompletenessMode;
  skipped?: boolean;
  skipReason?: string;
  totalCases: number;
  metrics: KnowledgeCompletenessMetrics;
  cases: KnowledgeCompletenessCaseResult[];
}

interface SeededKnowledgeIndex {
  byEvalId: Map<string, string>;
  byStoreId: Map<string, string>;
}

interface ItemEvidence {
  section: string;
  item: RankedCandidate;
}

interface EvidenceIndex {
  text: string;
  normalizedText: string;
  items: ItemEvidence[];
  evalIndex?: SeededKnowledgeIndex;
}

const DEFAULT_MIN_COMPLETENESS = 1;
const DEFAULT_MIN_SOURCE_COVERAGE = 1;
const DEFAULT_MAX_NOISE_RATE = 0;

const KNOWLEDGE_GAIN_WEIGHTS = {
  completeness: 0.55,
  sourceCoverage: 0.25,
  directEvidencePlacement: 0.10,
  noiseAvoidance: 0.10,
} as const;

export class KnowledgeCompletenessEvaluator {
  constructor(
    private readonly searcher: KnowledgeCompletenessSearcher,
    private readonly ingestor?: KnowledgeCompletenessIngestor,
  ) {}

  async run(
    fixture: KnowledgeCompletenessFixture,
    options: KnowledgeCompletenessOptions = {},
  ): Promise<KnowledgeCompletenessReport> {
    const mode = options.mode ?? 'fixture';
    const cases = fixture.cases.filter((testCase) => caseAppliesToMode(testCase, mode));
    const index = mode === 'fixture' ? await this.seedKnowledge(fixture) : emptyIndex();
    const results: KnowledgeCompletenessCaseResult[] = [];

    for (const testCase of cases) {
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
      results.push(evaluateKnowledgeCompletenessPack(testCase, pack, index));
    }

    return {
      fixtureName: fixture.name,
      project: fixture.project,
      evaluatedAt: new Date().toISOString(),
      mode,
      totalCases: results.length,
      metrics: buildMetrics(results),
      cases: results,
    };
  }

  private async seedKnowledge(fixture: KnowledgeCompletenessFixture): Promise<SeededKnowledgeIndex> {
    const byEvalId = new Map<string, string>();
    const byStoreId = new Map<string, string>();

    if (!fixture.knowledge?.length) {
      return { byEvalId, byStoreId };
    }

    if (!this.ingestor) {
      throw new Error('Knowledge completeness fixture defines knowledge but no ingestor is configured.');
    }

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
}

export function evaluateKnowledgeCompletenessPack(
  testCase: KnowledgeCompletenessCase,
  pack: ContextPack,
  evalIndex: SeededKnowledgeIndex = emptyIndex(),
): KnowledgeCompletenessCaseResult {
  const evidence = buildEvidenceIndex(pack, evalIndex);
  const factResults = testCase.requiredFacts.map((fact) => evaluateFact(fact, evidence));
  const sourceResults = (testCase.requiredSources ?? []).map((source) => evaluateSource(source, evidence));
  const forbiddenHits = evaluateForbiddenHits(testCase.forbiddenItems ?? [], evidence);
  const totalFactWeight = factResults.reduce((sum, fact) => sum + fact.weight, 0);
  const coveredFactWeight = factResults
    .filter((fact) => fact.passed)
    .reduce((sum, fact) => sum + fact.weight, 0);
  const completeness = totalFactWeight > 0 ? roundRate(coveredFactWeight / totalFactWeight) : 1;
  const sourceCoverage = sourceResults.length > 0
    ? roundRate(sourceResults.filter((source) => source.passed).length / sourceResults.length)
    : 1;
  const directEvidencePlacement = sourceResults.length > 0
    ? roundRate(sourceResults.filter((source) => source.directEvidence).length / sourceResults.length)
    : 1;
  const noisyKnowledgeIds = new Set(forbiddenHits.map((hit) => hit.knowledgeId));
  const selectedCount = evidence.items.length;
  const noiseRate = selectedCount > 0 ? roundRate(noisyKnowledgeIds.size / selectedCount) : 0;
  const knowledgeGainScore = roundScore(100 * (
    completeness * KNOWLEDGE_GAIN_WEIGHTS.completeness +
    sourceCoverage * KNOWLEDGE_GAIN_WEIGHTS.sourceCoverage +
    directEvidencePlacement * KNOWLEDGE_GAIN_WEIGHTS.directEvidencePlacement +
    (1 - clamp(noiseRate, 0, 1)) * KNOWLEDGE_GAIN_WEIGHTS.noiseAvoidance
  ));
  const minCompleteness = testCase.minCompleteness ?? DEFAULT_MIN_COMPLETENESS;
  const minSourceCoverage = testCase.minSourceCoverage ?? DEFAULT_MIN_SOURCE_COVERAGE;
  const maxNoiseRate = testCase.maxNoiseRate ?? DEFAULT_MAX_NOISE_RATE;
  const completenessPassed = completeness >= minCompleteness;
  const sourceCoveragePassed = sourceCoverage >= minSourceCoverage;
  const noiseRatePassed = noiseRate <= maxNoiseRate;
  const knowledgeGainScorePassed = testCase.minKnowledgeGainScore === undefined
    ? undefined
    : knowledgeGainScore >= testCase.minKnowledgeGainScore;
  const passed = completenessPassed
    && sourceCoveragePassed
    && noiseRatePassed
    && (knowledgeGainScorePassed ?? true);

  return {
    id: testCase.id,
    prompt: testCase.prompt,
    passed,
    completeness,
    minCompleteness,
    completenessPassed,
    sourceCoverage,
    minSourceCoverage,
    sourceCoveragePassed,
    noiseRate,
    maxNoiseRate,
    noiseRatePassed,
    directEvidencePlacement,
    knowledgeGainScore,
    minKnowledgeGainScore: testCase.minKnowledgeGainScore,
    knowledgeGainScorePassed,
    factResults,
    sourceResults,
    forbiddenHits,
    selectedKnowledgeIds: uniqueStrings(evidence.items.map(({ item }) => evalIndex.byStoreId.get(item.knowledgeId) ?? item.knowledgeId)),
    selectedKnowledgeTitles: evidence.items.map(({ item }) => item.title),
  };
}

export function skippedKnowledgeCompletenessReport(
  fixture: KnowledgeCompletenessFixture,
  mode: KnowledgeCompletenessMode,
  reason: string,
): KnowledgeCompletenessReport {
  return {
    fixtureName: fixture.name,
    project: fixture.project,
    evaluatedAt: new Date().toISOString(),
    mode,
    skipped: true,
    skipReason: reason,
    totalCases: 0,
    metrics: buildMetrics([]),
    cases: [],
  };
}

function buildEvidenceIndex(pack: ContextPack, evalIndex: SeededKnowledgeIndex): EvidenceIndex {
  const items = pack.sections.flatMap((section) => (
    section.items.map((item) => ({ section: section.name, item }))
  ));
  const lines: string[] = [
    `prompt: ${pack.prompt}`,
    `project: ${pack.project ?? ''}`,
    `confidence: ${pack.confidence}`,
    `classified task: ${pack.classified.taskType}`,
    `classified files: ${pack.classified.files.join(' ')}`,
    `classified symbols: ${pack.classified.symbols.join(' ')}`,
    `classified errors: ${pack.classified.errors.join(' ')}`,
    `classified technologies: ${pack.classified.technologies.join(' ')}`,
    `classified business areas: ${pack.classified.businessAreas.join(' ')}`,
    `classified exact terms: ${pack.classified.exactTerms.join(' ')}`,
    `classified domain: ${pack.classified.domain ?? ''}`,
    `intent goal: ${pack.classified.intent.taskGoal}`,
    `intent workflow stage: ${pack.classified.intent.workflowStage}`,
    `intent evidence types: ${pack.classified.intent.requiredEvidenceTypes.join(' ')}`,
  ];

  if (pack.contextFit) {
    lines.push(
      `context fit status: ${pack.contextFit.fitStatus}`,
      `context fit score: ${pack.contextFit.fitScore}`,
      `context fit reasons: ${pack.contextFit.fitReasons.join(' ')}`,
      `context fit missing: ${pack.contextFit.missingSignals.join(' ')}`,
    );
  }

  if (pack.orientation) {
    lines.push(
      `orientation task: ${pack.orientation.inferredTask}`,
      `orientation files: ${pack.orientation.recommendedFiles.map((file) => `${file.path} ${file.reason}`).join(' ')}`,
      `orientation surfaces: ${pack.orientation.likelySurfaces.join(' ')}`,
      `orientation verification: ${pack.orientation.verificationCommands.join(' ')}`,
      `orientation notes: ${pack.orientation.notes.join(' ')}`,
    );
  }

  if (pack.taskBrief) {
    lines.push(
      `task brief mode: ${pack.taskBrief.mode}`,
      `task brief goal: ${pack.taskBrief.goal}`,
      `task brief direct evidence ids: ${pack.taskBrief.directEvidenceKnowledgeIds.join(' ')}`,
      `task brief adjacent ids: ${pack.taskBrief.adjacentKnowledgeIds.join(' ')}`,
      `task brief actions: ${pack.taskBrief.actionItems.map((item) => `${item.action} ${item.label} ${item.targetPath ?? ''} ${item.command ?? ''}`).join(' ')}`,
    );
  }

  for (const { section, item } of items) {
    const evalId = evalIndex.byStoreId.get(item.knowledgeId);
    lines.push(
      `section: ${section}`,
      `knowledge id: ${item.knowledgeId}`,
      `eval id: ${evalId ?? ''}`,
      `title: ${item.title}`,
      `type: ${item.itemType}`,
      `summary: ${item.summary}`,
      `content: ${truncate(item.content, 1400)}`,
      `contextual content: ${truncate(item.contextualContent, 900)}`,
      `labels: ${labelsText(item.labels)}`,
      `references: ${referencesText(item.references)}`,
      `match reasons: ${item.matchReasons.join(' ')}`,
      `fit reasons: ${(item.fitReasons ?? []).join(' ')}`,
      `fit missing: ${(item.fitMissingSignals ?? []).join(' ')}`,
      `evidence category: ${item.evidenceCategory ?? ''}`,
      `evidence strength: ${item.evidenceStrength ?? ''}`,
      `usefulness reason: ${item.usefulnessReason ?? ''}`,
    );
  }

  if (pack.deepContext) {
    for (const section of pack.deepContext.sections) {
      for (const item of section.items) {
        lines.push(
          `deep section: ${section.name}`,
          `deep knowledge id: ${item.knowledgeId}`,
          `deep title: ${item.title}`,
          `deep summary: ${item.summary}`,
          `deep content: ${truncate(item.content, 1800)}`,
          `deep labels: ${labelsText(item.labels)}`,
          `deep references: ${referencesText(item.references)}`,
        );
      }
    }
  }

  const text = lines.filter(Boolean).join('\n');
  return {
    text,
    normalizedText: normalizeEvidence(text),
    items,
    evalIndex,
  };
}

function evaluateFact(
  fact: KnowledgeCompletenessRequiredFact,
  evidence: EvidenceIndex,
): KnowledgeCompletenessFactResult {
  const terms = fact.terms ?? [];
  const sourceRefs = fact.sourceRefs ?? [];
  const matchedTerms = terms.filter((term) => evidenceTextIncludes(evidence, term));
  const missingTerms = terms.filter((term) => !matchedTerms.includes(term));
  const matchedSourceRefs = sourceRefs.filter((ref) => sourceValueAppears({ type: 'ref', value: ref }, evidence));
  const missingSourceRefs = sourceRefs.filter((ref) => !matchedSourceRefs.includes(ref));

  return {
    id: fact.id,
    description: fact.description,
    weight: fact.weight ?? 1,
    passed: missingTerms.length === 0 && missingSourceRefs.length === 0,
    matchedTerms,
    missingTerms,
    matchedSourceRefs,
    missingSourceRefs,
  };
}

function evaluateSource(
  source: KnowledgeCompletenessRequiredSource,
  evidence: EvidenceIndex,
): KnowledgeCompletenessSourceResult {
  return {
    ...source,
    passed: sourceValueAppears(source, evidence),
    directEvidence: sourceValueAppears(source, evidence, true),
  };
}

function evaluateForbiddenHits(
  forbiddenItems: KnowledgeCompletenessForbiddenItem[],
  evidence: EvidenceIndex,
): KnowledgeCompletenessForbiddenHit[] {
  const hits: KnowledgeCompletenessForbiddenHit[] = [];

  for (const { section, item } of evidence.items) {
    for (const forbidden of forbiddenItems) {
      if (!itemMatchesForbidden(item, forbidden, evidence)) {
        continue;
      }

      hits.push({
        knowledgeId: evidence.evalIndex?.byStoreId.get(item.knowledgeId) ?? item.knowledgeId,
        title: item.title,
        section,
        forbiddenType: forbidden.type,
        value: forbidden.value,
      });
    }
  }

  return hits;
}

function sourceValueAppears(
  source: KnowledgeCompletenessRequiredSource,
  evidence: EvidenceIndex,
  directOnly = false,
): boolean {
  if (!directOnly) {
    if (source.type === 'knowledge') {
      return evidence.items.some(({ item }) => knowledgeIdMatches(item.knowledgeId, source.value, evidence));
    }

    if (source.type !== 'label' && evidenceTextIncludes(evidence, source.value)) {
      return true;
    }
  }

  return evidence.items.some(({ item }) => {
    if (directOnly && item.evidenceCategory !== 'directTaskEvidence') {
      return false;
    }

    switch (source.type) {
      case 'knowledge':
        return knowledgeIdMatches(item.knowledgeId, source.value, evidence);
      case 'file':
        return labelMatches(item.labels, 'file', source.value)
          || referenceMatches(item.references, source.value)
          || itemTextIncludes(item, source.value);
      case 'symbol':
        return labelMatches(item.labels, 'symbol', source.value)
          || itemTextIncludes(item, source.value);
      case 'label':
        return labelMatches(item.labels, source.labelType, source.value);
      case 'ref':
        return referenceMatches(item.references, source.value)
          || itemTextIncludes(item, source.value);
    }
  });
}

function itemMatchesForbidden(
  item: RankedCandidate,
  forbidden: KnowledgeCompletenessForbiddenItem,
  evidence: EvidenceIndex,
): boolean {
  switch (forbidden.type) {
    case 'id':
      return knowledgeIdMatches(item.knowledgeId, forbidden.value, evidence);
    case 'title':
      return containsLoose(item.title, forbidden.value);
    case 'label':
      return labelMatches(item.labels, forbidden.labelType, forbidden.value);
    case 'ref':
      return referenceMatches(item.references, forbidden.value);
    case 'any':
      return knowledgeIdMatches(item.knowledgeId, forbidden.value, evidence)
        || containsLoose(item.title, forbidden.value)
        || labelMatches(item.labels, forbidden.labelType, forbidden.value)
        || referenceMatches(item.references, forbidden.value)
        || itemTextIncludes(item, forbidden.value);
  }
}

function knowledgeIdMatches(storeId: string, expected: string, evidence: EvidenceIndex): boolean {
  const mappedStoreId = evidence.evalIndex?.byEvalId.get(expected);
  return storeId === expected
    || mappedStoreId === storeId
    || evidence.evalIndex?.byStoreId.get(storeId) === expected;
}

function labelMatches(labels: LabelInput[], labelType: LabelType | undefined, expected: string): boolean {
  const expectedNormalized = normalizeLabel(expected);
  return labels.some((label) => {
    if (labelType && label.type !== labelType) {
      return false;
    }
    return normalizeLabel(label.value) === expectedNormalized
      || normalizeLabel(`${label.type}:${label.value}`) === expectedNormalized;
  });
}

function referenceMatches(references: ReferenceInput[], expected: string): boolean {
  return references.some((reference) => containsLoose(reference.uri, expected));
}

function itemTextIncludes(item: RankedCandidate, expected: string): boolean {
  return containsLoose([
    item.title,
    item.summary,
    item.content,
    item.contextualContent,
    item.usefulnessReason ?? '',
    ...item.matchReasons,
    ...(item.fitReasons ?? []),
  ].join(' '), expected);
}

function evidenceTextIncludes(evidence: EvidenceIndex, expected: string): boolean {
  return containsLoose(evidence.text, expected)
    || evidence.normalizedText.includes(normalizeLabel(expected));
}

function containsLoose(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
    || normalizeEvidence(haystack).includes(normalizeLabel(needle));
}

function normalizeEvidence(value: string): string {
  return normalizeLabel(value.replace(/\s+/g, ' '));
}

function labelsText(labels: LabelInput[]): string {
  return labels.map((label) => `${label.type}:${label.value}:${label.weight ?? ''}`).join(' ');
}

function referencesText(references: ReferenceInput[]): string {
  return references.map((reference) => `${reference.type}:${reference.uri}`).join(' ');
}

function caseAppliesToMode(testCase: KnowledgeCompletenessCase, mode: KnowledgeCompletenessMode): boolean {
  return !testCase.modes?.length || testCase.modes.includes(mode);
}

function buildMetrics(cases: KnowledgeCompletenessCaseResult[]): KnowledgeCompletenessMetrics {
  return {
    passRate: average(cases.map((testCase) => (testCase.passed ? 1 : 0))),
    averageCompleteness: average(cases.map((testCase) => testCase.completeness)),
    averageSourceCoverage: average(cases.map((testCase) => testCase.sourceCoverage)),
    averageNoiseRate: average(cases.map((testCase) => testCase.noiseRate)),
    averageDirectEvidencePlacement: average(cases.map((testCase) => testCase.directEvidencePlacement)),
    averageKnowledgeGainScore: average(cases.map((testCase) => testCase.knowledgeGainScore)),
  };
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return roundRate(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundRate(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptyIndex(): SeededKnowledgeIndex {
  return { byEvalId: new Map(), byStoreId: new Map() };
}
