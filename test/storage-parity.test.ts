import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ok } from 'node:assert/strict';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { PostgresKnowledgeStore } from '../src/storage/postgres-store.js';
import { PARITY_FIXTURES, runFixture } from './support/parity-fixtures.js';
import { ensurePostgresMigrated, POSTGRES_URL, postgresAvailable } from './support/pg.js';

for (const fixture of PARITY_FIXTURES) {
  test(`parity[memory] ${fixture.name}`, async () => {
    const store = new MemoryKnowledgeStore();
    const project = `parity-memory-${randomUUID()}`;
    const { uris } = await runFixture(store, project, fixture);

    for (const expected of fixture.expectedSourceUris) {
      ok(uris.has(expected), `[memory] expected ${expected} in results, got: ${[...uris].join(', ')}`);
    }
    for (const forbidden of fixture.forbiddenSourceUris ?? []) {
      ok(!uris.has(forbidden), `[memory] forbidden ${forbidden} appeared in results`);
    }
  });

  test(`parity[postgres] ${fixture.name}`, async (t) => {
    const available = await postgresAvailable();
    if (!available.ok) {
      t.skip(available.reason);
      return;
    }
    await ensurePostgresMigrated();
    const store = new PostgresKnowledgeStore(POSTGRES_URL);
    const project = `parity-postgres-${randomUUID()}`;
    try {
      const { uris } = await runFixture(store, project, fixture);
      for (const expected of fixture.expectedSourceUris) {
        ok(uris.has(expected), `[postgres] expected ${expected} in results, got: ${[...uris].join(', ')}`);
      }
      for (const forbidden of fixture.forbiddenSourceUris ?? []) {
        ok(!uris.has(forbidden), `[postgres] forbidden ${forbidden} appeared in results`);
      }
    } finally {
      const closable = store as unknown as { close?: () => Promise<void> };
      await closable.close?.().catch(() => {});
    }
  });
}
