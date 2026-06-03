import test from 'node:test';
import { equal } from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig defaults exportBaseDir under data dir', () => {
  const prev = { ...process.env };
  delete process.env.TUBEROSA_EXPORT_BASE_DIR;
  delete process.env.TUBEROSA_IMPORT_BASE_DIR;
  try {
    const config = loadConfig();
    equal(config.backup.exportBaseDir, '.tuberosa/exports');
    equal(config.backup.importBaseDir, '.tuberosa/imports');
  } finally {
    process.env = prev;
  }
});

test('loadConfig honors TUBEROSA_EXPORT_BASE_DIR / IMPORT_BASE_DIR overrides', () => {
  const prev = { ...process.env };
  process.env.TUBEROSA_EXPORT_BASE_DIR = '/tmp/exp';
  process.env.TUBEROSA_IMPORT_BASE_DIR = '/tmp/imp';
  try {
    const config = loadConfig();
    equal(config.backup.exportBaseDir, '/tmp/exp');
    equal(config.backup.importBaseDir, '/tmp/imp');
  } finally {
    process.env = prev;
  }
});

import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejects, doesNotReject } from 'node:assert/strict';
import { assertSafeBundlePath, assertSafeChildName } from '../src/security/safe-paths.js';
import { ValidationError } from '../src/errors.js';

test('assertSafeChildName throws canonical ValidationError with status 400', () => {
  try {
    assertSafeChildName('../escape');
    throw new Error('should throw');
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    equal((err as ValidationError).status, 400);
  }
});

test('assertSafeChildName accepts safe POSIX names', () => {
  for (const name of ['atom-1', 'user_style.md', 'a.B-c_1']) {
    assertSafeChildName(name);
  }
});

test('assertSafeChildName rejects traversal and separators', () => {
  for (const name of ['..', '.', 'a/b', 'a\\b', '', 'a\0b', '..foo', 'foo/..']) {
    try {
      assertSafeChildName(name);
      throw new Error(`expected rejection for ${JSON.stringify(name)}`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
    }
  }
});

test('assertSafeBundlePath rejects absolute paths outside base', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-safe-'));
  try {
    await rejects(() => assertSafeBundlePath(base, '/etc/passwd'), ValidationError);
    await rejects(() => assertSafeBundlePath(base, '../escape'), ValidationError);
    await rejects(() => assertSafeBundlePath(base, 'good/../../escape'), ValidationError);
    await rejects(() => assertSafeBundlePath(base, 'has\0nul'), ValidationError);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('assertSafeBundlePath rejects symlink that escapes base', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-safe-'));
  const outside = await mkdtemp(join(tmpdir(), 'tuberosa-outside-'));
  try {
    await mkdir(join(base, 'sub'));
    await symlink(outside, join(base, 'sub', 'evil'));
    await rejects(() => assertSafeBundlePath(base, 'sub/evil'), ValidationError);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('assertSafeBundlePath accepts a non-existent child under base', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-safe-'));
  try {
    await doesNotReject(() => assertSafeBundlePath(base, 'new/sub/dir'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
