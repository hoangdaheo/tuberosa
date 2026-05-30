import { realpath, mkdir, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { ValidationError } from '../errors.js';

const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN_NAMES = new Set(['.', '..']);

export function assertSafeChildName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ValidationError('child name must be a non-empty string');
  }
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) {
    throw new ValidationError(`child name contains separator or NUL: ${JSON.stringify(name)}`);
  }
  if (FORBIDDEN_NAMES.has(name)) {
    throw new ValidationError(`child name is forbidden: ${JSON.stringify(name)}`);
  }
  if (name.startsWith('..')) {
    throw new ValidationError(`child name must not start with "..": ${JSON.stringify(name)}`);
  }
  if (!SAFE_NAME_PATTERN.test(name)) {
    throw new ValidationError(`child name contains disallowed characters: ${JSON.stringify(name)}`);
  }
}

async function realpathOrParent(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const parent = dirname(target);
    if (parent === target) return target;
    const parentReal = await realpathOrParent(parent);
    return resolve(parentReal, target.slice(parent.length + 1));
  }
}

export async function assertSafeBundlePath(base: string, candidate: string): Promise<string> {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new ValidationError('path must be a non-empty string');
  }
  if (candidate.includes('\0')) {
    throw new ValidationError('path contains NUL byte');
  }
  if (isAbsolute(candidate)) {
    throw new ValidationError('absolute path is not allowed; use a relative path under the configured base');
  }
  if (candidate.split(/[\\/]/).includes('..')) {
    throw new ValidationError('path contains ".." segment');
  }

  await mkdir(base, { recursive: true, mode: 0o700 });
  const realBase = await realpath(base);
  const resolved = resolve(realBase, candidate);
  const realResolved = await realpathOrParent(resolved);
  const withSep = realBase.endsWith(sep) ? realBase : realBase + sep;
  if (realResolved !== realBase && !realResolved.startsWith(withSep)) {
    throw new ValidationError('path resolves outside the configured base');
  }
  // Symlink hop check: every existing component under base must not point outside.
  let cursor = realBase;
  const rel = realResolved.slice(realBase.length).split(sep).filter(Boolean);
  for (const part of rel) {
    cursor = resolve(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        const target = await realpath(cursor);
        if (target !== cursor && !target.startsWith(withSep)) {
          throw new ValidationError(`symlink component escapes base: ${part}`);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
  }
  return realResolved;
}
