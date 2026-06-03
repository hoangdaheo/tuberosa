import { parseArgs } from 'node:util';
import { createAppServices } from '../src/app.js';
import { importPack } from '../src/export/importer.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    project: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'on-conflict': { type: 'string', default: 'review' },
    'preserve-user-id': { type: 'boolean', default: false },
    'preserve-priority': { type: 'boolean', default: false },
    'target-user-id': { type: 'string' },
  },
});

if (!values.from) {
  console.error('--from is required');
  process.exit(2);
}

const services = await createAppServices();
const report = await importPack(services.store, {
  from: values.from,
  project: values.project,
  dryRun: Boolean(values['dry-run']),
  onConflict: values['on-conflict'] === 'skip' ? 'skip' : 'review',
  preserveUserId: Boolean(values['preserve-user-id']),
  preservePriority: Boolean(values['preserve-priority']),
  targetUserId: values['target-user-id'] ?? services.config.userStyle.userId,
});
console.log(JSON.stringify(report, null, 2));
await services.close();
