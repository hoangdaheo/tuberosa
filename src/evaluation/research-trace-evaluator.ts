import { readFile } from 'node:fs/promises';
import type {
  AgentContextDecision,
  AgentLearningSignal,
  AgentSessionNote,
  ResearchTraceInput,
  ResearchTraceSummary,
} from '../types.js';
import { deriveResearchTrace, normalizeResearchTrace } from '../agent-session/research-trace.js';

export interface ResearchTraceEvalFixture {
  name: string;
  cases: ResearchTraceEvalCase[];
}

export interface ResearchTraceEvalCase {
  id: string;
  mode: 'explicit' | 'derived';
  input: ResearchTraceInput | ResearchTraceDerivationInput;
  expect: {
    derived: boolean;
    includes?: string[];
    excludes?: string[];
    maxSteps?: number;
  };
}

export interface ResearchTraceDerivationInput {
  outcome: string;
  learningSignals?: AgentLearningSignal[];
  sessionNotes?: AgentSessionNote[];
  contextDecisions?: AgentContextDecision[];
  changedFiles?: string[];
  verificationCommands?: string[];
}

export interface ResearchTraceEvalCaseResult {
  id: string;
  passed: boolean;
  derived: boolean;
  stepCount: number;
  failures: string[];
}

export interface ResearchTraceEvalReport {
  fixtureName: string;
  totalCases: number;
  passedCases: number;
  cases: ResearchTraceEvalCaseResult[];
}

export async function loadResearchTraceFixture(path: string): Promise<ResearchTraceEvalFixture> {
  return JSON.parse(await readFile(path, 'utf8')) as ResearchTraceEvalFixture;
}

export class ResearchTraceEvaluator {
  run(fixture: ResearchTraceEvalFixture): ResearchTraceEvalReport {
    const cases = fixture.cases.map((testCase) => this.evaluateCase(testCase));
    return {
      fixtureName: fixture.name,
      totalCases: cases.length,
      passedCases: cases.filter((testCase) => testCase.passed).length,
      cases,
    };
  }

  private evaluateCase(testCase: ResearchTraceEvalCase): ResearchTraceEvalCaseResult {
    const trace = testCase.mode === 'explicit'
      ? normalizeResearchTrace(testCase.input as ResearchTraceInput)
      : deriveResearchTrace(testCase.input as ResearchTraceDerivationInput);
    const failures = evaluateTrace(trace, testCase);
    return {
      id: testCase.id,
      passed: failures.length === 0,
      derived: trace.derived,
      stepCount: trace.steps.length,
      failures,
    };
  }
}

function evaluateTrace(trace: ResearchTraceSummary, testCase: ResearchTraceEvalCase): string[] {
  const failures: string[] = [];
  const serialized = JSON.stringify(trace);
  if (trace.derived !== testCase.expect.derived) {
    failures.push(`derived expected ${testCase.expect.derived} but got ${trace.derived}`);
  }
  if (testCase.expect.maxSteps !== undefined && trace.steps.length > testCase.expect.maxSteps) {
    failures.push(`step count ${trace.steps.length} exceeded ${testCase.expect.maxSteps}`);
  }
  for (const needle of testCase.expect.includes ?? []) {
    if (!serialized.includes(needle)) {
      failures.push(`missing expected trace text: ${needle}`);
    }
  }
  for (const needle of testCase.expect.excludes ?? []) {
    if (serialized.includes(needle)) {
      failures.push(`unexpected trace text: ${needle}`);
    }
  }
  if (trace.bytes <= 0) {
    failures.push('bytes must be positive');
  }
  return failures;
}
