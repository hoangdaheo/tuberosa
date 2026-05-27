import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { GateTelemetry } from '../src/atoms/gate-telemetry.js';

test('GateTelemetry.record: writes one row per call and reads back via list', async () => {
  const store = new MemoryKnowledgeStore();
  const telemetry = new GateTelemetry(store);
  await telemetry.record({
    project: 'tuberosa', candidateClaim: 'ran tests, passed', candidateType: 'fact',
    stage: 'triviality', outcome: 'rejected', reasons: ['triviality:test_result'],
  });
  await telemetry.record({
    project: 'tuberosa', candidateClaim: 'good claim', candidateType: 'fact',
    stage: 'floor', outcome: 'accepted', reasons: [],
  });
  const events = await store.listAtomGateEvents({ project: 'tuberosa', windowDays: 30, limit: 100 });
  assert.equal(events.length, 2);
  assert.ok(events.some((e) => e.stage === 'triviality' && e.outcome === 'rejected'));
});

test('GateTelemetry.record: never throws on degraded write', async () => {
  // Telemetry MUST be best-effort — a gate decision must never fail because
  // we couldn't record a row. Force the store to fail and observe no throw.
  const failingStore = {
    recordAtomGateEvent: async () => { throw new Error('db down'); },
    listAtomGateEvents: async () => [],
  } as unknown as MemoryKnowledgeStore;
  const telemetry = new GateTelemetry(failingStore);
  await telemetry.record({
    project: 'tuberosa', candidateClaim: 'c', candidateType: 'fact',
    stage: 'triviality', outcome: 'rejected', reasons: ['r'],
  });
  assert.ok(true, 'reached without throw');
});
