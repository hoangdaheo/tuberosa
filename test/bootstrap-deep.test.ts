import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { HashModelProvider } from '../src/model/provider.js';
import { KnowledgeSafetyService } from '../src/security/knowledge-safety.js';
import { IngestionService } from '../src/ingest/service.js';
import { SourceSyncService } from '../src/source-sync/service.js';
import { AtlasService } from '../src/atlas/service.js';
import { BootstrapService } from '../src/bootstrap/service.js';

test('BootstrapService.run: --deep reports graph density and is non-fatal', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'deep-'));
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');

  const store = new MemoryKnowledgeStore();
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-'));
  const models = new HashModelProvider();
  const ingestion = new IngestionService(store, models, { safety: new KnowledgeSafetyService() });
  const atlas = new AtlasService(store, { atlasDir });
  const sync = new SourceSyncService({ store, ingestion, atlasAutoRegen: false });
  const service = new BootstrapService({ store, sync, atlas, exportBaseDir: atlasDir });

  const report = await service.run({ project: 'p', repoPath: repo, generatedAt: '2026-05-29T00:00:00.000Z', deep: true });

  assert.ok(report.deep, 'deep present');
  assert.ok(report.deep!.graphDensity, 'graph density computed');
  assert.equal(typeof report.deep!.graphDensity!.edgesPerAtom, 'number');
  assert.ok(Array.isArray(report.deep!.warnings));
});
