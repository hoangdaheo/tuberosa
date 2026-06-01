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
  assert.equal(report.atlas?.files.length, 6);
  assert.equal(report.health.sourceCounts.tracked >= 2, true);
  assert.ok(report.nextActions.length >= 1);
  assert.equal(report.export, undefined, 'no export without --export');
});

test('BootstrapService.run: --export writes a two-layer pack', async () => {
  const repo = await fixtureRepo();
  const store = new MemoryKnowledgeStore();
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-'));
  const service = makeService(store, atlasDir);

  const report = await service.run({
    project: 'p',
    repoPath: repo,
    generatedAt: '2026-05-29T00:00:00.000Z',
    export: true,
  });

  assert.ok(report.export, 'export present');
  assert.ok(report.export!.out.endsWith('p-bootstrap'));
  await (await import('node:fs/promises')).readFile(join(report.export!.out, 'START-HERE.md'), 'utf8');
  await (await import('node:fs/promises')).readFile(join(report.export!.out, 'pack', 'manifest.json'), 'utf8');
});

test('BootstrapService.run: --export rejects unsafe --out', async () => {
  const repo = await fixtureRepo();
  const store = new MemoryKnowledgeStore();
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-'));
  const service = makeService(store, atlasDir);

  await assert.rejects(
    () => service.run({ project: 'p', repoPath: repo, generatedAt: '2026-05-29T00:00:00.000Z', export: true, out: '../../etc/evil' }),
    /.*/,
  );
});

/**
 * Dedicated fixture with package.json scripts so the convention stage detects a
 * meaningful signal count: `tsc` → detectedTech 'typescript', and `test`/`build`
 * script names → workflow-gate hints. Kept separate from `fixtureRepo()` so the
 * other tests' exact ingest/file-count assertions stay valid.
 */
async function fixtureRepoWithScripts(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bootstrap-scripts-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(dir, 'README.md'), '# Title\n\nProse.\n', 'utf8');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'p', scripts: { test: 'node --test', build: 'tsc -p .' } }, null, 2),
    'utf8',
  );
  return dir;
}

test('BootstrapService.run: populates conventions and points to bootstrap_handbook', async () => {
  const repo = await fixtureRepoWithScripts();
  const store = new MemoryKnowledgeStore();
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-'));
  const service = makeService(store, atlasDir);

  const report = await service.run({ project: 'p', repoPath: repo, generatedAt: '2026-05-29T00:00:00.000Z' });

  assert.ok(report.conventions, 'conventions present');
  assert.equal(typeof report.conventions!.candidateSignalCount, 'number');
  // package.json has a `tsc` build (detectedTech) + test/build workflow gates,
  // so a meaningful (>=1) signal count must surface — guards against the stage
  // silently producing 0 on a repo that actually has signals.
  const count = report.conventions!.candidateSignalCount;
  assert.ok(count >= 1, `signal count is meaningful (got ${count})`);
  assert.ok(
    report.nextActions.some((a) => a.includes('tuberosa_bootstrap_handbook') && a.includes(`${count} candidate signal`)),
    'next actions point to bootstrap_handbook with the candidate count',
  );
});

test('BootstrapService.run: conventions:false skips the stage', async () => {
  const repo = await fixtureRepo();
  const store = new MemoryKnowledgeStore();
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-'));
  const service = makeService(store, atlasDir);

  const report = await service.run({
    project: 'p',
    repoPath: repo,
    generatedAt: '2026-05-29T00:00:00.000Z',
    conventions: false,
  });

  assert.equal(report.conventions, undefined, 'conventions stage skipped');
  assert.ok(
    !report.nextActions.some((a) => a.includes('tuberosa_bootstrap_handbook')),
    'no bootstrap_handbook next action when skipped',
  );
});

test('BootstrapService.run: convention extraction failure is non-fatal', async () => {
  const repo = await fixtureRepo();
  const store = new MemoryKnowledgeStore();
  const atlasDir = await mkdtemp(join(tmpdir(), 'atlas-'));

  // Isolate the convention stage. The real AtlasService.regenerate also calls
  // gatherAtlasInputs -> store.listAtoms, so a store-wide sabotage would knock
  // out the atlas stage too and we couldn't attribute the warning to the
  // convention catch. A stub atlas that resolves WITHOUT touching the store
  // leaves the convention stage as the ONLY gatherAtlasInputs/listAtoms caller,
  // so throwing on every listAtoms cleanly exercises just its catch.
  const models = new HashModelProvider();
  const ingestion = new IngestionService(store, models, { safety: new KnowledgeSafetyService() });
  const sync = new SourceSyncService({ store, ingestion, atlasAutoRegen: false });
  const atlas = {
    regenerate: async () => ({ inputHash: 'sha256:test', files: [], contents: [] }),
  } as unknown as AtlasService;
  const service = new BootstrapService({
    store,
    sync,
    atlas,
    maintenance: new MaintenanceService(store),
    exportBaseDir: atlasDir,
  });

  store.listAtoms = (async () => {
    throw new Error('boom-listAtoms');
  }) as typeof store.listAtoms;

  const report = await service.run({ project: 'p', repoPath: repo, generatedAt: '2026-05-29T00:00:00.000Z' });

  assert.ok(report, 'run still resolves to a report');
  assert.equal(report.conventions, undefined, 'conventions left undefined on failure');
  assert.ok(
    report.warnings.some((w) => w.includes('convention extraction failed')),
    'failure captured as a warning',
  );
  assert.ok(
    !report.warnings.some((w) => w.includes('atlas regeneration')),
    'only the convention stage failed (atlas was not collateral damage)',
  );
});
