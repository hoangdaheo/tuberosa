import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { AtlasService } from '../src/atlas/service.js';

test('AtlasService.regenerate: writes five files + one atlas_runs row; stable hash', async () => {
  const store = new MemoryKnowledgeStore();
  await store.upsertSourceFile({ project: 'p', path: 'src/a/x.ts', contentHash: 'h', status: 'tracked' });
  const dir = await mkdtemp(join(tmpdir(), 'atlas-'));
  const svc = new AtlasService(store, { atlasDir: dir });

  const r1 = await svc.regenerate({ project: 'p', repoPath: process.cwd(), generatedAt: 't1', write: true });
  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ['commands.md', 'flows.md', 'open-gaps.md', 'project-map.md', 'risks.md']);
  assert.equal(r1.files.length, 5);
  assert.equal((await store.getLatestAtlasRun('p'))?.inputHash, r1.inputHash);

  const r2 = await svc.regenerate({ project: 'p', repoPath: process.cwd(), generatedAt: 't2', write: false });
  assert.equal(r2.inputHash, r1.inputHash, 'hash ignores generatedAt');

  const map = await readFile(join(dir, 'project-map.md'), 'utf8');
  const hash8 = r1.inputHash.replace(/^sha256:/, '').slice(0, 8);
  assert.match(map, new RegExp(`input ${hash8}`));
});
