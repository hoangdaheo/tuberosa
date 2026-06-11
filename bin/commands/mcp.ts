import { resolve } from 'node:path';
import type { CliInvocation, CommandIo, CommandResult } from './types.js';
import { resolvePackageRoot } from './package-root.js';

/**
 * `tuberosa mcp` — quick path to the MCP stdio server with sensible defaults.
 *
 * Strategy:
 *   - Default to the full-feature stack (TUBEROSA_STORE=postgres, TUBEROSA_CACHE=redis,
 *     TUBEROSA_MODEL_PROVIDER=local), matching what `tuberosa init` provisions.
 *   - Preserve any value the user already exported (they may override store, cache, etc.).
 *   - Pass --embedded (or set TUBEROSA_EMBEDDED=1) to opt into the volatile trial stack
 *     (memory/memory/hash) — useful when Postgres / Redis are unavailable or for quick
 *     experiments. Embedded mode overrides any exported env values.
 *   - Forward stdio inheriting (stdin → server stdin, server stdout → client stdout,
 *     server stderr → terminal). CRITICAL: stdout MUST stay JSON-RPC clean — this
 *     command never writes to stdout itself.
 *   - Resolve the entrypoint from the *package root* (where `dist/`/`src/` live),
 *     NOT the user's cwd. `npx tuberosa mcp` is meant to run from any project; the
 *     entry file ships inside the installed package, so resolving it from cwd
 *     failed with "Could not find MCP entrypoint" in every foreign project.
 *     `--root` still overrides the search base for power users.
 *   - Prefer the compiled `dist/src/mcp-stdio.js` when present (faster, no tsx tax);
 *     fall back to `tsx src/mcp-stdio.ts` for a fresh checkout.
 *   - The child still runs with the user's cwd so the physical mirror and any
 *     project-relative paths land in the user's project, not in node_modules.
 */
export async function mcpCommand(invocation: CliInvocation, io: CommandIo): Promise<CommandResult> {
  if (!io.spawn || !io.fs) {
    io.err('mcp requires fs + spawn adapters');
    return { exitCode: 1 };
  }
  const explicitRoot = typeof invocation.options.root === 'string' ? resolve(io.cwd, invocation.options.root) : undefined;
  const searchRoot = explicitRoot ?? (await resolvePackageRoot(io.env, io.fs));
  if (!searchRoot) {
    io.err('Could not locate the Tuberosa package. Set TUBEROSA_PACKAGE_ROOT or pass --root <path>.');
    return { exitCode: 1 };
  }
  const distEntry = `${searchRoot}/dist/src/mcp-stdio.js`;
  const tsxEntry = `${searchRoot}/src/mcp-stdio.ts`;
  const env = buildEnv(io.env, { embedded: invocation.options.embedded === true });

  if (await io.fs.exists(distEntry)) {
    return runChild(io, 'node', [distEntry], { cwd: io.cwd, env, inheritStdio: true });
  }
  if (await io.fs.exists(tsxEntry)) {
    return runChild(io, 'node', ['--import', 'tsx', tsxEntry], { cwd: io.cwd, env, inheritStdio: true });
  }
  io.err(`Could not find MCP entrypoint under ${searchRoot}. Reinstall tuberosa or pass --root <checkout>.`);
  return { exitCode: 1 };
}

export function buildEnv(
  env: Record<string, string | undefined>,
  options: { embedded?: boolean } = {},
): Record<string, string | undefined> {
  const embedded =
    options.embedded === true || env.TUBEROSA_EMBEDDED === '1' || env.TUBEROSA_EMBEDDED === 'true';
  if (embedded) {
    // Volatile trial mode — explicit opt-in, so it overrides exported values.
    return {
      ...env,
      TUBEROSA_STORE: 'memory',
      TUBEROSA_CACHE: 'memory',
      TUBEROSA_MODEL_PROVIDER: 'hash',
      TUBEROSA_AUTO_MIGRATE: 'false',
    };
  }
  return {
    ...env,
    TUBEROSA_STORE: env.TUBEROSA_STORE ?? 'postgres',
    TUBEROSA_CACHE: env.TUBEROSA_CACHE ?? 'redis',
    TUBEROSA_MODEL_PROVIDER: env.TUBEROSA_MODEL_PROVIDER ?? 'local',
    TUBEROSA_AUTO_MIGRATE: env.TUBEROSA_AUTO_MIGRATE ?? 'false',
  };
}

async function runChild(
  io: CommandIo,
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; inheritStdio?: boolean },
): Promise<CommandResult> {
  const result = await io.spawn!(command, args, options);
  return { exitCode: result.exitCode };
}
