import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { InventoryEntry, IgnoreReason } from './types.js';
import { classifyPath, type SyncPolicy } from './policy.js';

export interface InventoryResult {
  entries: InventoryEntry[];
  ignored: Array<{ path: string; reason: IgnoreReason }>;
}

export function hashContent(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function walkInventory(root: string, policy: SyncPolicy): Promise<InventoryResult> {
  const entries: InventoryEntry[] = [];
  const ignored: Array<{ path: string; reason: IgnoreReason }> = [];

  async function walk(dir: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const abs = join(dir, dirent.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (dirent.isDirectory()) {
        // Skip obviously excluded directories early to avoid descending into node_modules/.git.
        const dirClass = classifyPath(rel + '/', 0, policy);
        if (!dirClass.include && dirClass.reason === 'excluded') {
          continue;
        }
        await walk(abs);
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      const size = (await stat(abs)).size;
      const cls = classifyPath(rel, size, policy);
      if (!cls.include) {
        ignored.push({ path: rel, reason: cls.reason! });
        continue;
      }
      const buf = await readFile(abs);
      entries.push({ path: rel, contentHash: hashContent(buf), sizeBytes: size });
    }
  }

  await walk(root);
  return { entries, ignored };
}
