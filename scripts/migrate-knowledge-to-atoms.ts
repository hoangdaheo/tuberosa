import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createAppServices } from '../src/app.js';
import { AtomCritic } from '../src/atoms/critic.js';
import { migrateLegacyKnowledge, type MigrationReport } from '../src/atoms/migration.js';

function renderReport(report: MigrationReport, options: { project?: string; dryRun: boolean }): string {
  const lines: string[] = [];
  lines.push('# Legacy Knowledge → Atoms Migration');
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Project: ${options.project ?? '(all)'}`);
  lines.push(`- Mode: ${options.dryRun ? 'dry-run' : 'live'}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Scanned legacy items: ${report.scanned}`);
  lines.push(`- Atoms created: ${report.atomsCreated}`);
  lines.push(`- Items marked legacy_replaced: ${report.legacyReplaced}`);
  lines.push(`- Items marked legacy_archived: ${report.legacyArchived}`);
  lines.push(`- Failures: ${report.failures.length}`);
  if (report.failures.length > 0) {
    lines.push('');
    lines.push('## Failures');
    lines.push('');
    for (const failure of report.failures) {
      lines.push(`- ${failure.knowledgeId}: ${failure.reason}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  // pnpm forwards the literal `--` separator; drop it so parseArgs sees the flags.
  const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      project: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'batch-size': { type: 'string' },
      report: { type: 'string', default: 'migration-report.md' },
    },
    allowPositionals: true,
  });

  const project = values.project;
  const dryRun = Boolean(values['dry-run']);
  const batchSize = values['batch-size'] ? Number(values['batch-size']) : undefined;
  const reportPath = values.report as string;

  const services = await createAppServices();
  try {
    const critic = new AtomCritic(services.store, services.models);
    const report = await migrateLegacyKnowledge(services.store, services.models, critic, {
      project,
      dryRun,
      batchSize,
    });

    const markdown = renderReport(report, { project, dryRun });
    await writeFile(reportPath, markdown, 'utf8');
    console.log(markdown);
    console.log(`\nReport written to ${reportPath}`);
  } finally {
    await services.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
