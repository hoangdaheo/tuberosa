import type { CliInvocation, CommandIo, CommandResult } from './types.js';
import type { SourceSyncService } from '../../src/source-sync/service.js';
import type { SyncPlan } from '../../src/source-sync/types.js';

/** The subset of SourceSyncService the command needs — injectable for tests. */
export type SyncServiceLike = Pick<SourceSyncService, 'sync' | 'apply'>;

export interface SyncCommandDeps {
  /** Build a fully-wired SourceSyncService from config. Injected in tests. */
  makeService: (project: string, repoPath: string) => Promise<SyncServiceLike>;
}

function renderPlan(plan: SyncPlan): string[] {
  const summary = plan.summary;
  return [
    `Sync plan for ${plan.project} (${plan.mode}${plan.toSha ? ` @ ${plan.toSha.slice(0, 8)}` : ''}):`,
    `  added: ${summary.added}   changed: ${summary.changed}   renamed: ${summary.renamed}   deleted: ${summary.deleted}   ignored: ${summary.ignored}`,
    ...plan.deleted.map(
      (d) => `  - DELETE → archive: ${d.path} (${d.knowledgeIds.length} knowledge, ${d.atomIds.length} atoms)`,
    ),
  ];
}

export async function syncCommand(
  invocation: CliInvocation,
  io: CommandIo,
  deps: SyncCommandDeps,
): Promise<CommandResult> {
  const project = typeof invocation.options.project === 'string' ? invocation.options.project : '';
  if (!project) {
    io.err('tuberosa sync requires --project <name>');
    return { exitCode: 1 };
  }
  const repoPath = typeof invocation.options.path === 'string' ? invocation.options.path : io.cwd;
  const apply = invocation.options.apply === true;
  const yes = invocation.options.yes === true;
  const asJson = invocation.options.json === true;

  const service = await deps.makeService(project, repoPath);
  const { planId, plan } = await service.sync({ project, repoPath, trigger: 'cli' });

  if (asJson) {
    io.out(JSON.stringify({ planId, plan }, null, 2));
  } else {
    for (const line of renderPlan(plan)) {
      io.out(line);
    }
  }

  if (!apply) {
    io.out('');
    io.out('Dry-run. Re-run with --apply to execute (archives also need --yes).');
    return { exitCode: 0 };
  }
  if (plan.destructive && !yes) {
    io.err('Plan archives knowledge for deleted files. Re-run with --apply --yes to confirm.');
    return { exitCode: 1 };
  }
  const result = await service.apply({ planId, allowDestructive: plan.destructive && yes });
  io.out(
    `Applied: ingested ${result.ingested}, reingested ${result.reingested}, repointed ${result.repointed}, archived ${result.archived}, skipped ${result.skipped.length}.`,
  );
  return { exitCode: 0 };
}

/** `tuberosa hook install` — writes post-commit + post-merge hooks that run an additive-only sync. */
export async function hookCommand(invocation: CliInvocation, io: CommandIo): Promise<CommandResult> {
  if (invocation.positional[0] !== 'install') {
    io.err('usage: tuberosa hook install --project <name>');
    return { exitCode: 1 };
  }
  if (!io.fs) {
    io.err('hook install requires fs adapter');
    return { exitCode: 1 };
  }
  const project = typeof invocation.options.project === 'string' ? invocation.options.project : '';
  if (!project) {
    io.err('tuberosa hook install requires --project <name>');
    return { exitCode: 1 };
  }
  const script = [
    '#!/bin/sh',
    '# Tuberosa source-sync hook (additive-only; deletes are queued for review).',
    `npx tuberosa sync --project ${project} --apply --json > .tuberosa/last-sync.json 2>/dev/null || true`,
    '',
  ].join('\n');
  for (const hook of ['post-commit', 'post-merge']) {
    const path = `${io.cwd}/.git/hooks/${hook}`;
    await io.fs.writeFile(path, script);
    io.out(`Wrote ${path}`);
  }
  io.out('Note: the hook applies additive changes; deleted-file cleanup is left for `tuberosa sync --apply --yes`.');
  return { exitCode: 0 };
}
