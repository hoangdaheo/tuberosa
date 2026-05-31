import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('teamId defaults to "default" and reads TUBEROSA_TEAM_ID', () => {
  delete process.env.TUBEROSA_TEAM_ID;
  assert.equal(loadConfig().teamId, 'default');
  process.env.TUBEROSA_TEAM_ID = 'acme';
  assert.equal(loadConfig().teamId, 'acme');
  delete process.env.TUBEROSA_TEAM_ID;
});
