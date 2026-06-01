import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkInventory } from '../src/source-sync/fs-inventory.js';
import { DEFAULT_SYNC_POLICY } from '../src/source-sync/policy.js';

test('walkInventory: returns included files with stable content hashes, flags ignored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fsinv-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lock\n');

  const { entries, ignored } = await walkInventory(root, DEFAULT_SYNC_POLICY);
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths, ['src/a.ts']);
  assert.match(entries[0]!.contentHash, /^[a-f0-9]{64}$/);
  assert.ok(ignored.some((i) => i.path === 'pnpm-lock.yaml' && i.reason === 'excluded'));
});
