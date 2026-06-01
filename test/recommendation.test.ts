import test from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import {
  aggregateRecommendation,
  evaluateGates,
  type EvaluateGatesInput,
  type GateKey,
} from '../src/reflection/recommendation.js';
import type { ReflectionDraft } from '../src/types.js';

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

test('evaluateGates returns all pass when every signal is healthy', () => {
  // Phase 6b — write_gate gate added; the base draft has no writeGate metadata
  // so it passes-with-note (pre-Phase-6b backwards-compat path).
  const gates = evaluateGates(fullInput(baseDraft()));
  equal(gates.length, 13);
  for (const gate of gates) {
    equal(gate.status, 'pass', `expected ${gate.key} to pass: ${gate.message}`);
  }
});

test('aggregateRecommendation verdicts approve with high confidence when all gates pass', () => {
  const gates = evaluateGates(fullInput(baseDraft()));
  const rec = aggregateRecommendation(gates, { draftId: 'draft-1' });
  equal(rec.verdict, 'approve');
  equal(rec.confidence, 'high');
  equal(rec.canAutoApprove, true);
  equal(rec.blockers.length, 0);
  equal(rec.cons.length, 0);
});

test('duplicate candidates produce a hard blocker', () => {
  const gates = evaluateGates(fullInput(baseDraft({
    duplicateCandidates: [
      { knowledgeId: 'k1', title: 'Keep paywall IDs stable', score: 0.9 } as never,
    ],
  })));
  const dup = gates.find((g) => g.key === 'duplicates')!;
  equal(dup.status, 'fail');
  equal(dup.severity, 'hard');

  const rec = aggregateRecommendation(gates, { draftId: 'd' });
  equal(rec.verdict, 'reject');
  equal(rec.blockers.length, 1);
  equal(rec.blockers[0]!.key, 'duplicates');
});

test('non-grounded references produce a hard blocker', () => {
  const gates = evaluateGates(fullInput(baseDraft({
    references: [{ type: 'conversation', uri: 'tuberosa://agent-sessions/abc' }],
  })));
  const grounded = gates.find((g) => g.key === 'grounded_references')!;
  equal(grounded.status, 'fail');
  equal(grounded.severity, 'hard');

  const rec = aggregateRecommendation(gates, { draftId: 'd' });
  equal(rec.verdict, 'reject');
});

test('short content produces a soft fail recommending needs_changes', () => {
  const gates = evaluateGates(fullInput(baseDraft({
    summary: 'too short',
    content: 'also short',
  })));
  const maturity = gates.find((g) => g.key === 'draft_maturity')!;
  equal(maturity.status, 'fail');
  equal(maturity.severity, 'soft');

  const rec = aggregateRecommendation(gates, { draftId: 'd' });
  equal(rec.verdict, 'needs_changes');
  ok(rec.cons.some((c) => c.key === 'draft_maturity'));
});

test('low-confidence learning signals produce a hard blocker', () => {
  const draft = baseDraft({
    metadata: {
      contextFit: { fitStatus: 'ready', fitScore: 0.9, fitReasons: [], missingSignals: [] },
      learningSignals: [
        { kind: 'tip', text: 'maybe', confidence: 0.3 },
      ],
    },
  });
  const gates = evaluateGates(fullInput(draft));
  const conf = gates.find((g) => g.key === 'signal_confidence')!;
  equal(conf.status, 'fail');
  equal(conf.severity, 'hard');
  const rec = aggregateRecommendation(gates, { draftId: 'd' });
  equal(rec.verdict, 'reject');
});

test('missing session info produces unknown gates and medium confidence approval', () => {
  const draft = baseDraft();
  const gates = evaluateGates({ draft, mode: 'auto' });
  ok(gates.some((g) => g.status === 'unknown'));
  const rec = aggregateRecommendation(gates, { draftId: 'd' });
  equal(rec.verdict, 'approve');
  equal(rec.confidence, 'medium');
  equal(rec.canAutoApprove, false, 'cannot auto-approve when session signals are missing');
});

test('off learning mode produces a soft fail but does not block approval', () => {
  const gates = evaluateGates(fullInput(baseDraft(), { mode: 'off' }));
  const modeGate = gates.find((g) => g.key === 'learning_mode')!;
  equal(modeGate.status, 'fail');
  equal(modeGate.severity, 'soft');
  const rec = aggregateRecommendation(gates, { draftId: 'd' });
  equal(rec.verdict, 'needs_changes');
});

test('every GateKey appears exactly once', () => {
  const gates = evaluateGates(fullInput(baseDraft()));
  const seen = new Set<GateKey>();
  for (const gate of gates) {
    ok(!seen.has(gate.key), `duplicate gate ${gate.key}`);
    seen.add(gate.key);
  }
  deepEqual([...seen].sort(), [
    'compliance',
    'concrete_labels',
    'context_fit',
    'distillation_evidence',
    'draft_maturity',
    'duplicates',
    'grounded_references',
    'learning_mode',
    'negative_decisions',
    'noisy_feedback',
    'session_outcome',
    'signal_confidence',
    'write_gate',
  ]);
});
