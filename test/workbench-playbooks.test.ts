import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { getPlaybook, listPlaybooks } from '../src/workbench/presenters/playbookPresenter.js';

test('playbooks include required user scenarios', () => {
  const playbooks = listPlaybooks();
  deepEqual(playbooks.map((playbook) => playbook.id), [
    'first-task',
    'missing-context',
    'noisy-context',
    'review-memory',
    'debugging',
    'agent-mcp-examples',
    'cli-api-examples',
  ]);
});

test('missing context playbook includes a runnable workbench action', () => {
  const playbook = getPlaybook('missing-context');

  equal(playbook?.id, 'missing-context');
  ok(playbook?.steps.some((step) => step.action?.kind === 'open_start'));
});
