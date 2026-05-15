import type { ClassifiedQuery, ContextSearchInput, LabelInput, TaskType } from '../types.js';
import { normalizeLabel, uniqueStrings } from '../util/text.js';

const TECHNOLOGY_TERMS = [
  'typescript',
  'javascript',
  'react',
  'next',
  'node',
  'postgres',
  'pgvector',
  'redis',
  'docker',
  'mcp',
  'graphql',
  'rest',
  'python',
  'go',
  'rust',
  'aws',
  'lambda',
  'serverless',
];

const BUSINESS_HINTS = [
  'auth',
  'login',
  'billing',
  'newsletter',
  'paywall',
  'subscription',
  'search',
  'ads',
  'profile',
  'publishing',
  'content',
  'analytics',
  'notification',
];

export function classifyQuery(input: ContextSearchInput): ClassifiedQuery {
  const prompt = input.prompt;
  const lower = prompt.toLowerCase();
  const files = uniqueStrings([...(input.files ?? []), ...extractFiles(prompt)]);
  const symbols = uniqueStrings([...(input.symbols ?? []), ...extractSymbols(prompt)]);
  const errors = uniqueStrings([...(input.errors ?? []), ...extractErrors(prompt)]);
  const technologies = uniqueStrings(TECHNOLOGY_TERMS.filter((term) => lower.includes(term)));
  const businessAreas = uniqueStrings(BUSINESS_HINTS.filter((term) => lower.includes(term)));
  const taskType = input.taskType && input.taskType !== 'unknown' ? input.taskType : inferTaskType(lower);
  const project = input.project ?? inferProject(input);
  const exactTerms = uniqueStrings([
    ...files,
    ...symbols,
    ...errors,
    ...technologies,
    ...businessAreas,
    ...extractQuotedTerms(prompt),
  ]);

  const confidenceSignals = [
    project,
    taskType !== 'unknown' ? taskType : undefined,
    files.length ? files.join(',') : undefined,
    symbols.length ? symbols.join(',') : undefined,
    errors.length ? errors.join(',') : undefined,
    technologies.length ? technologies.join(',') : undefined,
    businessAreas.length ? businessAreas.join(',') : undefined,
  ].filter(Boolean).length;

  return {
    project,
    taskType,
    confidence: Math.min(0.96, 0.2 + confidenceSignals * 0.1),
    files,
    symbols,
    errors,
    technologies,
    businessAreas,
    exactTerms,
    lexicalQuery: buildLexicalQuery(prompt, exactTerms),
  };
}

export function labelsFromClassification(classified: ClassifiedQuery): LabelInput[] {
  const labels: LabelInput[] = [];

  if (classified.project) {
    labels.push({ type: 'project', value: classified.project, weight: 1 });
  }

  if (classified.taskType !== 'unknown') {
    labels.push({ type: 'task_type', value: classified.taskType, weight: 0.9 });
  }

  for (const value of classified.files) {
    labels.push({ type: 'file', value, weight: 0.9 });
  }

  for (const value of classified.symbols) {
    labels.push({ type: 'symbol', value, weight: 0.85 });
  }

  for (const value of classified.errors) {
    labels.push({ type: 'error', value, weight: 0.95 });
  }

  for (const value of classified.technologies) {
    labels.push({ type: 'technology', value, weight: 0.75 });
  }

  for (const value of classified.businessAreas) {
    labels.push({ type: 'business_area', value, weight: 0.8 });
  }

  return labels;
}

function inferTaskType(lower: string): TaskType {
  if (/\b(debug|bug|error|fail|failing|trace|fix)\b/.test(lower)) {
    return 'debugging';
  }

  if (/\b(implement|build|add|create|feature)\b/.test(lower)) {
    return 'implementation';
  }

  if (/\b(refactor|rename|extract|move|restructure)\b/.test(lower)) {
    return 'refactor';
  }

  if (/\b(review|pr|merge|risk)\b/.test(lower)) {
    return 'review';
  }

  if (/\b(plan|design|architecture|approach|spec)\b/.test(lower)) {
    return 'planning';
  }

  if (/\b(how does|understand|explore|where is|what calls)\b/.test(lower)) {
    return 'exploration';
  }

  if (/\b(test|coverage|verify)\b/.test(lower)) {
    return 'testing';
  }

  return 'unknown';
}

function inferProject(input: ContextSearchInput): string | undefined {
  if (input.repoHint) {
    return normalizeLabel(input.repoHint.split('/').filter(Boolean).at(-1) ?? input.repoHint);
  }

  if (input.cwd) {
    return normalizeLabel(input.cwd.split('/').filter(Boolean).at(-1) ?? input.cwd);
  }

  return undefined;
}

function extractFiles(prompt: string): string[] {
  return prompt.match(/(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+|[\w.-]+\.[jt]sx?|[\w.-]+\.py|[\w.-]+\.go|[\w.-]+\.rs|[\w.-]+\.md/g) ?? [];
}

function extractSymbols(prompt: string): string[] {
  const codeSpans = [...prompt.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((value) => /^[A-Za-z_$][\w$.:#-]+$/.test(value));
  const camelCase = prompt.match(/\b[A-Z][A-Za-z0-9_]*(?:Service|Controller|Repository|Provider|Handler|Store|Model|Schema|Config|Client)\b/g) ?? [];
  const pascalCase = (prompt.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? []).filter((value) => !SYMBOL_STOP_WORDS.has(value));
  const functions = [...prompt.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
  return uniqueStrings([...codeSpans, ...camelCase, ...pascalCase, ...functions]);
}

function extractErrors(prompt: string): string[] {
  return uniqueStrings([
    ...(prompt.match(/\b[A-Z][A-Z0-9_]*(?:Error|Exception|Failure)\b/g) ?? []),
    ...(prompt.match(/\b[A-Z]{2,}[-_][A-Z0-9_-]+\b/g) ?? []),
    ...(prompt.match(/\b(?:TS|ERR|E)[-_]?\d{3,6}\b/g) ?? []),
  ]);
}

function extractQuotedTerms(prompt: string): string[] {
  return [...prompt.matchAll(/"([^"]{3,80})"|'([^']{3,80})'/g)].map((match) => match[1] ?? match[2]);
}

function buildLexicalQuery(prompt: string, exactTerms: string[]): string {
  const importantWords = prompt
    .toLowerCase()
    .match(/[a-z0-9_./:-]{3,}/g)
    ?.filter((word) => !STOP_WORDS.has(word)) ?? [];

  return uniqueStrings([...exactTerms, ...importantWords]).slice(0, 32).join(' ');
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'what',
  'when',
  'where',
  'about',
  'into',
  'does',
  'have',
  'need',
  'want',
  'will',
  'should',
  'would',
  'could',
  'there',
  'their',
  'your',
  'using',
]);

const SYMBOL_STOP_WORDS = new Set([
  'Fix',
  'Add',
  'Create',
  'Update',
  'Delete',
  'Remove',
  'Review',
  'How',
  'What',
  'When',
  'Where',
  'Why',
  'Who',
  'Which',
  'React',
  'Node',
  'Docker',
  'Postgres',
  'Redis',
]);
