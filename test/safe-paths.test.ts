import test from 'node:test';
import { equal } from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig defaults exportBaseDir under data dir', () => {
  const prev = { ...process.env };
  delete process.env.TUBEROSA_EXPORT_BASE_DIR;
  delete process.env.TUBEROSA_IMPORT_BASE_DIR;
  try {
    const config = loadConfig();
    equal(config.exportBaseDir, '.tuberosa/exports');
    equal(config.importBaseDir, '.tuberosa/imports');
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
    equal(config.exportBaseDir, '/tmp/exp');
    equal(config.importBaseDir, '/tmp/imp');
  } finally {
    process.env = prev;
  }
});
