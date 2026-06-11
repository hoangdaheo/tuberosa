/**
 * Spec B — `tuberosa mcp install`: write agent MCP configs so users never
 * hand-edit them from a printed snippet.
 *
 * Targets: `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor) always;
 * `~/.codex/config.toml` (Codex) only when `~/.codex/` already exists.
 *
 * Merge, never clobber: JSON files are parsed and only the
 * `mcpServers.tuberosa` entry is added/replaced; every other key and server
 * is preserved. Unparseable JSON is refused — we print the snippet instead of
 * risking someone's config. TOML is append-only (no TOML dependency): we add
 * our own marked section, and never rewrite TOML we didn't author.
 *
 * The env block intentionally duplicates `buildEnv()`'s defaults: the config
 * file is self-documenting and survives future default changes.
 */

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function buildServerEntry(options: { postgresPort: number; redisPort: number }): McpServerEntry {
  return {
    command: 'npx',
    args: ['tuberosa', 'mcp'],
    env: {
      TUBEROSA_STORE: 'postgres',
      TUBEROSA_CACHE: 'redis',
      TUBEROSA_MODEL_PROVIDER: 'local',
      DATABASE_URL: `postgres://tuberosa:tuberosa@127.0.0.1:${options.postgresPort}/tuberosa`,
      REDIS_URL: `redis://127.0.0.1:${options.redisPort}`,
    },
  };
}

export type JsonMergeResult =
  | { status: 'written'; contents: string }
  | { status: 'exists' }
  | { status: 'invalid'; error: string };

export function mergeMcpJson(
  existing: string | undefined,
  entry: McpServerEntry,
  force: boolean,
): JsonMergeResult {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (error) {
      return { status: 'invalid', error: (error as Error).message };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'invalid', error: 'top-level JSON value is not an object' };
    }
    doc = parsed as Record<string, unknown>;
  }
  const rawServers = doc.mcpServers;
  const servers: Record<string, unknown> =
    rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)
      ? { ...(rawServers as Record<string, unknown>) }
      : {};
  if (servers.tuberosa !== undefined && !force) {
    return { status: 'exists' };
  }
  servers.tuberosa = entry;
  doc.mcpServers = servers;
  return { status: 'written', contents: `${JSON.stringify(doc, null, 2)}\n` };
}

/** Escape a string for a TOML basic (double-quoted) string: backslash and quote. */
function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function renderTomlSection(entry: McpServerEntry): string {
  const envLines = Object.entries(entry.env)
    .map(([key, value]) => `${key} = "${escapeTomlBasicString(value)}"`)
    .join('\n');
  return [
    '',
    '# added by tuberosa mcp install',
    '[mcp_servers.tuberosa]',
    `command = "${escapeTomlBasicString(entry.command)}"`,
    `args = [${entry.args.map((a) => `"${escapeTomlBasicString(a)}"`).join(', ')}]`,
    '',
    '[mcp_servers.tuberosa.env]',
    envLines,
    '',
  ].join('\n');
}

export function tomlHasTuberosaEntry(existing: string): boolean {
  return /^\s*\[mcp_servers\.tuberosa\]/m.test(existing);
}

import { resolve } from 'node:path';
import type { CliInvocation, CommandIo, CommandResult, FsAdapter } from './types.js';

const VALID_TARGETS = ['claude', 'cursor', 'codex'] as const;
export type InstallTarget = (typeof VALID_TARGETS)[number];

export interface InstallOutcome {
  target: InstallTarget;
  path: string;
  status: 'written' | 'skipped_exists' | 'skipped_manual' | 'refused_invalid';
  detail?: string;
}

export interface InstallContext {
  root: string;
  homeDir: string;
  postgresPort: number;
  redisPort: number;
  force: boolean;
  targets?: InstallTarget[];
}

/**
 * Shared installer used by both `tuberosa mcp install` and `tuberosa init`.
 * Returns one outcome per target so callers can report or aggregate exit codes.
 */
export async function installMcpConfigs(fs: FsAdapter, context: InstallContext): Promise<InstallOutcome[]> {
  const entry = buildServerEntry({ postgresPort: context.postgresPort, redisPort: context.redisPort });
  const targets = context.targets ?? (await defaultTargets(fs, context.homeDir));
  const outcomes: InstallOutcome[] = [];

  for (const target of targets) {
    if (target === 'codex') {
      outcomes.push(await installToml(fs, `${context.homeDir}/.codex/config.toml`, entry, context.force));
    } else {
      const path = target === 'claude'
        ? `${context.root}/.mcp.json`
        : `${context.root}/.cursor/mcp.json`;
      outcomes.push(await installJson(fs, target, path, entry, context.force));
    }
  }
  return outcomes;
}

async function defaultTargets(fs: FsAdapter, homeDir: string): Promise<InstallTarget[]> {
  const targets: InstallTarget[] = ['claude', 'cursor'];
  if (homeDir && (await fs.exists(`${homeDir}/.codex`))) targets.push('codex');
  return targets;
}

async function installJson(
  fs: FsAdapter,
  target: InstallTarget,
  path: string,
  entry: McpServerEntry,
  force: boolean,
): Promise<InstallOutcome> {
  const existing = (await fs.exists(path)) ? await fs.readFile(path) : undefined;
  const merged = mergeMcpJson(existing, entry, force);
  if (merged.status === 'invalid') {
    return { target, path, status: 'refused_invalid', detail: merged.error };
  }
  if (merged.status === 'exists') {
    return { target, path, status: 'skipped_exists' };
  }
  const dir = path.slice(0, path.lastIndexOf('/'));
  await fs.mkdir(dir, true);
  await fs.writeFile(path, merged.contents);
  return { target, path, status: 'written' };
}

async function installToml(
  fs: FsAdapter,
  path: string,
  entry: McpServerEntry,
  force: boolean,
): Promise<InstallOutcome> {
  const existing = (await fs.exists(path)) ? await fs.readFile(path) : '';
  if (tomlHasTuberosaEntry(existing)) {
    // We never rewrite TOML we didn't author — even --force only points at manual editing.
    return { target: 'codex', path, status: force ? 'skipped_manual' : 'skipped_exists' };
  }
  const next = existing === '' ? renderTomlSection(entry).trimStart() : existing + renderTomlSection(entry);
  const dir = path.slice(0, path.lastIndexOf('/'));
  await fs.mkdir(dir, true);
  await fs.writeFile(path, next);
  return { target: 'codex', path, status: 'written' };
}

/** CLI wrapper: option parsing + per-target reporting. */
export async function mcpInstallCommand(invocation: CliInvocation, io: CommandIo): Promise<CommandResult> {
  const fs = io.fs;
  if (!fs) {
    io.err('mcp install requires an fs adapter');
    return { exitCode: 1 };
  }
  const root = typeof invocation.options.root === 'string' ? resolve(io.cwd, invocation.options.root) : io.cwd;
  const homeDir = io.env.HOME ?? '';

  let targets: InstallTarget[] | undefined;
  if (typeof invocation.options.target === 'string') {
    const requested = invocation.options.target.split(',').map((t) => t.trim()).filter(Boolean);
    const invalid = requested.filter((t) => !(VALID_TARGETS as readonly string[]).includes(t));
    if (invalid.length > 0) {
      io.err(`Unknown --target value(s): ${invalid.join(', ')}. Valid targets: ${VALID_TARGETS.join(', ')}.`);
      return { exitCode: 1 };
    }
    targets = requested as InstallTarget[];
  }

  const outcomes = await installMcpConfigs(fs, {
    root,
    homeDir,
    postgresPort: 5432,
    redisPort: 6379,
    force: invocation.options.force === true,
    targets,
  });

  let exitCode = 0;
  for (const outcome of outcomes) {
    switch (outcome.status) {
      case 'written':
        io.out(`✓ ${outcome.target}: wrote ${outcome.path}`);
        break;
      case 'skipped_exists':
        io.out(`· ${outcome.target}: ${outcome.path} already configured (use --force to overwrite)`);
        break;
      case 'skipped_manual':
        io.out(`· ${outcome.target}: ${outcome.path} has an existing [mcp_servers.tuberosa] section — `
          + 'tuberosa does not rewrite TOML it did not author; please update it by manual edit.');
        break;
      case 'refused_invalid':
        io.err(`✗ ${outcome.target}: ${outcome.path} is not valid JSON (${outcome.detail}); file left untouched.`);
        io.out('Add this entry manually:');
        io.out(JSON.stringify({ mcpServers: { tuberosa: buildServerEntry({ postgresPort: 5432, redisPort: 6379 }) } }, null, 2));
        exitCode = 1;
        break;
    }
  }
  return { exitCode };
}
