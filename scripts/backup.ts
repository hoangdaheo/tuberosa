import { createAppServices } from '../src/app.js';

interface BackupCliOptions {
  id?: string;
  verify?: string;
  keepCount?: number;
  maxAgeDays?: number;
  list: boolean;
  status: boolean;
  prune: boolean;
  dryRun: boolean;
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
    if (options.status) {
      const status = await services.operations.getBackupStatus();
      printJsonOrText(options.json, status, () => {
        console.log(`Backup health: ${status.health}`);
        console.log(`Backup dir: ${status.backupDir}`);
        console.log(`Backups: ${status.backupCount}`);
        if (status.latestBackup) {
          console.log(`Latest: ${status.latestBackup.id} (${status.latestBackup.totalRows} rows)`);
        }
        console.log(`Scheduler: ${status.scheduler.enabled ? 'enabled' : 'disabled'}`);
      });
      return;
    }

    if (options.list) {
      const backups = await services.operations.listBackups();
      printJsonOrText(options.json, backups, () => {
        if (backups.length === 0) {
          console.log('No Tuberosa backups found.');
          return;
        }
        for (const backup of backups) {
          console.log(`${backup.id}\t${backup.createdAt}\t${backup.totalRows} rows\t${backup.path}`);
        }
      });
      return;
    }

    if (options.verify) {
      const verification = await services.operations.verifyBackup({ backupIdOrPath: options.verify });
      printJsonOrText(options.json, verification, () => {
        console.log(`Backup ${verification.backupId}: ${verification.health}`);
        console.log(`Rows: ${verification.totalRows}`);
        for (const issue of verification.issues) {
          console.log(`${issue.severity.toUpperCase()}: ${issue.message}`);
        }
      });
      if (!verification.ok) {
        process.exitCode = 1;
      }
      return;
    }

    if (options.prune) {
      const result = await services.operations.pruneBackups({
        dryRun: options.dryRun,
        keepCount: options.keepCount,
        maxAgeDays: options.maxAgeDays,
      });
      printJsonOrText(options.json, result, () => {
        console.log(`${result.dryRun ? 'Would prune' : 'Pruned'} ${result.pruned.length} backup(s).`);
        console.log(`Kept: ${result.kept.length}`);
        if (result.skipped.length > 0) {
          console.log(`Skipped: ${result.skipped.length}`);
        }
      });
      return;
    }

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
    list: false,
    status: false,
    prune: false,
    dryRun: false,
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

    if (arg === '--list') {
      options.list = true;
      continue;
    }

    if (arg === '--status') {
      options.status = true;
      continue;
    }

    if (arg === '--prune') {
      options.prune = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--verify') {
      options.verify = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--keep-count') {
      options.keepCount = readPositiveInteger(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === '--max-age-days') {
      options.maxAgeDays = readPositiveInteger(readOptionValue(args, index, arg), arg);
      index += 1;
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

function readPositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${option} requires a positive integer.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) {
    throw new Error(`${option} requires a positive integer.`);
  }

  return parsed;
}

function printJsonOrText(valueAsJson: boolean, value: unknown, printText: () => void): void {
  if (valueAsJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  printText();
}

function usage(): string {
  return [
    'Usage: pnpm run backup [--id <backup-id>] [--json]',
    '       pnpm run backup --list [--json]',
    '       pnpm run backup --status [--json]',
    '       pnpm run backup --verify <backup-id-or-path> [--json]',
    '       pnpm run backup --prune [--dry-run] [--keep-count <n>] [--max-age-days <days>] [--json]',
    '',
    'Creates, lists, verifies, and prunes portable JSONL backups under TUBEROSA_BACKUP_DIR.',
  ].join('\n');
}

await main();
