import { readFile } from 'node:fs/promises';
import type {
  ClassifiedQuery,
  ContextFit,
  ContextFitStatus,
  RankedCandidate,
  StartupBrief,
} from '../types.js';
import { composeStartupBrief } from '../retrieval/startup-brief.js';

export interface StartupBriefEvalFixture {
  name: string;
  cases: StartupBriefEvalCase[];
}

export interface StartupBriefEvalCase {
  id: string;
  prompt: string;
  seed: {
    worktreeFiles: StartupBriefSeedFile[];
    memory: StartupBriefSeedMemory[];
  };
  contextFit: {
    fitStatus: ContextFitStatus;
    missingSignals: string[];
  };
  expect: {
    verdict: StartupBrief['verdict'];
    readFirst: string[];
    missingSignals: string[];
  };
}

export interface StartupBriefSeedFile {
  path: string;
  heading?: string;
}

export interface StartupBriefSeedMemory {
  path: string;
  title: string;
}

export interface StartupBriefEvalCaseResult {
  id: string;
  passed: boolean;
  verdict: StartupBrief['verdict'];
  readFirst: string[];
  missingSignals: string[];
  failures: string[];
}

export interface StartupBriefEvalReport {
  fixtureName: string;
  totalCases: number;
  passedCases: number;
  cases: StartupBriefEvalCaseResult[];
}

export async function loadStartupBriefFixture(path: string): Promise<StartupBriefEvalFixture> {
  return JSON.parse(await readFile(path, 'utf8')) as StartupBriefEvalFixture;
}

export class StartupBriefEvaluator {
  run(fixture: StartupBriefEvalFixture): StartupBriefEvalReport {
    const cases = fixture.cases.map((testCase) => this.evaluateCase(testCase));
    return {
      fixtureName: fixture.name,
      totalCases: cases.length,
      passedCases: cases.filter((testCase) => testCase.passed).length,
      cases,
    };
  }

  private evaluateCase(testCase: StartupBriefEvalCase): StartupBriefEvalCaseResult {
    const brief = composeStartupBrief({
      prompt: testCase.prompt,
      classified: classifiedFor(testCase),
      candidates: candidatesFor(testCase),
      contextFit: contextFitFor(testCase),
    });
    const failures = evaluateBrief(brief, testCase);
    return {
      id: testCase.id,
      passed: failures.length === 0,
      verdict: brief.verdict,
      readFirst: brief.readFirst.map((item) => item.path),
      missingSignals: brief.missingSignals,
      failures,
    };
  }
}

function classifiedFor(testCase: StartupBriefEvalCase): ClassifiedQuery {
  const files = [
    ...testCase.seed.worktreeFiles.map((file) => file.path),
    ...testCase.seed.memory.map((item) => item.path),
  ];
  return {
    project: 'startup-brief-eval',
    taskType: 'implementation',
    confidence: 0.8,
    files,
    symbols: [],
    errors: [],
    technologies: [],
    businessAreas: [],
    exactTerms: files,
    lexicalQuery: [testCase.prompt, ...files].join(' '),
    intent: {
      taskGoal: 'continue current work',
      workflowStage: 'continuation',
      taskBriefMode: 'implementation',
      impliedFiles: files,
      impliedSymbols: [],
      impliedDomains: [],
      objectHints: [],
      recentSessionReferences: [],
      requiredEvidenceTypes: ['handoff', 'workflow', 'spec'],
      uncertaintyReasons: [],
    },
  };
}

function candidatesFor(testCase: StartupBriefEvalCase): RankedCandidate[] {
  const worktree = testCase.seed.worktreeFiles.map((file, index) => candidateFor({
    index,
    path: file.path,
    title: file.path,
    source: 'worktree',
    metadata: { worktree: { path: file.path, firstHeading: file.heading } },
  }));
  const memory = testCase.seed.memory.map((item, index) => candidateFor({
    index: worktree.length + index,
    path: item.path,
    title: item.title,
    source: 'memory',
    metadata: {},
  }));
  return [...worktree, ...memory];
}

function candidateFor(input: {
  index: number;
  path: string;
  title: string;
  source: RankedCandidate['source'];
  metadata: Record<string, unknown>;
}): RankedCandidate {
  return {
    knowledgeId: input.source === 'worktree'
      ? `worktree:${input.path}:${input.index}`
      : `memory-${input.index}`,
    title: input.title,
    summary: input.title,
    content: '',
    contextualContent: '',
    itemType: 'memory',
    project: 'startup-brief-eval',
    labels: [{ type: 'file', value: input.path, weight: 1 }],
    references: [{ type: 'file', uri: input.path }],
    tokenEstimate: 12,
    trustLevel: 1,
    source: input.source,
    rawScore: 1 - input.index * 0.05,
    rank: input.index + 1,
    metadata: input.metadata,
    fusedScore: 1 - input.index * 0.05,
    rerankScore: 1 - input.index * 0.05,
    finalScore: 1 - input.index * 0.05,
    matchReasons: [input.source === 'worktree' ? 'worktree match' : 'memory match'],
  };
}

function contextFitFor(testCase: StartupBriefEvalCase): ContextFit {
  return {
    fitStatus: testCase.contextFit.fitStatus,
    fitScore: testCase.contextFit.fitStatus === 'ready' ? 0.9 : 0.4,
    fitReasons: [],
    missingSignals: testCase.contextFit.missingSignals,
  };
}

function evaluateBrief(brief: StartupBrief, testCase: StartupBriefEvalCase): string[] {
  const failures: string[] = [];
  if (brief.verdict !== testCase.expect.verdict) {
    failures.push(`verdict expected ${testCase.expect.verdict} but got ${brief.verdict}`);
  }
  for (const path of testCase.expect.readFirst) {
    if (!brief.readFirst.some((item) => item.path === path)) {
      failures.push(`readFirst missing ${path}`);
    }
  }
  for (const signal of testCase.expect.missingSignals) {
    if (!brief.missingSignals.includes(signal)) {
      failures.push(`missingSignals missing ${signal}`);
    }
  }
  const unexpectedSignals = brief.missingSignals.filter((signal) => !testCase.expect.missingSignals.includes(signal));
  for (const signal of unexpectedSignals) {
    failures.push(`missingSignals included unexpected ${signal}`);
  }
  return failures;
}
