import { resolve } from 'node:path';
import type { CliInvocation, CommandIo, CommandResult } from './types.js';
import { DEFAULT_MCP_PORT } from './types.js';
import { resolvePackageRoot } from './package-root.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  remediation?: string;
}

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 13;

/**
 * `tuberosa doctor` — print a checklist of common install issues.
 *
 * Each check returns a `DoctorCheck` with a status and human-readable detail.
 * The function is pure over the injected `CommandIo` so tests can simulate
 * "no Docker", "port held", and "stale migrations" by swapping spawn/fs.
 */
export async function doctorCommand(invocation: CliInvocation, io: CommandIo): Promise<CommandResult> {
  const checks = await runDoctorChecks(invocation, io);
  const wantsJson = invocation.options.json === true || invocation.options.json === 'true';
  if (wantsJson) {
    io.out(JSON.stringify({ checks }, null, 2));
  } else {
    renderText(checks, io);
  }
  const failed = checks.some((check) => check.status === 'fail');
  return { exitCode: failed ? 1 : 0 };
}

export async function runDoctorChecks(invocation: CliInvocation, io: CommandIo): Promise<DoctorCheck[]> {
  const portOption = typeof invocation.options.port === 'string' ? Number(invocation.options.port) : DEFAULT_MCP_PORT;
  const port = Number.isFinite(portOption) ? portOption : DEFAULT_MCP_PORT;
  const root = typeof invocation.options.root === 'string' ? resolve(io.cwd, invocation.options.root) : io.cwd;
  // migrations/ and the MCP entrypoint ship *inside the package*, not in the
  // user's project. Resolve the package root so `npx tuberosa doctor` from a
  // foreign project doesn't false-warn about "missing" bundled files. Fall back
  // to the project root only when resolution fails (degraded, but never crashes).
  const packageRoot = (io.fs && (await resolvePackageRoot(io.env, io.fs))) || root;

  const checks: DoctorCheck[] = [];
  checks.push(checkNode(io));
  checks.push(await checkPnpm(io));
  checks.push(await checkDocker(io));
  checks.push(await checkPort(io, port));
  checks.push(await checkPostgres(io));
  checks.push(await checkMigrations(io, packageRoot));
  checks.push(await checkMcpStdio(io, packageRoot));
  checks.push(await checkEmbeddingModel(io));
  return checks;
}

function renderText(checks: DoctorCheck[], io: CommandIo): void {
  io.out('Tuberosa doctor');
  io.out('---------------');
  for (const check of checks) {
    const icon = check.status === 'ok' ? '✓'
      : check.status === 'warn' ? '!'
      : check.status === 'skip' ? '·'
      : '✗';
    io.out(`${icon} ${check.name}: ${check.detail}`);
    if (check.status !== 'ok' && check.remediation) {
      io.out(`    fix: ${check.remediation}`);
    }
  }
  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  io.out('');
  io.out(`Result: ${failed} fail, ${warned} warn, ${checks.length - failed - warned} ok/skip.`);
}

function checkNode(io: CommandIo): DoctorCheck {
  const version = io.env.npm_node_version ?? process.version.replace(/^v/, '');
  const match = version.match(/^(\d+)\.(\d+)/);
  if (!match) {
    return { name: 'node version', status: 'warn', detail: `unrecognised version ${version}` };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    return {
      name: 'node version',
      status: 'fail',
      detail: `Node ${version} is below the required ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.`,
      remediation: `Use Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ (see .nvmrc, currently pinned to 22.21.1).`,
    };
  }
  return { name: 'node version', status: 'ok', detail: `Node ${version}` };
}

async function checkPnpm(io: CommandIo): Promise<DoctorCheck> {
  if (!io.spawn) return { name: 'pnpm', status: 'skip', detail: 'spawn unavailable' };
  const result = await io.spawn('pnpm', ['--version'], { timeoutMs: 5_000 });
  if (result.exitCode !== 0) {
    return {
      name: 'pnpm',
      status: 'fail',
      detail: 'pnpm not found on PATH',
      remediation: 'Run `corepack enable && corepack prepare pnpm@11.1.2 --activate`.',
    };
  }
  return { name: 'pnpm', status: 'ok', detail: `pnpm ${result.stdout.trim()}` };
}

async function checkDocker(io: CommandIo): Promise<DoctorCheck> {
  if (!io.spawn) return { name: 'docker', status: 'skip', detail: 'spawn unavailable' };
  const result = await io.spawn('docker', ['--version'], { timeoutMs: 5_000 });
  if (result.exitCode !== 0) {
    return {
      name: 'docker',
      status: 'warn',
      detail: 'Docker not detected — embedded mode (memory store) will be used by `init`.',
      remediation: 'Install Docker Desktop or run with `--no-docker` to silence this warning.',
    };
  }
  return { name: 'docker', status: 'ok', detail: result.stdout.trim() };
}

async function checkPort(io: CommandIo, port: number): Promise<DoctorCheck> {
  if (!io.spawn) return { name: `port ${port}`, status: 'skip', detail: 'spawn unavailable' };
  // `lsof -t -iTCP:<port> -sTCP:LISTEN` exits 0 with a PID list when held, 1 when free.
  const result = await io.spawn('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: 5_000 });
  if (result.exitCode === 0 && result.stdout.trim().length > 0) {
    return {
      name: `port ${port}`,
      status: 'fail',
      detail: `port ${port} is already held by pid ${result.stdout.trim()}`,
      remediation: `Stop the process holding port ${port} or pass --port to override.`,
    };
  }
  return { name: `port ${port}`, status: 'ok', detail: 'port available' };
}

async function checkPostgres(io: CommandIo): Promise<DoctorCheck> {
  const url = io.env.DATABASE_URL;
  if (!url) {
    return {
      name: 'postgres reachability',
      status: 'skip',
      detail: 'DATABASE_URL not set in this shell; assuming embedded-mode defaults. '
        + '(env set in .mcp.json is only visible to the MCP server your agent spawns, not to this terminal — '
        + 'export DATABASE_URL here to check a real DB.)',
    };
  }
  if (!io.spawn) return { name: 'postgres reachability', status: 'skip', detail: 'spawn unavailable' };
  // pg_isready returns 0 when the server is accepting connections.
  const result = await io.spawn('pg_isready', ['-d', url], { timeoutMs: 5_000 });
  if (result.exitCode === 0) {
    return { name: 'postgres reachability', status: 'ok', detail: 'pg_isready: accepting connections' };
  }
  return {
    name: 'postgres reachability',
    status: 'fail',
    detail: `pg_isready exited ${result.exitCode}: ${result.stderr.trim() || 'no detail'}`,
    remediation: 'Start the database (`docker compose up -d postgres`) or fix DATABASE_URL.',
  };
}

async function checkMigrations(io: CommandIo, packageRoot: string): Promise<DoctorCheck> {
  if (!io.fs) return { name: 'migrations', status: 'skip', detail: 'fs unavailable' };
  const path = `${packageRoot}/migrations`;
  if (!(await io.fs.exists(path))) {
    return {
      name: 'migrations',
      status: 'warn',
      detail: `migrations/ directory not found under the Tuberosa package (${packageRoot})`,
      remediation: 'Reinstall Tuberosa — the migrations/ directory ships inside the package. `tuberosa init` applies them.',
    };
  }
  return { name: 'migrations', status: 'ok', detail: 'migrations/ present (bundled with the package)' };
}

async function checkEmbeddingModel(io: CommandIo): Promise<DoctorCheck> {
  const provider = io.env.TUBEROSA_MODEL_PROVIDER ?? (io.env.OPENAI_API_KEY ? 'openai' : 'local');
  if (provider !== 'local') {
    return { name: 'embedding model', status: 'skip', detail: `provider is '${provider}' — no local model needed` };
  }
  if (!io.fs) return { name: 'embedding model', status: 'skip', detail: 'fs unavailable' };
  // io.env is used (not os.homedir) so tests can inject a fake HOME without
  // touching the real home directory. '~' is a display-only placeholder and
  // should never be reached in practice because HOME is always set in real shells.
  const cacheDir = io.env.TUBEROSA_MODEL_CACHE_DIR ?? `${io.env.HOME ?? '~'}/.cache/tuberosa/models`;
  const model = io.env.TUBEROSA_EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5';
  const modelPath = `${cacheDir}/${model}`;
  if (await io.fs.exists(modelPath)) {
    return { name: 'embedding model', status: 'ok', detail: `${model} cached at ${modelPath}` };
  }
  return {
    name: 'embedding model',
    status: 'warn',
    detail: `${model} not found in ${cacheDir} — first query will download it (or fall back to hash)`,
    remediation: 'Run `npx tuberosa init` (its warm-up step downloads the model).',
  };
}

async function checkMcpStdio(io: CommandIo, packageRoot: string): Promise<DoctorCheck> {
  if (!io.fs) return { name: 'mcp stdout sanity', status: 'skip', detail: 'fs unavailable' };
  // The published package ships the compiled `dist/src/mcp-stdio.js`; a fresh
  // checkout has the `src/mcp-stdio.ts` source. Either is a healthy install.
  const tsxEntry = `${packageRoot}/src/mcp-stdio.ts`;
  const distEntry = `${packageRoot}/dist/src/mcp-stdio.js`;
  const entry = (await io.fs.exists(tsxEntry))
    ? tsxEntry
    : (await io.fs.exists(distEntry))
      ? distEntry
      : undefined;
  if (!entry) {
    return {
      name: 'mcp stdout sanity',
      status: 'warn',
      detail: `MCP entrypoint not found under the Tuberosa package (${packageRoot})`,
      remediation: 'Reinstall Tuberosa, or run from a checkout where `dist/src/mcp-stdio.js` or `src/mcp-stdio.ts` exists.',
    };
  }
  try {
    const contents = await io.fs.readFile(entry);
    // `process.stdout.write` is required by JSON-RPC framing in the MCP entrypoint
    // and is therefore allowed. `console.log` is never the right call in this code
    // path because it interleaves diagnostics with protocol frames.
    if (/console\.log\(/.test(contents)) {
      return {
        name: 'mcp stdout sanity',
        status: 'fail',
        detail: `${entry} contains console.log — would corrupt MCP JSON-RPC frames`,
        remediation: 'Replace console.log with process.stderr.write for diagnostics.',
      };
    }
    return { name: 'mcp stdout sanity', status: 'ok', detail: 'MCP entrypoint keeps stdout clean' };
  } catch (error) {
    return {
      name: 'mcp stdout sanity',
      status: 'warn',
      detail: `could not read ${entry}: ${(error as Error).message}`,
    };
  }
}
