import test from 'node:test';
import { equal, deepEqual, throws } from 'node:assert/strict';
import { z } from 'zod';
import { parseOrThrow, zRequiredString } from '../src/schemas/primitives.js';
import { validateContextSearchInput } from '../src/validation.js';
import { ValidationError } from '../src/errors.js';

test('parseOrThrow returns parsed value on success', () => {
  const schema = z.object({ prompt: z.string() });
  deepEqual(parseOrThrow(schema, { prompt: 'x' }, 'ctx'), { prompt: 'x' });
});

test('parseOrThrow throws ValidationError with details on failure', () => {
  const schema = z.object({ prompt: z.string() });
  throws(
    () => parseOrThrow(schema, { prompt: 42 }, 'context search input'),
    (err: unknown) =>
      err instanceof ValidationError &&
      err.code === 'validation_error' &&
      err.status === 400 &&
      Array.isArray((err as ValidationError).details) &&
      ((err as ValidationError).details as Array<{ path: string }>).some((d) => d.path.includes('prompt')),
  );
});

test('zRequiredString rejects empty and whitespace-only, accepts non-blank without trimming', () => {
  equal(zRequiredString.safeParse('').success, false);
  equal(zRequiredString.safeParse('   ').success, false);
  const ok = zRequiredString.safeParse('  x  ');
  equal(ok.success, true);
  if (ok.success) equal(ok.data, '  x  '); // not trimmed
});

test('contextSearch: taskType alias bugfix -> debugging', () => {
  equal(validateContextSearchInput({ prompt: 'x', taskType: 'bugfix' }).taskType, 'debugging');
});
test('contextSearch: taskType alias coding -> implementation', () => {
  equal(validateContextSearchInput({ prompt: 'x', taskType: 'coding' }).taskType, 'implementation');
});
test('contextSearch: tokenBudget clamps to 200000', () => {
  equal(validateContextSearchInput({ prompt: 'x', tokenBudget: 9_999_999 }).tokenBudget, 200_000);
});
test('contextSearch: oversized prompt rejected', () => {
  throws(() => validateContextSearchInput({ prompt: 'a'.repeat(2_000_001) }));
});
test('contextSearch: too-many files rejected', () => {
  throws(() => validateContextSearchInput({ prompt: 'x', files: Array.from({ length: 4097 }, (_, i) => `f${i}.ts`) }));
});
test('contextSearch: namespace null treated as absent', () => {
  equal(validateContextSearchInput({ prompt: 'x', namespace: null }).namespace, undefined);
});
test('contextSearch: non-finite tokenBudget rejected', () => {
  throws(() => validateContextSearchInput({ prompt: 'x', tokenBudget: Infinity }));
});
