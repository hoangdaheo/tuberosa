import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { toGraphElements } from '../../src/workbench-v2/viz/graph-data.js';

test('toGraphElements maps items + relations to cy elements', () => {
  const els = toGraphElements({
    items: [
      { id: 'a', title: 'A', itemType: 'code_ref', score: 0.9, labels: ['x'] },
      { id: 'b', title: 'B', itemType: 'spec', score: 0.7, labels: ['x'] },
    ],
    relations: [{ sourceId: 'a', targetId: 'b', kind: 'related_to' }],
  });
  equal(els.length, 3);
  ok(els.find((e) => e.data.id === 'a'));
  ok(els.find((e) => e.data.source === 'a' && e.data.target === 'b'));
});
