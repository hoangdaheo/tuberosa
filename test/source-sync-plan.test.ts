import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildPlan, type ChangeSet } from '../src/source-sync/plan.js';

test('buildPlan: maps change classes and computes summary + destructive flag', () => {
  const changes: ChangeSet = {
    project: 'p', repoPath: '/r', mode: 'git', fromSha: 's1', toSha: 's2',
    added: [{ path: 'src/new.ts', sizeBytes: 20, willIngestAs: 'code_ref' }],
    changed: [{ path: 'src/a.ts', oldHash: 'h1', newHash: 'h2', knowledgeIds: ['k1'] }],
    renamed: [{ from: 'old.ts', to: 'new.ts', similarity: 98 }],
    deleted: [{ path: 'src/gone.ts', knowledgeIds: ['k2'], atomIds: ['atomA'], chunkCount: 3 }],
    ignored: [{ path: 'pnpm-lock.yaml', reason: 'excluded' }],
  };
  const plan = buildPlan(changes);
  assert.equal(plan.summary.added, 1);
  assert.equal(plan.summary.deleted, 1);
  assert.equal(plan.destructive, true, 'deletions make a plan destructive');
});

test('buildPlan: empty deletions → not destructive', () => {
  const plan = buildPlan({
    project: 'p', repoPath: '/r', mode: 'fs',
    added: [], changed: [], renamed: [], deleted: [], ignored: [],
  });
  assert.equal(plan.destructive, false);
});
