import { existsSync, promises as fsp, realpathSync } from 'node:fs';
import { spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { CommandIo, FsAdapter, SpawnFn, SpawnOptions, SpawnResult } from './types.js';

/**
 * Phase 5 — production CommandIo factory.
 *
 * The CLI is invoked from a real terminal. Wrap node:fs + node:child_process
 * in the small adapter surface the commands consume; tests replace these with
 * deterministic in-memory implementations.
 */
export function createDefaultIo(): CommandIo {
  return {
    out: (line: string) => process.stdout.write(`${line}\n`),
    err: (line: string) => process.stderr.write(`${line}\n`),
    cwd: process.cwd(),
    env: { ...process.env },
    spawn: defaultSpawn,
    fs: defaultFs,
  };
}

export const defaultFs: FsAdapter = {
  async exists(path: string): Promise<boolean> {
    return existsSync(path);
  },
  async readFile(path: string): Promise<string> {
    return fsp.readFile(path, 'utf8');
  },
  async writeFile(path: string, contents: string): Promise<void> {
    await fsp.writeFile(path, contents, 'utf8');
  },
  async mkdir(path: string, recursive = true): Promise<void> {
    await fsp.mkdir(path, { recursive });
  },
  async realpath(path: string): Promise<string> {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
};

export const defaultSpawn: SpawnFn = (command, args, options) => spawnProcess(command, args, options);

function spawnProcess(command: string, args: string[], options: SpawnOptions = {}): Promise<SpawnResult> {
  return new Promise((resolveResult) => {
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) } as NodeJS.ProcessEnv,
    };
    if (options.inheritStdio) {
      const child = nodeSpawn(command, args, { ...spawnOptions, stdio: 'inherit' });
      child.on('close', (code) => resolveResult({ exitCode: code ?? 0, stdout: '', stderr: '' }));
      child.on('error', () => resolveResult({ exitCode: 1, stdout: '', stderr: 'spawn error' }));
      return;
    }

    let stdout = '';
    let stderr = '';
    const child = nodeSpawn(command, args, spawnOptions);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs && Number.isFinite(options.timeoutMs)) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, options.timeoutMs);
    }
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolveResult({ exitCode: code ?? 0, stdout, stderr });
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolveResult({ exitCode: 1, stdout, stderr: `${stderr}${(error as Error).message}` });
    });
  });
}
