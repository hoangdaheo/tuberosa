import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
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

test('SourceSyncService: apply refuses destructive plan unless allowed', async () => {
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
  await assert.rejects(() => svc.apply({ planId, allowDestructive: false }), /destructive/i);

  const res = await svc.apply({ planId, allowDestructive: true });
  assert.equal(res.archived >= 1, true);
});
