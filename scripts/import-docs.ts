import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { createAppServices } from '../src/app.js';
import type { IngestionMode } from '../src/ingest/service.js';

interface ImportDocsOptions {
  project?: string;
  mode: IngestionMode;
  paths: string[];
  help: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  if (!options.project) {
    throw new Error(`--project is required.\n\n${usage()}`);
  }

  if (options.paths.length === 0) {
    throw new Error(`At least one file path is required.\n\n${usage()}`);
  }

  const services = await createAppServices();
  try {
    const files = await Promise.all(options.paths.map(async (path) => {
      const absolutePath = resolve(path);
      return {
        project: options.project as string,
        path: relative(process.cwd(), absolutePath),
        content: await readFile(absolutePath, 'utf8'),
      };
    }));
    const stored = await services.operations.importFiles({
      project: options.project,
      mode: options.mode,
      files,
    });

    console.log(JSON.stringify({
      project: options.project,
      mode: options.mode,
      imported: stored.length,
      items: stored.map((item) => ({
        id: item.id,
        title: item.title,
        sourceUri: item.sourceUri,
      })),
    }, null, 2));
  } finally {
    await services.close();
  }
}

function parseArgs(args: string[]): ImportDocsOptions {
  const options: ImportDocsOptions = {
    mode: 'atomic',
    paths: [],
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--project') {
      options.project = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--mode') {
      options.mode = readMode(readOptionValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }

    options.paths.push(arg);
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

function readMode(value: string): IngestionMode {
  if (value !== 'document' && value !== 'atomic') {
    throw new Error('--mode must be document or atomic.');
  }

  return value;
}

function usage(): string {
  return [
    'Usage: pnpm run import:docs --project <name> [--mode atomic|document] <file...>',
    '',
    'Examples:',
    '  pnpm run import:docs --project tuberosa docs/FLOW_LOGIC.md docs/SETUP_AND_USAGE.md',
    '  pnpm run import:docs --project tuberosa --mode document README.md',
  ].join('\n');
}

await main();
