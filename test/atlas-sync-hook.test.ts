import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { IngestionService } from '../src/ingest/service.js';
import { HashModelProvider } from '../src/model/provider.js';
import { SourceSyncService, type AtlasRegenerator } from '../src/source-sync/service.js';

test('apply regenerates the atlas; a failing atlas does not fail apply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-hook-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');

  const store = new MemoryKnowledgeStore();
  const ingestion = new IngestionService(store, new HashModelProvider());

  let atlasCalled = false;
  const failingAtlas: AtlasRegenerator = {
    regenerate: async () => {
      atlasCalled = true;
      throw new Error('boom');
    },
  };
  const svc = new SourceSyncService({ store, ingestion, atlas: failingAtlas });

  const { planId, plan } = await svc.sync({ project: 'p', repoPath: root, trigger: 'cli' });
  assert.equal(plan.summary.added, 1);

  const result = await svc.apply({ planId, allowDestructive: false });
  assert.equal(result.ingested, 1, 'apply still completes despite the atlas throwing');
  assert.equal(atlasCalled, true, 'the atlas hook was invoked');
});

test('apply skips atlas when atlasAutoRegen is false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-hook-off-'));
  await writeFile(join(root, 'keep.ts'), 'export const k = 1;\n');
  const store = new MemoryKnowledgeStore();
  const ingestion = new IngestionService(store, new HashModelProvider());

  let atlasCalled = false;
  const atlas: AtlasRegenerator = {
    regenerate: async () => {
      atlasCalled = true;
    },
  };
  const svc = new SourceSyncService({ store, ingestion, atlas, atlasAutoRegen: false });

  const { planId } = await svc.sync({ project: 'p', repoPath: root, trigger: 'cli' });
  await svc.apply({ planId, allowDestructive: false });
  assert.equal(atlasCalled, false);
});
