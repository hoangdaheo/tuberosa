import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { exportBootstrapPack, slugifyAreaKey } from '../src/export/bootstrap-pack.js';
import type { BootstrapHealth } from '../src/bootstrap/types.js';

const HEALTH: BootstrapHealth = {
  sourceCounts: { tracked: 1, changed: 0, missing: 0, archived: 0, ignored: 0 },
  tombstones: 0, openImportConflicts: 0, maintenanceItems: 0, gaps: 0,
};

test('slugifyAreaKey: path keys become safe slugs', () => {
  assert.equal(slugifyAreaKey('src/retrieval'), 'src-retrieval');
  assert.equal(slugifyAreaKey('_unassigned'), '_unassigned');
  assert.equal(slugifyAreaKey('_root'), '_root');
});

test('exportBootstrapPack: writes two-layer categorized bundle', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/retrieval/service.ts', contentHash: 'h' });
  await store.createAtom({
    project: 'p', claim: 'Fusion is weighted RRF.', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/retrieval/service.ts' }],
    trigger: { files: ['src/retrieval/service.ts'] }, producedBy: 'user',
  });

  const out = await mkdtemp(join(tmpdir(), 'v2-'));
  const report = await exportBootstrapPack(store, {
    project: 'p',
    out,
    atlasContents: [{ name: 'project-map.md', content: '# Map\n' }],
    atlasInputHash: 'sha256:deadbeef',
    health: HEALTH,
  });

  const startHere = await readFile(join(out, 'START-HERE.md'), 'utf8');
  assert.ok(startHere.includes('p'), 'START-HERE names the project');
  await readFile(join(out, 'atlas', 'project-map.md'), 'utf8');
  await readFile(join(out, 'health', 'summary.md'), 'utf8');

  const manifest = JSON.parse(await readFile(join(out, 'pack', 'manifest.json'), 'utf8'));
  assert.equal(manifest.layout, 'categorized-v2');
  assert.equal(manifest.schemaVersion, 2);
  assert.ok(Array.isArray(manifest.areas));
  const areaDirs = await readdir(join(out, 'pack', 'areas'));
  assert.ok(areaDirs.includes('src-retrieval'), 'atom routed to its area slug');
  const atomFiles = await readdir(join(out, 'pack', 'areas', 'src-retrieval', 'atoms'));
  assert.equal(atomFiles.length, 1);
  assert.equal(report.atoms, 1);
  assert.equal(report.areas >= 1, true);
});
