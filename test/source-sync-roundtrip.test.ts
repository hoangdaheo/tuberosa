import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { SourceSyncService } from '../src/source-sync/service.js';

test('round-trip: first sync ingests, deleting a file archives it, resurrect restores it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.ts'), 'export const keep = 1;\n');
  await writeFile(join(root, 'src', 'gone.ts'), 'export const gone = 1;\n');

  const store = new MemoryKnowledgeStore();
  const ingestion = new IngestionService(store, new HashModelProvider());
  const svc = new SourceSyncService({ store, ingestion });

  // 1. First sync → both files ingested.
  const first = await svc.sync({ project: 'p', repoPath: root, trigger: 'cli' });
  assert.equal(first.plan.summary.added, 2);
  await svc.apply({ planId: first.planId, allowDestructive: false });
  const goneBefore = await store.listKnowledgeBySourcePath({ project: 'p', path: 'src/gone.ts' });
  assert.ok(goneBefore.length >= 1);

  // 2. Delete a file on disk → second sync plans a deletion.
  await rm(join(root, 'src', 'gone.ts'));
  const second = await svc.sync({ project: 'p', repoPath: root, trigger: 'cli' });
  assert.equal(second.plan.summary.deleted, 1);
  assert.equal(second.plan.destructive, true);

  // 3. Apply → knowledge archived, excluded from approved listing.
  await svc.apply({ planId: second.planId, allowDestructive: true });
  const approved = await store.listKnowledge({ project: 'p', status: 'approved', limit: 100 });
  assert.equal(approved.find((k) => k.id === goneBefore[0].id), undefined);

  // 4. Resurrect → back in approved listing.
  await store.updateKnowledge(goneBefore[0].id, { status: 'approved' });
  const afterResurrect = await store.listKnowledge({ project: 'p', status: 'approved', limit: 100 });
  assert.ok(afterResurrect.find((k) => k.id === goneBefore[0].id));
});
