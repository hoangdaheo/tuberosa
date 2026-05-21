import { readFile } from 'node:fs/promises';
import type {
  ContextMappingCase,
  ContextMappingExpectedEntities,
  ContextMappingFeedbackEvent,
  ContextMappingFixture,
  ContextMappingKnowledge,
  ContextMappingRelation,
  ContextMappingTaxon,
} from './context-mapping-evaluator.js';

const VALID_TAXONS: readonly ContextMappingTaxon[] = [
  'nl_to_code',
  'code_to_code',
  'text_to_text_doc',
  'hybrid',
];

export async function loadContextMappingFixture(filePath: string): Promise<ContextMappingFixture> {
  const raw = await readFile(filePath, 'utf8');
  return parseContextMappingFixture(JSON.parse(raw), filePath);
}

export function parseContextMappingFixture(
  value: unknown,
  source = 'context-mapping fixture',
): ContextMappingFixture {
  const fixture = expectRecord(value, source);
  const name = expectString(fixture.name, `${source}.name`);
  const project = expectString(fixture.project, `${source}.project`);
  const knowledge = expectArray(fixture.knowledge, `${source}.knowledge`).map((item, index) => (
    parseKnowledge(item, `${source}.knowledge[${index}]`)
  ));
  const distractors = fixture.distractors === undefined
    ? undefined
    : expectArray(fixture.distractors, `${source}.distractors`).map((item, index) => (
      parseKnowledge(item, `${source}.distractors[${index}]`)
    ));
  const feedbackEvents = fixture.feedbackEvents === undefined
    ? undefined
    : expectArray(fixture.feedbackEvents, `${source}.feedbackEvents`).map((item, index) => (
      parseFeedbackEvent(item, `${source}.feedbackEvents[${index}]`)
    ));
  const relations = fixture.relations === undefined
    ? undefined
    : expectArray(fixture.relations, `${source}.relations`).map((item, index) => (
      parseRelation(item, `${source}.relations[${index}]`)
    ));
  const cases = expectArray(fixture.cases, `${source}.cases`).map((item, index) => (
    parseCase(item, `${source}.cases[${index}]`)
  ));

  ensureUnique(knowledge.map((item) => item.evalId), `${source}.knowledge[].evalId`);
  if (distractors) {
    ensureUnique(distractors.map((item) => item.evalId), `${source}.distractors[].evalId`);
  }
  ensureUnique(cases.map((item) => item.id), `${source}.cases[].id`);

  return { name, project, knowledge, distractors, feedbackEvents, relations, cases };
}

function parseKnowledge(value: unknown, path: string): ContextMappingKnowledge {
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

function parseFeedbackEvent(value: unknown, path: string): ContextMappingFeedbackEvent {
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

function parseRelation(value: unknown, path: string): ContextMappingRelation {
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

function parseCase(value: unknown, path: string): ContextMappingCase {
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
    expectedEntities: parseExpectedEntities(item.expectedEntities, `${path}.expectedEntities`),
    expectedFitStatus: optionalString(item.expectedFitStatus, `${path}.expectedFitStatus`) as ContextMappingCase['expectedFitStatus'],
  };
}

function parseExpectedEntities(value: unknown, path: string): ContextMappingExpectedEntities | undefined {
  if (value === undefined) return undefined;
  const item = expectRecord(value, path);
  return {
    files: optionalStringArray(item.files, `${path}.files`),
    symbols: optionalStringArray(item.symbols, `${path}.symbols`),
  };
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

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  return expectArray(value, path).map((item, index) => expectString(item, `${path}[${index}]`));
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
