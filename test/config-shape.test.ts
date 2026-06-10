import test from 'node:test';
import { equal } from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig groups storage/model/backup/http with defaults', () => {
  const prev = { ...process.env };
  try {
    delete process.env.TUBEROSA_STORE;
    delete process.env.OPENAI_API_KEY;
    const cfg = loadConfig();
    equal(cfg.storage.store, 'postgres');
    equal(cfg.model.provider, 'local');
    equal(cfg.backup.dir, '.tuberosa/backups');
    equal(cfg.http.host, '127.0.0.1');
  } finally {
    process.env = prev;
  }
});
