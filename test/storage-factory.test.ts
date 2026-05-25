import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import type { AppConfig } from '../src/config.js';
import { createKnowledgeStore } from '../src/storage/factory.js';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { PostgresKnowledgeStore } from '../src/storage/postgres-store.js';

function configFor(store: 'memory' | 'postgres'): AppConfig {
  return {
    store,
    databaseUrl: 'postgres://tuberosa:tuberosa@localhost:5432/tuberosa',
  } as AppConfig;
}

test('createKnowledgeStore returns MemoryKnowledgeStore when store=memory', () => {
  const store = createKnowledgeStore(configFor('memory'));
  ok(store instanceof MemoryKnowledgeStore);
});

test('createKnowledgeStore returns PostgresKnowledgeStore when store=postgres', () => {
  // Construction does not open the pool eagerly so this is safe without Docker.
  const store = createKnowledgeStore(configFor('postgres'));
  ok(store instanceof PostgresKnowledgeStore);
  // Best-effort cleanup so the test process can exit cleanly.
  void (store as unknown as { close?: () => Promise<void> }).close?.().catch(() => {});
});

test('createKnowledgeStore returns the same class across repeated calls', () => {
  const a = createKnowledgeStore(configFor('memory'));
  const b = createKnowledgeStore(configFor('memory'));
  equal(a.constructor, b.constructor);
});
