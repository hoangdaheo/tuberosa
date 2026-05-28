import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { createUserStyleAtom } from '../src/user-style/store-helpers.js';

test('createUserStyleAtom: creates atom with scope=user, user_id set, priority recorded', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await createUserStyleAtom(store, {
    userId: 'alice@example.com',
    claim: 'Prefer named exports.',
    type: 'convention',
    priority: 'coding_preference',
    trigger: { intentTags: ['style'] },
  });
  assert.equal(atom.scope, 'user');
  assert.equal(atom.userId, 'alice@example.com');
  assert.equal(atom.priority, 'coding_preference');
});

test('createUserStyleAtom: rejects type=procedure', async () => {
  const store = new MemoryKnowledgeStore();
  await assert.rejects(
    createUserStyleAtom(store, {
      userId: 'a',
      claim: 'Multi-step.',
      type: 'procedure' as never,
      priority: 'coding_preference',
      trigger: { intentTags: ['x'] },
    }),
    /procedure/,
  );
});

test('createUserStyleAtom: auto-inserts prior_session evidence when sessionId is passed', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await createUserStyleAtom(store, {
    userId: 'a',
    claim: 'Use Conventional Commits.',
    type: 'convention',
    priority: 'personal_workflow',
    trigger: { intentTags: ['commit'] },
    sessionId: 'sess-1',
  });
  assert.ok(atom.evidence.some((e) => e.kind === 'prior_session' && e.sessionId === 'sess-1'));
});

test('createUserStyleAtom: when no evidence and no sessionId, sets low_evidence metadata', async () => {
  const store = new MemoryKnowledgeStore();
  const atom = await createUserStyleAtom(store, {
    userId: 'a',
    claim: 'Always use pnpm.',
    type: 'convention',
    priority: 'personal_workflow',
    trigger: { intentTags: ['tools'] },
  });
  assert.equal(atom.evidence.length, 0);
  assert.equal(atom.metadata?.lowEvidence, true);
});

test('searchAtomsByTrigger: scope=user filter returns only user atoms for the given userId', async () => {
  const store = new MemoryKnowledgeStore();
  await createUserStyleAtom(store, {
    userId: 'alice@example.com',
    claim: 'P1',
    type: 'convention',
    priority: 'coding_preference',
    trigger: { taskTypes: ['refactor'] },
  });
  await createUserStyleAtom(store, {
    userId: 'bob@example.com',
    claim: 'P2',
    type: 'convention',
    priority: 'coding_preference',
    trigger: { taskTypes: ['refactor'] },
  });
  await store.createAtom({
    project: 'tuberosa',
    claim: 'Project atom',
    type: 'convention',
    evidence: [{ kind: 'file', path: 'x.ts' }],
    trigger: { taskTypes: ['refactor'] },
    producedBy: 'agent_session',
  });
  const found = await store.searchAtomsByTrigger(
    { taskTypes: ['refactor'] },
    { project: undefined, scope: 'user', userId: 'alice@example.com', limit: 10 },
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].userId, 'alice@example.com');
});
