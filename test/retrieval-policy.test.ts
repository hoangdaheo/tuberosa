import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, freshnessWindowFor, loadRetrievalPolicy, resetRetrievalPolicyCache } from '../src/retrieval/policy.js';

test('DEFAULT_POLICY exposes Phase 2 knobs with sensible defaults', () => {
  assert.equal(DEFAULT_POLICY.useFreshnessMap, true);
  assert.equal(DEFAULT_POLICY.duplicateDetector, 'on');
  assert.equal(DEFAULT_POLICY.duplicateJaccardThreshold >= 0.8, true);
  assert.equal(DEFAULT_POLICY.duplicateCosineThreshold >= 0.9, true);
  assert.equal(DEFAULT_POLICY.piiRedaction.emails, false);
  assert.equal(DEFAULT_POLICY.piiRedaction.phones, false);
  assert.equal(DEFAULT_POLICY.piiRedaction.ipv4, false);
  assert.equal(DEFAULT_POLICY.suppressionEnabled.domainMismatch, true);
  assert.equal(DEFAULT_POLICY.suppressionEnabled.stale, true);
});

test('freshnessWindowFor returns per-itemType windows for every KnowledgeItemType', () => {
  const itemTypes = ['spec', 'workflow', 'memory', 'bugfix', 'code_ref', 'rule', 'wiki', 'conversation'] as const;
  for (const itemType of itemTypes) {
    const window = freshnessWindowFor(DEFAULT_POLICY, itemType);
    assert.ok(window.currentDays > 0, `currentDays for ${itemType} should be positive`);
    assert.ok(window.staleDays > window.currentDays, `staleDays for ${itemType} should exceed currentDays`);
  }
});

test('loadRetrievalPolicy merges JSON overrides over DEFAULT_POLICY', () => {
  resetRetrievalPolicyCache();
  const dir = mkdtempSync(join(tmpdir(), 'tuberosa-policy-'));
  const path = join(dir, 'policy.json');
  writeFileSync(path, JSON.stringify({
    duplicateJaccardThreshold: 0.5,
    piiRedaction: { emails: true },
    domainMismatch: { mismatchPenalty: -0.1 },
  }));
  const previous = process.env.TUBEROSA_RETRIEVAL_POLICY;
  process.env.TUBEROSA_RETRIEVAL_POLICY = path;
  try {
    const policy = loadRetrievalPolicy();
    assert.equal(policy.duplicateJaccardThreshold, 0.5);
    assert.equal(policy.piiRedaction.emails, true);
    assert.equal(policy.piiRedaction.phones, false, 'unspecified pii flag should fall back to default');
    assert.equal(policy.domainMismatch.mismatchPenalty, -0.1);
    assert.equal(policy.domainMismatch.enabled, DEFAULT_POLICY.domainMismatch.enabled);
    assert.deepEqual(policy.sourceWeights, DEFAULT_POLICY.sourceWeights);
  } finally {
    if (previous === undefined) delete process.env.TUBEROSA_RETRIEVAL_POLICY;
    else process.env.TUBEROSA_RETRIEVAL_POLICY = previous;
    rmSync(dir, { recursive: true, force: true });
    resetRetrievalPolicyCache();
  }
});

test('loadRetrievalPolicy returns DEFAULT_POLICY when override path is missing', () => {
  resetRetrievalPolicyCache();
  const previous = process.env.TUBEROSA_RETRIEVAL_POLICY;
  process.env.TUBEROSA_RETRIEVAL_POLICY = join(tmpdir(), 'tuberosa-missing-policy.json');
  try {
    const policy = loadRetrievalPolicy();
    assert.deepEqual(policy, DEFAULT_POLICY);
  } finally {
    if (previous === undefined) delete process.env.TUBEROSA_RETRIEVAL_POLICY;
    else process.env.TUBEROSA_RETRIEVAL_POLICY = previous;
    resetRetrievalPolicyCache();
  }
});
