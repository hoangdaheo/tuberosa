import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { evaluateTierTransition } from '../src/atoms/tier.js';
import type { KnowledgeAtom } from '../src/types/atoms.js';

function atom(overrides: Partial<KnowledgeAtom> = {}): KnowledgeAtom {
  return {
    id: 'a1',
    project: 'tuberosa',
    claim: 'x',
    type: 'fact',
    evidence: [{ kind: 'file', path: 'a.ts' }],
    trigger: { errors: ['e'] },
    tier: 'draft',
    reuseCount: 0,
    status: 'active',
    audit: { producedBy: 'agent_session', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ...overrides,
  };
}

const NOW = new Date('2026-05-26T00:00:00Z');

test('evaluateTierTransition: draft → verified when verification + reuseCount ≥ 2 + recent', () => {
  const a = atom({
    tier: 'draft',
    reuseCount: 2,
    lastReusedAt: new Date('2026-05-01T00:00:00Z').toISOString(),
    verification: { command: 'pnpm test' },
  });
  const next = evaluateTierTransition(a, NOW);
  assert.equal(next, 'verified');
});

test('evaluateTierTransition: draft stays draft without verification field', () => {
  const a = atom({ tier: 'draft', reuseCount: 5, lastReusedAt: NOW.toISOString() });
  assert.equal(evaluateTierTransition(a, NOW), 'draft');
});

test('evaluateTierTransition: verified → draft after 180 days of no reuse', () => {
  const a = atom({
    tier: 'verified',
    reuseCount: 2,
    lastReusedAt: new Date('2025-10-01T00:00:00Z').toISOString(), // > 180 days ago
    verification: { command: 'pnpm test' },
  });
  assert.equal(evaluateTierTransition(a, NOW), 'draft');
});

test('evaluateTierTransition: canonical is sticky — does not auto-demote', () => {
  const a = atom({
    tier: 'canonical',
    reuseCount: 0,
    lastReusedAt: undefined,
    links: [{ toAtomId: 'b', kind: 'related_to', confidence: 0.9 }],
  });
  assert.equal(evaluateTierTransition(a, NOW), 'canonical');
});
