import type {
  KnowledgeGraphJsonlExport,
  ProjectMapExport,
  ReadableSummaryExport,
} from '../types.js';

export type OrganizationCommand = 'project-map' | 'knowledge-graph' | 'readable-summary';

export interface OrganizationCliOptions {
  command?: OrganizationCommand;
  project?: string;
  limit: number;
  out?: string;
  help: boolean;
}

export interface OrganizationExportOperations {
  exportProjectMap(options: { project?: string; limit: number }): Promise<ProjectMapExport>;
  exportKnowledgeGraphJsonl(options: { project?: string; limit: number }): Promise<KnowledgeGraphJsonlExport>;
  exportReadableSummary(options: { project?: string; limit: number }): Promise<ReadableSummaryExport>;
}

export type OrganizationExport = ProjectMapExport | KnowledgeGraphJsonlExport | ReadableSummaryExport;

const ORGANIZATION_COMMANDS = new Set<OrganizationCommand>([
  'project-map',
  'knowledge-graph',
  'readable-summary',
]);

export function parseOrganizationArgs(args: string[]): OrganizationCliOptions {
  const options: OrganizationCliOptions = {
    limit: 100,
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

    if (arg === '--limit') {
      options.limit = readPositiveInteger(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg === '--out') {
      options.out = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}\n\n${organizationUsage()}`);
    }

    if (options.command) {
      throw new Error(`Unexpected extra command: ${arg}\n\n${organizationUsage()}`);
    }

    if (!ORGANIZATION_COMMANDS.has(arg as OrganizationCommand)) {
      throw new Error(`Unknown organization command: ${arg}\n\n${organizationUsage()}`);
    }

    options.command = arg as OrganizationCommand;
  }

  if (!options.help && !options.command) {
    throw new Error(`Command is required.\n\n${organizationUsage()}`);
  }

  return options;
}

export async function runOrganizationExport(
  operations: OrganizationExportOperations,
  options: OrganizationCliOptions,
): Promise<OrganizationExport> {
  if (!options.command) {
    throw new Error('Organization command is required.');
  }

  const query = { project: options.project, limit: options.limit };
  switch (options.command) {
    case 'project-map':
      return operations.exportProjectMap(query);
    case 'knowledge-graph':
      return operations.exportKnowledgeGraphJsonl(query);
    case 'readable-summary':
      return operations.exportReadableSummary(query);
  }
}

export function formatOrganizationExport(command: OrganizationCommand, output: OrganizationExport): string {
  if (command === 'project-map') {
    return JSON.stringify(output, null, 2);
  }

  return 'content' in output ? output.content : JSON.stringify(output, null, 2);
}

export function organizationUsage(): string {
  return [
    'Usage: pnpm run organization -- <project-map|knowledge-graph|readable-summary> [--project <name>] [--limit <n>] [--out <path>]',
    '',
    'Prints read-only organization exports to stdout by default.',
  ].join('\n');
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
