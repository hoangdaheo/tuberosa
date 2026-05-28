import { parseArgs } from 'node:util';
import { createAppServices } from '../src/app.js';
import { clusterUserCorrections } from '../src/user-style/clusterer.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  allowPositionals: true,
  options: {
    user: { type: 'string' },
    windowDays: { type: 'string', default: '30' },
    min: { type: 'string', default: '3' },
  },
});

if (!values.user) {
  console.error('--user <userId> is required');
  process.exit(2);
}

const services = await createAppServices();
try {
  const report = await clusterUserCorrections(services.store, services.models, {
    userId: values.user,
    windowDays: Number(values.windowDays),
    minClusterEvents: Number(values.min),
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await services.close();
}
