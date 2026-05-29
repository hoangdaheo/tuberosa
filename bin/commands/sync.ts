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
  // Additive ops always apply; archives need --yes. A destructive plan without --yes still applies
  // the additions and queues the deletions to .tuberosa/pending-sync.json (no silent drop).
  const result = await service.apply({ planId, allowDestructive: plan.destructive && yes });
  io.out(
    `Applied: ingested ${result.ingested}, reingested ${result.reingested}, repointed ${result.repointed}, archived ${result.archived}, skipped ${result.skipped.length}.`,
  );
  if (result.deferredDeletions.length > 0) {
    io.out(
      `Deferred ${result.deferredDeletions.length} deletion(s) to .tuberosa/pending-sync.json — re-run with --apply --yes to archive:`,
    );
    for (const d of result.deferredDeletions) {
      io.out(`  - ${d.path} (${d.knowledgeIds.length} knowledge)`);
    }
  }
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
  // `--no-install` keeps npx from silently fetching a package named "tuberosa" from the public
  // registry when the local CLI is not linked (supply-chain guard). `|| true` keeps the hook
  // non-blocking; deletions are deferred to .tuberosa/pending-sync.json, never auto-archived.
  const script = [
    '#!/bin/sh',
    '# Tuberosa source-sync hook: applies additive ops; deletions are queued to',
    '# .tuberosa/pending-sync.json for review (never auto-archived).',
    'mkdir -p .tuberosa',
    `npx --no-install tuberosa sync --project ${project} --apply --json > .tuberosa/last-sync.json || true`,
    '',
  ].join('\n');
  for (const hook of ['post-commit', 'post-merge']) {
    const path = `${io.cwd}/.git/hooks/${hook}`;
    await io.fs.writeFile(path, script);
    io.out(`Wrote ${path}`);
  }
  io.out(
    'Note: the hook applies additive changes automatically; deletions are queued to ' +
      '.tuberosa/pending-sync.json — review and archive with `tuberosa sync --apply --yes`.',
  );
  return { exitCode: 0 };
}
