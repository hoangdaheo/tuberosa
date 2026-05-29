import type { IgnoreReason } from './types.js';

export interface SyncPolicy {
  excludeGlobs: string[]; // matched against the repo-relative path
  binaryExtensions: string[]; // lowercased, no dot
  maxContentBytes: number;
}

export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  excludeGlobs: [
    'dist/', 'build/', 'node_modules/', 'coverage/', '.tuberosa/', '.git/',
    'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
    '.env', '.env.*',
  ],
  binaryExtensions: [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'gz', 'tar',
    'wasm', 'woff', 'woff2', 'ttf', 'eot', 'mp4', 'mov', 'exe', 'bin',
  ],
  maxContentBytes: 512 * 1024,
};

export interface PathClassification {
  include: boolean;
  reason?: IgnoreReason;
}

function matchesGlob(path: string, glob: string): boolean {
  if (glob.endsWith('/')) {
    return path === glob.slice(0, -1) || path.startsWith(glob);
  }
  if (glob.includes('*')) {
    const re = new RegExp(
      '^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    );
    return re.test(path) || re.test(path.split('/').pop() ?? '');
  }
  return path === glob || (path.split('/').pop() ?? '') === glob;
}

export function classifyPath(
  path: string,
  sizeBytes: number,
  policy: SyncPolicy = DEFAULT_SYNC_POLICY,
): PathClassification {
  if (policy.excludeGlobs.some((glob) => matchesGlob(path, glob))) {
    return { include: false, reason: 'excluded' };
  }
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  if (policy.binaryExtensions.includes(ext)) {
    return { include: false, reason: 'binary' };
  }
  if (sizeBytes > policy.maxContentBytes) {
    return { include: false, reason: 'too_large' };
  }
  return { include: true };
}
