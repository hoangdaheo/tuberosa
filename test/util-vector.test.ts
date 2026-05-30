import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { cosineSimilarity } from '../src/util/vector.js';

test('cosineSimilarity: identical vectors → 1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
});
test('cosineSimilarity: orthogonal → 0', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});
test('cosineSimilarity: zero vector or empty → 0', () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([], [1]), 0);
});
