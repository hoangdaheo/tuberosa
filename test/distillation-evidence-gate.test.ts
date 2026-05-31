import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import {
  evaluateGates,
  type EvaluateGatesInput,
} from '../src/reflection/recommendation.js';
import type { ReflectionDraft } from '../src/types.js';

// Copied/adapted from test/recommendation.test.ts so the unrelated gates
// (duplicates, grounded_references, concrete_labels, maturity, ...) stay green
// and we isolate the distillation_evidence gate behavior.
function baseDraft(overrides: Partial<ReflectionDraft> = {}): ReflectionDraft {
  return {
    id: 'draft-1',
    project: 'demo',
    title: 'Keep refresh token rotation in AuthService',
    summary: 'When fixing TS-999 in AuthService, do not reset refresh tokens during retry.',
    content: 'Detailed explanation of the lesson with enough characters to clear the maturity gate. ' + 'x'.repeat(40),
    itemType: 'bugfix',
    triggerType: 'error_recovery',
    status: 'pending',
    suggestedLabels: [
      { type: 'file', value: 'src/auth.ts', weight: 1 },
      { type: 'error', value: 'TS-999', weight: 1 },
    ],
    references: [
      { type: 'file', uri: 'src/auth.ts' },
      { type: 'conversation', uri: 'tuberosa://agent-sessions/abc' },
    ],
    metadata: {
      contextFit: { fitStatus: 'ready', fitScore: 0.95, fitReasons: [], missingSignals: [] },
      learningSignals: [
        { kind: 'tip', text: 'Preserve token rotation', confidence: 0.85 },
      ],
    },
    duplicateCandidates: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const fullInput = (draft: ReflectionDraft, overrides: Partial<EvaluateGatesInput> = {}): EvaluateGatesInput => ({
  draft,
  mode: 'auto',
  outcome: 'completed',
  compliance: {
    status: 'compliant',
    checkedAt: new Date().toISOString(),
    instruction: 'ok',
    decisionIds: [],
  },
  decisions: [],
  selectedPack: {
    id: 'pack-1',
    prompt: 'fix TS-999',
    confidence: 0.9,
    status: 'selected',
    classified: { taskType: 'debugging', files: [], symbols: [], errors: [], technologies: [], businessAreas: [], intent: 'debug' } as never,
    contextFit: { fitStatus: 'ready', fitScore: 0.9, fitReasons: [], missingSignals: [] },
    sections: [],
    rejectedKnowledgeIds: [],
    createdAt: new Date().toISOString(),
  },
  ...overrides,
});

function conventionMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contextFit: { fitStatus: 'ready', fitScore: 0.95, fitReasons: [], missingSignals: [] },
    learningSignals: [{ kind: 'tip', text: 'Preserve token rotation', confidence: 0.85 }],
    convention: true,
    evidenceAtomIds: ['atom-1', 'atom-2'],
    steps: ['Step one', 'Step two'],
    trigger: { files: ['src/auth.ts'] },
    ...overrides,
  };
}

const findGate = (input: EvaluateGatesInput) =>
  evaluateGates(input).find((g) => g.key === 'distillation_evidence');

test('distillation_evidence passes for a well-formed convention draft', () => {
  const gate = findGate(fullInput(baseDraft({ metadata: conventionMeta() })));
  ok(gate, 'distillation_evidence gate should exist');
  equal(gate!.status, 'pass');
});

test('distillation_evidence fails (hard) when only one source atom', () => {
  const gate = findGate(fullInput(baseDraft({ metadata: conventionMeta({ evidenceAtomIds: ['atom-1'] }) })));
  ok(gate);
  equal(gate!.status, 'fail');
  equal(gate!.severity, 'hard');
});

test('distillation_evidence fails when steps are empty', () => {
  const gate = findGate(fullInput(baseDraft({ metadata: conventionMeta({ steps: [] }) })));
  ok(gate);
  equal(gate!.status, 'fail');
});

test('distillation_evidence is a no-op (pass) for non-convention drafts', () => {
  const gate = findGate(fullInput(baseDraft()));
  ok(gate);
  equal(gate!.status, 'pass');
});
