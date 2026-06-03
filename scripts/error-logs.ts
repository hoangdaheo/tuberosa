import { readFile } from 'node:fs/promises';
import { createAppServices } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ErrorLogInsightService } from '../src/error-log/insights.js';
import { ErrorLogService } from '../src/error-log/service.js';
import { ValidationError } from '../src/errors.js';
import { KnowledgeSafetyService } from '../src/security/knowledge-safety.js';
import type {
  CollectErrorLogsOptions,
  CreateErrorLogReflectionDraftInput,
  ErrorLog,
  ErrorLogCategory,
  ErrorLogSeverity,
  ErrorLogStatus,
  ResolveErrorLogInput,
} from '../src/types.js';
import {
  validateCollectErrorLogsInput,
  validateCreateErrorLogReflectionDraftInput,
  validateErrorLogIdArguments,
  validateResolveErrorLogInput,
} from '../src/validation.js';

type ErrorLogCommand = 'collect' | 'list' | 'get' | 'draft' | 'resolve';

interface BaseCliOptions {
  json: boolean;
  help: boolean;
}

interface HelpCliOptions extends BaseCliOptions {
  command?: undefined;
}

interface CollectCliOptions extends BaseCliOptions {
  command: 'collect' | 'list';
  project?: string;
  categories?: string[];
  severities?: string[];
  statuses?: string[];
  query?: string;
  tag?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  brief: boolean;
}

interface GetCliOptions extends BaseCliOptions {
  command: 'get';
  id?: string;
  markdown: boolean;
}

interface DraftCliOptions extends BaseCliOptions {
  command: 'draft';
  errorLogIds: string[];
  project?: string;
  title?: string;
  summary?: string;
  content?: string;
  contentFile?: string;
  linkLogs?: boolean;
}

interface ResolveCliOptions extends BaseCliOptions {
  command: 'resolve';
  id?: string;
  status?: string;
  rootCause?: string;
  resolutionSummary?: string;
  changedFiles?: string[];
  verificationCommands?: string[];
  reflectionDraftId?: string;
  notes?: string;
}

type ErrorLogsCliOptions = HelpCliOptions | CollectCliOptions | GetCliOptions | DraftCliOptions | ResolveCliOptions;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.command) {
    console.log(usage());
    return;
  }

  if (options.command === 'draft') {
    await runDraftCommand(options);
    return;
  }

  const { errorLogs, insights } = createLocalErrorLogServices();

  if (options.command === 'collect' || options.command === 'list') {
    const collectionOptions = collectOptionsFromCli(options);
    const collection = await insights.collect(collectionOptions);
    if (options.command === 'list') {
      const logs = collection.logs;
      printJsonOrText(options.json, logs, () => printLogList(logs));
      return;
    }

    printJsonOrText(options.json, collection, () => {
      if (options.brief) {
        console.log(collection.agentBrief.trimEnd());
        return;
      }

      console.log(`Matched ${collection.totalMatched}; returned ${collection.returned}.`);
      if (collection.nextOffset !== undefined) {
        console.log(`Next offset: ${collection.nextOffset}`);
      }
      printLogList(collection.logs);
    });
    return;
  }

  if (options.command === 'get') {
    if (!options.id) {
      throw new Error(`get requires <error-log-id>.\n\n${usage()}`);
    }

    if (options.markdown) {
      const markdown = await errorLogs.readLogMarkdown(options.id);
      if (!markdown) {
        throw new Error(`Error log not found: ${options.id}`);
      }
      console.log(markdown.trimEnd());
      return;
    }

    const log = await errorLogs.getLog(options.id);
    if (!log) {
      throw new Error(`Error log not found: ${options.id}`);
    }

    printJsonOrText(options.json, log, () => printLog(log));
    return;
  }

  if (options.command === 'resolve') {
    const input = resolveInputFromCli(options);
    const result = await insights.resolve(input);
    if (!result) {
      throw new Error(`Error log not found: ${input.id}`);
    }

    printJsonOrText(options.json, result, () => {
      console.log(`Resolved ${result.log.id} as ${result.log.status}.`);
      console.log(result.instruction);
    });
  }
}

async function runDraftCommand(options: DraftCliOptions): Promise<void> {
  const content = options.contentFile ? await readFile(options.contentFile, 'utf8') : options.content;
  const input = validateCreateErrorLogReflectionDraftInput({
    errorLogIds: options.errorLogIds,
    project: options.project,
    title: options.title,
    summary: options.summary,
    content,
    linkLogs: options.linkLogs,
  } satisfies CreateErrorLogReflectionDraftInput);

  const services = await createAppServices();
  try {
    const result = await services.errorLogInsights.createReflectionDraft(input);
    printJsonOrText(options.json, result, () => {
      console.log(`Created reflection draft ${result.draft.id}.`);
      if (result.linkedErrorLogIds.length > 0) {
        console.log(`Linked error logs: ${result.linkedErrorLogIds.join(', ')}`);
      }
    });
  } finally {
    await services.close();
  }
}

function createLocalErrorLogServices(): {
  errorLogs: ErrorLogService;
  insights: ErrorLogInsightService;
} {
  const config = loadConfig();
  const safety = new KnowledgeSafetyService();
  const errorLogs = new ErrorLogService({
    rootDir: config.errorLog.dir,
    maxBytes: config.errorLog.maxBytes,
    safety,
  });

  return {
    errorLogs,
    insights: new ErrorLogInsightService(errorLogs),
  };
}

function parseArgs(args: string[]): ErrorLogsCliOptions {
  args = args.filter((arg) => arg !== '--');
  const base: BaseCliOptions = {
    json: false,
    help: false,
  };

  if (args.length === 0) {
    return { ...base, help: true };
  }

  const command = args[0]!;
  if (command === '--help' || command === '-h') {
    return { ...base, help: true };
  }

  if (!isCommand(command)) {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }

  if (command === 'collect' || command === 'list') {
    return parseCollectArgs(command, args.slice(1), base);
  }

  if (command === 'get') {
    return parseGetArgs(args.slice(1), base);
  }

  if (command === 'draft') {
    return parseDraftArgs(args.slice(1), base);
  }

  return parseResolveArgs(args.slice(1), base);
}

function parseCollectArgs(command: 'collect' | 'list', args: string[], base: BaseCliOptions): CollectCliOptions {
  const options: CollectCliOptions = {
    ...base,
    command,
    brief: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parseSharedFlag(options, arg)) {
      continue;
    }

    if (arg === '--project') {
      options.project = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--category') {
      options.categories = append(options.categories, readOptionValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--severity') {
      options.severities = append(options.severities, readOptionValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--status') {
      options.statuses = append(options.statuses, readOptionValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--tag') {
      options.tag = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--query' || arg === '-q') {
      options.query = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--since') {
      options.since = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--until') {
      options.until = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      options.limit = readNonNegativeInteger(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--offset') {
      options.offset = readNonNegativeInteger(readOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--brief') {
      options.brief = true;
      continue;
    }

    throw new Error(`Unknown option for ${command}: ${arg}\n\n${usage()}`);
  }

  return options;
}

function parseGetArgs(args: string[], base: BaseCliOptions): GetCliOptions {
  const options: GetCliOptions = {
    ...base,
    command: 'get',
    markdown: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parseSharedFlag(options, arg)) {
      continue;
    }
    if (arg === '--markdown') {
      options.markdown = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option for get: ${arg}\n\n${usage()}`);
    }
    if (options.id) {
      throw new Error(`get accepts one error log id.\n\n${usage()}`);
    }
    options.id = arg;
  }

  return options;
}

function parseDraftArgs(args: string[], base: BaseCliOptions): DraftCliOptions {
  const options: DraftCliOptions = {
    ...base,
    command: 'draft',
    errorLogIds: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parseSharedFlag(options, arg)) {
      continue;
    }
    if (arg === '--id' || arg === '--error-log-id') {
      options.errorLogIds.push(readOptionValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--project') {
      options.project = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--title') {
      options.title = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--summary') {
      options.summary = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--content') {
      options.content = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--content-file') {
      options.contentFile = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--no-link') {
      options.linkLogs = false;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option for draft: ${arg}\n\n${usage()}`);
    }
    options.errorLogIds.push(arg);
  }

  return options;
}

function parseResolveArgs(args: string[], base: BaseCliOptions): ResolveCliOptions {
  const options: ResolveCliOptions = {
    ...base,
    command: 'resolve',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parseSharedFlag(options, arg)) {
      continue;
    }
    if (arg === '--id' || arg === '--error-log-id') {
      options.id = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--status') {
      options.status = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--root-cause') {
      options.rootCause = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--summary' || arg === '--resolution-summary') {
      options.resolutionSummary = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--changed-file') {
      options.changedFiles = append(options.changedFiles, readOptionValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--verification-command') {
      options.verificationCommands = append(options.verificationCommands, readOptionValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--reflection-draft-id') {
      options.reflectionDraftId = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--notes') {
      options.notes = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option for resolve: ${arg}\n\n${usage()}`);
    }
    if (options.id) {
      throw new Error(`resolve accepts one error log id.\n\n${usage()}`);
    }
    options.id = arg;
  }

  return options;
}

function collectOptionsFromCli(options: CollectCliOptions): CollectErrorLogsOptions {
  return validateCollectErrorLogsInput({
    project: options.project,
    categories: options.categories as ErrorLogCategory[] | undefined,
    severities: options.severities as ErrorLogSeverity[] | undefined,
    statuses: options.statuses as ErrorLogStatus[] | undefined,
    query: options.query,
    tag: options.tag,
    since: options.since,
    until: options.until,
    limit: options.limit,
    offset: options.offset,
  });
}

function resolveInputFromCli(options: ResolveCliOptions): ResolveErrorLogInput {
  const { id } = validateErrorLogIdArguments({ id: options.id });
  return validateResolveErrorLogInput({
    id,
    status: options.status,
    rootCause: options.rootCause,
    resolutionSummary: options.resolutionSummary,
    changedFiles: options.changedFiles,
    verificationCommands: options.verificationCommands,
    reflectionDraftId: options.reflectionDraftId,
    notes: options.notes,
  });
}

function parseSharedFlag(options: BaseCliOptions, arg: string): boolean {
  if (arg === '--help' || arg === '-h') {
    options.help = true;
    return true;
  }
  if (arg === '--json') {
    options.json = true;
    return true;
  }
  return false;
}

function printLogList(logs: Pick<ErrorLog, 'id' | 'title' | 'severity' | 'status' | 'lastSeenAt' | 'occurrenceCount'>[]): void {
  if (logs.length === 0) {
    console.log('No error logs found.');
    return;
  }

  for (const log of logs) {
    console.log(`${log.id}\t${log.severity}/${log.status}\t${log.lastSeenAt}\t${log.occurrenceCount}x\t${log.title}`);
  }
}

function printLog(log: ErrorLog): void {
  console.log(`${log.title} (${log.severity}/${log.status})`);
  console.log(`ID: ${log.id}`);
  console.log(`Project: ${log.project ?? 'unprojected'}`);
  console.log(`Last seen: ${log.lastSeenAt}`);
  console.log(`Occurrences: ${log.occurrenceCount}`);
  console.log(`Summary: ${log.summary}`);
  if (log.files.length > 0) {
    console.log(`Files: ${log.files.join(', ')}`);
  }
  if (log.reflectionDraftId) {
    console.log(`Reflection draft: ${log.reflectionDraftId}`);
  }
}

function printJsonOrText(valueAsJson: boolean, value: unknown, printText: () => void): void {
  if (valueAsJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  printText();
}

function isCommand(value: string): value is ErrorLogCommand {
  return value === 'collect' || value === 'list' || value === 'get' || value === 'draft' || value === 'resolve';
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

function readNonNegativeInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${option} requires a non-negative integer.`);
  }

  return Number.parseInt(value, 10);
}

function append(values: string[] | undefined, value: string): string[] {
  return [...(values ?? []), value];
}

function usage(): string {
  return [
    'Usage: pnpm run error-logs collect [--project <name>] [--status <status>] [--limit <n>] [--brief] [--json]',
    '       pnpm run error-logs list [--project <name>] [--status <status>] [--category <category>] [--json]',
    '       pnpm run error-logs get <error-log-id> [--markdown] [--json]',
    '       pnpm run error-logs draft <error-log-id...> [--project <name>] [--title <text>] [--summary <text>] [--content-file <path>] [--no-link] [--json]',
    '       pnpm run error-logs resolve <error-log-id> --root-cause <text> --summary <text> [--changed-file <path>] [--verification-command <command>] [--reflection-draft-id <id>] [--status fixed|wont_fix] [--json]',
    '',
    'Collect, inspect, transform, and resolve filesystem-backed Tuberosa error-log incidents.',
  ].join('\n');
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof ValidationError ? `Validation error: ${message}` : message);
  process.exitCode = 1;
}
