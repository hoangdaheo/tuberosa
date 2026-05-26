import test from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';
import { parseHash, routeToHash } from '../../src/workbench-v2/state/routes.js';

test('parseHash', () => {
  deepEqual(parseHash(''), { chapter: 1 });
  deepEqual(parseHash('#/ch5'), { chapter: 5 });
  deepEqual(parseHash('#/ch5/node/abc'), { chapter: 5, graphNodeId: 'abc' });
  deepEqual(parseHash('#/ch9/session/s-1'), { chapter: 9, sessionId: 's-1' });
  deepEqual(parseHash('#/cheese'), { chapter: 1 });
});

test('routeToHash', () => {
  equal(routeToHash({ chapter: 1 }), '#/ch1');
  equal(routeToHash({ chapter: 5, graphNodeId: 'abc' }), '#/ch5/node/abc');
  equal(routeToHash({ chapter: 9, sessionId: 's-1' }), '#/ch9/session/s-1');
});
