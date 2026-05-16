import { createAppServices } from '../src/app.js';

interface RestoreCliOptions {
  backup?: string;
  dryRun: boolean;
  replace: boolean;
  json: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.backup) {
    throw new Error(`--backup is required.\n\n${usage()}`);
  }

  const services = await createAppServices();
  try {
    const result = await services.operations.restoreBackup({
      backupIdOrPath: options.backup,
      dryRun: options.dryRun,
      replace: options.replace,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const mode = result.dryRun ? 'Dry run' : 'Restored';
      console.log(`${mode} Tuberosa backup ${result.backupId}`);
      console.log(`Replace: ${result.replace}`);
      console.log(`Tables: ${Object.entries(result.restored).map(([name, rows]) => `${name}=${rows}`).join(', ')}`);
    }
  } finally {
    await services.close();
  }
}

function parseArgs(args: string[]): RestoreCliOptions {
  const options: RestoreCliOptions = {
    dryRun: false,
    replace: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--replace') {
      options.replace = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--backup') {
      options.backup = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }

  return options;
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

function usage(): string {
  return [
    'Usage: pnpm run restore -- --backup <backup-id-or-path> [--dry-run] [--replace] [--json]',
    '',
    'Actual restore requires --replace. Use --dry-run first to inspect row counts.',
  ].join('\n');
}

await main();
