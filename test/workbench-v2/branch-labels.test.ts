import test from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { BRANCH_LABELS, branchLabel } from '../../src/workbench-v2/data/branch-labels.js';
import { acmeBilling } from '../../src/workbench-v2/data/fixtures.js';

test('every branch tag used by a prompt has a label', () => {
  for (const p of acmeBilling.prompts) {
    for (const b of p.branches) {
      ok(BRANCH_LABELS[b], `missing label for branch ${b}`);
    }
  }
});

test('branchLabel falls back to the raw tag', () => {
  equal(branchLabel('fit:ready'), 'Fit: ready');
  equal(branchLabel('unknown:tag' as never), 'unknown:tag');
});
