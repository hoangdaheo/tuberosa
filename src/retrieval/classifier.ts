import type {
  ClassifiedQuery,
  ContextSearchInput,
  LabelInput,
  LabelProvenance,
  RetrievalEvidenceType,
  RetrievalIntent,
  RetrievalWorkflowStage,
  TaskBriefMode,
  TaskType,
} from '../types.js';
import { normalizeLabel, uniqueStrings } from '../util/text.js';
import { isOntologyMatch } from '../relations/ontology.js';

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
  const objectHints = uniqueStrings(extractUuidHints(prompt));
  const files = uniqueStrings([...(input.files ?? []), ...extractFiles(prompt), ...extractContinuationFiles(lower)]);
  const symbols = uniqueStrings([...(input.symbols ?? []), ...extractSymbols(identifierText)])
    .filter((symbol) => !objectHints.includes(symbol));
  const errors = uniqueStrings([...(input.errors ?? []), ...extractErrors(identifierText)]);
  const technologies = uniqueStrings(TECHNOLOGY_TERMS.filter((term) => matchesTechnology(lower, term)));
  const businessAreas = uniqueStrings(BUSINESS_HINTS.filter((term) => lower.includes(term)));
  const taskType = input.taskType && input.taskType !== 'unknown' ? input.taskType : inferTaskType(lower);
  const project = input.project ?? inferProject(input);
  const domain = inferDomain(files);
  const exactTerms = uniqueStrings([
    ...files,
    ...symbols,
    ...errors,
    ...technologies,
    ...businessAreas,
    ...objectHints,
    ...extractQuotedTerms(prompt),
    ...extractCompoundTerms(prompt),
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
    domain,
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
      objectHints,
      hasContinuationIntent,
    }),
  };
}

export function labelsFromClassification(classified: ClassifiedQuery): LabelInput[] {
  const labels: LabelInput[] = [];
  const make = (type: LabelInput['type'], value: string, weight: number, confidence: number): LabelInput => ({
    type,
    value,
    weight,
    provenance: classifierProvenance(confidence),
  });

  if (classified.project) {
    labels.push(make('project', classified.project, 1, 0.9));
  }

  if (classified.taskType !== 'unknown') {
    labels.push(make('task_type', classified.taskType, 0.9, 0.8));
  }

  if (classified.domain) {
    labels.push(make('domain', classified.domain, 0.85, 0.7));
  }

  for (const value of classified.files) {
    labels.push(make('file', value, 0.9, 0.85));
  }

  for (const value of classified.symbols) {
    labels.push(make('symbol', value, 0.85, 0.8));
  }

  for (const value of classified.errors) {
    labels.push(make('error', value, 0.95, 0.9));
  }

  for (const value of classified.technologies) {
    labels.push(make('technology', value, 0.75, 0.7));
  }

  for (const value of classified.businessAreas) {
    labels.push(make('business_area', value, 0.8, 0.7));
  }

  return labels;
}

function classifierProvenance(confidence: number): LabelProvenance {
  return { source: 'classifier', confidence: Math.max(0, Math.min(1, confidence)) };
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
  objectHints: string[];
  hasContinuationIntent: boolean;
}): RetrievalIntent {
  const impliedDomains = uniqueStrings([...input.businessAreas, ...input.technologies]);

  return {
    taskGoal: inferTaskGoal(input.prompt, input.taskType, input.hasContinuationIntent),
    workflowStage: inferWorkflowStage(input.taskType, input.hasContinuationIntent),
    taskBriefMode: inferTaskBriefMode(input.lower, input.taskType, input.hasContinuationIntent),
    impliedFiles: input.files,
    impliedSymbols: input.symbols,
    impliedDomains,
    objectHints: input.objectHints,
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

function inferTaskBriefMode(lower: string, taskType: TaskType, hasContinuationIntent: boolean): TaskBriefMode {
  if (/\b(context[-_\s]?quality|selected_but_noisy|too_much_adjacent_context|noisy|adjacent feedback|missing orientation|missing current handoff|missing verification)\b/.test(lower)) {
    return 'context_quality_review';
  }

  if (/\b(reflection[-_\s]?drafts?|pending reflections?|review reflections?|approve reflection|reject reflection|(?:approve|reject|needs[-_\s]?changes)\b.*\b(?:reflection|draft)|(?:reflection|draft)\b.*\b(?:approve|reject|needs[-_\s]?changes))\b/.test(lower)) {
    return 'reflection_review';
  }

  if (/\b(handoff cleanup|handoff clean[-_\s]?up|cleanup handoff|clean up (?:the )?handoff|resolve (?:the )?(?:current )?(?:handoff|section)|current work cleanup|current[-_\s]?work clean[-_\s]?up)\b/.test(lower)) {
    return 'handoff_cleanup';
  }

  if (/\b(operations?|ops)\b.*\b(gaps?|proposals?|queues?)\b|\b(knowledge gaps?|learning proposals?|review queues?|ops queues?)\b/.test(lower)) {
    return 'operations_review';
  }

  if (hasContinuationIntent) {
    return 'implementation';
  }

  switch (taskType) {
    case 'debugging':
      return 'debugging';
    case 'implementation':
    case 'refactor':
    case 'testing':
    case 'exploration':
      return 'implementation';
    case 'review':
      return 'review';
    case 'planning':
      return 'planning';
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

function inferDomain(files: string[]): string | undefined {
  for (const path of files) {
    const match = path.match(/^src\/([a-z][\w-]+)\//i);
    if (match) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

export function hasDomainMismatch(
  candidate: { labels: LabelInput[] },
  classified: ClassifiedQuery,
): boolean {
  if (!classified.domain) {
    return false;
  }
  // Phase 1: only USER-SUPPLIED or REVIEWED domain labels participate in mismatch.
  // Classifier-inferred labels are heuristic (one file's path) and shouldn't trigger
  // false-positive suppression on candidates that simply live in a different src/X/.
  const domainLabels = candidate.labels.filter((label) => label.type === 'domain' && isExplicitDomainLabel(label));
  if (domainLabels.length === 0) {
    return false;
  }
  return !domainLabels.some((label) => isOntologyMatch('domain', label.value, classified.domain!));
}

function isExplicitDomainLabel(label: LabelInput): boolean {
  const provenance = label.provenance?.source;
  if (!provenance) return true; // user-supplied with no provenance attached
  return provenance !== 'classifier';
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

function extractUuidHints(prompt: string): string[] {
  return (prompt.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi) ?? [])
    .map((value) => value.toLowerCase());
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
  'changes',
  'everything',
  'tried',
  'failed',
  'needed',
  'correction',
  'things',
]);

const SYMBOL_STOP_WORDS = new Set([
  'Implement',
  'Fix',
  'Add',
  'Create',
  'Update',
  'Delete',
  'Remove',
  'Change',
  'Modify',
  'Review',
  'Refactor',
  'Rename',
  'Extract',
  'Restructure',
  'Use',
  'Pull',
  'Push',
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
  'Everything',
  'Tried',
  'Failed',
  'Needed',
  'Correction',
  'Things',
  'Status',
  'Summary',
  'Notes',
  'Result',
  'Results',
  'Queue',
  'Queues',
  'Draft',
  'Drafts',
  'Gap',
  'Gaps',
  'Proposal',
  'Proposals',
  'Operation',
  'Operations',
  'Admin',
  'UUID',
  'UUIDs',
  'ID',
  'IDs',
  'HTTP',
  'API',
  'JSON',
  'React',
  'Node',
  'Docker',
  'Postgres',
  'Redis',
  // Imperative verbs and common question starters that appear PascalCase at sentence start
  'Walk',
  'Run',
  'Show',
  'Tell',
  'Make',
  'Check',
  'Verify',
  'Inspect',
  'Find',
  'Move',
  'Debug',
  'Build',
  'Test',
  'Parse',
  'Load',
  'Save',
  'Send',
  'Receive',
  'Handle',
  'Process',
  'Fetch',
  'Store',
  'Start',
  'Stop',
  'Complete',
  'Finish',
  'Begin',
  'Retry',
  'Get',
  'Set',
  'Explain',
  'Describe',
  'List',
  'Trace',
  'Follow',
  'Print',
  'Log',
  'Track',
  'Monitor',
  'Compare',
  'Let',
  'Can',
  'Could',
  'Would',
  'Should',
  'Will',
  // Phase 1: vetted task verbs that frequently appear at sentence start and pollute symbols.
  // User-supplied symbols via the `symbols:` input bypass this filter — caller authority wins.
  'Analyze',
  'Analyse',
  'Analyzing',
  'Analysed',
  'Analyzed',
  'Answer',
  'Answers',
  'Answering',
  'Answered',
  'Investigate',
  'Investigates',
  'Investigating',
  'Investigated',
  'Investigation',
  'Improving',
  'Improved',
  'Improvement',
  'Implementing',
  'Implementation',
  'Fixed',
  'Fixes',
  'Fixing',
  'Adding',
  'Adds',
  'Refactoring',
  'Refactored',
  'Reviewing',
  'Reviewed',
  'Audit',
  'Audits',
  'Auditing',
  'Audited',
  'Map',
  'Maps',
  'Mapping',
  'Mapped',
  'Tracing',
  'Traced',
  'Plan',
  'Plans',
  'Planning',
  'Planned',
  'Building',
  'Built',
  'Testing',
  'Tested',
  'Verifying',
  'Validate',
  'Validates',
  'Validating',
  'Validated',
  'Identify',
  'Identifies',
  'Identifying',
  'Identified',
  'Document',
  'Documents',
  'Documenting',
  'Documented',
  'Expand',
  'Expands',
  'Expanding',
  'Expanded',
  'Ensure',
  'Ensures',
  'Ensuring',
  'Ensured',
  'Confirm',
  'Confirms',
  'Confirming',
  'Confirmed',
  'Propose',
  'Proposes',
  'Proposing',
  'Proposed',
]);

function isLikelyDocumentIdentifier(value: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(value) && value.includes('_') && !/\d/.test(value);
}

function extractCompoundTerms(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const hyphenated = lower.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) ?? [];
  const underscored = lower.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
  return [...hyphenated, ...underscored].filter((term) => term.length >= 5);
}
