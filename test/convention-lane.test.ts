import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { loadConfig, type AppConfig } from '../src/config.js';

function withTeamId(teamId: string): AppConfig {
  return { ...loadConfig(), teamId, store: 'memory', cache: 'memory' };
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
