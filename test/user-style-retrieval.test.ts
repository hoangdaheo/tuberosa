import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createUserStyleAtom } from '../src/user-style/store-helpers.js';

function withUserId(userId: string | undefined): AppConfig {
  return { ...loadConfig(), userId, userStyleEnabled: true, store: 'memory', cache: 'memory' };
}

test('searchContext: matching user-style atom surfaces with userStyle: matchReason', async () => {
  const store = new MemoryKnowledgeStore();
  await createUserStyleAtom(store, {
    userId: 'alice@example.com',
    claim: 'Prefer named exports for module clarity across all projects.',
    type: 'convention',
    priority: 'coding_preference',
    trigger: { intentTags: ['style'], symbols: ['export'] },
  });
  const config = withUserId('alice@example.com');
  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), config);
  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'how should I export this module',
    symbols: ['export'],
  });
  const items = pack.sections.flatMap((s) => s.items);
  const styleHit = items.find((i) => i.matchReasons?.some((r) => r.startsWith('userStyle:')));
  assert.ok(styleHit, `expected at least one userStyle hit; got ${JSON.stringify(items.map((i) => i.matchReasons))}`);
});

test('searchContext: TUBEROSA_USER_ID unset → no user-style hits', async () => {
  const store = new MemoryKnowledgeStore();
  await createUserStyleAtom(store, {
    userId: 'alice@example.com',
    claim: 'Use Conventional Commits across all my projects.',
    type: 'convention',
    priority: 'coding_preference',
    trigger: { intentTags: ['commit'], symbols: ['commit'] },
  });
  const config = withUserId(undefined);
  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), config);
  const pack = await service.searchContext({
    project: 'tuberosa',
    prompt: 'how to commit',
    symbols: ['commit'],
  });
  const items = pack.sections.flatMap((s) => s.items);
  const styleHit = items.find((i) => i.matchReasons?.some((r) => r.startsWith('userStyle:')));
  assert.equal(styleHit, undefined);
});
