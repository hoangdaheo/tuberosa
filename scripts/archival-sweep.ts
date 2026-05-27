import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { createAppServices } from '../src/app.js';
import { runArchivalSweep } from '../src/atoms/archival.js';

const { values } = parseArgs({
  // `pnpm run archival-sweep -- --dry-run` can forward a literal `--`; drop any
  // such separators so they aren't treated as the end-of-options marker.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    report: { type: 'string' },
  },
});

const dryRun = values['dry-run'] ?? false;
const services = await createAppServices();
const report = await runArchivalSweep(services.store, new Date(), { dryRun });

const markdown = [
  '# Atom Archival Sweep Report',
  '',
  `**Mode:** ${dryRun ? 'dry-run' : 'apply'}`,
  `**Scanned at:** ${report.scannedAt}`,
  '',
  `- Scanned: ${report.scanned}`,
  `- Archived by time: ${report.archivedByTime.length}`,
  `- Archived by signal: ${report.archivedBySignal.length}`,
].join('\n');

if (values.report) await writeFile(values.report, markdown, 'utf8');
console.log(markdown);
await services.close();
