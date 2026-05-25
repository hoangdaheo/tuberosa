import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { deepEqual, ok } from 'node:assert/strict';

test('migrations/: only one 002_* file remains, with explicit 003_ cleanup', async () => {
  const files = (await readdir('migrations')).filter((f) => f.endsWith('.sql')).sort();
  const m002 = files.filter((f) => f.startsWith('002_'));
  deepEqual(m002, ['002_learning_review_records.sql'], 'only the non-duplicate 002 file should remain');
  ok(files.includes('003_cleanup_dup_002s.sql'), '003_cleanup_dup_002s.sql must exist to prune orphan schema_migrations rows');
});
