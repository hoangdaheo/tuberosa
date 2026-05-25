import type {
  AgentContextDecision,
  AgentLearningSignal,
  AgentSessionNote,
  ResearchTraceInput,
  ResearchTraceStep,
  ResearchTraceSummary,
} from '../types.js';
import { truncate, uniqueStrings } from '../util/text.js';

export const MAX_RESEARCH_TRACE_STEPS = 12;
export const MAX_RESEARCH_TRACE_STEP_TEXT = 280;
export const MAX_RESEARCH_TRACE_OUTCOME = 500;

export function normalizeResearchTrace(input: ResearchTraceInput): ResearchTraceSummary {
  const steps = input.steps.slice(0, MAX_RESEARCH_TRACE_STEPS).map(normalizeStep);
  const outcome = truncate(input.outcome.trim(), MAX_RESEARCH_TRACE_OUTCOME);
  const summary: ResearchTraceSummary = {
    steps,
    outcome,
    derived: false,
    bytes: 0,
  };
  return { ...summary, bytes: traceBytes(summary) };
}

export function deriveResearchTrace(input: {
  learningSignals?: AgentLearningSignal[];
  sessionNotes?: AgentSessionNote[];
  contextDecisions?: AgentContextDecision[];
  changedFiles?: string[];
  verificationCommands?: string[];
  outcome: string;
}): ResearchTraceSummary {
  const steps: ResearchTraceStep[] = [];
  const decisions = input.contextDecisions ?? [];
  const selected = [...decisions].reverse().find((decision) => (
    decision.decision === 'selected' || decision.decision === 'selected_but_noisy'
  ));
  if (selected) {
    steps.push(normalizeStep({
      kind: 'decision',
      text: selected.reason
        ? `Recorded context decision ${selected.decision}: ${selected.reason}`
        : `Recorded context decision ${selected.decision}.`,
    }));
  }

  const changedFiles = uniqueStrings(input.changedFiles ?? []);
  if (changedFiles.length) {
    steps.push(normalizeStep({
      kind: 'action',
      text: `Changed files: ${changedFiles.join(', ')}`,
      references: changedFiles.slice(0, 6).map((file) => ({ file })),
    }));
  }

  const verificationCommands = uniqueStrings(input.verificationCommands ?? []);
  if (verificationCommands.length) {
    steps.push(normalizeStep({
      kind: 'action',
      text: `Ran verification: ${verificationCommands.join('; ')}`,
      references: verificationCommands.slice(0, 4).map((command) => ({ command })),
    }));
  }

  for (const signal of input.learningSignals ?? []) {
    if (steps.length >= MAX_RESEARCH_TRACE_STEPS) break;
    const kind = stepKindForSignal(signal.kind);
    if (!kind) continue;
    steps.push(normalizeStep({
      kind,
      text: signal.text,
      references: [
        ...(signal.files ?? []).slice(0, 4).map((file) => ({ file })),
        ...(signal.symbols ?? []).slice(0, 4).map((symbol) => ({ symbol })),
      ],
    }));
  }

  for (const note of input.sessionNotes ?? []) {
    if (steps.length >= MAX_RESEARCH_TRACE_STEPS) break;
    if (!note.feedbackType) continue;
    steps.push(normalizeStep({
      kind: 'observation',
      text: `Post-finish feedback ${note.feedbackType}: ${note.note}`,
    }));
  }

  if (steps.length === 0) {
    steps.push(normalizeStep({
      kind: 'observation',
      text: 'Session finished without structured research steps.',
    }));
  }

  const summary: ResearchTraceSummary = {
    steps: steps.slice(0, MAX_RESEARCH_TRACE_STEPS),
    outcome: truncate(input.outcome.trim(), MAX_RESEARCH_TRACE_OUTCOME),
    derived: true,
    bytes: 0,
  };
  return { ...summary, bytes: traceBytes(summary) };
}

function normalizeStep(step: ResearchTraceStep): ResearchTraceStep {
  return {
    kind: step.kind,
    text: truncate(step.text.trim(), MAX_RESEARCH_TRACE_STEP_TEXT),
    references: step.references?.filter((reference) => (
      Boolean(reference.file || reference.symbol || reference.command || reference.knowledgeId)
    )),
  };
}

function stepKindForSignal(kind: AgentLearningSignal['kind']): ResearchTraceStep['kind'] | undefined {
  switch (kind) {
    case 'verification':
    case 'file_change':
      return 'observation';
    case 'tip':
    case 'decision':
      return 'thought';
    case 'mistake':
    case 'follow_up':
      return 'observation';
    case 'user_preference':
      return 'decision';
  }
}

function traceBytes(trace: Omit<ResearchTraceSummary, 'bytes'>): number {
  return Buffer.byteLength(JSON.stringify({
    steps: trace.steps,
    outcome: trace.outcome,
    derived: trace.derived,
  }), 'utf8');
}
