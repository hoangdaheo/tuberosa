import { execFileSync } from 'node:child_process';

export interface GitDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string; similarity: number }>;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

export function gitHeadSha(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

export function gitLsFiles(cwd: string): string[] {
  return git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean);
}

/** Diff between `fromSha` and HEAD with rename detection (`-M`). NUL-delimited, status-prefixed. */
export function gitDiffSince(cwd: string, fromSha: string): GitDiff {
  const out = git(cwd, ['diff', '--name-status', '-M', '-z', `${fromSha}`, 'HEAD']);
  const tokens = out.split('\0').filter((t) => t.length > 0);
  const diff: GitDiff = { added: [], modified: [], deleted: [], renamed: [] };
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++]!;
    if (status.startsWith('R')) {
      const similarity = Number(status.slice(1)) || 100;
      const from = tokens[i++]!;
      const to = tokens[i++]!;
      diff.renamed.push({ from, to, similarity });
    } else if (status.startsWith('C')) {
      i++; // copy similarity score — drop the source path
      const to = tokens[i++]!;
      diff.added.push(to); // copy → treat target as add
    } else {
      const path = tokens[i++]!;
      if (status === 'A') diff.added.push(path);
      else if (status === 'M') diff.modified.push(path);
      else if (status === 'D') diff.deleted.push(path);
      else diff.modified.push(path);
    }
  }
  return diff;
}
