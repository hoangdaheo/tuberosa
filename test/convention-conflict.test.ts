import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { MemoryCache } from '../src/cache.js';
import { HashModelProvider } from '../src/model/provider.js';
import { RetrievalService } from '../src/retrieval/service.js';
import { makeTestConfig } from './support/test-config.js';
import { createUserStyleAtom } from '../src/user-style/store-helpers.js';

// Phase 2 Task 4: the pack conflict resolver is the 3-layer resolveLayeredConflicts.
// A team convention must beat a personal coding_preference. The distinguishing
// signal vs. the old 2-layer resolveStyleConflicts is the instruction copy:
// the layered resolver labels the winner "Team convention: ...", whereas the old
// resolver treats the team convention as a generic project candidate and emits
// "Project convention: ...". Both suppress the user candidate, so we assert on copy.
test('searchContext: team convention beats personal coding_preference (Team convention copy)', async () => {
  const store = new MemoryKnowledgeStore();

  // (a) team-scope convention atom.
  await store.createAtom({
    project: 'platform-conventions',
    claim: 'Use named exports.',
    type: 'convention',
    evidence: [],
    trigger: { intentTags: ['style'], symbols: ['export'] },
    producedBy: 'user',
    scope: 'team',
    teamId: 'team-acme',
  });

  // (b) personal coding_preference user-style atom that directly contradicts (a).
  await createUserStyleAtom(store, {
    userId: 'alice@example.com',
    claim: 'Never use named exports.',
    type: 'convention',
    priority: 'coding_preference',
    trigger: { intentTags: ['style'], symbols: ['export'] },
  });

  const config = makeTestConfig({ teamId: 'team-acme', userId: 'alice@example.com', userStyleEnabled: true });
  const service = new RetrievalService(store, new MemoryCache(), new HashModelProvider(), config);

  const pack = await service.searchContext({
    project: 'some-OTHER-project',
    prompt: 'how should I export this module',
    symbols: ['export'],
  });

  const items = pack.sections.flatMap((s) => s.items);

  // Team convention survives.
  const teamHit = items.find((i) => i.title === 'Use named exports.');
  assert.ok(
    teamHit,
    `expected the team convention to survive; got titles ${JSON.stringify(items.map((i) => i.title))}`,
  );

  // Personal coding_preference is suppressed (yields to the team layer).
  const userHit = items.find((i) => i.matchReasons?.some((r) => r.startsWith('userStyle:coding_preference:')));
  assert.equal(userHit, undefined, 'coding_preference user-style atom should be suppressed by the team layer');

  // Layered resolver labels the winning layer "Team convention"; the old 2-layer
  // resolver would have said "Project convention" here.
  assert.ok(
    pack.instruction?.toLowerCase().includes('team convention'),
    `expected pack.instruction to mention "Team convention"; got ${pack.instruction}`,
  );
});
