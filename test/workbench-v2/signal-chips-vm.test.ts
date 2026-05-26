import test from 'node:test';
import { deepEqual } from 'node:assert/strict';
import { toSignalChips } from '../../src/workbench-v2/viz/signal-chips-vm.js';

test('toSignalChips groups by kind and preserves order', () => {
  const chips = toSignalChips({
    symbols: ['Foo', 'Bar'],
    errors: ['ENOENT'],
    files: ['a.ts'],
    businessAreas: [],
    technologies: [],
    taskType: 'implement',
  });
  deepEqual(chips, [
    { kind: 'task', label: 'implement' },
    { kind: 'symbol', label: 'Foo' },
    { kind: 'symbol', label: 'Bar' },
    { kind: 'file', label: 'a.ts' },
    { kind: 'error', label: 'ENOENT' },
  ]);
});
