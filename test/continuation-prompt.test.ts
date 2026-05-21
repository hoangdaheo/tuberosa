import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isContinuationPrompt } from '../src/retrieval/service.js';

test('isContinuationPrompt matches genuine continuation phrases', () => {
  const positives = [
    'Continue the current Phase 8 context hardening work from the roadmap',
    'continue the work on retrieval suppression',
    'Continue the task we started yesterday',
    'continue from where we left off',
    'resume the work on agent compliance',
    'resume my session',
    'pick up where we stopped',
    'where we left off last sprint',
    'apply the latest handoff notes',
    'apply the latest hand-off notes',
    'continue the previous investigation',
  ];

  for (const prompt of positives) {
    assert.ok(isContinuationPrompt(prompt), `expected continuation match: ${prompt}`);
  }
});

test('isContinuationPrompt rejects prompts that merely mention "continue" or "current"', () => {
  const negatives = [
    'current rate limit policy',
    'show the current deploy runbook',
    'continue using strict mode',
    'we should continue caching the result',
    'tests continue to pass after the refactor',
    'the current Phase 8 retrieval policy',
    'how does the current authentication flow work',
    'list current open knowledge gaps',
  ];

  for (const prompt of negatives) {
    assert.equal(isContinuationPrompt(prompt), false, `expected NOT a continuation: ${prompt}`);
  }
});
