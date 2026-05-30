import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { exportBootstrapPack } from '../src/export/bootstrap-pack.js';
import { importPack } from '../src/export/importer.js';
import type { BootstrapHealth } from '../src/bootstrap/types.js';

const HEALTH: BootstrapHealth = {
  sourceCounts: { tracked: 1, changed: 0, missing: 0, archived: 0, ignored: 0 },
  tombstones: 0, openImportConflicts: 0, maintenanceItems: 0, gaps: 0,
};

test('importPack: reads a categorized-v2 pack from pack/', async () => {
  const src = new MemoryKnowledgeStore();
  await src.upsertSourceFile({ project: 'p', path: 'src/retrieval/service.ts', contentHash: 'h' });
  await src.createAtom({
    project: 'p', claim: 'Fusion is weighted RRF.', type: 'fact',
    evidence: [{ kind: 'file', path: 'src/retrieval/service.ts' }],
    trigger: { files: ['src/retrieval/service.ts'] }, producedBy: 'user',
  });
  const bundle = await mkdtemp(join(tmpdir(), 'v2-imp-'));
  await exportBootstrapPack(src, { project: 'p', out: bundle, atlasContents: [{ name: 'project-map.md', content: '# Map\n' }], health: HEALTH });

  const dst = new MemoryKnowledgeStore();
  const report = await importPack(dst, { from: join(bundle, 'pack'), project: 'p2' });

  assert.equal(report.atomsInserted, 1);
  const atoms = await dst.listAtoms({ project: 'p2', limit: 100 });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0]!.claim, 'Fusion is weighted RRF.');
});
