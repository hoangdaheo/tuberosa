#!/usr/bin/env node
import { parseArgs, usage } from './commands/parser.js';
import { createDefaultIo } from './commands/io.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { mcpCommand } from './commands/mcp.js';
import { syncCommand, hookCommand } from './commands/sync.js';
import { makeSyncService } from './commands/sync-factory.js';
import { atlasCommand } from './commands/atlas.js';
import { makeAtlasService } from './commands/atlas-factory.js';
import { bootstrapCommand } from './commands/bootstrap.js';
import { makeBootstrapService } from './commands/bootstrap-factory.js';
import { setupModelsCommand } from './commands/setup-models.js';
import type { CliInvocation, CommandIo, CommandResult } from './commands/types.js';

/**
 * Phase 5 — top-level CLI dispatcher.
 *
 * Exposed as `bin.tuberosa` in package.json so `npx tuberosa init` / `npx tuberosa doctor`
 * / `npx tuberosa mcp` work straight out of the published package.
 *
 * Kept tiny on purpose: parsing + dispatch + exit. All real logic lives under
 * `bin/commands/*` and is injectable via `CommandIo` so the test suite never spawns
 * docker / postgres / pnpm in CI.
 */
export async function runCli(argv: string[], io: CommandIo = createDefaultIo()): Promise<CommandResult> {
  const invocation = parseArgs(argv);
  return dispatch(invocation, io);
}

export async function dispatch(invocation: CliInvocation, io: CommandIo): Promise<CommandResult> {
  switch (invocation.command) {
    case 'init':
      return initCommand(invocation, io);
    case 'doctor':
      return doctorCommand(invocation, io);
    case 'mcp':
      return mcpCommand(invocation, io);
    case 'sync':
      return syncCommand(invocation, io, { makeService: () => makeSyncService() });
    case 'hook':
      return hookCommand(invocation, io);
    case 'atlas':
      return atlasCommand(invocation, io, { makeService: () => makeAtlasService() });
    case 'bootstrap':
      return bootstrapCommand(invocation, io, { makeService: () => makeBootstrapService() });
    case 'setup-models':
      return setupModelsCommand(invocation, io);
    case 'help':
    default:
      io.out(usage());
      return { exitCode: 0 };
  }
}

const isEntrypoint = isMainModule();
if (isEntrypoint) {
  runCli(process.argv.slice(2)).then((result) => {
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  }).catch((error: unknown) => {
    process.stderr.write(`tuberosa: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  // ES module entry-point detection that survives both `tsx` (file:// URL) and the
  // compiled `dist/bin/tuberosa.js` (filesystem path). When imported as a library
  // (the test suite), neither branch matches and we don't run the CLI automatically.
  if (typeof process.argv[1] !== 'string') return false;
  try {
    const metaUrl = import.meta.url;
    if (!metaUrl) return false;
    const expected = new URL(`file://${process.argv[1]}`).href;
    return metaUrl === expected || metaUrl.endsWith('/bin/tuberosa.ts') || metaUrl.endsWith('/bin/tuberosa.js');
  } catch {
    return false;
  }
}
