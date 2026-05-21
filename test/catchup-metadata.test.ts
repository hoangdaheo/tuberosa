import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCatchupMetadata } from '../src/operations/catchup.js';
import { writeLastEval } from '../src/operations/last-eval.js';

test('getCatchupMetadata returns config, project goal, roadmap, and sandbox headline when all sources exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'tuberosa-catchup-'));
  const docsDir = join(root, 'docs');
  const configDir = join(root, 'config');
  const sandboxDir = join(root, 'eval', 'sandbox');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(sandboxDir, { recursive: true });

  const projectGoalPath = join(docsDir, 'tuberosa-project.md');
  const roadmapPath = join(root, 'roadmap.md');
  writeFileSync(projectGoalPath, '# Project intent\nTuberosa is a local-first context broker.');
  writeFileSync(roadmapPath, '# Roadmap\nPhase 11 — observability.');

  const configPath = join(configDir, 'catchup.json');
  writeFileSync(configPath, JSON.stringify({
    projectGoalDocPath: 'docs/tuberosa-project.md',
    currentPhase: 'Phase 11',
    roadmapDocPath: 'roadmap.md',
    knownIssues: [
      { id: 'T1', title: 'sample open issue', status: 'open' },
      { id: 'T2', title: 'sample done issue', status: 'done' },
    ],
    keyMcpTools: [
      { name: 'tuberosa_start_session', purpose: 'open session', minArgs: ['prompt', 'project'] },
    ],
  }));

  const sandboxPath = join(sandboxDir, 'report.md');
  writeFileSync(sandboxPath, [
    '# Sandbox Report',
    '',
    '## Headline Metrics',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    '| hit rate | 95.5% |',
    '| MRR | 0.4882 |',
    '| noise rate | 9.1% |',
    '| stale suppression | 100.0% |',
    '| duplicate suppression | 100.0% |',
    '| adversarial block rate | 100.0% |',
    '| latency p50 / p95 / max (ms) | 14 / 19 / 56 |',
    '',
    '**Status:** all thresholds passed.',
    '',
  ].join('\n'));

  const lastEvalPath = join(root, 'last-eval.json');
  writeLastEval({
    status: 'pass',
    generatedAt: '2026-05-21T12:00:00.000Z',
    totalCases: 14,
    passedCases: 14,
    fixtureName: 'default retrieval quality',
    project: 'newsletter-app',
    metrics: { hitRate: 1, meanReciprocalRank: 1, exactFileMatchRate: 1 },
  }, { path: lastEvalPath });

  try {
    const meta = getCatchupMetadata({ configPath, sandboxReportPath: sandboxPath, lastEvalPath });

    assert.equal(meta.configExists, true);
    assert.ok(meta.retrievalEval, 'retrieval eval should be loaded');
    assert.equal(meta.retrievalEval?.status, 'pass');
    assert.equal(meta.retrievalEval?.passedCases, 14);
    assert.equal(meta.retrievalEval?.metrics.hitRate, 1);
    assert.equal(meta.currentPhase, 'Phase 11');
    assert.equal(meta.projectGoal.exists, true);
    assert.ok(meta.projectGoal.content?.includes('local-first context broker'));
    assert.equal(meta.roadmap.exists, true);
    assert.ok(meta.roadmap.content?.includes('Phase 11'));
    assert.equal(meta.knownIssues.length, 2);
    assert.equal(meta.knownIssues[0].status, 'open');
    assert.equal(meta.keyMcpTools.length, 1);
    assert.equal(meta.keyMcpTools[0].name, 'tuberosa_start_session');
    assert.ok(meta.sandbox, 'sandbox report should be parsed');
    assert.equal(meta.sandbox?.status, 'pass');
    assert.equal(meta.sandbox?.headline.hitRate, 0.955);
    assert.equal(meta.sandbox?.headline.latencyP95, 19);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getCatchupMetadata degrades gracefully when config is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'tuberosa-catchup-'));
  try {
    const meta = getCatchupMetadata({
      configPath: join(root, 'missing-config.json'),
      sandboxReportPath: join(root, 'missing-report.md'),
      lastEvalPath: join(root, 'missing-last-eval.json'),
    });
    assert.equal(meta.configExists, false);
    assert.equal(meta.currentPhase, undefined);
    assert.equal(meta.projectGoal.exists, false);
    assert.equal(meta.roadmap.exists, false);
    assert.deepEqual(meta.knownIssues, []);
    assert.deepEqual(meta.keyMcpTools, []);
    assert.equal(meta.sandbox, null);
    assert.equal(meta.retrievalEval, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
