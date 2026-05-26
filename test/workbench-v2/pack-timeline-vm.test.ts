import test from 'node:test';
import { equal } from 'node:assert/strict';
import { toPackVM } from '../../src/workbench-v2/viz/pack-timeline-vm.js';

test('toPackVM totals counts and tokens', () => {
  const vm = toPackVM({
    essential: [
      { id: 'a', title: 'A', tokens: 100 },
      { id: 'b', title: 'B', tokens: 200 },
    ],
    supporting: [{ id: 'c', title: 'C', tokens: 50 }],
    optional: [],
  });
  equal(vm.essential.count, 2);
  equal(vm.essential.tokens, 300);
  equal(vm.totals.tokens, 350);
});
