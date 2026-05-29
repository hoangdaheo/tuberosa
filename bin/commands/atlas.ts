import type { CliInvocation, CommandIo, CommandResult } from './types.js';
import type { AtlasService } from '../../src/atlas/service.js';

/** The subset of AtlasService the command needs — injectable for tests. */
export type AtlasServiceLike = Pick<AtlasService, 'regenerate'>;

export interface AtlasCommandDeps {
  /** Build a fully-wired AtlasService from config. Injected in tests. */
  makeService: (project: string, repoPath: string) => Promise<AtlasServiceLike>;
}

export async function atlasCommand(
  invocation: CliInvocation,
  io: CommandIo,
  deps: AtlasCommandDeps,
): Promise<CommandResult> {
  const project = typeof invocation.options.project === 'string' ? invocation.options.project : '';
  if (!project) {
    io.err('tuberosa atlas requires --project <name>');
    return { exitCode: 1 };
  }
  const repoPath = typeof invocation.options.path === 'string' ? invocation.options.path : io.cwd;
  const write = invocation.options.write === true;
  const asJson = invocation.options.json === true;

  const service = await deps.makeService(project, repoPath);
  const generatedAt = new Date().toISOString();
  const result = await service.regenerate({ project, repoPath, generatedAt, write });

  if (asJson) {
    io.out(JSON.stringify({ inputHash: result.inputHash, files: result.files, written: write }, null, 2));
  } else {
    io.out(`Atlas for ${project} (${write ? 'written to disk' : 'dry-run'}):`);
    for (const f of result.files) io.out(`  ${f.name} — ${f.bytes} bytes`);
    if (!write) io.out('Re-run with --write to persist to .tuberosa/atlas/.');
  }
  return { exitCode: 0 };
}
