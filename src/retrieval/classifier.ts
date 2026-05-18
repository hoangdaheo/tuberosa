import type {
  ClassifiedQuery,
  ContextSearchInput,
  LabelInput,
  RetrievalEvidenceType,
  RetrievalIntent,
  RetrievalWorkflowStage,
  TaskType,
} from '../types.js';
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
  const hasContinuationIntent = isContinuationIntent(lower);
  const identifierText = stripFilePaths(prompt);
  const files = uniqueStrings([...(input.files ?? []), ...extractFiles(prompt), ...extractContinuationFiles(lower)]);
  const symbols = uniqueStrings([...(input.symbols ?? []), ...extractSymbols(identifierText)]);
  const errors = uniqueStrings([...(input.errors ?? []), ...extractErrors(identifierText)]);
  const technologies = uniqueStrings(TECHNOLOGY_TERMS.filter((term) => matchesTechnology(lower, term)));
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
    intent: buildRetrievalIntent({
      prompt,
      lower,
      taskType,
      project,
      files,
      symbols,
      errors,
      technologies,
      businessAreas,
      hasContinuationIntent,
    }),
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

  if (/\b(implement|build|add|create|update|change|modify|feature)\b/.test(lower)) {
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

  if (isContinuationIntent(lower)) {
    return 'implementation';
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

function buildRetrievalIntent(input: {
  prompt: string;
  lower: string;
  taskType: TaskType;
  project: string | undefined;
  files: string[];
  symbols: string[];
  errors: string[];
  technologies: string[];
  businessAreas: string[];
  hasContinuationIntent: boolean;
}): RetrievalIntent {
  const impliedDomains = uniqueStrings([...input.businessAreas, ...input.technologies]);

  return {
    taskGoal: inferTaskGoal(input.prompt, input.taskType, input.hasContinuationIntent),
    workflowStage: inferWorkflowStage(input.taskType, input.hasContinuationIntent),
    impliedFiles: input.files,
    impliedSymbols: input.symbols,
    impliedDomains,
    recentSessionReferences: input.hasContinuationIntent ? ['selected_context_decisions'] : [],
    requiredEvidenceTypes: inferRequiredEvidenceTypes(input),
    uncertaintyReasons: inferUncertaintyReasons(input),
  };
}

function inferTaskGoal(prompt: string, taskType: TaskType, hasContinuationIntent: boolean): string {
  if (hasContinuationIntent) {
    return 'continue current work';
  }

  switch (taskType) {
    case 'debugging':
      return 'debug or fix reported failure';
    case 'implementation':
      return 'implement requested change';
    case 'refactor':
      return 'refactor existing code';
    case 'review':
      return 'review changes or risk';
    case 'planning':
      return 'plan or design the work';
    case 'exploration':
      return 'understand existing code or workflow';
    case 'testing':
      return 'verify behavior with tests';
    case 'unknown':
      return compactPromptGoal(prompt);
  }
}

function compactPromptGoal(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 160) || 'understand user request';
}

function inferWorkflowStage(taskType: TaskType, hasContinuationIntent: boolean): RetrievalWorkflowStage {
  if (hasContinuationIntent) {
    return 'continuation';
  }

  switch (taskType) {
    case 'debugging':
      return 'investigation';
    case 'implementation':
    case 'refactor':
      return 'implementation';
    case 'review':
      return 'review';
    case 'planning':
      return 'planning';
    case 'exploration':
      return 'exploration';
    case 'testing':
      return 'verification';
    case 'unknown':
      return 'unknown';
  }
}

function inferRequiredEvidenceTypes(input: {
  lower: string;
  taskType: TaskType;
  files: string[];
  symbols: string[];
  errors: string[];
  hasContinuationIntent: boolean;
}): RetrievalEvidenceType[] {
  const evidence: RetrievalEvidenceType[] = [];

  if (input.hasContinuationIntent) {
    evidence.push('handoff', 'session_history', 'workflow');
  }

  switch (input.taskType) {
    case 'debugging':
      evidence.push('bugfix', 'code_reference', 'incident_lesson');
      break;
    case 'implementation':
      evidence.push('spec', 'workflow', 'code_reference');
      break;
    case 'refactor':
      evidence.push('code_reference', 'workflow');
      break;
    case 'review':
      evidence.push('code_reference', 'spec');
      break;
    case 'planning':
      evidence.push('spec', 'workflow', 'docs');
      break;
    case 'exploration':
      evidence.push('code_reference', 'docs');
      break;
    case 'testing':
      evidence.push('tests', 'code_reference');
      break;
    case 'unknown':
      evidence.push('docs');
      break;
  }

  if (input.files.length || input.symbols.length) {
    evidence.push('code_reference');
  }

  if (input.errors.length) {
    evidence.push('bugfix', 'incident_lesson');
  }

  if (/\b(reflection|memory|lesson|learned)\b/.test(input.lower)) {
    evidence.push('reflection_memory');
  }

  return uniqueStrings(evidence) as RetrievalEvidenceType[];
}

function inferUncertaintyReasons(input: {
  project: string | undefined;
  taskType: TaskType;
  files: string[];
  symbols: string[];
  errors: string[];
  hasContinuationIntent: boolean;
}): string[] {
  const reasons: string[] = [];

  if (!input.project) {
    reasons.push('project is unclear');
  }

  if (input.taskType === 'unknown') {
    reasons.push('task type is unclear');
  }

  if (!input.files.length && !input.symbols.length && !input.errors.length) {
    reasons.push('no concrete file, symbol, or error signal was supplied');
  }

  if (input.hasContinuationIntent) {
    reasons.push('continuation prompt relies on handoff or recent selected-session context');
  }

  return reasons;
}

function extractFiles(prompt: string): string[] {
  return prompt.match(/(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+|[\w.-]+\.[jt]sx?|[\w.-]+\.py|[\w.-]+\.go|[\w.-]+\.rs|[\w.-]+\.md/g) ?? [];
}

function stripFilePaths(prompt: string): string {
  return prompt.replace(/(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+|[\w.-]+\.[jt]sx?|[\w.-]+\.py|[\w.-]+\.go|[\w.-]+\.rs|[\w.-]+\.md/g, ' ');
}

function extractContinuationFiles(lower: string): string[] {
  if (!isContinuationIntent(lower)) {
    return [];
  }

  return lower.includes('roadmap') || /\bphase\s*\d/.test(lower)
    ? ['handoff.md', 'docs/AGENT_CONTEXT_ROADMAP.md']
    : ['handoff.md'];
}

function extractSymbols(prompt: string): string[] {
  const codeSpans = [...prompt.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((value) => /^[A-Za-z_$][\w$.:#-]+$/.test(value));
  const camelCase = prompt.match(/\b[A-Z][A-Za-z0-9_]*(?:Service|Controller|Repository|Provider|Handler|Store|Model|Schema|Config|Client)\b/g) ?? [];
  const pascalCase = (prompt.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? [])
    .filter((value) => !SYMBOL_STOP_WORDS.has(value) && !isLikelyDocumentIdentifier(value));
  const functions = [...prompt.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
  return uniqueStrings([...codeSpans, ...camelCase, ...pascalCase, ...functions]);
}

function matchesTechnology(lower: string, term: string): boolean {
  if (term === 'next') {
    return /\b(next\.js|nextjs|next\s+(?:app|application|project|repo|site|route|router|page|api|server|config)|app\/(?:page|layout|route)\.[jt]sx?)\b/.test(lower);
  }

  if (term === 'go') {
    return /\b(golang|go\s+(?:api|app|code|module|package|project|repo|runtime|server|service)|[\w./-]+\.go)\b/.test(lower);
  }

  return new RegExp(`\\b${escapeRegExp(term)}\\b`).test(lower);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractErrors(prompt: string): string[] {
  return uniqueStrings([
    ...(prompt.match(/\b[A-Z][A-Z0-9_]*(?:Error|Exception|Failure)\b/g) ?? []),
    ...(prompt.match(/\b[A-Z]{2,}[-_][A-Z0-9_-]+\b/g) ?? []),
    ...(prompt.match(/\b(?:TS|ERR|E)[-_]?\d{3,6}\b/g) ?? []),
  ].filter((value) => !isLikelyDocumentIdentifier(value)));
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

function isContinuationIntent(lower: string): boolean {
  return /\b(continue|resume|handoff|handover)\b|\bpick up\b|\bwhere we left off\b|\bcurrent work\b/.test(lower);
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
  'before',
  'after',
  'added',
  'updated',
  'verified',
  'loaded',
  'implemented',
  'improve',
  'focus',
  'next',
]);

const SYMBOL_STOP_WORDS = new Set([
  'Fix',
  'Add',
  'Create',
  'Update',
  'Delete',
  'Remove',
  'Review',
  'Use',
  'Pull',
  'Continue',
  'Continuation',
  'Resume',
  'Current',
  'Phase',
  'Roadmap',
  'The',
  'For',
  'Keep',
  'Strip',
  'Before',
  'After',
  'Added',
  'Updated',
  'Verified',
  'Loaded',
  'Implemented',
  'Improve',
  'Focus',
  'Next',
  'Agent',
  'Context',
  'Usefulness',
  'Hardening',
  'Tuberosa',
  'MCP',
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

function isLikelyDocumentIdentifier(value: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(value) && value.includes('_') && !/\d/.test(value);
}
