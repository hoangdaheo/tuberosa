import { resolve } from 'node:path';
import type { CliInvocation, CommandIo, CommandResult } from './types.js';

/**
 * `tuberosa mcp` — quick path to the MCP stdio server with sensible defaults.
 *
 * Strategy:
 *   - Default to embedded-mode (TUBEROSA_STORE=memory, TUBEROSA_CACHE=memory,
 *     TUBEROSA_MODEL_PROVIDER=hash) so users can try Tuberosa without Postgres / Redis.
 *   - Preserve any value the user already exported (they may have a real DB running).
 *   - Forward stdio inheriting (stdin → server stdin, server stdout → client stdout,
 *     server stderr → terminal). CRITICAL: stdout MUST stay JSON-RPC clean — this
 *     command never writes to stdout itself.
 *   - Prefer the compiled `dist/src/mcp-stdio.js` when present (faster, no tsx tax);
 *     fall back to `tsx src/mcp-stdio.ts` for a fresh checkout.
 */
export async function mcpCommand(invocation: CliInvocation, io: CommandIo): Promise<CommandResult> {
  if (!io.spawn || !io.fs) {
    io.err('mcp requires fs + spawn adapters');
    return { exitCode: 1 };
  }
  const root = typeof invocation.options.root === 'string' ? resolve(io.cwd, invocation.options.root) : io.cwd;
  const distEntry = `${root}/dist/src/mcp-stdio.js`;
  const tsxEntry = `${root}/src/mcp-stdio.ts`;
  const env = buildEnv(io.env);

  if (await io.fs.exists(distEntry)) {
    return runChild(io, 'node', [distEntry], { cwd: root, env, inheritStdio: true });
  }
  if (await io.fs.exists(tsxEntry)) {
    return runChild(io, 'node', ['--import', 'tsx', tsxEntry], { cwd: root, env, inheritStdio: true });
  }
  io.err(`Could not find MCP entrypoint under ${root}. Run inside a Tuberosa checkout or pass --root.`);
  return { exitCode: 1 };
}

export function buildEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...env,
    TUBEROSA_STORE: env.TUBEROSA_STORE ?? 'memory',
    TUBEROSA_CACHE: env.TUBEROSA_CACHE ?? 'memory',
    TUBEROSA_MODEL_PROVIDER: env.TUBEROSA_MODEL_PROVIDER ?? 'hash',
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
