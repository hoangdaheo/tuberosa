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

  it('finds bundled migrations + MCP entry under the package root, not the user cwd', async () => {
    const spawn = makeSpawn((command, args) => {
      if (command === 'pnpm') return { exitCode: 0, stdout: '11.1.2', stderr: '' };
      if (command === 'docker') return { exitCode: 1, stdout: '', stderr: 'not found' };
      if (command === 'lsof' && args.includes('-iTCP:3027')) return { exitCode: 1, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }, []);
    // User project (/work/proj) has NO migrations/ or src/ — they ship inside the
    // package (/pkg). This is the `npx tuberosa doctor` from a foreign project case.
    const fs = makeFs({
      '/pkg/package.json': '{"name":"tuberosa"}',
      '/pkg/migrations': '',
      '/pkg/dist/src/mcp-stdio.js': "process.stdout.write('frame')",
    });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/pkg' }, spawn });
    const checks = await runDoctorChecks({ command: 'doctor', options: {}, positional: [] }, harness.io);
    assert.equal(checks.find((c) => c.name === 'migrations')?.status, 'ok', 'migrations resolved from package root');
    assert.equal(checks.find((c) => c.name === 'mcp stdout sanity')?.status, 'ok', 'compiled dist entry counts as healthy');
  });
});

describe('doctor embedding model check', () => {
  it('reports ok when the model is cached', async () => {
    const fs = makeFs({ '/home/u/.cache/tuberosa/models/Xenova/bge-small-en-v1.5': 'dir' });
    const harness = makeIo({ fs, env: { HOME: '/home/u' } });
    const checks = await runDoctorChecks({ command: 'doctor', options: {}, positional: [] }, harness.io);
    const check = checks.find((entry) => entry.name === 'embedding model');
    assert.equal(check?.status, 'ok');
  });

  it('warns with warm-up remediation when the model is missing', async () => {
    const harness = makeIo({ env: { HOME: '/home/u' } });
    const checks = await runDoctorChecks({ command: 'doctor', options: {}, positional: [] }, harness.io);
    const check = checks.find((entry) => entry.name === 'embedding model');
    assert.equal(check?.status, 'warn');
    assert.ok(check?.remediation?.includes('tuberosa init'));
  });

  it('skips when the provider is not local', async () => {
    const harness = makeIo({ env: { HOME: '/home/u', TUBEROSA_MODEL_PROVIDER: 'openai' } });
    const checks = await runDoctorChecks({ command: 'doctor', options: {}, positional: [] }, harness.io);
    const check = checks.find((entry) => entry.name === 'embedding model');
    assert.equal(check?.status, 'skip');
  });
});

describe('init command', () => {
  it('runs docker compose + migrate and prints the MCP snippet when docker is present', async () => {
    const calls: RecordedSpawn[] = [];
    const spawn = makeSpawn((command, args) => {
      if (command === 'docker' && args[0] === '--version') return { exitCode: 0, stdout: 'docker 24', stderr: '' };
      if (command === 'docker' && args.includes('exec')) return { exitCode: 0, stdout: 'accepting', stderr: '' };
      if (command === 'docker' && args.includes('up')) return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }, calls);
    // The migrations live inside the installed package (/pkg), not the user's
    // project (/work/proj). Pin the package root so the test exercises the real
    // module-relative resolution path deterministically.
    const fs = makeFs({
      '/work/proj/.env.example': 'X=1\n',
      '/pkg/package.json': '{"name":"tuberosa"}',
      '/pkg/dist/scripts/migrate.js': '',
      '/pkg/dist/scripts/warmup-embeddings.js': '',
      '/pkg/dist/scripts/reembed.js': '',
    });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/pkg' }, spawn });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.ok(harness.stdout.some((line) => /Tuberosa is up/.test(line)));
    assert.ok(harness.stdout.some((line) => /mcp_servers.tuberosa/.test(line)));
    assert.equal(await fs.exists('/work/proj/.tuberosa/compose.yml'), true);
    assert.equal(await fs.exists('/work/proj/.env'), true);
    // Regression: init must NOT shell out to `pnpm run migrate` (that script only
    // exists in the Tuberosa checkout, so it failed in every foreign project).
    assert.ok(
      !calls.some((c) => c.command === 'pnpm' && c.args[0] === 'run' && c.args[1] === 'migrate'),
      'init must not run `pnpm run migrate`',
    );
    const migrate = calls.find((c) => c.command === 'node' && c.args.some((a) => /migrate\.js$/.test(a)));
    assert.ok(migrate, 'init should run the package-bundled migrate entry with node');
    assert.deepEqual(migrate!.args, ['/pkg/dist/scripts/migrate.js']);
    assert.equal(migrate!.cwd, '/pkg', 'migrate child cwd must be the package root so migrations/ resolves');
    assert.equal(migrate!.env?.DATABASE_URL, 'postgres://tuberosa:tuberosa@127.0.0.1:5432/tuberosa');
  });

  it('falls back to the tsx migrate entry when dist is absent (fresh checkout)', async () => {
    const calls: RecordedSpawn[] = [];
    const spawn = makeSpawn((command, args) => {
      if (command === 'docker' && args[0] === '--version') return { exitCode: 0, stdout: 'docker 24', stderr: '' };
      if (command === 'docker' && args.includes('exec')) return { exitCode: 0, stdout: 'accepting', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }, calls);
    const fs = makeFs({
      '/work/proj/.env.example': 'X=1\n',
      '/pkg/package.json': '{"name":"tuberosa"}',
      // no dist/ — only the TypeScript source is present; warmup + reembed tsx sources exist
      '/pkg/scripts/warmup-embeddings.ts': '',
      '/pkg/scripts/reembed.ts': '',
    });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/pkg' }, spawn });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    const migrate = calls.find((c) => c.command === 'node' && c.args.some((a) => /migrate\.ts$/.test(a)));
    assert.ok(migrate, 'init should fall back to `node --import tsx scripts/migrate.ts`');
    assert.deepEqual(migrate!.args, ['--import', 'tsx', '/pkg/scripts/migrate.ts']);
    assert.equal(migrate!.cwd, '/pkg');
  });

  it('fails clearly (not via pnpm) when the package root cannot be located for migrations', async () => {
    const spawn = makeSpawn((command, args) => {
      if (command === 'docker' && args[0] === '--version') return { exitCode: 0, stdout: 'docker 24', stderr: '' };
      if (command === 'docker' && args.includes('exec')) return { exitCode: 0, stdout: 'accepting', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }, []);
    // Point at a root that has no package.json — resolution fails.
    const fs = makeFs({ '/work/proj/.env.example': 'X=1\n' });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/nope' }, spawn });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 1);
    assert.ok(harness.stderr.some((line) => /package root/i.test(line)));
  });

  it('skips migrations entirely with --skip-migrate', async () => {
    const calls: RecordedSpawn[] = [];
    const spawn = makeSpawn((command, args) => {
      if (command === 'docker' && args[0] === '--version') return { exitCode: 0, stdout: 'docker 24', stderr: '' };
      if (command === 'docker' && args.includes('exec')) return { exitCode: 0, stdout: 'accepting', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }, calls);
    const fs = makeFs({
      '/work/proj/.env.example': 'X=1\n',
      '/pkg/package.json': '{"name":"tuberosa"}',
      '/pkg/dist/scripts/warmup-embeddings.js': '',
      '/pkg/dist/scripts/reembed.js': '',
    });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/pkg' }, spawn });
    const result = await initCommand({ command: 'init', options: { 'skip-migrate': true }, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.ok(!calls.some((c) => /migrate\./.test(c.args.join(' '))), 'no migrate child should be spawned');
  });

  it('hard-fails with guidance when Docker is missing', async () => {
    const harness = makeIo({
      spawn: makeSpawn((command) => (
        command === 'docker' ? { exitCode: 1, stdout: '', stderr: 'not found' } : { exitCode: 0, stdout: '', stderr: '' }
      ), []),
    });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 1);
    assert.ok(harness.stderr.join('\n').includes('docs.docker.com'));
    assert.ok(harness.stderr.join('\n').includes('--embedded'));
  });

  it('--embedded prints trial-mode instructions and exits 0 without Docker', async () => {
    const harness = makeIo({
      spawn: makeSpawn(() => ({ exitCode: 1, stdout: '', stderr: '' }), []),
    });
    const result = await initCommand({ command: 'init', options: { embedded: true }, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.ok(harness.stdout.join('\n').includes('volatile'));
  });

  it('--no-docker still works but prints a deprecation note', async () => {
    const harness = makeIo({
      spawn: makeSpawn(() => ({ exitCode: 1, stdout: '', stderr: '' }), []),
    });
    const result = await initCommand({ command: 'init', options: { 'no-docker': true }, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.ok(harness.stderr.join('\n').includes('deprecated'));
  });

  it('fails when the embedding warm-up fails', async () => {
    const fs = makeFs({ '/work/proj/.env.example': 'X=1', '/pkg/package.json': '{"name":"tuberosa"}', '/pkg/dist/scripts/migrate.js': 'm', '/pkg/dist/scripts/warmup-embeddings.js': 'w', '/pkg/migrations': 'dir' });
    const harness = makeIo({
      fs,
      env: { TUBEROSA_PACKAGE_ROOT: '/pkg' },
      spawn: makeSpawn((command, args) => {
        if (args.some((arg) => arg.includes('warmup-embeddings'))) return { exitCode: 1, stdout: '', stderr: 'model download failed' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }, []),
    });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 1);
    assert.ok(harness.stderr.join('\n').includes('--embedded'));
  });

  it('runs the reembed backfill after migrations and only warns on failure', async () => {
    const fs = makeFs({ '/work/proj/.env.example': 'X=1', '/pkg/package.json': '{"name":"tuberosa"}', '/pkg/dist/scripts/migrate.js': 'm', '/pkg/dist/scripts/warmup-embeddings.js': 'w', '/pkg/dist/scripts/reembed.js': 'r', '/pkg/migrations': 'dir' });
    const spawnCalls: RecordedSpawn[] = [];
    const harness = makeIo({
      fs,
      env: { TUBEROSA_PACKAGE_ROOT: '/pkg' },
      spawn: makeSpawn((command, args) => {
        if (args.some((arg) => arg.includes('reembed'))) return { exitCode: 1, stdout: '', stderr: 'transient' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }, spawnCalls),
    });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0); // reembed failure is a warning, not fatal
    const indexOf = (needle: string) => spawnCalls.findIndex((call) => call.args.some((arg) => arg.includes(needle)));
    assert.ok(indexOf('reembed') >= 0);
    assert.ok(indexOf('migrate') < indexOf('warmup-embeddings'), 'migrate must run before warm-up');
    assert.ok(indexOf('warmup-embeddings') < indexOf('reembed'), 'warm-up must run before reembed');
    assert.ok(harness.stderr.join('\n').includes('reembed'));
  });

  it('copies the bundled comprehension skill into .claude/skills when --with-skills is passed', async () => {
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), []);
    const fs = makeFs({
      '/work/proj/.env.example': 'X=1\n',
      // The installed package ships its skills here; TUBEROSA_SKILLS_SRC points the
      // copier at that bundled skills root (overrides module-relative resolution).
      '/pkg/.claude/skills/bundled-skills.json':
        '{"skills":[{"name":"tuberosa-onboard-project","files":["SKILL.md"]}]}',
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
      '/pkg/.claude/skills/bundled-skills.json':
        '{"skills":[{"name":"tuberosa-onboard-project","files":["SKILL.md"]}]}',
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

  it('copies every skill the manifest lists', async () => {
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), []);
    const fs = makeFs({
      '/work/proj/.env.example': 'X=1\n',
      '/pkg/.claude/skills/bundled-skills.json':
        '{"skills":[{"name":"skill-a","files":["SKILL.md"]},{"name":"skill-b","files":["SKILL.md"]}]}',
      '/pkg/.claude/skills/skill-a/SKILL.md': '# a\n',
      '/pkg/.claude/skills/skill-b/SKILL.md': '# b\n',
    });
    const harness = makeIo({ fs, env: { TUBEROSA_SKILLS_SRC: '/pkg/.claude/skills' }, spawn });
    await initCommand(
      { command: 'init', options: { 'no-docker': true, 'with-skills': true }, positional: [] },
      harness.io,
    );
    assert.equal(await fs.readFile('/work/proj/.claude/skills/skill-a/SKILL.md'), '# a\n');
    assert.equal(await fs.readFile('/work/proj/.claude/skills/skill-b/SKILL.md'), '# b\n');
  });

  it('skips skill copy with a clear message when the manifest is missing', async () => {
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), []);
    const fs = makeFs({ '/work/proj/.env.example': 'X=1\n' });
    const harness = makeIo({ fs, env: { TUBEROSA_SKILLS_SRC: '/pkg/.claude/skills' }, spawn });
    const result = await initCommand(
      { command: 'init', options: { 'no-docker': true, 'with-skills': true }, positional: [] },
      harness.io,
    );
    assert.equal(result.exitCode, 0, 'a missing manifest must not fail init');
    assert.ok(harness.stderr.some((line) => /manifest/i.test(line)), 'should warn about the missing manifest');
  });
});

describe('mcp command', () => {
  it('resolves the entrypoint from the package root, not cwd, and runs in the user cwd', async () => {
    const calls: RecordedSpawn[] = [];
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), calls);
    // The entrypoint ships inside the package (/pkg); the user invokes from /work/proj.
    const fs = makeFs({
      '/pkg/package.json': '{"name":"tuberosa"}',
      '/pkg/dist/src/mcp-stdio.js': '',
    });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/pkg' }, spawn });
    const result = await mcpCommand({ command: 'mcp', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.equal(calls[0]!.command, 'node');
    assert.deepEqual(calls[0]!.args, ['/pkg/dist/src/mcp-stdio.js']);
    assert.equal(calls[0]!.cwd, '/work/proj', 'child cwd is the user project, so the mirror lands there');
    assert.equal(calls[0]!.env?.TUBEROSA_STORE, 'postgres');
    assert.equal(calls[0]!.env?.TUBEROSA_MODEL_PROVIDER, 'local');
  });

  it('falls back to tsx entry when dist is missing', async () => {
    const calls: RecordedSpawn[] = [];
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), calls);
    const fs = makeFs({
      '/pkg/package.json': '{"name":"tuberosa"}',
      '/pkg/src/mcp-stdio.ts': '',
    });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/pkg' }, spawn });
    await mcpCommand({ command: 'mcp', options: {}, positional: [] }, harness.io);
    assert.equal(calls[0]!.command, 'node');
    assert.deepEqual(calls[0]!.args, ['--import', 'tsx', '/pkg/src/mcp-stdio.ts']);
  });

  it('honours --root as an entrypoint override (legacy power-user path)', async () => {
    const calls: RecordedSpawn[] = [];
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), calls);
    const fs = makeFs({ '/checkout/dist/src/mcp-stdio.js': '' });
    const harness = makeIo({ fs, spawn });
    const result = await mcpCommand({ command: 'mcp', options: { root: '/checkout' }, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls[0]!.args, ['/checkout/dist/src/mcp-stdio.js']);
  });

  it('errors clearly when the package cannot be located', async () => {
    const spawn = makeSpawn(() => ({ exitCode: 0, stdout: '', stderr: '' }), []);
    const fs = makeFs({}); // no package.json anywhere the resolver can see
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/nope' }, spawn });
    const result = await mcpCommand({ command: 'mcp', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 1);
    assert.ok(harness.stderr.some((line) => /Could not locate the Tuberosa package/.test(line)));
  });

  it('preserves user-set env vars instead of overwriting them', () => {
    const env = buildEnv({ TUBEROSA_STORE: 'postgres', PATH: '/bin' });
    assert.equal(env.TUBEROSA_STORE, 'postgres');
    assert.equal(env.TUBEROSA_CACHE, 'redis');
    assert.equal(env.PATH, '/bin');
  });

  it('mcp --embedded spawns the server with the trial env', async () => {
    const fs = makeFs({ '/pkg/package.json': '{"name":"tuberosa"}', '/pkg/dist/src/mcp-stdio.js': 'compiled' });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/pkg' } });
    const result = await mcpCommand({ command: 'mcp', options: { embedded: true }, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.equal(harness.spawnCalls[0]?.env?.TUBEROSA_STORE, 'memory');
    assert.equal(harness.spawnCalls[0]?.env?.TUBEROSA_MODEL_PROVIDER, 'hash');
  });
});

describe('mcp buildEnv (Spec A defaults)', () => {
  it('defaults to the full-feature stack', () => {
    const env = buildEnv({});
    assert.equal(env.TUBEROSA_STORE, 'postgres');
    assert.equal(env.TUBEROSA_CACHE, 'redis');
    assert.equal(env.TUBEROSA_MODEL_PROVIDER, 'local');
    assert.equal(env.TUBEROSA_AUTO_MIGRATE, 'false');
  });

  it('preserves user-exported values', () => {
    const env = buildEnv({ TUBEROSA_STORE: 'memory', TUBEROSA_MODEL_PROVIDER: 'openai' });
    assert.equal(env.TUBEROSA_STORE, 'memory');
    assert.equal(env.TUBEROSA_MODEL_PROVIDER, 'openai');
    assert.equal(env.TUBEROSA_CACHE, 'redis');
  });

  it('--embedded forces the volatile trial stack', () => {
    const env = buildEnv({ TUBEROSA_STORE: 'postgres' }, { embedded: true });
    assert.equal(env.TUBEROSA_STORE, 'memory');
    assert.equal(env.TUBEROSA_CACHE, 'memory');
    assert.equal(env.TUBEROSA_MODEL_PROVIDER, 'hash');
  });

  it('TUBEROSA_EMBEDDED=1 in the environment triggers embedded mode', () => {
    const env = buildEnv({ TUBEROSA_EMBEDDED: '1' });
    assert.equal(env.TUBEROSA_STORE, 'memory');
    assert.equal(env.TUBEROSA_MODEL_PROVIDER, 'hash');
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
