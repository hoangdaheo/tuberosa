import { parseArgs } from 'node:util';
import { createAppServices } from '../src/app.js';
import { importPack } from '../src/export/importer.js';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    project: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'on-conflict': { type: 'string', default: 'review' },
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
});
console.log(JSON.stringify(report, null, 2));
await services.close();
