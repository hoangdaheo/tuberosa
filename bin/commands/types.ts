/**
 * Phase 5 — shared CLI contracts.
 *
 * Goal: every subcommand is a pure function over an injectable `CommandIo`
 * surface. That lets tests exercise the full code path (parser → command →
 * stdout/stderr) without spawning child processes or touching the real filesystem.
 *
 * Subcommands return a numeric exit code so `bin/tuberosa.ts` can forward it
 * to `process.exit` without caring which command ran.
 */

export interface CommandIo {
  /** Print a line to stdout. */
  out(line: string): void;
  /** Print a line to stderr. Doctor and init use this for warnings / errors. */
  err(line: string): void;
  /** Current working directory. Defaulted by the dispatcher to `process.cwd()`. */
  cwd: string;
  /** Environment lookup. Tests inject a frozen map; production passes `process.env`. */
  env: Record<string, string | undefined>;
  /**
   * Optional spawn surface. Tests inject a fake that returns scripted exit codes;
   * production uses a thin wrapper around `node:child_process`.
   */
  spawn?: SpawnFn;
  /** Optional filesystem surface. Tests inject an in-memory fs; production uses node:fs. */
  fs?: FsAdapter;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (command: string, args: string[], options?: SpawnOptions) => Promise<SpawnResult>;

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Detached spawn — used by `tuberosa mcp` to inherit stdio. */
  inheritStdio?: boolean;
}

export interface FsAdapter {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  realpath(path: string): Promise<string>;
}

export interface CliInvocation {
  command: 'init' | 'doctor' | 'mcp' | 'help';
  options: Record<string, string | boolean>;
  positional: string[];
}

export interface CommandResult {
  exitCode: number;
}

export const DEFAULT_MCP_PORT = 3027;
