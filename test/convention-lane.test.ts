import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { makeTestConfig } from './support/test-config.js';

function withTeamId(teamId: string) {
  return makeTestConfig({ userStyle: { teamId } });
}

test('searchContext: team convention atom surfaces cross-project via convention source', async () => {
  const store = new MemoryKnowledgeStore();
  const config = withTeamId('team-acme');
  const claim = 'All implementation work must update the changelog before merging.';
  await store.createAtom({
    project: 'platform-conventions',
    claim,
    type: 'convention',
    evidence: [],
    trigger: { taskTypes: ['implementation'] },
    producedBy: 'user',
    scope: 'team',
    teamId: 'team-acme',
  });

  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), config);
  const pack = await service.searchContext({
    project: 'some-OTHER-project',
    prompt: 'implementation of the new payment feature',
    taskType: 'implementation',
  });

  const items = pack.sections.flatMap((s) => s.items);
  const conventionHit = items.find((i) => i.source === 'convention');
  assert.ok(
    conventionHit,
    `expected a convention-source item; got sources ${JSON.stringify(items.map((i) => i.source))}`,
  );
  assert.equal(conventionHit?.title, claim);
});

test('searchContext: project convention atom surfaces via convention source for the same project', async () => {
  const store = new MemoryKnowledgeStore();
  const config = withTeamId('team-acme');
  const claim = 'Refactors in this project must keep public exports backward-compatible.';
  await store.createAtom({
    project: 'payments-service',
    claim,
    type: 'convention',
    evidence: [],
    trigger: { taskTypes: ['refactor'] },
    producedBy: 'user',
    scope: 'project',
  });

  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), config);
  const pack = await service.searchContext({
    project: 'payments-service',
    prompt: 'refactor of the settlement module',
    taskType: 'refactor',
  });

  const items = pack.sections.flatMap((s) => s.items);
  const conventionHit = items.find((i) => i.source === 'convention');
  assert.ok(
    conventionHit,
    `expected a convention-source item; got sources ${JSON.stringify(items.map((i) => i.source))}`,
  );
  assert.equal(conventionHit?.title, claim);
});
