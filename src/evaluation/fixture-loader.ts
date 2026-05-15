import { readFile } from 'node:fs/promises';
import type {
  RetrievalEvalCase,
  RetrievalEvalClassificationExpectation,
  RetrievalEvalFixture,
  RetrievalEvalKnowledge,
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
  const cases = expectArray(fixture.cases, `${source}.cases`).map((item, index) => (
    parseCase(item, `${source}.cases[${index}]`)
  ));

  ensureUnique(knowledge.map((item) => item.evalId), `${source}.knowledge[].evalId`);
  ensureUnique(cases.map((item) => item.id), `${source}.cases[].id`);

  return { name, project, knowledge, cases };
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
    unexpectedKnowledgeIds: optionalStringArray(item.unexpectedKnowledgeIds, `${path}.unexpectedKnowledgeIds`),
    rejectedKnowledgeIds: optionalStringArray(item.rejectedKnowledgeIds, `${path}.rejectedKnowledgeIds`),
    expectedClassification: parseExpectedClassification(
      item.expectedClassification,
      `${path}.expectedClassification`,
    ),
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
