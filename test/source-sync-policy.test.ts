import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyPath, DEFAULT_SYNC_POLICY } from '../src/source-sync/policy.js';

test('policy: source + docs are included', () => {
  assert.equal(classifyPath('src/a.ts', 10, DEFAULT_SYNC_POLICY).include, true);
  assert.equal(classifyPath('docs/x.md', 10, DEFAULT_SYNC_POLICY).include, true);
});

test('policy: lockfiles, dist, env, binaries are excluded with a reason', () => {
  assert.deepEqual(classifyPath('pnpm-lock.yaml', 10, DEFAULT_SYNC_POLICY), { include: false, reason: 'excluded' });
  assert.deepEqual(classifyPath('dist/a.js', 10, DEFAULT_SYNC_POLICY), { include: false, reason: 'excluded' });
  assert.deepEqual(classifyPath('.env', 10, DEFAULT_SYNC_POLICY), { include: false, reason: 'excluded' });
  assert.deepEqual(classifyPath('img/logo.png', 10, DEFAULT_SYNC_POLICY), { include: false, reason: 'binary' });
});

test('policy: oversized files are ignored as too_large', () => {
  assert.deepEqual(classifyPath('src/big.ts', 999_999_999, DEFAULT_SYNC_POLICY), { include: false, reason: 'too_large' });
});
