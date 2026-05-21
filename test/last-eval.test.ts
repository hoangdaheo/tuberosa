import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLastEval, writeLastEval } from '../src/operations/last-eval.js';

test('writeLastEval persists a pass record and readLastEval round-trips it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tuberosa-last-eval-'));
  const path = join(dir, 'last-eval.json');
  try {
    writeLastEval({
      status: 'pass',
      generatedAt: '2026-05-21T12:00:00.000Z',
      totalCases: 14,
      passedCases: 14,
      fixtureName: 'default retrieval quality',
      project: 'newsletter-app',
      metrics: { hitRate: 1, meanReciprocalRank: 1 },
    }, { path });

    const raw = readFileSync(path, 'utf8');
    assert.match(raw, /"status": "pass"/);
    assert.match(raw, /"fixtureName": "default retrieval quality"/);

    const parsed = readLastEval({ path });
    assert.ok(parsed);
    assert.equal(parsed.status, 'pass');
    assert.equal(parsed.totalCases, 14);
    assert.equal(parsed.passedCases, 14);
    assert.equal(parsed.metrics.hitRate, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLastEval returns null when the sentinel is missing or malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tuberosa-last-eval-'));
  try {
    assert.equal(readLastEval({ path: join(dir, 'absent.json') }), null);

    const malformed = join(dir, 'broken.json');
    writeLastEval({
      status: 'pass',
      generatedAt: '2026-05-21T12:00:00.000Z',
      totalCases: 0,
      passedCases: 0,
      metrics: {},
    }, { path: malformed });
    const broken = readFileSync(malformed, 'utf8').replace('"status": "pass"', '"status": "weird"');
    writeFileSync(malformed, broken);
    assert.equal(readLastEval({ path: malformed }), null, 'invalid status should be rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
