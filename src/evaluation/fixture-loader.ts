import { readFile } from 'node:fs/promises';
import type {
  RetrievalEvalCase,
  RetrievalEvalClassificationExpectation,
  RetrievalEvalExpectedKnowledgeGap,
  RetrievalEvalFeedbackEvent,
  RetrievalEvalFixture,
  RetrievalEvalKnowledge,
  RetrievalEvalRelation,
} from './retrieval-evaluator.js';

export async function loadRetrievalEvalFixture(filePath: string): Promise<RetrievalEvalFixture> {
  const raw = await readFile(filePath, 'utf8');
  return parseRetrievalEvalFixture(JSON.parse(raw), filePath);
}

export function parseRetrievalEvalFixture(value: unknown, source = 'retrieval eval fixture'): RetrievalEvalFixture {
  const fixture = expectRecord(value, source);
  const name = expectString(fixture.name, `${source}.name`);
  const project = expectString(fixture.project, `${source}.project`);
  const knowledge = expectArray(fixture.knowledge, `${source}.knowledge`).map((item, index) => (
    parseKnowledge(item, `${source}.knowledge[${index}]`)
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
  ensureUnique(cases.map((item) => item.id), `${source}.cases[].id`);

  return { name, project, knowledge, feedbackEvents, relations, cases };
}

function parseKnowledge(value: unknown, path: string): RetrievalEvalKnowledge {
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

function parseCase(value: unknown, path: string): RetrievalEvalCase {
  const item = expectRecord(value, path);

  return {
    id: expectString(item.id, `${path}.id`),
    prompt: expectString(item.prompt, `${path}.prompt`),
    project: optionalString(item.project, `${path}.project`),
    taskType: optionalString(item.taskType, `${path}.taskType`) as RetrievalEvalCase['taskType'],
    files: optionalStringArray(item.files, `${path}.files`),
    symbols: optionalStringArray(item.symbols, `${path}.symbols`),
    errors: optionalStringArray(item.errors, `${path}.errors`),
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

function parseFeedbackEvent(value: unknown, path: string): RetrievalEvalFeedbackEvent {
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
  if (value === undefined) {
    return undefined;
  }

  const item = expectRecord(value, path);
  return {
    status: optionalString(item.status, `${path}.status`) as RetrievalEvalExpectedKnowledgeGap['status'],
    promptIncludes: optionalString(item.promptIncludes, `${path}.promptIncludes`),
    reasonIncludes: optionalString(item.reasonIncludes, `${path}.reasonIncludes`),
    missingSignals: optionalStringArray(item.missingSignals, `${path}.missingSignals`),
    contextPackIdRequired: optionalBoolean(item.contextPackIdRequired, `${path}.contextPackIdRequired`),
  };
}

function parseRelation(value: unknown, path: string): RetrievalEvalRelation {
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
  if (value === undefined) {
    return undefined;
  }

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
  if (value === undefined) {
    return undefined;
  }

  return expectString(value, path);
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${path} must be a number.`);
  }

  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean.`);
  }

  return value;
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

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
