import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createAppServices } from '../src/app.js';
import {
  formatOrganizationExport,
  organizationUsage,
  parseOrganizationArgs,
  runOrganizationExport,
} from '../src/operations/organization-cli.js';

async function main(): Promise<void> {
  const options = parseOrganizationArgs(process.argv.slice(2));
  if (options.help) {
    console.log(organizationUsage());
    return;
  }

  const services = await createAppServices();
  try {
    const output = await runOrganizationExport(services.operations, options);
    const text = formatOrganizationExport(options.command as NonNullable<typeof options.command>, output);
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
