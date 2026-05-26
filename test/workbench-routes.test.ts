import test from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import {
  DEFAULT_WORKBENCH_ROUTE,
  parseWorkbenchHash,
  routeToHash,
  type WorkbenchRoute,
} from '../src/workbench/state/routes.js';

test('workbench routes parse new top-level surfaces', () => {
  deepEqual(parseWorkbenchHash('#/start'), { view: 'start' });
  deepEqual(parseWorkbenchHash('#/sessions'), { view: 'sessions' });
  deepEqual(parseWorkbenchHash('#/session/session-123'), { view: 'session', sessionId: 'session-123' });
  deepEqual(parseWorkbenchHash('#/review?filter=gaps'), { view: 'review', filter: 'gaps' });
  deepEqual(parseWorkbenchHash('#/knowledge'), { view: 'knowledge' });
  deepEqual(parseWorkbenchHash('#/playbooks/missing-context'), { view: 'playbooks', playbookId: 'missing-context' });
  deepEqual(parseWorkbenchHash('#/system'), { view: 'system' });
});

test('workbench route serialization keeps canonical hashes', () => {
  const cases: WorkbenchRoute[] = [
    { view: 'start' },
    { view: 'sessions' },
    { view: 'session', sessionId: 'session-123' },
    { view: 'review', filter: 'drafts' },
    { view: 'knowledge' },
    { view: 'playbooks', playbookId: 'first-task' },
    { view: 'system' },
  ];

  equal(routeToHash(cases[0]), '#/start');
  equal(routeToHash(cases[1]), '#/sessions');
  equal(routeToHash(cases[2]), '#/session/session-123');
  equal(routeToHash(cases[3]), '#/review?filter=drafts');
  equal(routeToHash(cases[4]), '#/knowledge');
  equal(routeToHash(cases[5]), '#/playbooks/first-task');
  equal(routeToHash(cases[6]), '#/system');
});

test('unknown hashes fall back to Start', () => {
  deepEqual(parseWorkbenchHash(''), DEFAULT_WORKBENCH_ROUTE);
  deepEqual(parseWorkbenchHash('#/overview'), DEFAULT_WORKBENCH_ROUTE);
  deepEqual(parseWorkbenchHash('#/memory/drafts'), DEFAULT_WORKBENCH_ROUTE);
});
