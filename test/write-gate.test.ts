import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { computeWriteGate, type WriteGateDraftSnapshot, type WriteGateInputCandidate } from '../src/reflection/write-gate.js';
import type { ModelProvider } from '../src/model/provider.js';

function draft(overrides: Partial<WriteGateDraftSnapshot> = {}): WriteGateDraftSnapshot {
  return {
    title: 'Always X',
    summary: 'Always X summary',
    content: 'Always X content',
    labels: [],
    references: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<WriteGateInputCandidate> = {}): WriteGateInputCandidate {
  return {
    knowledgeId: '11111111-1111-1111-1111-111111111111',
    title: 'Existing memory',
    summary: 'Existing summary',
    content: 'Existing content',
    labels: [],
    references: [],
    rawScore: 0.5,
    ...overrides,
  };
}

test('computeWriteGate returns ADD when no candidates exist', async () => {
  const result = await computeWriteGate({ draft: draft(), candidates: [] });
  equal(result.decision, 'ADD');
  equal(result.evidenceIds.length, 0);
});

test('computeWriteGate returns NOOP at high cosine + high label overlap', async () => {
  // No models => cosineFn uses clampCosine(rawScore). High rawScore + high label overlap = NOOP.
  const labels = [
    { type: 'file' as const, value: 'src/foo.ts', weight: 1 },
    { type: 'symbol' as const, value: 'FooBar', weight: 1 },
  ];
  const result = await computeWriteGate({
    draft: draft({ labels }),
    candidates: [candidate({ labels, rawScore: 0.95 })],
  });
  equal(result.decision, 'NOOP');
  equal(result.evidenceIds[0], candidate().knowledgeId);
});

test('computeWriteGate returns DELETE when high cosine + contradicting file paths share a basename', async () => {
  const sharedLabel = { type: 'symbol' as const, value: 'Sender', weight: 1 };
  const result = await computeWriteGate({
    draft: draft({
      labels: [sharedLabel],
      references: [{ type: 'file', uri: 'src/email/sender.ts' }],
    }),
    candidates: [candidate({
      labels: [sharedLabel],
      references: [{ type: 'file', uri: 'src/legacy/email/sender.ts' }],
      rawScore: 0.9,
    })],
  });
  equal(result.decision, 'DELETE');
});

test('computeWriteGate returns UPDATE when partial match plus novel content tokens', async () => {
  const sharedLabel = { type: 'file' as const, value: 'src/foo.ts', weight: 1 };
  const result = await computeWriteGate({
    draft: draft({
      content: 'novel-fact-token-one novel-fact-token-two novel-fact-token-three novel-fact-token-four',
      labels: [sharedLabel],
    }),
    candidates: [candidate({
      content: 'completely unrelated body text without overlap',
      labels: [sharedLabel],
      rawScore: 0.85,
    })],
  });
  equal(result.decision, 'UPDATE');
});

test('computeWriteGate falls back to ADD when partial-only similarity and no novelty', async () => {
  // Low cosine, even with label overlap → ADD path.
  const result = await computeWriteGate({
    draft: draft(),
    candidates: [candidate({ rawScore: 0.3 })],
  });
  equal(result.decision, 'ADD');
  // Closest is still reported for downstream callers.
  ok(result.closestKnowledgeId);
});

test('computeWriteGate refuses to auto-decide stronger than ADD when embedding requested but unavailable', async () => {
  // Audit P1: when models.embed returns [], cosineFn silently falls back to rawScore
  // and can NOOP / UPDATE / DELETE on the lexical proxy. The fix: if embeddings were
  // requested (models supplied) but the draft embedding is empty/missing, force ADD.
  const failingModels: ModelProvider = {
    async embed() { return []; },
    async rewriteQuery() { return undefined; },
    async rerank() { return { candidates: [], model: 'noop' }; },
  };
  const labels = [
    { type: 'file' as const, value: 'src/foo.ts', weight: 1 },
    { type: 'symbol' as const, value: 'FooBar', weight: 1 },
  ];
  const result = await computeWriteGate({
    draft: draft({ labels }),
    candidates: [candidate({ labels, rawScore: 0.95 })],
    models: failingModels,
  });
  equal(result.decision, 'ADD', 'expected ADD when embedding requested but unavailable');
});
