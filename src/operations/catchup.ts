import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readSandboxReport, type ParsedSandboxReport } from './sandbox-report.js';
import { readLastEval, type LastEvalRecord } from './last-eval.js';

const DEFAULT_CONFIG_PATH = resolve(process.cwd(), 'config/catchup.json');
const DEFAULT_SANDBOX_REPORT_PATH = resolve(process.cwd(), 'eval/sandbox/report.md');

export interface CatchupKnownIssue {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'done' | string;
}

export interface CatchupMcpTool {
  name: string;
  purpose?: string;
  minArgs: string[];
}

export interface CatchupMetadataConfig {
  projectGoalDocPath?: string;
  currentPhase?: string;
  roadmapDocPath?: string;
  knownIssues?: CatchupKnownIssue[];
  keyMcpTools?: CatchupMcpTool[];
}

export interface CatchupDocSnippet {
  path: string;
  exists: boolean;
  content?: string;
}

export interface CatchupMetadata {
  configPath: string;
  configExists: boolean;
  currentPhase?: string;
  projectGoal: CatchupDocSnippet;
  roadmap: CatchupDocSnippet;
  knownIssues: CatchupKnownIssue[];
  keyMcpTools: CatchupMcpTool[];
  sandbox: ParsedSandboxReport | null;
  retrievalEval: LastEvalRecord | null;
}

export interface GetCatchupMetadataOptions {
  configPath?: string;
  sandboxReportPath?: string;
  lastEvalPath?: string;
  /** Max characters of project-goal doc to inline (default 12_000). */
  maxDocChars?: number;
}

export function getCatchupMetadata(options: GetCatchupMetadataOptions = {}): CatchupMetadata {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const sandboxPath = options.sandboxReportPath ?? DEFAULT_SANDBOX_REPORT_PATH;
  const maxDocChars = options.maxDocChars ?? 12_000;

  const config = readConfig(configPath);
  const configDir = dirname(configPath);
  const projectGoal = readDocSnippet(resolveDocPath(config.projectGoalDocPath, configDir), maxDocChars);
  const roadmap = readDocSnippet(resolveDocPath(config.roadmapDocPath, configDir), maxDocChars);

  return {
    configPath,
    configExists: existsSync(configPath),
    currentPhase: config.currentPhase,
    projectGoal,
    roadmap,
    knownIssues: config.knownIssues ?? [],
    keyMcpTools: config.keyMcpTools ?? [],
    sandbox: readSandboxReport(sandboxPath),
    retrievalEval: readLastEval({ path: options.lastEvalPath }),
  };
}

function readConfig(path: string): CatchupMetadataConfig {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as CatchupMetadataConfig;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function resolveDocPath(docPath: string | undefined, configDir: string): string | undefined {
  if (!docPath) return undefined;
  return isAbsolute(docPath) ? docPath : resolve(configDir, '..', docPath);
}

function readDocSnippet(path: string | undefined, maxChars: number): CatchupDocSnippet {
  if (!path) {
    return { path: '', exists: false };
  }
  try {
    statSync(path);
  } catch {
    return { path, exists: false };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    return {
      path,
      exists: true,
      content: raw.length > maxChars ? `${raw.slice(0, maxChars)}\n\n…[truncated ${raw.length - maxChars} chars]` : raw,
    };
  } catch {
    return { path, exists: false };
  }
}
