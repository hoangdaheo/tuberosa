import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSandboxReport } from '../src/operations/sandbox-report.js';

const SAMPLE_REPORT = `# Sandbox Report

- Seed: \`12648430\`
- Knowledge items: 332
- Prompts: 44

## Headline Metrics

| Metric | Value |
| --- | --- |
| hit rate | 95.5% |
| MRR | 0.4882 |
| noise rate | 9.1% |
| stale suppression | 100.0% |
| duplicate suppression | 100.0% |
| adversarial block rate | 100.0% |
| latency p50 / p95 / max (ms) | 14 / 19 / 56 |

**Status:** all thresholds passed.
`;

test('parseSandboxReport extracts headline metrics from the standard report format', () => {
  const parsed = parseSandboxReport(SAMPLE_REPORT);
  assert.ok(parsed, 'expected a parsed report');
  assert.equal(parsed.status, 'pass');
  assert.equal(parsed.headline.hitRate, 0.955);
  assert.equal(parsed.headline.mrr, 0.4882);
  assert.equal(parsed.headline.noiseRate, 0.091);
  assert.equal(parsed.headline.staleSuppression, 1);
  assert.equal(parsed.headline.duplicateSuppression, 1);
  assert.equal(parsed.headline.adversarialBlock, 1);
  assert.equal(parsed.headline.latencyP50, 14);
  assert.equal(parsed.headline.latencyP95, 19);
  assert.equal(parsed.headline.latencyMax, 56);
});

test('parseSandboxReport returns null on empty input', () => {
  assert.equal(parseSandboxReport(''), null);
  assert.equal(parseSandboxReport('   \n  '), null);
});

test('parseSandboxReport returns unknown status when the footer is missing', () => {
  const noStatus = SAMPLE_REPORT.replace(/\*\*Status:\*\*[^\n]*\n?/g, '');
  const parsed = parseSandboxReport(noStatus);
  assert.ok(parsed);
  assert.equal(parsed.status, 'unknown');
});

test('parseSandboxReport flags failure when status row indicates a failure', () => {
  const failing = SAMPLE_REPORT.replace('all thresholds passed', 'thresholds failed: noiseRate 0.250 > 0.2');
  const parsed = parseSandboxReport(failing);
  assert.ok(parsed);
  assert.equal(parsed.status, 'fail');
});
