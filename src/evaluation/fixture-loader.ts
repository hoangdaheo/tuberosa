import { readFile } from 'node:fs/promises';
import type { LabelType } from '../types.js';
import type {
  RetrievalEvalCase,
  RetrievalEvalClassificationExpectation,
  RetrievalEvalExpectedKnowledgeGap,
  RetrievalEvalFeedbackEvent,
  RetrievalEvalAtom,
  RetrievalEvalFixture,
  RetrievalEvalKnowledge,
  RetrievalEvalRelation,
} from './retrieval-evaluator.js';
import type {
  ContextMappingCase,
  ContextMappingExpectedEntities,
  ContextMappingFeedbackEvent,
  ContextMappingFixture,
  ContextMappingKnowledge,
  ContextMappingRelation,
  ContextMappingTaxon,
} from './context-mapping-evaluator.js';
import type {
  KnowledgeCompletenessCase,
  KnowledgeCompletenessFixture,
  KnowledgeCompletenessForbiddenItem,
  KnowledgeCompletenessMode,
  KnowledgeCompletenessRequiredFact,
  KnowledgeCompletenessRequiredSource,
} from './knowledge-completeness-evaluator.js';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, path);
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${path} must be a number.`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean.`);
  }
  return value;
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  return expectArray(value, path).map((item, index) => expectString(item, `${path}[${index}]`));
}

function optionalPositiveNumber(value: unknown, path: string): number | undefined {
  const parsed = optionalNumber(value, path);
  if (parsed !== undefined && parsed <= 0) {
    throw new Error(`${path} must be greater than 0.`);
  }
  return parsed;
}

function optionalRate(value: unknown, path: string): number | undefined {
  const parsed = optionalNumber(value, path);
  if (parsed !== undefined && (parsed < 0 || parsed > 1)) {
    throw new Error(`${path} must be between 0 and 1.`);
  }
  return parsed;
}

function optionalScore(value: unknown, path: string): number | undefined {
  const parsed = optionalNumber(value, path);
  if (parsed !== undefined && (parsed < 0 || parsed > 100)) {
    throw new Error(`${path} must be between 0 and 100.`);
  }
  return parsed;
}

function ensureUnique(values: string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${path} contains duplicate value: ${value}`);
    }
    seen.add(value);
  }
}

// ---------------------------------------------------------------------------
// Retrieval eval fixture
// ---------------------------------------------------------------------------

export async function loadRetrievalEvalFixture(filePath: string): Promise<RetrievalEvalFixture> {
  return parseRetrievalEvalFixture(await readJsonFile(filePath), filePath);
}

export function parseRetrievalEvalFixture(value: unknown, source = 'retrieval eval fixture'): RetrievalEvalFixture {
  const fixture = expectRecord(value, source);
  const name = expectString(fixture.name, `${source}.name`);
  const project = expectString(fixture.project, `${source}.project`);
  const knowledge = expectArray(fixture.knowledge, `${source}.knowledge`).map((item, index) => (
    parseRetrievalKnowledge(item, `${source}.knowledge[${index}]`)
  ));
  const feedbackEvents = fixture.feedbackEvents === undefined
    ? undefined
    : expectArray(fixture.feedbackEvents, `${source}.feedbackEvents`).map((item, index) => (
      parseRetrievalFeedbackEvent(item, `${source}.feedbackEvents[${index}]`)
    ));
  const relations = fixture.relations === undefined
    ? undefined
    : expectArray(fixture.relations, `${source}.relations`).map((item, index) => (
      parseRetrievalRelation(item, `${source}.relations[${index}]`)
    ));
  const atoms = fixture.atoms === undefined
    ? undefined
    : expectArray(fixture.atoms, `${source}.atoms`).map((item, index) => (
      parseAtom(item, `${source}.atoms[${index}]`)
    ));
  const cases = expectArray(fixture.cases, `${source}.cases`).map((item, index) => (
    parseRetrievalCase(item, `${source}.cases[${index}]`)
  ));

  ensureUnique(knowledge.map((item) => item.evalId), `${source}.knowledge[].evalId`);
  ensureUnique(cases.map((item) => item.id), `${source}.cases[].id`);

  return { name, project, knowledge, atoms, feedbackEvents, relations, cases };
}

function parseRetrievalKnowledge(value: unknown, path: string): RetrievalEvalKnowledge {
  const item = expectRecord(value, path);
  return {
    evalId: expectString(item.evalId, `${path}.evalId`),
    project: optionalString(item.project, `${path}.project`),
    sourceType: expectString(item.sourceType, `${path}.sourceType`),
    sourceUri: expectString(item.sourceUri, `${path}.sourceUri`),
    sourceTitle: optionalString(item.sourceTitle, `${path}.sourceTitle`),
    itemType: expectString(item.itemType, `${path}.itemType`) as RetrievalEvalKnowledge['itemType'],
    title: expectString(item.title, `${path}.title`),
    summary: optionalString(item.summary, `${path}.summary`),
    content: expectString(item.content, `${path}.content`),
    trustLevel: optionalNumber(item.trustLevel, `${path}.trustLevel`),
    labels: item.labels as RetrievalEvalKnowledge['labels'],
    references: item.references as RetrievalEvalKnowledge['references'],
    metadata: item.metadata as RetrievalEvalKnowledge['metadata'],
    freshnessAt: optionalString(item.freshnessAt, `${path}.freshnessAt`),
    status: optionalString(item.status, `${path}.status`) as RetrievalEvalKnowledge['status'],
  };
}

function parseAtom(value: unknown, path: string): RetrievalEvalAtom {
  const item = expectRecord(value, path);
  return {
    evalId: expectString(item.evalId, `${path}.evalId`),
    project: optionalString(item.project, `${path}.project`),
    claim: expectString(item.claim, `${path}.claim`),
    type: expectString(item.type, `${path}.type`) as RetrievalEvalAtom['type'],
    evidence: item.evidence as RetrievalEvalAtom['evidence'],
    trigger: item.trigger as RetrievalEvalAtom['trigger'],
    verification: item.verification as RetrievalEvalAtom['verification'],
    producedBy: optionalString(item.producedBy, `${path}.producedBy`) as RetrievalEvalAtom['producedBy'],
    tier: optionalString(item.tier, `${path}.tier`) as RetrievalEvalAtom['tier'],
    reuseCount: optionalNumber(item.reuseCount, `${path}.reuseCount`),
    lastReusedAt: optionalString(item.lastReusedAt, `${path}.lastReusedAt`),
    status: optionalString(item.status, `${path}.status`) as RetrievalEvalAtom['status'],
    scope: optionalString(item.scope, `${path}.scope`) as RetrievalEvalAtom['scope'],
    teamId: optionalString(item.teamId, `${path}.teamId`),
  };
}

function parseRetrievalCase(value: unknown, path: string): RetrievalEvalCase {
  const item = expectRecord(value, path);
  return {
    id: expectString(item.id, `${path}.id`),
    prompt: expectString(item.prompt, `${path}.prompt`),
    project: optionalString(item.project, `${path}.project`),
    taskType: optionalString(item.taskType, `${path}.taskType`) as RetrievalEvalCase['taskType'],
    files: optionalStringArray(item.files, `${path}.files`),
    symbols: optionalStringArray(item.symbols, `${path}.symbols`),
    errors: optionalStringArray(item.errors, `${path}.errors`),
    noiseTolerance: optionalString(item.noiseTolerance, `${path}.noiseTolerance`) as RetrievalEvalCase['noiseTolerance'],
    tokenBudget: optionalNumber(item.tokenBudget, `${path}.tokenBudget`),
    expectedKnowledgeIds: optionalStringArray(item.expectedKnowledgeIds, `${path}.expectedKnowledgeIds`),
    expectedSelectedKnowledgeIds: optionalStringArray(
      item.expectedSelectedKnowledgeIds,
      `${path}.expectedSelectedKnowledgeIds`,
    ),
    unexpectedKnowledgeIds: optionalStringArray(item.unexpectedKnowledgeIds, `${path}.unexpectedKnowledgeIds`),
    rejectedKnowledgeIds: optionalStringArray(item.rejectedKnowledgeIds, `${path}.rejectedKnowledgeIds`),
    minConfidence: optionalNumber(item.minConfidence, `${path}.minConfidence`),
    expectedContextFitStatus: optionalString(
      item.expectedContextFitStatus,
      `${path}.expectedContextFitStatus`,
    ) as RetrievalEvalCase['expectedContextFitStatus'],
    minContextFitScore: optionalNumber(item.minContextFitScore, `${path}.minContextFitScore`),
    expectedClassification: parseExpectedClassification(
      item.expectedClassification,
      `${path}.expectedClassification`,
    ),
  };
}

function parseRetrievalFeedbackEvent(value: unknown, path: string): RetrievalEvalFeedbackEvent {
  const item = expectRecord(value, path);
  return {
    feedbackType: expectString(item.feedbackType, `${path}.feedbackType`) as RetrievalEvalFeedbackEvent['feedbackType'],
    prompt: optionalString(item.prompt, `${path}.prompt`),
    project: optionalString(item.project, `${path}.project`),
    knowledgeIds: optionalStringArray(item.knowledgeIds, `${path}.knowledgeIds`),
    reason: optionalString(item.reason, `${path}.reason`),
    metadata: item.metadata as RetrievalEvalFeedbackEvent['metadata'],
    expectedKnowledgeGap: parseExpectedKnowledgeGap(
      item.expectedKnowledgeGap,
      `${path}.expectedKnowledgeGap`,
    ),
  };
}

function parseExpectedKnowledgeGap(
  value: unknown,
  path: string,
): RetrievalEvalExpectedKnowledgeGap | undefined {
  if (value === undefined) return undefined;
  const item = expectRecord(value, path);
  return {
    status: optionalString(item.status, `${path}.status`) as RetrievalEvalExpectedKnowledgeGap['status'],
    promptIncludes: optionalString(item.promptIncludes, `${path}.promptIncludes`),
    reasonIncludes: optionalString(item.reasonIncludes, `${path}.reasonIncludes`),
    missingSignals: optionalStringArray(item.missingSignals, `${path}.missingSignals`),
    contextPackIdRequired: optionalBoolean(item.contextPackIdRequired, `${path}.contextPackIdRequired`),
  };
}

function parseRetrievalRelation(value: unknown, path: string): RetrievalEvalRelation {
  const item = expectRecord(value, path);
  return {
    fromEvalId: expectString(item.fromEvalId, `${path}.fromEvalId`),
    relationType: expectString(item.relationType, `${path}.relationType`),
    targetKind: expectString(item.targetKind, `${path}.targetKind`) as 'knowledge',
    toEvalId: expectString(item.toEvalId, `${path}.toEvalId`),
    confidence: optionalNumber(item.confidence, `${path}.confidence`),
    inferred: item.inferred === undefined ? undefined : Boolean(item.inferred),
  };
}

function parseExpectedClassification(
  value: unknown,
  path: string,
): RetrievalEvalClassificationExpectation | undefined {
  if (value === undefined) return undefined;
  const item = expectRecord(value, path);
  return {
    files: optionalStringArray(item.files, `${path}.files`),
    symbols: optionalStringArray(item.symbols, `${path}.symbols`),
    errors: optionalStringArray(item.errors, `${path}.errors`),
    technologies: optionalStringArray(item.technologies, `${path}.technologies`),
    businessAreas: optionalStringArray(item.businessAreas, `${path}.businessAreas`),
    taskType: optionalString(item.taskType, `${path}.taskType`) as RetrievalEvalClassificationExpectation['taskType'],
  };
}

// ---------------------------------------------------------------------------
// Context-mapping fixture
// ---------------------------------------------------------------------------

const VALID_TAXONS: readonly ContextMappingTaxon[] = [
  'nl_to_code',
  'code_to_code',
  'text_to_text_doc',
  'hybrid',
];

export async function loadContextMappingFixture(filePath: string): Promise<ContextMappingFixture> {
  return parseContextMappingFixture(await readJsonFile(filePath), filePath);
}

export function parseContextMappingFixture(
  value: unknown,
  source = 'context-mapping fixture',
): ContextMappingFixture {
  const fixture = expectRecord(value, source);
  const name = expectString(fixture.name, `${source}.name`);
  const project = expectString(fixture.project, `${source}.project`);
  const knowledge = expectArray(fixture.knowledge, `${source}.knowledge`).map((item, index) => (
    parseContextMappingKnowledge(item, `${source}.knowledge[${index}]`)
  ));
  const distractors = fixture.distractors === undefined
    ? undefined
    : expectArray(fixture.distractors, `${source}.distractors`).map((item, index) => (
      parseContextMappingKnowledge(item, `${source}.distractors[${index}]`)
    ));
  const feedbackEvents = fixture.feedbackEvents === undefined
    ? undefined
    : expectArray(fixture.feedbackEvents, `${source}.feedbackEvents`).map((item, index) => (
      parseContextMappingFeedbackEvent(item, `${source}.feedbackEvents[${index}]`)
    ));
  const relations = fixture.relations === undefined
    ? undefined
    : expectArray(fixture.relations, `${source}.relations`).map((item, index) => (
      parseContextMappingRelation(item, `${source}.relations[${index}]`)
    ));
  const cases = expectArray(fixture.cases, `${source}.cases`).map((item, index) => (
    parseContextMappingCase(item, `${source}.cases[${index}]`)
  ));

  ensureUnique(knowledge.map((item) => item.evalId), `${source}.knowledge[].evalId`);
  if (distractors) {
    ensureUnique(distractors.map((item) => item.evalId), `${source}.distractors[].evalId`);
  }
  ensureUnique(cases.map((item) => item.id), `${source}.cases[].id`);

  return { name, project, knowledge, distractors, feedbackEvents, relations, cases };
}

function parseContextMappingKnowledge(value: unknown, path: string): ContextMappingKnowledge {
  const item = expectRecord(value, path);
  return {
    evalId: expectString(item.evalId, `${path}.evalId`),
    project: optionalString(item.project, `${path}.project`),
    sourceType: expectString(item.sourceType, `${path}.sourceType`),
    sourceUri: expectString(item.sourceUri, `${path}.sourceUri`),
    sourceTitle: optionalString(item.sourceTitle, `${path}.sourceTitle`),
    itemType: expectString(item.itemType, `${path}.itemType`) as ContextMappingKnowledge['itemType'],
    title: expectString(item.title, `${path}.title`),
    summary: optionalString(item.summary, `${path}.summary`),
    content: expectString(item.content, `${path}.content`),
    trustLevel: optionalNumber(item.trustLevel, `${path}.trustLevel`),
    labels: item.labels as ContextMappingKnowledge['labels'],
    references: item.references as ContextMappingKnowledge['references'],
    metadata: item.metadata as ContextMappingKnowledge['metadata'],
    freshnessAt: optionalString(item.freshnessAt, `${path}.freshnessAt`),
  };
}

function parseContextMappingFeedbackEvent(value: unknown, path: string): ContextMappingFeedbackEvent {
  const item = expectRecord(value, path);
  return {
    feedbackType: expectString(item.feedbackType, `${path}.feedbackType`) as ContextMappingFeedbackEvent['feedbackType'],
    prompt: optionalString(item.prompt, `${path}.prompt`),
    project: optionalString(item.project, `${path}.project`),
    knowledgeIds: optionalStringArray(item.knowledgeIds, `${path}.knowledgeIds`),
    reason: optionalString(item.reason, `${path}.reason`),
    metadata: item.metadata as ContextMappingFeedbackEvent['metadata'],
  };
}

function parseContextMappingRelation(value: unknown, path: string): ContextMappingRelation {
  const item = expectRecord(value, path);
  return {
    fromEvalId: expectString(item.fromEvalId, `${path}.fromEvalId`),
    relationType: expectString(item.relationType, `${path}.relationType`),
    targetKind: expectString(item.targetKind, `${path}.targetKind`) as 'knowledge',
    toEvalId: expectString(item.toEvalId, `${path}.toEvalId`),
    confidence: optionalNumber(item.confidence, `${path}.confidence`),
    inferred: item.inferred === undefined ? undefined : Boolean(item.inferred),
  };
}

function parseContextMappingCase(value: unknown, path: string): ContextMappingCase {
  const item = expectRecord(value, path);
  const taxonRaw = expectString(item.taxon, `${path}.taxon`);
  if (!VALID_TAXONS.includes(taxonRaw as ContextMappingTaxon)) {
    throw new Error(`${path}.taxon must be one of: ${VALID_TAXONS.join(', ')} (got "${taxonRaw}").`);
  }
  return {
    id: expectString(item.id, `${path}.id`),
    prompt: expectString(item.prompt, `${path}.prompt`),
    taxon: taxonRaw as ContextMappingTaxon,
    project: optionalString(item.project, `${path}.project`),
    taskType: optionalString(item.taskType, `${path}.taskType`) as ContextMappingCase['taskType'],
    files: optionalStringArray(item.files, `${path}.files`),
    symbols: optionalStringArray(item.symbols, `${path}.symbols`),
    errors: optionalStringArray(item.errors, `${path}.errors`),
    tokenBudget: optionalNumber(item.tokenBudget, `${path}.tokenBudget`),
    expectedRelevantKnowledgeIds: optionalStringArray(item.expectedRelevantKnowledgeIds, `${path}.expectedRelevantKnowledgeIds`),
    directEvidenceKnowledgeIds: optionalStringArray(item.directEvidenceKnowledgeIds, `${path}.directEvidenceKnowledgeIds`),
    adjacentEvidenceKnowledgeIds: optionalStringArray(item.adjacentEvidenceKnowledgeIds, `${path}.adjacentEvidenceKnowledgeIds`),
    forbiddenKnowledgeIds: optionalStringArray(item.forbiddenKnowledgeIds, `${path}.forbiddenKnowledgeIds`),
    noiseDistractorIds: optionalStringArray(item.noiseDistractorIds, `${path}.noiseDistractorIds`),
    expectedEntities: parseContextMappingExpectedEntities(item.expectedEntities, `${path}.expectedEntities`),
    expectedFitStatus: optionalString(item.expectedFitStatus, `${path}.expectedFitStatus`) as ContextMappingCase['expectedFitStatus'],
  };
}

function parseContextMappingExpectedEntities(value: unknown, path: string): ContextMappingExpectedEntities | undefined {
  if (value === undefined) return undefined;
  const item = expectRecord(value, path);
  return {
    files: optionalStringArray(item.files, `${path}.files`),
    symbols: optionalStringArray(item.symbols, `${path}.symbols`),
  };
}

// ---------------------------------------------------------------------------
// Knowledge-completeness fixture
// ---------------------------------------------------------------------------

export async function loadKnowledgeCompletenessFixture(filePath: string): Promise<KnowledgeCompletenessFixture> {
  return parseKnowledgeCompletenessFixture(await readJsonFile(filePath), filePath);
}

export function parseKnowledgeCompletenessFixture(
  value: unknown,
  source = 'knowledge completeness fixture',
): KnowledgeCompletenessFixture {
  const fixture = expectRecord(value, source);
  const name = expectString(fixture.name, `${source}.name`);
  const project = expectString(fixture.project, `${source}.project`);
  const knowledge = fixture.knowledge === undefined
    ? undefined
    : expectArray(fixture.knowledge, `${source}.knowledge`).map((item, index) => (
      parseCompletenessKnowledge(item, `${source}.knowledge[${index}]`)
    ));
  const cases = expectArray(fixture.cases, `${source}.cases`).map((item, index) => (
    parseCompletenessCase(item, `${source}.cases[${index}]`)
  ));

  if (knowledge) {
    ensureUnique(knowledge.map((item) => item.evalId), `${source}.knowledge[].evalId`);
  }
  ensureUnique(cases.map((item) => item.id), `${source}.cases[].id`);

  return { name, project, knowledge, cases };
}

function parseCompletenessKnowledge(value: unknown, path: string): RetrievalEvalKnowledge {
  const item = expectRecord(value, path);
  return {
    evalId: expectString(item.evalId, `${path}.evalId`),
    project: optionalString(item.project, `${path}.project`),
    sourceType: expectString(item.sourceType, `${path}.sourceType`),
    sourceUri: expectString(item.sourceUri, `${path}.sourceUri`),
    sourceTitle: optionalString(item.sourceTitle, `${path}.sourceTitle`),
    itemType: expectString(item.itemType, `${path}.itemType`) as RetrievalEvalKnowledge['itemType'],
    title: expectString(item.title, `${path}.title`),
    summary: optionalString(item.summary, `${path}.summary`),
    content: expectString(item.content, `${path}.content`),
    trustLevel: optionalNumber(item.trustLevel, `${path}.trustLevel`),
    labels: item.labels as RetrievalEvalKnowledge['labels'],
    references: item.references as RetrievalEvalKnowledge['references'],
    metadata: item.metadata as RetrievalEvalKnowledge['metadata'],
    freshnessAt: optionalString(item.freshnessAt, `${path}.freshnessAt`),
  };
}

function parseCompletenessCase(value: unknown, path: string): KnowledgeCompletenessCase {
  const item = expectRecord(value, path);
  const requiredFacts = expectArray(item.requiredFacts, `${path}.requiredFacts`).map((fact, index) => (
    parseRequiredFact(fact, `${path}.requiredFacts[${index}]`)
  ));
  const requiredSources = item.requiredSources === undefined
    ? undefined
    : expectArray(item.requiredSources, `${path}.requiredSources`).map((source, index) => (
      parseRequiredSource(source, `${path}.requiredSources[${index}]`)
    ));
  const forbiddenItems = item.forbiddenItems === undefined
    ? undefined
    : expectArray(item.forbiddenItems, `${path}.forbiddenItems`).map((forbidden, index) => (
      parseForbiddenItem(forbidden, `${path}.forbiddenItems[${index}]`)
    ));

  if (requiredFacts.length === 0 && (!requiredSources || requiredSources.length === 0)) {
    throw new Error(`${path} must define requiredFacts or requiredSources.`);
  }

  return {
    id: expectString(item.id, `${path}.id`),
    prompt: expectString(item.prompt, `${path}.prompt`),
    project: optionalString(item.project, `${path}.project`),
    taskType: optionalString(item.taskType, `${path}.taskType`) as KnowledgeCompletenessCase['taskType'],
    files: optionalStringArray(item.files, `${path}.files`),
    symbols: optionalStringArray(item.symbols, `${path}.symbols`),
    errors: optionalStringArray(item.errors, `${path}.errors`),
    tokenBudget: optionalNumber(item.tokenBudget, `${path}.tokenBudget`),
    modes: parseCompletenessModes(item.modes, `${path}.modes`),
    requiredFacts,
    requiredSources,
    forbiddenItems,
    minCompleteness: optionalRate(item.minCompleteness, `${path}.minCompleteness`),
    minSourceCoverage: optionalRate(item.minSourceCoverage, `${path}.minSourceCoverage`),
    maxNoiseRate: optionalRate(item.maxNoiseRate, `${path}.maxNoiseRate`),
    minKnowledgeGainScore: optionalScore(item.minKnowledgeGainScore, `${path}.minKnowledgeGainScore`),
  };
}

function parseRequiredFact(value: unknown, path: string): KnowledgeCompletenessRequiredFact {
  const item = expectRecord(value, path);
  const terms = optionalStringArray(item.terms, `${path}.terms`);
  const sourceRefs = optionalStringArray(item.sourceRefs, `${path}.sourceRefs`);

  if ((!terms || terms.length === 0) && (!sourceRefs || sourceRefs.length === 0)) {
    throw new Error(`${path} must define terms or sourceRefs.`);
  }

  return {
    id: expectString(item.id, `${path}.id`),
    description: optionalString(item.description, `${path}.description`),
    weight: optionalPositiveNumber(item.weight, `${path}.weight`),
    terms,
    sourceRefs,
  };
}

function parseRequiredSource(value: unknown, path: string): KnowledgeCompletenessRequiredSource {
  const item = expectRecord(value, path);
  return {
    type: expectRequiredSourceType(item.type, `${path}.type`),
    value: expectString(item.value, `${path}.value`),
    labelType: optionalString(item.labelType, `${path}.labelType`) as LabelType | undefined,
  };
}

function parseForbiddenItem(value: unknown, path: string): KnowledgeCompletenessForbiddenItem {
  const item = expectRecord(value, path);
  return {
    type: expectForbiddenItemType(item.type, `${path}.type`),
    value: expectString(item.value, `${path}.value`),
    labelType: optionalString(item.labelType, `${path}.labelType`) as LabelType | undefined,
  };
}

function parseCompletenessModes(value: unknown, path: string): KnowledgeCompletenessMode[] | undefined {
  if (value === undefined) return undefined;
  return expectArray(value, path).map((mode, index) => {
    const parsed = expectString(mode, `${path}[${index}]`);
    if (parsed !== 'fixture' && parsed !== 'live') {
      throw new Error(`${path}[${index}] must be "fixture" or "live".`);
    }
    return parsed;
  });
}

function expectRequiredSourceType(value: unknown, path: string): KnowledgeCompletenessRequiredSource['type'] {
  const parsed = expectString(value, path);
  if (!['file', 'symbol', 'label', 'knowledge', 'ref'].includes(parsed)) {
    throw new Error(`${path} must be file, symbol, label, knowledge, or ref.`);
  }
  return parsed as KnowledgeCompletenessRequiredSource['type'];
}

function expectForbiddenItemType(value: unknown, path: string): KnowledgeCompletenessForbiddenItem['type'] {
  const parsed = expectString(value, path);
  if (!['title', 'id', 'label', 'ref', 'any'].includes(parsed)) {
    throw new Error(`${path} must be title, id, label, ref, or any.`);
  }
  return parsed as KnowledgeCompletenessForbiddenItem['type'];
}
