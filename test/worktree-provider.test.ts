import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyQuery } from '../src/retrieval/classifier.js';
import { WorktreeProvider } from '../src/retrieval/worktree.js';

test('worktree provider does not let prompt-named files starve git-changed files', async () => {
  const sandbox = createSandbox();
  try {
    initGitRepo(sandbox);
    writeFileSync(join(sandbox, 'prompt-1.txt'), 'Prompt one\n');
    writeFileSync(join(sandbox, 'prompt-2.txt'), 'Prompt two\n');
    writeFileSync(join(sandbox, 'prompt-3.txt'), 'Prompt three\n');
    writeFileSync(join(sandbox, 'changed.ts'), 'export const changed = true;\n');

    const result = await provider({ maxFiles: 2 }).search({
      cwd: sandbox,
      prompt: 'Continue prompt-1.txt prompt-2.txt prompt-3.txt',
      classified: classifyQuery({
        prompt: 'Continue prompt-1.txt prompt-2.txt prompt-3.txt',
        files: ['prompt-1.txt', 'prompt-2.txt', 'prompt-3.txt'],
      }),
      taskType: 'implementation',
      limit: 10,
    });

    const reasons = result.candidates.map((candidate) => (
      (candidate.metadata?.worktree as { reason?: string } | undefined)?.reason
    ));
    ok(reasons.includes('prompt_named'), `expected prompt_named in ${JSON.stringify(reasons)}`);
    ok(reasons.includes('git_changed'), `expected git_changed in ${JSON.stringify(reasons)}`);
  } finally {
    destroySandbox(sandbox);
  }
});

test('worktree provider parses git status -z paths with control characters', async () => {
  const sandbox = createSandbox();
  try {
    initGitRepo(sandbox);
    const rel = 'control\nname.ts';
    writeFileSync(join(sandbox, rel), 'export const controlName = true;\n');

    const result = await provider({ maxFiles: 4 }).search({
      cwd: sandbox,
      prompt: 'Continue changed files',
      classified: classifyQuery({ prompt: 'Continue changed files' }),
      taskType: 'implementation',
      limit: 10,
    });

    const candidate = result.candidates.find((item) => item.title === rel);
    ok(candidate, `expected git status path ${JSON.stringify(rel)} in ${JSON.stringify(result.candidates.map((item) => item.title))}`);
    equal((candidate!.metadata?.worktree as { reason?: string } | undefined)?.reason, 'git_changed');
  } finally {
    destroySandbox(sandbox);
  }
});

test('worktree provider exposes bounded file evidence instead of raw file bodies', async () => {
  const sandbox = createSandbox();
  try {
    writeFileSync(
      join(sandbox, 'handoff.md'),
      '# Handoff\n\nVisible raw body token that should not be copied into context.\n',
    );

    const result = await provider({ maxFiles: 4 }).search({
      cwd: sandbox,
      prompt: 'Continue from handoff.md',
      classified: classifyQuery({ prompt: 'Continue from handoff.md', files: ['handoff.md'] }),
      taskType: 'implementation',
      limit: 10,
    });

    const candidate = result.candidates.find((item) => item.title === 'handoff.md');
    ok(candidate, 'expected handoff.md worktree candidate');
    ok(candidate!.content.includes('First heading: Handoff'));
    ok(candidate!.content.includes('Size bytes:'));
    ok(!candidate!.content.includes('Visible raw body token'), 'raw file body should not be copied into context');
    ok(!candidate!.contextualContent.includes('Visible raw body token'), 'raw file body should not be copied into contextual content');
  } finally {
    destroySandbox(sandbox);
  }
});

function provider(options: { maxFiles: number }): WorktreeProvider {
  return new WorktreeProvider({
    enabled: true,
    maxFiles: options.maxFiles,
    maxMtimeAgeHours: 72,
    maxIngestContentBytes: 2 * 1024 * 1024,
  });
}

function createSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'tuberosa-worktree-provider-'));
}

function destroySandbox(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function initGitRepo(cwd: string): void {
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
}
