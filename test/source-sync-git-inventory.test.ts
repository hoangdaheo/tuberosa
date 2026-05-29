import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitDiffSince, isGitRepo, gitHeadSha } from '../src/source-sync/git-inventory.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test('gitDiffSince: classifies add / modify / rename / delete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitinv-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 't@t']);
  git(root, ['config', 'user.name', 't']);
  await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
  await writeFile(join(root, 'old.ts'), 'export const keep = 1;\n'.repeat(5));
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'c1']);
  const base = gitHeadSha(root);

  await writeFile(join(root, 'a.ts'), 'const a = 2;\n'); // modify
  await writeFile(join(root, 'b.ts'), 'const b = 1;\n'); // add
  await rename(join(root, 'old.ts'), join(root, 'new.ts')); // rename
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'c2']);

  assert.equal(isGitRepo(root), true);
  const diff = gitDiffSince(root, base);
  assert.ok(diff.added.includes('b.ts'), `added should include b.ts, got ${JSON.stringify(diff.added)}`);
  assert.ok(diff.modified.includes('a.ts'), `modified should include a.ts, got ${JSON.stringify(diff.modified)}`);
  assert.ok(
    diff.renamed.some((r) => r.from === 'old.ts' && r.to === 'new.ts'),
    `renamed should include old.ts→new.ts, got ${JSON.stringify(diff.renamed)}`,
  );
});

test('isGitRepo: false for a non-git directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nogit-'));
  assert.equal(isGitRepo(root), false);
});
