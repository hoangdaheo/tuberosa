import { createAppServices } from '../src/app.js';

interface BackupCliOptions {
  id?: string;
  json: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const services = await createAppServices();
  try {
    const backup = await services.operations.createBackup({ id: options.id });
    if (options.json) {
      console.log(JSON.stringify(backup, null, 2));
    } else {
      console.log(`Created Tuberosa backup ${backup.id}`);
      console.log(`Path: ${backup.path}`);
      console.log(`Tables: ${backup.tables.map((table) => `${table.name}=${table.rows}`).join(', ')}`);
    }
  } finally {
    await services.close();
  }
}

function parseArgs(args: string[]): BackupCliOptions {
  const options: BackupCliOptions = {
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--id') {
      options.id = readOptionValue(args, index, arg);
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
    'Usage: pnpm run backup -- [--id <backup-id>] [--json]',
    '',
    'Creates a portable JSONL backup under TUBEROSA_BACKUP_DIR.',
  ].join('\n');
}

await main();
