import { readFile } from 'node:fs/promises';
import type { LabelType } from '../types.js';
import type { RetrievalEvalKnowledge } from './retrieval-evaluator.js';
import type {
  KnowledgeCompletenessCase,
  KnowledgeCompletenessFixture,
  KnowledgeCompletenessForbiddenItem,
  KnowledgeCompletenessMode,
  KnowledgeCompletenessRequiredFact,
  KnowledgeCompletenessRequiredSource,
} from './knowledge-completeness-evaluator.js';

export async function loadKnowledgeCompletenessFixture(filePath: string): Promise<KnowledgeCompletenessFixture> {
  const raw = await readFile(filePath, 'utf8');
  return parseKnowledgeCompletenessFixture(JSON.parse(raw), filePath);
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
      parseKnowledge(item, `${source}.knowledge[${index}]`)
    ));
  const cases = expectArray(fixture.cases, `${source}.cases`).map((item, index) => (
    parseCase(item, `${source}.cases[${index}]`)
  ));

  if (knowledge) {
    ensureUnique(knowledge.map((item) => item.evalId), `${source}.knowledge[].evalId`);
  }
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

function parseCase(value: unknown, path: string): KnowledgeCompletenessCase {
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
    modes: parseModes(item.modes, `${path}.modes`),
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

function parseModes(value: unknown, path: string): KnowledgeCompletenessMode[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectArray(value, path).map((mode, index) => {
    const parsed = expectString(mode, `${path}[${index}]`);
    if (parsed !== 'fixture' && parsed !== 'live') {
      throw new Error(`${path}[${index}] must be "fixture" or "live".`);
    }
    return parsed;
  });
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

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectString(value, path);
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectArray(value, path).map((item, index) => expectString(item, `${path}[${index}]`));
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
