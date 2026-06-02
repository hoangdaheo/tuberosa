import test from 'node:test';
import { equal, deepEqual, throws } from 'node:assert/strict';
import { z } from 'zod';
import { parseOrThrow, zRequiredString } from '../src/schemas/primitives.js';
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
