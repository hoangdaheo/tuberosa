import type { CliInvocation } from './types.js';

/**
 * Phase 5 — tiny argv parser tuned for the CLI surface we need:
 *
 * - First non-flag token is the command (`init`, `doctor`, `mcp`, `help`).
 * - `--flag` becomes `{flag: true}`.
 * - `--flag value` or `--flag=value` becomes `{flag: 'value'}`.
 * - `-h` / `--help` always resolve to the `help` command, regardless of position.
 *
 * No dependency on commander/yargs — keeps `tuberosa` runnable straight from `dist/`.
 */
export function parseArgs(argv: string[]): CliInvocation {
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: CliInvocation['command'] = 'help';
  let commandResolved = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '-h' || token === '--help') {
      command = 'help';
      commandResolved = true;
      continue;
    }
    if (token.startsWith('--')) {
      const eqIndex = token.indexOf('=');
      if (eqIndex > 0) {
        const key = token.slice(2, eqIndex);
        const value = token.slice(eqIndex + 1);
        options[key] = value;
        continue;
      }
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        options[key] = next;
        index += 1;
      } else {
        options[key] = true;
      }
      continue;
    }
    if (token.startsWith('-')) {
      // single-letter flags reserved for help/version only — anything else is ignored to stay strict
      continue;
    }
    if (!commandResolved) {
      if (
        token === 'init' || token === 'doctor' || token === 'mcp'
        || token === 'sync' || token === 'hook' || token === 'atlas'
        || token === 'bootstrap' || token === 'help'
      ) {
        command = token;
      } else {
        // Unknown command — surface via the help screen so users see the supported list.
        positional.push(token);
        command = 'help';
      }
      commandResolved = true;
      continue;
    }
    positional.push(token);
  }

  return { command, options, positional };
}

export function usage(): string {
  return [
    'Usage: tuberosa <command> [options]',
    '',
    'Commands:',
    '  init      Bootstrap the full local stack: Docker Postgres + Redis, migrations, local embedding model, agent MCP configs, bundled skills. Hard-fails without Docker (use --embedded for volatile trial mode).',
    '  doctor    Diagnose common install issues (Node, pnpm, Docker, port 3027, Postgres reachability, MCP stdio).',
    '  mcp       Run the MCP stdio server (full stack by default; --embedded for the volatile trial stack). `mcp install` writes agent configs: .mcp.json, .cursor/mcp.json, ~/.codex/config.toml.',
    '  sync      Detect added/changed/renamed/deleted files and review/apply a cleanup plan.',
    '  hook      Manage git hooks (e.g. `tuberosa hook install`) for additive-only auto-sync.',
    '  bootstrap First-run project knowledge: sync (additive) + atlas + health summary, optional --export / --deep.',
    '  help      Show this help message.',
    '',
    'Common options:',
    '  --json              Emit machine-readable JSON instead of text (doctor, sync).',
    '  --project <name>    Project to sync (required for `sync` / `hook install`).',
    '  --path <repo>       Repo root for `sync` (defaults to cwd).',
    '  --apply             Apply the sync plan (additive ops; archives also need --yes).',
    '  --yes               Confirm destructive archiving during `sync --apply`.',
    '  --embedded          Volatile trial mode (memory store, hash embeddings) for `init` and `mcp`.',
    '  --no-docker         Deprecated alias of --embedded.',
    '  --skip-migrate      Skip applying database migrations after compose comes up.',
    '  --no-skills         Skip copying bundled agent skills into <root>/.claude/skills/ (init).',
    '  --no-mcp-config     Skip writing agent MCP config files (init).',
    '  --target <list>     Comma-separated targets for `mcp install`: claude, cursor, codex.',
    '  --force             Overwrite an existing tuberosa entry (`mcp install`, JSON targets only).',
    '  --port <number>     Override the HTTP port (default 3027).',
    '  --root <path>       Use <path> as the project root instead of cwd.',
    '  -h, --help          Show this help.',
    '',
    'Examples:',
    '  npx tuberosa init',
    '  npx tuberosa doctor',
    '  npx tuberosa mcp',
    '  npx tuberosa mcp install',
  ].join('\n');
}
