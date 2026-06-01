import type { CliInvocation, CommandIo, CommandResult } from './types.js';
import type { BootstrapService } from '../../src/bootstrap/service.js';
import type { BootstrapReport } from '../../src/bootstrap/types.js';

/** The subset of BootstrapService the command needs — injectable for tests. */
export type BootstrapServiceLike = Pick<BootstrapService, 'run'>;

export interface BootstrapCommandDeps {
  makeService: (project: string, repoPath: string) => Promise<BootstrapServiceLike>;
}

function renderReport(report: BootstrapReport): string[] {
  const lines: string[] = [];
  const s = report.sync.summary;
  lines.push(`Bootstrap for ${report.project}:`);
  lines.push(`  sync: added ${s.added}, changed ${s.changed}, renamed ${s.renamed}, deleted ${s.deleted}, ignored ${s.ignored}`);
  lines.push(`  applied: ingested ${report.sync.applied.ingested}, reingested ${report.sync.applied.reingested}, repointed ${report.sync.applied.repointed}, archived ${report.sync.applied.archived}`);
  if (report.atlas) lines.push(`  atlas: ${report.atlas.files.length} files (input ${report.atlas.inputHash.replace(/^sha256:/, '').slice(0, 8)})`);
  const h = report.health;
  lines.push(`  health: ${h.sourceCounts.tracked} tracked, ${h.tombstones} tombstones, ${h.openImportConflicts} open conflicts, ${h.maintenanceItems} maintenance, ${h.gaps} gaps`);
  if (report.deep) {
    lines.push(`  deep: ${report.deep.coChangeEdgesEmitted ?? 0} co-change edges, ${report.deep.graphDensity?.edgesPerAtom?.toFixed(2) ?? 'n/a'} edges/atom`);
    for (const w of report.deep.warnings) lines.push(`  deep-warning: ${w}`);
  }
  if (report.export) lines.push(`  export: ${report.export.out} (${report.export.areas} areas, ${report.export.atoms} atoms, ${report.export.knowledge} knowledge)`);
  for (const w of report.warnings) lines.push(`  warning: ${w}`);
  lines.push('Next actions:');
  for (const a of report.nextActions) lines.push(`  - ${a}`);
  return lines;
}

export async function bootstrapCommand(
  invocation: CliInvocation,
  io: CommandIo,
  deps: BootstrapCommandDeps,
): Promise<CommandResult> {
  const project = typeof invocation.options.project === 'string' ? invocation.options.project : '';
  if (!project) {
    io.err('tuberosa bootstrap requires --project <name>');
    return { exitCode: 1 };
  }
  const repoPath = typeof invocation.options.path === 'string' ? invocation.options.path : io.cwd;
  const asJson = invocation.options.json === true;
  const wantExport = invocation.options.export === true;
  const deep = invocation.options.deep === true;
  const noConventions = invocation.options['no-conventions'] === true;
  const out = typeof invocation.options.out === 'string' ? invocation.options.out : undefined;

  const service = await deps.makeService(project, repoPath);
  const report = await service.run({
    project,
    repoPath,
    generatedAt: new Date().toISOString(),
    export: wantExport,
    deep,
    conventions: !noConventions,
    out,
  });

  if (asJson) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    for (const line of renderReport(report)) io.out(line);
  }
  return { exitCode: 0 };
}
