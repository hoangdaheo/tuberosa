import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { SourceSyncService } from '../src/source-sync/service.js';

test('SourceSyncService: first sync on empty ledger plans every file as an add', async () => {
  const root = await mkdtemp(join(tmpdir(), 'svc-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'README.md'), '# hi\n');

  const store = new MemoryKnowledgeStore();
  const ingestion = new IngestionService(store, new HashModelProvider());
  const svc = new SourceSyncService({ store, ingestion });

  const { planId, plan } = await svc.sync({ project: 'p', repoPath: root, trigger: 'cli' });
  assert.equal(plan.summary.added, 2);
  assert.equal(plan.destructive, false);
  assert.ok(planId);

  const res = await svc.apply({ planId, allowDestructive: false });
  assert.equal(res.ingested, 2);
});

test('SourceSyncService: apply defers a destructive plan (queues it) unless --yes allows it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'svc2-'));
  await writeFile(join(root, 'keep.ts'), 'export const k = 1;\n');
  const store = new MemoryKnowledgeStore();
  const ingestion = new IngestionService(store, new HashModelProvider());
  const svc = new SourceSyncService({ store, ingestion });

  // seed a ledger row + knowledge for a file that won't exist on disk → deletion
  await ingestion.ingestFiles('p', [{ project: 'p', path: 'gone.ts', content: 'export const g = 1;\n' }]);
  await store.upsertSourceFile({ project: 'p', path: 'gone.ts', contentHash: 'h', status: 'tracked' });

  const { planId, plan } = await svc.sync({ project: 'p', repoPath: root, trigger: 'cli' });
  assert.equal(plan.destructive, true);

  // allowDestructive:false → nothing archived, deletion queued to .tuberosa/pending-sync.json.
  const deferred = await svc.apply({ planId, allowDestructive: false });
  assert.equal(deferred.archived, 0, 'no silent archive without --yes');
  assert.equal(deferred.deferredDeletions.length, 1);
  assert.equal(deferred.deferredDeletions[0].path, 'gone.ts');
  const queue = JSON.parse(await readFile(join(root, '.tuberosa', 'pending-sync.json'), 'utf8'));
  assert.equal(queue.deferredDeletions[0].path, 'gone.ts');

  // re-apply the same persisted plan with allowDestructive:true → now archived.
  const res = await svc.apply({ planId, allowDestructive: true });
  assert.equal(res.archived >= 1, true);
  assert.equal(res.deferredDeletions.length, 0);
});

test('SourceSyncService: deleting a file archives the atoms tied to it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'svc3-'));
  await writeFile(join(root, 'keep.ts'), 'export const k = 1;\n');
  const store = new MemoryKnowledgeStore();
  const ingestion = new IngestionService(store, new HashModelProvider());
  const svc = new SourceSyncService({ store, ingestion });

  // an atom whose trigger points at a file that will be deleted
  const atom = await store.createAtom({
    project: 'p', claim: 'gone-file behavior', type: 'fact', evidence: [{ kind: 'file', path: 'gone.ts' }],
    trigger: { files: ['gone.ts'] }, producedBy: 'agent_session',
  });
  await store.upsertSourceFile({ project: 'p', path: 'gone.ts', contentHash: 'h', status: 'tracked' });

  const { planId, plan } = await svc.sync({ project: 'p', repoPath: root, trigger: 'cli' });
  const del = plan.deleted.find((d) => d.path === 'gone.ts');
  assert.ok(del, 'deletion planned for gone.ts');
  assert.ok(del!.atomIds.includes(atom.id), 'plan links the atom to the deleted file (P0 §5 step 4)');

  await svc.apply({ planId, allowDestructive: true });
  const after = await store.getAtom(atom.id);
  assert.equal(after?.status, 'archived', 'atom tied to a deleted file is tombstoned');
});
