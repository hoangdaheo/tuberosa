import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createAppServices } from '../src/app.js';
import {
  contextQualityUsage,
  formatContextQualityWorkbench,
  parseContextQualityArgs,
  runContextQualityReviewAction,
  runContextQualityWorkbench,
} from '../src/operations/context-quality-cli.js';

async function main(): Promise<void> {
  const options = parseContextQualityArgs(process.argv.slice(2));
  if (options.help) {
    console.log(contextQualityUsage());
    return;
  }

  const services = await createAppServices();
  try {
    const reviewAction = await runContextQualityReviewAction(services.operations, options);
    const report = await runContextQualityWorkbench(services.operations, options);
    const text = options.json
      ? JSON.stringify(reviewAction ? { reviewAction, report } : report, null, 2)
      : formatContextQualityWorkbench(report, { apiBase: options.apiBase, reviewAction });

    if (options.out) {
      await mkdir(dirname(options.out), { recursive: true });
      await writeFile(options.out, text, 'utf8');
      return;
    }

    console.log(text);
  } finally {
    await services.close();
  }
}

await main();
