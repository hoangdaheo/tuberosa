import test from 'node:test';
import { equal } from 'node:assert/strict';
import { shouldFail, DEFAULT_HIT_RATE_THRESHOLD, type CliOptions } from '../scripts/eval-retrieval.js';

const baseOpts: CliOptions = { fixturePath: 'test', topK: 5, json: false, help: false };
import type { RetrievalEvalReport } from '../src/evaluation/retrieval-evaluator.js';

function makeReport(metrics: { hitRate: number | null }, cases: { passed: boolean }[]): RetrievalEvalReport {
  return {
    fixturePath: 'test',
    generatedAt: new Date().toISOString(),
    metrics: {
      total: cases.length,
      passed: cases.filter((c) => c.passed).length,
      failed: cases.filter((c) => !c.passed).length,
      hitRate: metrics.hitRate,
      staleRejectionRate: 1.0,
      classificationAccuracy: {} as never,
    },
    cases: cases.map((c, i) => ({ name: `case-${i}`, passed: c.passed } as never)),
  } as unknown as RetrievalEvalReport;
}

test('DEFAULT_HIT_RATE_THRESHOLD is 1.0 (CLAUDE.md invariant)', () => {
  equal(DEFAULT_HIT_RATE_THRESHOLD, 1.0);
});

test('shouldFail returns true when hitRate < 1.0 even with no explicit threshold', () => {
  const report = makeReport({ hitRate: 0.9 }, [{ passed: true }, { passed: true }]);
  equal(shouldFail(report, baseOpts), true);
});

test('shouldFail returns false at hitRate=1.0 with no failed cases and default threshold', () => {
  const report = makeReport({ hitRate: 1.0 }, [{ passed: true }, { passed: true }]);
  equal(shouldFail(report, baseOpts), false);
});

test('shouldFail still returns true when any case failed, regardless of hitRate', () => {
  const report = makeReport({ hitRate: 1.0 }, [{ passed: true }, { passed: false }]);
  equal(shouldFail(report, baseOpts), true);
});

test('shouldFail respects explicit lower threshold for soft eval runs', () => {
  const report = makeReport({ hitRate: 0.8 }, [{ passed: true }]);
  equal(shouldFail(report, { ...baseOpts, failUnderHitRate: 0.7 }), false);
  equal(shouldFail(report, { ...baseOpts, failUnderHitRate: 0.9 }), true);
});
