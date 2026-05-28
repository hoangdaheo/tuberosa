import { parseArgs } from 'node:util';
import { createAppServices } from '../src/app.js';
import { exportPack } from '../src/export/exporter.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  allowPositionals: true,
  options: {
    project: { type: 'string' },
    out: { type: 'string', default: '.tuberosa-pack' },
    'include-chunks': { type: 'boolean', default: true },
    'include-archived': { type: 'boolean', default: false },
    'max-chunk-tokens': { type: 'string', default: '200000' },
    'dry-run': { type: 'boolean', default: false },
    'include-user-style': { type: 'string' },
  },
});

if (!values.project) {
  console.error('--project is required');
  process.exit(2);
}

const services = await createAppServices();
const report = await exportPack(services.store, {
  project: values.project,
  out: values.out!,
  includeChunks: Boolean(values['include-chunks']),
  includeArchived: Boolean(values['include-archived']),
  maxChunkTokens: Number(values['max-chunk-tokens']),
  dryRun: Boolean(values['dry-run']),
  includeUserStyle: values['include-user-style'],
});
console.log(JSON.stringify(report, null, 2));
await services.close();
