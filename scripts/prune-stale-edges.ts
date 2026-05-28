import { parseArgs } from 'node:util';
import { createAppServices } from '../src/app.js';
import { pruneStaleEdges } from '../src/atoms/inference/prune.js';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const services = await createAppServices();
try {
  const report = await pruneStaleEdges(services.store, {
    project: values.project,
    dryRun: Boolean(values['dry-run']),
  });
  console.log(JSON.stringify(report));
} finally {
  await services.close();
}
