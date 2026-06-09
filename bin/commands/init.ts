import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliInvocation, CommandIo, CommandResult, SpawnFn, FsAdapter } from './types.js';
import { DEFAULT_MCP_PORT } from './types.js';
import { composeTemplate } from './compose-template.js';
import { BUNDLED_SKILLS_MANIFEST, parseManifest, manifestSkillFilePaths } from './bundled-skills.js';
import { resolvePackageRoot } from './package-root.js';

export interface InitContext {
  root: string;
  port: number;
  postgresPort: number;
  redisPort: number;
  forceEmbedded: boolean;
  skipMigrate: boolean;
}

/**
 * `tuberosa init` — bootstrap the local stack in one command.
 *
 * Behaviour:
 *   1. Detect Docker. If present (and not `--no-docker`), write `.tuberosa/compose.yml`
 *      from the embedded template and `docker compose up -d`. Wait for Postgres health,
 *      apply the package's bundled migrations in-package, and print the MCP snippet.
 *   2. If Docker is absent (or `--no-docker`), fall back to embedded-mode: print the
 *      `TUBEROSA_STORE=memory …` env vars the user needs and skip docker entirely.
 *   3. Copy `.env.example → .env` when missing.
 *   4. Idempotent: re-running just re-prints the snippet and reconciles missing files.
 */
export async function initCommand(invocation: CliInvocation, io: CommandIo): Promise<CommandResult> {
  const context = resolveContext(invocation, io);
  const fs = io.fs;
  const spawn = io.spawn;
  if (!fs || !spawn) {
    io.err('init requires fs + spawn adapters');
    return { exitCode: 1 };
  }

  await ensureEnvFile(io, fs, context);
  if (invocation.options['with-skills'] === true) {
    await copyBundledSkills(io, fs, context.root);
  }
  const dockerAvailable = !context.forceEmbedded && (await detectDocker(spawn));
  if (!dockerAvailable) {
    return printEmbeddedMode(io, context, context.forceEmbedded ? 'forced by --no-docker' : 'docker not detected');
  }

  await fs.mkdir(`${context.root}/.tuberosa`, true);
  const composePath = `${context.root}/.tuberosa/compose.yml`;
  await writeComposeIfMissing(io, fs, composePath, context);

  const composeResult = await spawn('docker', ['compose', '--file', composePath, 'up', '-d'], {
    cwd: context.root,
    env: io.env,
    timeoutMs: 180_000,
  });
  if (composeResult.exitCode !== 0) {
    io.err(`docker compose failed (exit ${composeResult.exitCode}): ${composeResult.stderr.trim() || composeResult.stdout.trim()}`);
    io.err('Falling back to embedded-mode instructions; fix Docker and re-run `npx tuberosa init` to switch back.');
    return printEmbeddedMode(io, context, 'docker compose returned non-zero');
  }

  const healthy = await waitForPostgresHealth(io, spawn, composePath, context.root);
  if (!healthy) {
    io.err('postgres did not report healthy within the 60s window');
    return { exitCode: 1 };
  }

  if (!context.skipMigrate) {
    const migrateExit = await runMigrations(io, fs, spawn, context);
    if (migrateExit !== 0) return { exitCode: migrateExit };
  }

  printSuccess(io, context);
  return { exitCode: 0 };
}

function resolveContext(invocation: CliInvocation, io: CommandIo): InitContext {
  const root = typeof invocation.options.root === 'string' ? resolve(io.cwd, invocation.options.root) : io.cwd;
  const portOption = typeof invocation.options.port === 'string' ? Number(invocation.options.port) : DEFAULT_MCP_PORT;
  const port = Number.isFinite(portOption) ? portOption : DEFAULT_MCP_PORT;
  return {
    root,
    port,
    postgresPort: 5432,
    redisPort: 6379,
    forceEmbedded: invocation.options['no-docker'] === true,
    skipMigrate: invocation.options['skip-migrate'] === true,
  };
}

async function ensureEnvFile(io: CommandIo, fs: FsAdapter, context: InitContext): Promise<void> {
  const envPath = `${context.root}/.env`;
  const examplePath = `${context.root}/.env.example`;
  if (await fs.exists(envPath)) return;
  if (!(await fs.exists(examplePath))) {
    io.err(`.env.example not found at ${examplePath}; skipping .env creation.`);
    return;
  }
  const contents = await fs.readFile(examplePath);
  await fs.writeFile(envPath, contents);
  io.out(`Wrote ${envPath} from .env.example.`);
}

/**
 * `--with-skills` — copy the package's bundled agent skills into `<root>/.claude/skills/`.
 *
 * Source resolution, in order:
 *   1. `TUBEROSA_SKILLS_SRC` env var (points directly at the skills root) — escape hatch + test seam.
 *   2. Module-relative candidates: from `bin/commands/init.{ts,js}` the package root is two or
 *      three levels up (tsx checkout vs compiled `dist/bin/commands/`), with skills under
 *      `.claude/skills`. The first candidate that actually contains the manifest wins.
 *
 * Never overwrites an existing destination file — user edits are preserved (we only fill gaps).
 */
async function copyBundledSkills(io: CommandIo, fs: FsAdapter, root: string): Promise<void> {
  const srcRoot = await resolveSkillsSource(io, fs);
  if (!srcRoot) {
    io.err('--with-skills: could not locate bundled skills manifest. Set TUBEROSA_SKILLS_SRC to the skills root.');
    return;
  }
  const manifestPath = `${srcRoot}/${BUNDLED_SKILLS_MANIFEST}`;
  if (!(await fs.exists(manifestPath))) {
    io.err(`--with-skills: bundled skills manifest missing at ${manifestPath}; skipping.`);
    return;
  }
  let relPaths: string[];
  try {
    relPaths = manifestSkillFilePaths(parseManifest(await fs.readFile(manifestPath)));
  } catch (error) {
    io.err(`--with-skills: invalid bundled skills manifest: ${(error as Error).message}; skipping.`);
    return;
  }
  let copied = 0;
  for (const rel of relPaths) {
    const srcPath = `${srcRoot}/${rel}`;
    const destPath = `${root}/.claude/skills/${rel}`;
    if (!(await fs.exists(srcPath))) {
      io.err(`--with-skills: bundled skill missing at ${srcPath}; skipping.`);
      continue;
    }
    if (await fs.exists(destPath)) {
      io.out(`Skill already present, leaving it in place: ${rel} (delete to re-copy).`);
      continue;
    }
    await fs.mkdir(dirname(destPath), true);
    await fs.writeFile(destPath, await fs.readFile(srcPath));
    io.out(`Copied skill ${rel} → ${destPath}`);
    copied += 1;
  }
  if (copied > 0) {
    io.out(`Installed ${copied} skill(s) under ${root}/.claude/skills/. Restart Claude Code to discover them.`);
  }
}

async function resolveSkillsSource(io: CommandIo, fs: FsAdapter): Promise<string | undefined> {
  const override = io.env.TUBEROSA_SKILLS_SRC;
  const candidates = override ? [override] : skillsSourceCandidates();
  for (const candidate of candidates) {
    if (await fs.exists(`${candidate}/${BUNDLED_SKILLS_MANIFEST}`)) return candidate;
  }
  return undefined;
}

/** Module-relative guesses for the bundled skills root (tsx checkout and compiled dist). */
function skillsSourceCandidates(): string[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return [
      resolve(here, '../../.claude/skills'), // bin/commands → repo root
      resolve(here, '../../../.claude/skills'), // dist/bin/commands → package root
    ];
  } catch {
    return [];
  }
}

async function detectDocker(spawn: SpawnFn): Promise<boolean> {
  const result = await spawn('docker', ['--version'], { timeoutMs: 5_000 });
  return result.exitCode === 0;
}

async function writeComposeIfMissing(io: CommandIo, fs: FsAdapter, composePath: string, context: InitContext): Promise<void> {
  if (await fs.exists(composePath)) {
    io.out(`Found existing ${composePath}; leaving it in place (delete to regenerate).`);
    return;
  }
  const yaml = composeTemplate({
    password: 'tuberosa',
    postgresPort: context.postgresPort,
    redisPort: context.redisPort,
  });
  await fs.writeFile(composePath, yaml);
  io.out(`Wrote ${composePath}.`);
}

/**
 * Apply the database migrations that ship *inside the Tuberosa package*.
 *
 * This must NOT shell out to `pnpm run migrate` in the user's project: that
 * script only exists in the Tuberosa checkout, so `npx tuberosa init` in any
 * other project failed with `[ERR_PNPM_NO_SCRIPT] Missing script: migrate`.
 *
 * Instead we run the package's own migrate entry (`dist/scripts/migrate.js`
 * when published, `scripts/migrate.ts` in a tsx checkout) with the package root
 * as the child's cwd. `runMigrations()` resolves its SQL directory from
 * `process.cwd()/migrations`, so that cwd is what makes the bundled `migrations/`
 * directory resolvable regardless of where the user invoked the CLI.
 */
async function runMigrations(io: CommandIo, fs: FsAdapter, spawn: SpawnFn, context: InitContext): Promise<number> {
  const packageRoot = await resolvePackageRoot(io.env, fs);
  if (!packageRoot) {
    io.err('Could not locate the Tuberosa package root to run migrations. Set TUBEROSA_PACKAGE_ROOT or re-run with --skip-migrate.');
    return 1;
  }
  const distEntry = `${packageRoot}/dist/scripts/migrate.js`;
  const tsxEntry = `${packageRoot}/scripts/migrate.ts`;
  const args: string[] = (await fs.exists(distEntry)) ? [distEntry] : ['--import', 'tsx', tsxEntry];
  const migrate = await spawn('node', args, {
    cwd: packageRoot,
    env: { ...io.env, DATABASE_URL: io.env.DATABASE_URL ?? `postgres://tuberosa:tuberosa@127.0.0.1:${context.postgresPort}/tuberosa` },
    timeoutMs: 120_000,
  });
  if (migrate.exitCode !== 0) {
    io.err(`migrations failed (exit ${migrate.exitCode}): ${migrate.stderr.trim() || migrate.stdout.trim()}`);
    return 1;
  }
  return 0;
}

async function waitForPostgresHealth(io: CommandIo, spawn: SpawnFn, composePath: string, cwd: string): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await spawn('docker', ['compose', '--file', composePath, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'tuberosa'], {
      cwd,
      timeoutMs: 10_000,
    });
    if (result.exitCode === 0) return true;
    await sleep(2_000);
  }
  io.err('Timed out waiting for postgres to become healthy.');
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printSuccess(io: CommandIo, context: InitContext): void {
  io.out('');
  io.out('Tuberosa is up.');
  io.out(`  HTTP:     http://127.0.0.1:${context.port}/health`);
  io.out(`  Postgres: 127.0.0.1:${context.postgresPort}`);
  io.out(`  Redis:    127.0.0.1:${context.redisPort}`);
  io.out('');
  io.out('MCP snippet (Claude Code / Codex / Cursor):');
  io.out(mcpSnippet(context));
  io.out('Re-run `npx tuberosa init` to reconcile a missing compose file or .env.');
}

function printEmbeddedMode(io: CommandIo, context: InitContext, reason: string): CommandResult {
  io.out('');
  io.out(`Embedded-mode init (${reason}).`);
  io.out('  Data is volatile — no Postgres, no Redis. Useful for trying Tuberosa.');
  io.out('');
  io.out('Run the MCP stdio server with embedded defaults:');
  io.out('  npx tuberosa mcp');
  io.out('');
  io.out('Or set these vars for `pnpm run dev`:');
  io.out('  TUBEROSA_STORE=memory');
  io.out('  TUBEROSA_CACHE=memory');
  io.out('  TUBEROSA_MODEL_PROVIDER=hash');
  io.out('');
  io.out('MCP snippet (Claude Code / Codex / Cursor):');
  io.out(mcpSnippet(context, { embedded: true }));
  return { exitCode: 0 };
}

function mcpSnippet(context: InitContext, options: { embedded?: boolean } = {}): string {
  const env = options.embedded
    ? '      TUBEROSA_STORE = "memory"\n      TUBEROSA_CACHE = "memory"\n      TUBEROSA_MODEL_PROVIDER = "hash"\n'
    : '';
  return [
    '  [mcp_servers.tuberosa]',
    '  command = "npx"',
    '  args = ["tuberosa", "mcp"]',
    env ? '  env = {' : undefined,
    env ? env.trimEnd() + '  }' : undefined,
    `  # cwd = "${context.root}"`,
  ].filter((line): line is string => Boolean(line)).join('\n');
}
