import { createAppServices } from '../src/app.js';
import {
  formatWorkbenchSummary,
  parseWorkbenchArgs,
  runWorkbenchSummary,
  workbenchUsage,
} from '../src/operations/workbench-cli.js';

async function main(): Promise<void> {
  const options = parseWorkbenchArgs(process.argv.slice(2));
  if (options.help) {
    console.log(workbenchUsage());
    return;
  }

  const services = await createAppServices();
  try {
    const summary = await runWorkbenchSummary(services, options);
    const text = options.json
      ? JSON.stringify(summary, null, 2)
      : formatWorkbenchSummary(summary, { apiBase: options.apiBase });
    console.log(text);
  } finally {
    await services.close();
  }
}

await main();
