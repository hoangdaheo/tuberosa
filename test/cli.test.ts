import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, usage } from '../bin/commands/parser.js';
import { doctorCommand, runDoctorChecks } from '../bin/commands/doctor.js';
import { initCommand } from '../bin/commands/init.js';
import { buildEnv, mcpCommand } from '../bin/commands/mcp.js';
import { composeTemplate } from '../bin/commands/compose-template.js';
import { dispatch } from '../bin/tuberosa.js';
import type { CommandIo, FsAdapter, SpawnFn, SpawnResult } from '../bin/commands/types.js';

interface RecordedSpawn {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

interface IoHarness {
  io: CommandIo;
  stdout: string[];
  stderr: string[];
  spawnCalls: RecordedSpawn[];
}

function makeFs(initial: Record<string, string> = {}): FsAdapter {
  const files = new Map(Object.entries(initial));
  return {
    async exists(path) {
      return files.has(path);
    },
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    async writeFile(path, contents) {
      files.set(path, contents);
    },
    async mkdir() {
      // no-op for the in-memory adapter
    },
    async realpath(path) {
      return path;
    },
  };
}

function makeSpawn(handler: (command: string, args: string[]) => SpawnResult, calls: RecordedSpawn[]): SpawnFn {
  return async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd, env: options?.env });
    return handler(command, args);
  };
}

function makeIo(overrides: Partial<{
  cwd: string;
  env: Record<string, string | undefined>;
  fs: FsAdapter;
  spawn: SpawnFn;
}> = {}): IoHarness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const spawnCalls: RecordedSpawn[] = [];
  const io: CommandIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    cwd: overrides.cwd ?? '/work/proj',
    env: overrides.env ?? {},
    fs: overrides.fs ?? makeFs(),
    spawn: overrides.spawn ?? makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), spawnCalls),
  };
  return { io, stdout, stderr, spawnCalls };
}

describe('cli parser', () => {
  it('parses long flags with and without values', () => {
    const result = parseArgs(['doctor', '--json', '--port', '4040', '--root=/x']);
    assert.equal(result.command, 'doctor');
    assert.equal(result.options.json, true);
    assert.equal(result.options.port, '4040');
    assert.equal(result.options.root, '/x');
  });

  it('treats -h as the help command regardless of position', () => {
    assert.equal(parseArgs(['init', '-h']).command, 'help');
    assert.equal(parseArgs(['--help', 'init']).command, 'help');
  });

  it('falls back to help on unknown commands and records the unknown token', () => {
    const result = parseArgs(['frobnicate']);
    assert.equal(result.command, 'help');
    assert.deepEqual(result.positional, ['frobnicate']);
  });

  it('usage text lists every public command', () => {
    const text = usage();
    for (const command of ['init', 'doctor', 'mcp', 'help']) {
      assert.ok(text.includes(command), `usage should mention ${command}`);
    }
  });
});

describe('doctor command', () => {
  it('reports failure when port 3027 is held', async () => {
    const calls: RecordedSpawn[] = [];
    const spawn = makeSpawn((command, args) => {
      if (command === 'pnpm') return { exitCode: 0, stdout: '11.1.2', stderr: '' };
      if (command === 'docker') return { exitCode: 0, stdout: 'Docker version 24.0', stderr: '' };
      if (command === 'lsof' && args.includes('-iTCP:3027')) return { exitCode: 0, stdout: '4242', stderr: '' };
      if (command === 'pg_isready') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }, calls);
    const fs = makeFs({
      '/work/proj/migrations': '',
      '/work/proj/src/mcp-stdio.ts': "console.error('ok')",
    });
    const harness = makeIo({ fs, spawn });
    const checks = await runDoctorChecks({ command: 'doctor', options: {}, positional: [] }, harness.io);
    const portCheck = checks.find((check) => check.name === 'port 3027');
    assert.equal(portCheck?.status, 'fail');
    assert.match(portCheck?.detail ?? '', /4242/);
  });

  it('exits non-zero only when at least one check fails', async () => {
    const spawn = makeSpawn((command, args) => {
      if (command === 'pnpm') return { exitCode: 0, stdout: '11.1.2', stderr: '' };
      if (command === 'docker') return { exitCode: 1, stdout: '', stderr: 'not found' };
      if (command === 'lsof' && args.includes('-iTCP:3027')) return { exitCode: 1, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }, []);
    const fs = makeFs({
      '/work/proj/migrations': '',
      '/work/proj/src/mcp-stdio.ts': "process.stderr.write('hi')",
    });
    const harness = makeIo({ fs, spawn });
    const result = await doctorCommand({ command: 'doctor', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0, 'docker is a warn, not a fail');
    assert.ok(harness.stdout.some((line) => /docker/i.test(line)));
  });

  it('flags MCP entry when it writes to stdout', async () => {
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), []);
    const fs = makeFs({
      '/work/proj/migrations': '',
      '/work/proj/src/mcp-stdio.ts': "console.log('this would corrupt MCP frames')",
    });
    const harness = makeIo({ fs, spawn });
    const result = await doctorCommand({ command: 'doctor', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 1);
    assert.ok(harness.stdout.some((line) => /mcp stdout sanity/i.test(line)));
  });
});

describe('init command', () => {
  it('runs docker compose + migrate and prints the MCP snippet when docker is present', async () => {
    const spawn = makeSpawn((command, args) => {
      if (command === 'docker' && args[0] === '--version') return { exitCode: 0, stdout: 'docker 24', stderr: '' };
      if (command === 'docker' && args.includes('exec')) return { exitCode: 0, stdout: 'accepting', stderr: '' };
      if (command === 'docker' && args.includes('up')) return { exitCode: 0, stdout: '', stderr: '' };
      if (command === 'pnpm' && args[0] === 'run') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }, []);
    const fs = makeFs({ '/work/proj/.env.example': 'X=1\n' });
    const harness = makeIo({ fs, spawn });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.ok(harness.stdout.some((line) => /Tuberosa is up/.test(line)));
    assert.ok(harness.stdout.some((line) => /mcp_servers.tuberosa/.test(line)));
    assert.equal(await fs.exists('/work/proj/.tuberosa/compose.yml'), true);
    assert.equal(await fs.exists('/work/proj/.env'), true);
  });

  it('falls back to embedded mode when docker is absent', async () => {
    const spawn = makeSpawn((command) => {
      if (command === 'docker') return { exitCode: 127, stdout: '', stderr: 'command not found' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }, []);
    const fs = makeFs({ '/work/proj/.env.example': 'X=1\n' });
    const harness = makeIo({ fs, spawn });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.ok(harness.stdout.some((line) => /Embedded-mode init/.test(line)));
    assert.ok(harness.stdout.some((line) => /TUBEROSA_STORE=memory/.test(line)));
    assert.equal(await fs.exists('/work/proj/.tuberosa/compose.yml'), false, 'no compose file in embedded mode');
  });

  it('honours --no-docker by forcing embedded mode', async () => {
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: 'docker 24', stderr: '' }), []);
    const fs = makeFs({ '/work/proj/.env.example': 'X=1\n' });
    const harness = makeIo({ fs, spawn });
    await initCommand({ command: 'init', options: { 'no-docker': true }, positional: [] }, harness.io);
    assert.ok(harness.stdout.some((line) => /forced by --no-docker/.test(line)));
  });

  it('copies the bundled comprehension skill into .claude/skills when --with-skills is passed', async () => {
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), []);
    const fs = makeFs({
      '/work/proj/.env.example': 'X=1\n',
      // The installed package ships its skills here; TUBEROSA_SKILLS_SRC points the
      // copier at that bundled skills root (overrides module-relative resolution).
      '/pkg/.claude/skills/tuberosa-onboard-project/SKILL.md': '# onboard skill\n',
    });
    const harness = makeIo({ fs, env: { TUBEROSA_SKILLS_SRC: '/pkg/.claude/skills' }, spawn });
    const result = await initCommand(
      { command: 'init', options: { 'no-docker': true, 'with-skills': true }, positional: [] },
      harness.io,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(
      await fs.exists('/work/proj/.claude/skills/tuberosa-onboard-project/SKILL.md'),
      true,
      'comprehension skill should be copied into the project',
    );
    assert.equal(
      await fs.readFile('/work/proj/.claude/skills/tuberosa-onboard-project/SKILL.md'),
      '# onboard skill\n',
    );
    assert.ok(harness.stdout.some((line) => /tuberosa-onboard-project/.test(line)));
  });

  it('does not overwrite an existing skill file when --with-skills is passed', async () => {
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), []);
    const fs = makeFs({
      '/work/proj/.env.example': 'X=1\n',
      '/pkg/.claude/skills/tuberosa-onboard-project/SKILL.md': '# bundled\n',
      '/work/proj/.claude/skills/tuberosa-onboard-project/SKILL.md': '# user-edited\n',
    });
    const harness = makeIo({ fs, env: { TUBEROSA_SKILLS_SRC: '/pkg/.claude/skills' }, spawn });
    await initCommand(
      { command: 'init', options: { 'no-docker': true, 'with-skills': true }, positional: [] },
      harness.io,
    );
    assert.equal(
      await fs.readFile('/work/proj/.claude/skills/tuberosa-onboard-project/SKILL.md'),
      '# user-edited\n',
      'existing user skill must be preserved, not clobbered',
    );
  });
});

describe('mcp command', () => {
  it('prefers compiled dist entry when available and applies embedded defaults', async () => {
    const calls: RecordedSpawn[] = [];
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), calls);
    const fs = makeFs({ '/work/proj/dist/src/mcp-stdio.js': '' });
    const harness = makeIo({ fs, spawn });
    const result = await mcpCommand({ command: 'mcp', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.equal(calls[0]!.command, 'node');
    assert.deepEqual(calls[0]!.args, ['/work/proj/dist/src/mcp-stdio.js']);
    assert.equal(calls[0]!.env?.TUBEROSA_STORE, 'memory');
    assert.equal(calls[0]!.env?.TUBEROSA_MODEL_PROVIDER, 'hash');
  });

  it('falls back to tsx entry when dist is missing', async () => {
    const calls: RecordedSpawn[] = [];
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), calls);
    const fs = makeFs({ '/work/proj/src/mcp-stdio.ts': '' });
    const harness = makeIo({ fs, spawn });
    await mcpCommand({ command: 'mcp', options: {}, positional: [] }, harness.io);
    assert.equal(calls[0]!.command, 'node');
    assert.deepEqual(calls[0]!.args, ['--import', 'tsx', '/work/proj/src/mcp-stdio.ts']);
  });

  it('preserves user-set env vars instead of overwriting them', () => {
    const env = buildEnv({ TUBEROSA_STORE: 'postgres', PATH: '/bin' });
    assert.equal(env.TUBEROSA_STORE, 'postgres');
    assert.equal(env.TUBEROSA_CACHE, 'memory');
    assert.equal(env.PATH, '/bin');
  });
});

describe('dispatch', () => {
  it('routes commands to their handlers', async () => {
    const harness = makeIo();
    const help = await dispatch({ command: 'help', options: {}, positional: [] }, harness.io);
    assert.equal(help.exitCode, 0);
    assert.ok(harness.stdout.join('\n').includes('Usage: tuberosa'));
  });
});

describe('compose template', () => {
  it('renders a YAML that wires Postgres + Redis health checks', () => {
    const yaml = composeTemplate({ password: 'tuberosa', postgresPort: 5432, redisPort: 6379 });
    assert.ok(yaml.includes('pg_isready'));
    assert.ok(yaml.includes('redis-cli'));
    assert.ok(yaml.includes('127.0.0.1:5432:5432'));
  });
});
