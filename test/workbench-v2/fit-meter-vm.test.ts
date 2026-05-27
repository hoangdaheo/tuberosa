import test from 'node:test';
import { equal } from 'node:assert/strict';
import { fitStatusFromScore, fitMeterVM, DEFAULT_FIT_THRESHOLDS } from '../../src/workbench-v2/viz/fit-meter-vm.js';

test('status derives from score and thresholds', () => {
  equal(fitStatusFromScore(0.8, DEFAULT_FIT_THRESHOLDS), 'ready');
  equal(fitStatusFromScore(0.5, DEFAULT_FIT_THRESHOLDS), 'needs_confirmation');
  equal(fitStatusFromScore(0.2, DEFAULT_FIT_THRESHOLDS), 'insufficient');
});

test('fitMeterVM clamps percent and respects explicit status', () => {
  const vm = fitMeterVM({ score: 1.4, status: 'ready' });
  equal(vm.percent, 100);
  equal(vm.status, 'ready');
  equal(vm.label, 'ready');
  const vm2 = fitMeterVM({ score: 0.5 });
  equal(vm2.status, 'needs_confirmation');
  equal(vm2.label, 'needs confirmation');
});
