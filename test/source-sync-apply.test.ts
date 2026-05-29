import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { applyPlan } from '../src/source-sync/apply.js';
import { hashContent } from '../src/source-sync/fs-inventory.js';
import type { SyncPlan } from '../src/source-sync/types.js';

function newIngestion(store: MemoryKnowledgeStore): IngestionService {
  return new IngestionService(store, new HashModelProvider());
}

test('applyPlan: archives knowledge for a deleted file and excludes it from approved listing', async () => {
  const store = new MemoryKnowledgeStore();
  const ingestion = newIngestion(store);
  await ingestion.ingestFiles('p', [{ project: 'p', path: 'src/gone.ts', content: 'export const gone = 1;\n' }]);
  await store.upsertSourceFile({ project: 'p', path: 'src/gone.ts', contentHash: 'h', status: 'tracked' });

  const linked = await store.listKnowledgeBySourcePath({ project: 'p', path: 'src/gone.ts' });
  assert.ok(linked.length >= 1, 'precondition: knowledge exists for the file');

  const plan: SyncPlan = {
    project: 'p', repoPath: '/r', mode: 'git',
    added: [], changed: [], renamed: [],
    deleted: [{ path: 'src/gone.ts', knowledgeIds: linked.map((k) => k.id), atomIds: [], chunkCount: 0 }],
    ignored: [], summary: { added: 0, changed: 0, renamed: 0, deleted: 1, ignored: 0 }, destructive: true,
  };

  const reader = async () => { throw new Error('no reads expected for delete-only plan'); };
  const result = await applyPlan({ store, ingestion, plan, readFile: reader });
  assert.equal(result.archived, linked.length);

  const approved = await store.listKnowledge({ project: 'p', status: 'approved', limit: 100 });
  assert.equal(approved.find((k) => k.id === linked[0].id), undefined, 'archived item no longer in approved listing');
  const archived = await store.listKnowledge({ project: 'p', status: 'archived', limit: 100 });
  assert.ok(archived.find((k) => k.id === linked[0].id), 'item is preserved under archived status (tombstone)');
  const sf = await store.getSourceFile({ project: 'p', path: 'src/gone.ts' });
  assert.equal(sf?.status, 'archived');
});

test('applyPlan: ingests added files and records a ledger row', async () => {
  const store = new MemoryKnowledgeStore();
  const ingestion = newIngestion(store);
  const content = 'export const added = 1;\n';
  const plan: SyncPlan = {
    project: 'p', repoPath: '/r', mode: 'git',
    added: [{ path: 'src/added.ts', sizeBytes: content.length, willIngestAs: 'code_ref' }],
    changed: [], renamed: [], deleted: [], ignored: [],
    summary: { added: 1, changed: 0, renamed: 0, deleted: 0, ignored: 0 }, destructive: false,
  };
  const reader = async (p: string) => { assert.equal(p, 'src/added.ts'); return content; };
  const result = await applyPlan({ store, ingestion, plan, readFile: reader });
  assert.equal(result.ingested, 1);
  const sf = await store.getSourceFile({ project: 'p', path: 'src/added.ts' });
  assert.equal(sf?.contentHash, hashContent(content));
});

test('applyPlan: changed entry whose on-disk hash drifted is skipped', async () => {
  const store = new MemoryKnowledgeStore();
  const ingestion = newIngestion(store);
  await ingestion.ingestFiles('p', [{ project: 'p', path: 'src/a.ts', content: 'v1\n' }]);
  const plan: SyncPlan = {
    project: 'p', repoPath: '/r', mode: 'git',
    added: [], changed: [{ path: 'src/a.ts', oldHash: 'old', newHash: hashContent('v2\n'), knowledgeIds: [] }],
    renamed: [], deleted: [], ignored: [],
    summary: { added: 0, changed: 1, renamed: 0, deleted: 0, ignored: 0 }, destructive: false,
  };
  const reader = async () => 'TOTALLY-DIFFERENT\n'; // hash != newHash
  const result = await applyPlan({ store, ingestion, plan, readFile: reader });
  assert.equal(result.reingested, 0);
  assert.deepEqual(result.skipped, [{ path: 'src/a.ts', reason: 'hash_mismatch' }]);
});

test('applyPlan: rename re-points knowledge sourcePath and preserves knowledge id', async () => {
  const store = new MemoryKnowledgeStore();
  const ingestion = newIngestion(store);
  await ingestion.ingestFiles('p', [{ project: 'p', path: 'old.ts', content: 'export const x = 1;\n' }]);
  await store.upsertSourceFile({ project: 'p', path: 'old.ts', contentHash: 'h', status: 'tracked' });
  const before = await store.listKnowledgeBySourcePath({ project: 'p', path: 'old.ts' });
  assert.ok(before.length >= 1);

  const plan: SyncPlan = {
    project: 'p', repoPath: '/r', mode: 'git',
    added: [], changed: [], renamed: [{ from: 'old.ts', to: 'new.ts', similarity: 100 }], deleted: [], ignored: [],
    summary: { added: 0, changed: 0, renamed: 1, deleted: 0, ignored: 0 }, destructive: false,
  };
  const result = await applyPlan({ store, ingestion, plan, readFile: async () => '' });
  assert.equal(result.repointed, 1);

  const afterNew = await store.listKnowledgeBySourcePath({ project: 'p', path: 'new.ts' });
  const afterOld = await store.listKnowledgeBySourcePath({ project: 'p', path: 'old.ts' });
  assert.equal(afterNew.length, before.length);
  assert.equal(afterNew[0].id, before[0].id, 'knowledge id preserved across rename');
  assert.equal(afterOld.length, 0, 'old path no longer resolves');
});
