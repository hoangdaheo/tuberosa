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
import { MaintenanceService } from '../src/maintenance/service.js';
import { BootstrapService } from '../src/bootstrap/service.js';

async function fixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bootstrap-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(dir, 'README.md'), '# Title\n\nProse.\n', 'utf8');
  return dir;
}

function makeService(store: MemoryKnowledgeStore, atlasDir: string): BootstrapService {
  const models = new HashModelProvider();
  const ingestion = new IngestionService(store, models, { safety: new KnowledgeSafetyService() });
  const atlas = new AtlasService(store, { atlasDir });
  const sync = new SourceSyncService({ store, ingestion, atlasAutoRegen: false });
  return new BootstrapService({ store, sync, atlas, maintenance: new MaintenanceService(store), exportBaseDir: atlasDir });
}

test('BootstrapService.run: applies additive sync and regenerates atlas', async () => {
  const repo = await fixtureRepo();
  const store = new MemoryKnowledgeStore();
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-'));
  const service = makeService(store, atlasDir);

  const report = await service.run({ project: 'p', repoPath: repo, generatedAt: '2026-05-29T00:00:00.000Z' });

  assert.ok(report.sync.applied.ingested >= 2, 'ingests added files');
  assert.equal(report.sync.applied.deferredDeletions.length, 0);
  assert.ok(report.atlas, 'atlas present');
  assert.equal(report.atlas?.files.length, 5);
  assert.equal(report.health.sourceCounts.tracked >= 2, true);
  assert.ok(report.nextActions.length >= 1);
  assert.equal(report.export, undefined, 'no export without --export');
});
