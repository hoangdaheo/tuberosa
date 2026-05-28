import { parseArgs } from 'node:util';
import { createAppServices } from '../src/app.js';
import { inferCoChangeLinks } from '../src/atoms/inference/co-change.js';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    cwd: { type: 'string' },
    lookback: { type: 'string' },
  },
});

if (!values.project) {
  console.error('--project is required');
  process.exit(2);
}

const services = await createAppServices();
try {
  const report = await inferCoChangeLinks(services.store, {
    project: values.project,
    cwd: values.cwd ?? process.cwd(),
    lookbackCommits: values.lookback ? Number(values.lookback) : undefined,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await services.close();
}
