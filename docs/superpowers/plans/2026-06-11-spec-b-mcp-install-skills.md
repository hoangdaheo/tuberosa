# Spec B — Zero-Touch Agent Config + Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tuberosa mcp install` writes agent MCP configs (`.mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml`) merge-never-clobber, and `tuberosa init` ships all bundled skills and writes those configs by default — zero hand-editing for the end user.

**Architecture:** A new pure module (`bin/commands/mcp-install.ts`) holds entry-building, JSON-merge, and TOML-append logic with zero I/O; a thin command wrapper does the file I/O through the existing injectable `FsAdapter`, so every behavior is unit-testable with the in-memory harness in `test/cli.test.ts`. `init` calls the same shared installer after the stack is healthy. Skills become consumer-safe first (rewrite repo-internal references), then the bundled-skills manifest expands to all four skills — the existing prepack gate (`scripts/verify-bundled-skills.ts`) mechanically forces the matching `package.json` `files` entries, and gains a consumer-safety grep gate.

**Tech Stack:** TypeScript (NodeNext ESM), Node built-in test runner + tsx, no new dependencies (hand-rolled JSON merge; TOML is append-only by design).

**Spec:** `docs/superpowers/specs/2026-06-10-full-featured-enduser-design.md` § Spec B (lines 119–156).

**Standing rules:** prefix node/pnpm commands with `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH`; never edit eval fixtures/thresholds; MCP stdout stays protocol-only; conventional commits, no Co-Authored-By trailers.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `bin/commands/mcp-install.ts` | Create | Pure helpers (entry build, JSON merge, TOML render/detect) + `installMcpConfigs` (fs I/O via adapter) + `mcpInstallCommand` (CLI wrapper) |
| `bin/commands/mcp.ts` | Modify | Route `positional[0] === 'install'` to `mcpInstallCommand` |
| `bin/commands/init.ts` | Modify | Skills copied by default (`--no-skills` opt-out, `--with-skills` removed); call `installMcpConfigs` after stack-up (`--no-mcp-config` opt-out) |
| `bin/commands/parser.ts` | Modify | `usage()` text for `mcp install`, `--no-skills`, `--no-mcp-config`, `--target`, `--force`; drop `--with-skills` line |
| `.claude/skills/tuberosa-guide/SKILL.md` | Modify | Consumer-safe rewrite (1 reference) |
| `.claude/skills/tuberosa-operating/SKILL.md` | Modify | Consumer-safe rewrite (10 references) |
| `.claude/skills/tuberosa-agent-loop/SKILL.md` | Verify only | Already passes the consumer-safety grep |
| `.claude/skills/bundled-skills.json` | Modify | Manifest: 1 → 4 skills |
| `package.json` | Modify | `files`: add 3 skill dirs |
| `scripts/verify-bundled-skills.ts` | Modify | Add consumer-safety grep gate |
| `test/cli.test.ts` | Modify | All new CLI behavior tests |
| `README.md`, `docs/INSTALL.md` | Modify | Document `mcp install`, default skills, opt-outs |

**Known trap (bake into the gate):** the consumer-safety grep must use `(^|[^a-zA-Z])eval/` — a naive `eval/` substring match false-positives on `retrieval/ingest`, which legitimately appears in `tuberosa-onboard-project/SKILL.md:175`.

---

### Task 1: Pure helpers — server entry, JSON merge, TOML render/detect

**Files:**
- Create: `bin/commands/mcp-install.ts`
- Test: `test/cli.test.ts` (append a new `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.ts` (the file already imports `assert`, `describe`, `it`; add the new import next to the existing `bin/commands` imports at the top):

```typescript
import {
  buildServerEntry,
  mergeMcpJson,
  renderTomlSection,
  tomlHasTuberosaEntry,
} from '../bin/commands/mcp-install.js';
```

And at the bottom of the file:

```typescript
describe('mcp install pure helpers', () => {
  it('builds the full-feature server entry with explicit env', () => {
    const entry = buildServerEntry({ postgresPort: 5432, redisPort: 6379 });
    assert.equal(entry.command, 'npx');
    assert.deepEqual(entry.args, ['tuberosa', 'mcp']);
    assert.deepEqual(entry.env, {
      TUBEROSA_STORE: 'postgres',
      TUBEROSA_CACHE: 'redis',
      TUBEROSA_MODEL_PROVIDER: 'local',
      DATABASE_URL: 'postgres://tuberosa:tuberosa@127.0.0.1:5432/tuberosa',
      REDIS_URL: 'redis://127.0.0.1:6379',
    });
  });

  it('writes a fresh .mcp.json when no file exists', () => {
    const entry = buildServerEntry({ postgresPort: 5432, redisPort: 6379 });
    const result = mergeMcpJson(undefined, entry, false);
    assert.equal(result.status, 'written');
    const doc = JSON.parse((result as { contents: string }).contents);
    assert.equal(doc.mcpServers.tuberosa.command, 'npx');
  });

  it('merges into existing JSON preserving foreign servers and unknown keys', () => {
    const existing = JSON.stringify({
      $schema: 'https://example.com/schema.json',
      mcpServers: { gitnexus: { command: 'gitnexus', args: ['mcp'] } },
    });
    const entry = buildServerEntry({ postgresPort: 5432, redisPort: 6379 });
    const result = mergeMcpJson(existing, entry, false);
    assert.equal(result.status, 'written');
    const doc = JSON.parse((result as { contents: string }).contents);
    assert.equal(doc.$schema, 'https://example.com/schema.json');
    assert.equal(doc.mcpServers.gitnexus.command, 'gitnexus');
    assert.deepEqual(doc.mcpServers.tuberosa.args, ['tuberosa', 'mcp']);
  });

  it('skips when tuberosa is already configured, unless --force', () => {
    const existing = JSON.stringify({ mcpServers: { tuberosa: { command: 'old' } } });
    const entry = buildServerEntry({ postgresPort: 5432, redisPort: 6379 });
    assert.equal(mergeMcpJson(existing, entry, false).status, 'exists');
    const forced = mergeMcpJson(existing, entry, true);
    assert.equal(forced.status, 'written');
    const doc = JSON.parse((forced as { contents: string }).contents);
    assert.equal(doc.mcpServers.tuberosa.command, 'npx');
  });

  it('refuses to touch unparseable or non-object JSON', () => {
    const entry = buildServerEntry({ postgresPort: 5432, redisPort: 6379 });
    assert.equal(mergeMcpJson('{not json', entry, false).status, 'invalid');
    assert.equal(mergeMcpJson('[1,2]', entry, false).status, 'invalid');
  });

  it('renders a TOML section with marker and env sub-table', () => {
    const toml = renderTomlSection(buildServerEntry({ postgresPort: 5432, redisPort: 6379 }));
    assert.ok(toml.includes('# added by tuberosa mcp install'));
    assert.ok(toml.includes('[mcp_servers.tuberosa]'));
    assert.ok(toml.includes('command = "npx"'));
    assert.ok(toml.includes('args = ["tuberosa", "mcp"]'));
    assert.ok(toml.includes('[mcp_servers.tuberosa.env]'));
    assert.ok(toml.includes('DATABASE_URL = "postgres://tuberosa:tuberosa@127.0.0.1:5432/tuberosa"'));
  });

  it('detects an existing [mcp_servers.tuberosa] TOML entry', () => {
    assert.equal(tomlHasTuberosaEntry('[mcp_servers.tuberosa]\ncommand = "x"\n'), true);
    assert.equal(tomlHasTuberosaEntry('  [mcp_servers.tuberosa]\n'), true);
    assert.equal(tomlHasTuberosaEntry('[mcp_servers.other]\n'), false);
    assert.equal(tomlHasTuberosaEntry(''), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/cli.test.ts`
Expected: FAIL — `Cannot find module '../bin/commands/mcp-install.js'`

- [ ] **Step 3: Implement the pure helpers**

Create `bin/commands/mcp-install.ts`:

```typescript
import { resolve } from 'node:path';
import type { CliInvocation, CommandIo, CommandResult, FsAdapter } from './types.js';

/**
 * Spec B — `tuberosa mcp install`: write agent MCP configs so users never
 * hand-edit them from a printed snippet.
 *
 * Targets: `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor) always;
 * `~/.codex/config.toml` (Codex) only when `~/.codex/` already exists.
 *
 * Merge, never clobber: JSON files are parsed and only the
 * `mcpServers.tuberosa` entry is added/replaced; every other key and server
 * is preserved byte-for-byte in structure. Unparseable JSON is refused — we
 * print the snippet instead of risking someone's config. TOML is append-only
 * (no TOML dependency): we add our own marked section, and never rewrite
 * TOML we didn't author.
 *
 * The env block intentionally duplicates `buildEnv()`'s defaults: the config
 * file is self-documenting and survives future default changes.
 */

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function buildServerEntry(options: { postgresPort: number; redisPort: number }): McpServerEntry {
  return {
    command: 'npx',
    args: ['tuberosa', 'mcp'],
    env: {
      TUBEROSA_STORE: 'postgres',
      TUBEROSA_CACHE: 'redis',
      TUBEROSA_MODEL_PROVIDER: 'local',
      DATABASE_URL: `postgres://tuberosa:tuberosa@127.0.0.1:${options.postgresPort}/tuberosa`,
      REDIS_URL: `redis://127.0.0.1:${options.redisPort}`,
    },
  };
}

export type JsonMergeResult =
  | { status: 'written'; contents: string }
  | { status: 'exists' }
  | { status: 'invalid'; error: string };

export function mergeMcpJson(
  existing: string | undefined,
  entry: McpServerEntry,
  force: boolean,
): JsonMergeResult {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (error) {
      return { status: 'invalid', error: (error as Error).message };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'invalid', error: 'top-level JSON value is not an object' };
    }
    doc = parsed as Record<string, unknown>;
  }
  const rawServers = doc.mcpServers;
  const servers: Record<string, unknown> =
    rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)
      ? { ...(rawServers as Record<string, unknown>) }
      : {};
  if (servers.tuberosa !== undefined && !force) {
    return { status: 'exists' };
  }
  servers.tuberosa = entry;
  doc.mcpServers = servers;
  return { status: 'written', contents: `${JSON.stringify(doc, null, 2)}\n` };
}

export function renderTomlSection(entry: McpServerEntry): string {
  const envLines = Object.entries(entry.env)
    .map(([key, value]) => `${key} = "${value}"`)
    .join('\n');
  return [
    '',
    '# added by tuberosa mcp install',
    '[mcp_servers.tuberosa]',
    `command = "${entry.command}"`,
    `args = [${entry.args.map((a) => `"${a}"`).join(', ')}]`,
    '',
    '[mcp_servers.tuberosa.env]',
    envLines,
    '',
  ].join('\n');
}

export function tomlHasTuberosaEntry(existing: string): boolean {
  return /^\s*\[mcp_servers\.tuberosa\]/m.test(existing);
}
```

(The `CliInvocation`/`CommandIo`/`CommandResult`/`FsAdapter` imports are used by Task 2's `installMcpConfigs`/`mcpInstallCommand`; the compiler tolerates type-only unused imports — if `tsc` complains after Step 4, trim them and re-add in Task 2.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/cli.test.ts`
Expected: PASS (all, including the 7 new ones)

- [ ] **Step 5: Commit**

```bash
git add bin/commands/mcp-install.ts test/cli.test.ts
git commit -m "feat(cli): pure helpers for mcp install (entry build, JSON merge, TOML append)"
```

---

### Task 2: `installMcpConfigs` + `mcpInstallCommand` + routing

**Files:**
- Modify: `bin/commands/mcp-install.ts` (append)
- Modify: `bin/commands/mcp.ts` (route `install`)
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.ts` (also add `mcpInstallCommand` to the Task 1 import):

```typescript
describe('mcp install command', () => {
  const HOME = '/home/u';

  it('writes .mcp.json and .cursor/mcp.json by default; codex only when ~/.codex exists', async () => {
    const fs = makeFs({});
    const harness = makeIo({ fs, env: { HOME } });
    const result = await mcpInstallCommand({ command: 'mcp', options: {}, positional: ['install'] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.equal(await fs.exists('/work/proj/.mcp.json'), true);
    assert.equal(await fs.exists('/work/proj/.cursor/mcp.json'), true);
    assert.equal(await fs.exists(`${HOME}/.codex/config.toml`), false);
    const doc = JSON.parse(await fs.readFile('/work/proj/.mcp.json'));
    assert.equal(doc.mcpServers.tuberosa.env.TUBEROSA_STORE, 'postgres');
  });

  it('includes codex by default when ~/.codex exists, appending a marked TOML section', async () => {
    const fs = makeFs({ [`${HOME}/.codex`]: 'dir', [`${HOME}/.codex/config.toml`]: 'model = "o3"\n' });
    const harness = makeIo({ fs, env: { HOME } });
    const result = await mcpInstallCommand({ command: 'mcp', options: {}, positional: ['install'] }, harness.io);
    assert.equal(result.exitCode, 0);
    const toml = await fs.readFile(`${HOME}/.codex/config.toml`);
    assert.ok(toml.startsWith('model = "o3"\n'), 'existing TOML content must be preserved');
    assert.ok(toml.includes('# added by tuberosa mcp install'));
    assert.ok(toml.includes('[mcp_servers.tuberosa]'));
  });

  it('skips an already-configured JSON entry and reports --force as the override', async () => {
    const fs = makeFs({
      '/work/proj/.mcp.json': JSON.stringify({ mcpServers: { tuberosa: { command: 'old' } } }),
    });
    const harness = makeIo({ fs, env: { HOME } });
    const result = await mcpInstallCommand({ command: 'mcp', options: {}, positional: ['install'] }, harness.io);
    assert.equal(result.exitCode, 0);
    const doc = JSON.parse(await fs.readFile('/work/proj/.mcp.json'));
    assert.equal(doc.mcpServers.tuberosa.command, 'old', 'must not clobber without --force');
    assert.ok(harness.stdout.join('\n').includes('--force'));
  });

  it('--force replaces only the tuberosa entry', async () => {
    const fs = makeFs({
      '/work/proj/.mcp.json': JSON.stringify({
        mcpServers: { tuberosa: { command: 'old' }, other: { command: 'keep' } },
      }),
    });
    const harness = makeIo({ fs, env: { HOME } });
    const result = await mcpInstallCommand({ command: 'mcp', options: { force: true }, positional: ['install'] }, harness.io);
    assert.equal(result.exitCode, 0);
    const doc = JSON.parse(await fs.readFile('/work/proj/.mcp.json'));
    assert.equal(doc.mcpServers.tuberosa.command, 'npx');
    assert.equal(doc.mcpServers.other.command, 'keep');
  });

  it('refuses unparseable JSON, prints the snippet, and exits non-zero', async () => {
    const fs = makeFs({ '/work/proj/.mcp.json': '{broken' });
    const harness = makeIo({ fs, env: { HOME } });
    const result = await mcpInstallCommand({ command: 'mcp', options: {}, positional: ['install'] }, harness.io);
    assert.equal(result.exitCode, 1);
    assert.equal(await fs.readFile('/work/proj/.mcp.json'), '{broken', 'file must be untouched');
    assert.ok(harness.stderr.join('\n').includes('.mcp.json'));
    assert.ok(harness.stdout.join('\n').includes('"tuberosa"'), 'snippet printed for manual recovery');
  });

  it('skips a TOML file that already has the entry; --force prints manual-edit instructions', async () => {
    const fs = makeFs({
      [`${HOME}/.codex`]: 'dir',
      [`${HOME}/.codex/config.toml`]: '[mcp_servers.tuberosa]\ncommand = "old"\n',
    });
    const harness = makeIo({ fs, env: { HOME } });
    await mcpInstallCommand({ command: 'mcp', options: { target: 'codex' }, positional: ['install'] }, harness.io);
    assert.equal(await fs.readFile(`${HOME}/.codex/config.toml`), '[mcp_servers.tuberosa]\ncommand = "old"\n');
    const forced = await mcpInstallCommand({ command: 'mcp', options: { target: 'codex', force: true }, positional: ['install'] }, harness.io);
    assert.equal(forced.exitCode, 0);
    assert.equal(await fs.readFile(`${HOME}/.codex/config.toml`), '[mcp_servers.tuberosa]\ncommand = "old"\n', 'we never rewrite TOML we did not author');
    assert.ok(harness.stdout.join('\n').includes('manual'), 'must point at manual editing');
  });

  it('--target restricts the set and rejects unknown targets', async () => {
    const fs = makeFs({});
    const harness = makeIo({ fs, env: { HOME } });
    const result = await mcpInstallCommand({ command: 'mcp', options: { target: 'cursor' }, positional: ['install'] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.equal(await fs.exists('/work/proj/.mcp.json'), false);
    assert.equal(await fs.exists('/work/proj/.cursor/mcp.json'), true);
    const bad = await mcpInstallCommand({ command: 'mcp', options: { target: 'vscode' }, positional: ['install'] }, harness.io);
    assert.equal(bad.exitCode, 1);
    assert.ok(harness.stderr.join('\n').includes('vscode'));
  });

  it('routes `tuberosa mcp install` through mcpCommand', async () => {
    const fs = makeFs({});
    const harness = makeIo({ fs, env: { HOME } });
    const result = await mcpCommand({ command: 'mcp', options: {}, positional: ['install'] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.equal(await fs.exists('/work/proj/.mcp.json'), true);
    assert.equal(harness.spawnCalls.length, 0, 'install must not spawn the MCP server');
  });
});
```

Note: `makeFs` treats any present key as existing, so `'dir'` works as a directory marker for the `~/.codex` existence check.

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/cli.test.ts`
Expected: FAIL — `mcpInstallCommand` is not exported

- [ ] **Step 3: Implement the installer + command + routing**

Append to `bin/commands/mcp-install.ts`:

```typescript
const VALID_TARGETS = ['claude', 'cursor', 'codex'] as const;
export type InstallTarget = (typeof VALID_TARGETS)[number];

export interface InstallOutcome {
  target: InstallTarget;
  path: string;
  status: 'written' | 'skipped_exists' | 'skipped_manual' | 'refused_invalid';
  detail?: string;
}

export interface InstallContext {
  root: string;
  homeDir: string;
  postgresPort: number;
  redisPort: number;
  force: boolean;
  targets?: InstallTarget[];
}

/**
 * Shared installer used by both `tuberosa mcp install` and `tuberosa init`.
 * Returns one outcome per target so callers can report or aggregate exit codes.
 */
export async function installMcpConfigs(fs: FsAdapter, context: InstallContext): Promise<InstallOutcome[]> {
  const entry = buildServerEntry({ postgresPort: context.postgresPort, redisPort: context.redisPort });
  const targets = context.targets ?? (await defaultTargets(fs, context.homeDir));
  const outcomes: InstallOutcome[] = [];

  for (const target of targets) {
    if (target === 'codex') {
      outcomes.push(await installToml(fs, `${context.homeDir}/.codex/config.toml`, entry, context.force));
    } else {
      const path = target === 'claude'
        ? `${context.root}/.mcp.json`
        : `${context.root}/.cursor/mcp.json`;
      outcomes.push(await installJson(fs, target, path, entry, context.force));
    }
  }
  return outcomes;
}

async function defaultTargets(fs: FsAdapter, homeDir: string): Promise<InstallTarget[]> {
  const targets: InstallTarget[] = ['claude', 'cursor'];
  if (homeDir && (await fs.exists(`${homeDir}/.codex`))) targets.push('codex');
  return targets;
}

async function installJson(
  fs: FsAdapter,
  target: InstallTarget,
  path: string,
  entry: McpServerEntry,
  force: boolean,
): Promise<InstallOutcome> {
  const existing = (await fs.exists(path)) ? await fs.readFile(path) : undefined;
  const merged = mergeMcpJson(existing, entry, force);
  if (merged.status === 'invalid') {
    return { target, path, status: 'refused_invalid', detail: merged.error };
  }
  if (merged.status === 'exists') {
    return { target, path, status: 'skipped_exists' };
  }
  const dir = path.slice(0, path.lastIndexOf('/'));
  await fs.mkdir(dir, true);
  await fs.writeFile(path, merged.contents);
  return { target, path, status: 'written' };
}

async function installToml(
  fs: FsAdapter,
  path: string,
  entry: McpServerEntry,
  force: boolean,
): Promise<InstallOutcome> {
  const existing = (await fs.exists(path)) ? await fs.readFile(path) : '';
  if (tomlHasTuberosaEntry(existing)) {
    // We never rewrite TOML we didn't author — even --force only points at manual editing.
    return { target: 'codex', path, status: force ? 'skipped_manual' : 'skipped_exists' };
  }
  const next = existing === '' ? renderTomlSection(entry).trimStart() : existing + renderTomlSection(entry);
  const dir = path.slice(0, path.lastIndexOf('/'));
  await fs.mkdir(dir, true);
  await fs.writeFile(path, next);
  return { target: 'codex', path, status: 'written' };
}

/** CLI wrapper: option parsing + per-target reporting. */
export async function mcpInstallCommand(invocation: CliInvocation, io: CommandIo): Promise<CommandResult> {
  const fs = io.fs;
  if (!fs) {
    io.err('mcp install requires an fs adapter');
    return { exitCode: 1 };
  }
  const root = typeof invocation.options.root === 'string' ? resolve(io.cwd, invocation.options.root) : io.cwd;
  const homeDir = io.env.HOME ?? '';

  let targets: InstallTarget[] | undefined;
  if (typeof invocation.options.target === 'string') {
    const requested = invocation.options.target.split(',').map((t) => t.trim()).filter(Boolean);
    const invalid = requested.filter((t) => !(VALID_TARGETS as readonly string[]).includes(t));
    if (invalid.length > 0) {
      io.err(`Unknown --target value(s): ${invalid.join(', ')}. Valid targets: ${VALID_TARGETS.join(', ')}.`);
      return { exitCode: 1 };
    }
    targets = requested as InstallTarget[];
  }

  const outcomes = await installMcpConfigs(fs, {
    root,
    homeDir,
    postgresPort: 5432,
    redisPort: 6379,
    force: invocation.options.force === true,
    targets,
  });

  let exitCode = 0;
  for (const outcome of outcomes) {
    switch (outcome.status) {
      case 'written':
        io.out(`✓ ${outcome.target}: wrote ${outcome.path}`);
        break;
      case 'skipped_exists':
        io.out(`· ${outcome.target}: ${outcome.path} already configured (use --force to overwrite)`);
        break;
      case 'skipped_manual':
        io.out(`· ${outcome.target}: ${outcome.path} has an existing [mcp_servers.tuberosa] section — `
          + 'tuberosa does not rewrite TOML it did not author; please update it by manual edit.');
        break;
      case 'refused_invalid':
        io.err(`✗ ${outcome.target}: ${outcome.path} is not valid JSON (${outcome.detail}); file left untouched.`);
        io.out('Add this entry manually:');
        io.out(JSON.stringify({ mcpServers: { tuberosa: buildServerEntry({ postgresPort: 5432, redisPort: 6379 }) } }, null, 2));
        exitCode = 1;
        break;
    }
  }
  return { exitCode };
}
```

In `bin/commands/mcp.ts`, add the routing at the top of `mcpCommand` (before the spawn-adapter guard) plus the import:

```typescript
import { mcpInstallCommand } from './mcp-install.js';
```

```typescript
export async function mcpCommand(invocation: CliInvocation, io: CommandIo): Promise<CommandResult> {
  if (invocation.positional[0] === 'install') {
    return mcpInstallCommand(invocation, io);
  }
  if (!io.spawn || !io.fs) {
    // ... existing body unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/commands/mcp-install.ts bin/commands/mcp.ts test/cli.test.ts
git commit -m "feat(cli): tuberosa mcp install writes agent configs merge-never-clobber"
```

---

### Task 3: `init` writes MCP configs by default (`--no-mcp-config` opt-out)

**Files:**
- Modify: `bin/commands/init.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('init command', ...)` block in `test/cli.test.ts`:

```typescript
  it('writes MCP configs after the stack is up and reports them', async () => {
    const fs = makeFs({ '/work/proj/.env.example': 'X=1', '/pkg/package.json': '{"name":"tuberosa"}', '/pkg/dist/scripts/migrate.js': 'm', '/pkg/dist/scripts/warmup-embeddings.js': 'w', '/pkg/dist/scripts/reembed.js': 'r', '/pkg/migrations': 'dir' });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/pkg', HOME: '/home/u' } });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.equal(await fs.exists('/work/proj/.mcp.json'), true);
    assert.equal(await fs.exists('/work/proj/.cursor/mcp.json'), true);
    assert.ok(harness.stdout.some((line) => line.includes('.mcp.json')));
  });

  it('--no-mcp-config skips the config writer', async () => {
    const fs = makeFs({ '/work/proj/.env.example': 'X=1', '/pkg/package.json': '{"name":"tuberosa"}', '/pkg/dist/scripts/migrate.js': 'm', '/pkg/dist/scripts/warmup-embeddings.js': 'w', '/pkg/dist/scripts/reembed.js': 'r', '/pkg/migrations': 'dir' });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/pkg', HOME: '/home/u' } });
    const result = await initCommand({ command: 'init', options: { 'no-mcp-config': true }, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.equal(await fs.exists('/work/proj/.mcp.json'), false);
  });

  it('a config-writer refusal (invalid JSON) warns but does not fail init', async () => {
    const fs = makeFs({ '/work/proj/.env.example': 'X=1', '/work/proj/.mcp.json': '{broken', '/pkg/package.json': '{"name":"tuberosa"}', '/pkg/dist/scripts/migrate.js': 'm', '/pkg/dist/scripts/warmup-embeddings.js': 'w', '/pkg/dist/scripts/reembed.js': 'r', '/pkg/migrations': 'dir' });
    const harness = makeIo({ fs, env: { TUBEROSA_PACKAGE_ROOT: '/pkg', HOME: '/home/u' } });
    const result = await initCommand({ command: 'init', options: {}, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0, 'init succeeded — config write is best-effort');
    assert.equal(await fs.readFile('/work/proj/.mcp.json'), '{broken');
    assert.ok(harness.stderr.some((line) => line.includes('not valid JSON')));
  });
```

(All init tests in this file use a default spawn that returns exit 0 for docker/migrate/warmup/reembed, matching the existing pattern.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/cli.test.ts`
Expected: FAIL — `.mcp.json` not created by init

- [ ] **Step 3: Implement init integration**

In `bin/commands/init.ts`, add the import:

```typescript
import { installMcpConfigs } from './mcp-install.js';
```

In `initCommand`, after the reembed block and before `printSuccess(io, context)`:

```typescript
  if (invocation.options['no-mcp-config'] !== true) {
    const outcomes = await installMcpConfigs(fs, {
      root: context.root,
      homeDir: io.env.HOME ?? '',
      postgresPort: context.postgresPort,
      redisPort: context.redisPort,
      force: false,
    });
    for (const outcome of outcomes) {
      if (outcome.status === 'written') io.out(`✓ MCP config: wrote ${outcome.path}`);
      else if (outcome.status === 'refused_invalid') {
        io.err(`MCP config: ${outcome.path} is not valid JSON (${outcome.detail}); file left untouched — run \`npx tuberosa mcp install\` after fixing it.`);
      } else io.out(`· MCP config: ${outcome.path} already configured`);
    }
  }
```

(`skipped_manual` cannot occur here because init never passes `force: true`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/commands/init.ts test/cli.test.ts
git commit -m "feat(cli): init writes agent MCP configs by default (--no-mcp-config opts out)"
```

---

### Task 4: Consumer-safe rewrites of `tuberosa-guide` and `tuberosa-operating`

**Files:**
- Modify: `.claude/skills/tuberosa-guide/SKILL.md` (1 reference)
- Modify: `.claude/skills/tuberosa-operating/SKILL.md` (10 references)
- Verify only: `.claude/skills/tuberosa-agent-loop/SKILL.md` (already clean)

The acceptance check (spec B.2.2): no reference in a shipped SKILL.md to a path or command that doesn't exist in a consumer project. The gate (Task 5) mechanizes this as: no `docs/`, no `pnpm run`, no `(^|[^a-zA-Z])eval/` in shipped SKILL.md files.

- [ ] **Step 1: Confirm the current reference inventory**

Run:
```bash
grep -rnE 'docs/|pnpm run|(^|[^a-zA-Z])eval/' .claude/skills/tuberosa-guide/SKILL.md .claude/skills/tuberosa-agent-loop/SKILL.md .claude/skills/tuberosa-operating/SKILL.md
```
Expected: 11 hits — 1 in guide (line ~43, `docs/SETUP.md`), 10 in operating, 0 in agent-loop. If the counts differ (files drifted since this plan was written), apply the same rewrite principles to whatever the grep reports.

- [ ] **Step 2: Rewrite `tuberosa-guide/SKILL.md`**

Replace the environment-setup table row that points at `docs/SETUP.md`:

```markdown
| Set up the environment | `docs/SETUP.md` |
```

with:

```markdown
| Set up the environment | `npx tuberosa init` (one command; run `npx tuberosa doctor` if anything fails) |
```

- [ ] **Step 3: Rewrite `tuberosa-operating/SKILL.md`**

Apply these replacements (line numbers approximate; match on content):

1. Line ~22 (task table row): replace
   `| 5 | Check quality                 | `pnpm run eval:*` (one at a time)                      |`
   with
   `| 5 | Check quality                 | contributor-only: quality evals run in the Tuberosa repo, not in your project |`

2. Lines ~61–63 (the eval table): replace the three rows naming `pnpm run eval:retrieval` / `eval:agent-context` / `eval:knowledge-completeness` with a single sentence in place of the table:
   ```markdown
   Quality evals (`retrieval`, `agent-context`, `knowledge-completeness`) are contributor tooling that runs inside the Tuberosa checkout — as an operator of an installed Tuberosa you never run them. If retrieval quality looks wrong, use `tuberosa doctor` and the feedback tools (`tuberosa_feedback_context`) instead.
   ```

3. Line ~69 (the PATH-prefixed example command): delete the block quote entirely (it shows a contributor-machine `pnpm run eval:retrieval` invocation with a hardcoded `/home/nash` path).

4. Line ~78: replace
   `(exact choice lives in `docs/SETUP.md` / `docs/MINIMAL_ENV.md`)`
   with
   `(any current OpenAI model id works; pick a small one for cost)`

5. Line ~80: replace
   `✅ `pnpm run eval:knowledge-completeness` exercises this path. ❌ Still no atoms under `hash` — that provider has extraction off by design.`
   with
   `✅ After restart, new sessions produce atoms (check with `tuberosa_atom_gate_stats`). ❌ Still no atoms under `hash` — that provider has extraction off by design.`

6. Line ~82: replace
   `> For the full provider/env matrix (which keys each provider needs), read `docs/SETUP.md` and `docs/MINIMAL_ENV.md`. Do not memorize it from here.`
   with
   `> For the full provider/env matrix (which keys each provider needs), see the Configuration section of the Tuberosa README (shipped with the package). Do not memorize it from here.`

7. Line ~89 (related-docs list): delete the
   `- `docs/SETUP.md` — environment setup and provider matrix.`
   bullet.

- [ ] **Step 4: Verify the grep is clean**

Run:
```bash
grep -rnE 'docs/|pnpm run|(^|[^a-zA-Z])eval/' .claude/skills/tuberosa-guide/SKILL.md .claude/skills/tuberosa-agent-loop/SKILL.md .claude/skills/tuberosa-operating/SKILL.md .claude/skills/tuberosa-onboard-project/SKILL.md; echo "exit=$?"
```
Expected: no output, `exit=1` (no matches). Note `tuberosa-onboard-project` is included: its `retrieval/ingest` text must NOT match (this validates the `(^|[^a-zA-Z])eval/` pattern). If onboard-project has real `docs/`/`pnpm run` hits, rewrite them with the same principles.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/tuberosa-guide/SKILL.md .claude/skills/tuberosa-operating/SKILL.md
git commit -m "docs(skills): make guide and operating skills consumer-safe"
```

---

### Task 5: Consumer-safety grep gate in `verify-bundled-skills.ts`

**Files:**
- Modify: `scripts/verify-bundled-skills.ts`
- Test: manual gate run (the script is its own test — it must pass on the now-clean skills and fail on a planted violation)

- [ ] **Step 1: Implement the gate**

In `scripts/verify-bundled-skills.ts`, after check 3 (missing-file loop) and before the `if (errors.length > 0)` block, add:

```typescript
  // 4. Consumer-safety: shipped SKILL.md files must not reference repo-internal
  //    paths or contributor commands that don't exist in a consumer project.
  //    `(^|[^a-zA-Z])eval/` (not a bare `eval/`) so `retrieval/ingest` doesn't false-positive.
  const FORBIDDEN: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /docs\//, label: 'repo-internal docs/ path' },
    { pattern: /pnpm run/, label: 'contributor-only pnpm script' },
    { pattern: /(^|[^a-zA-Z])eval\//m, label: 'repo-internal eval/ path' },
  ];
  for (const rel of manifestSkillFilePaths(manifest)) {
    if (!rel.endsWith('SKILL.md')) continue;
    const fullPath = resolve(repoRoot, '.claude/skills', rel);
    if (!existsSync(fullPath)) continue; // already reported by check 3
    const contents = await readFile(fullPath, 'utf8');
    for (const { pattern, label } of FORBIDDEN) {
      const match = pattern.exec(contents);
      if (match) {
        const line = contents.slice(0, match.index).split('\n').length;
        errors.push(`.claude/skills/${rel}:${line} contains a ${label} — shipped skills must be consumer-safe`);
      }
    }
  }
```

- [ ] **Step 2: Verify the gate passes on the current manifest**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run verify:bundled-skills`
Expected: `Bundled-skills OK: 1 skill(s), 1 file(s) shipped.`

- [ ] **Step 3: Verify the gate catches a planted violation**

Run:
```bash
echo "see docs/SETUP.md" >> .claude/skills/tuberosa-onboard-project/SKILL.md
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run verify:bundled-skills; echo "exit=$?"
git checkout .claude/skills/tuberosa-onboard-project/SKILL.md
```
Expected: `FAILED` output naming `tuberosa-onboard-project/SKILL.md` with `repo-internal docs/ path`, `exit=1`; then the checkout restores the file.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-bundled-skills.ts
git commit -m "feat(skills): consumer-safety grep gate in verify-bundled-skills"
```

---

### Task 6: Manifest expansion to all four skills

**Files:**
- Modify: `.claude/skills/bundled-skills.json`
- Modify: `package.json` (`files` array, lines ~41–42)

- [ ] **Step 1: Expand the manifest**

Replace the contents of `.claude/skills/bundled-skills.json` with:

```json
{
  "skills": [
    { "name": "tuberosa-onboard-project", "files": ["SKILL.md"] },
    { "name": "tuberosa-guide", "files": ["SKILL.md"] },
    { "name": "tuberosa-agent-loop", "files": ["SKILL.md"] },
    { "name": "tuberosa-operating", "files": ["SKILL.md"] }
  ]
}
```

- [ ] **Step 2: Run the gate to see it force the files entries**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run verify:bundled-skills`
Expected: FAILED with three `manifest lists "..." but package.json "files" does not ship it` errors.

- [ ] **Step 3: Add the package.json files entries**

In `package.json`, the `files` array currently contains (lines ~41–42):

```json
    ".claude/skills/bundled-skills.json",
    ".claude/skills/tuberosa-onboard-project/"
```

Extend to:

```json
    ".claude/skills/bundled-skills.json",
    ".claude/skills/tuberosa-onboard-project/",
    ".claude/skills/tuberosa-guide/",
    ".claude/skills/tuberosa-agent-loop/",
    ".claude/skills/tuberosa-operating/"
```

- [ ] **Step 4: Run the gate to verify parity**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run verify:bundled-skills`
Expected: `Bundled-skills OK: 4 skill(s), 4 file(s) shipped.` (This also re-runs the Task 5 consumer-safety gate over the three newly added skills — it passes because Task 4 cleaned them. Task ordering matters: 4 → 5 → 6.)

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/bundled-skills.json package.json
git commit -m "feat(skills): ship all four tuberosa skills in the bundled manifest"
```

---

### Task 7: `init` copies skills by default; `--no-skills` opt-out; `--with-skills` removed

**Files:**
- Modify: `bin/commands/init.ts` (line ~43)
- Modify: `test/cli.test.ts` (existing `--with-skills` tests)

- [ ] **Step 1: Update the tests**

In `test/cli.test.ts`, the existing skills-copy tests (search for `--with-skills` / `with-skills`) currently pass `options: { 'with-skills': true }`. Update them:

1. The "copies the bundled comprehension skill into .claude/skills when --with-skills is passed" test: rename to `'copies bundled skills into .claude/skills by default'` and change its options to `{}`.
2. Any test asserting skills are NOT copied without the flag: rename to `'--no-skills skips the skills copy'` and change its options to `{ 'no-skills': true }`, asserting the destination file does not exist.
3. Keep the never-overwrite test as-is except for the options change (`{}` instead of `{ 'with-skills': true }`).

Add one new test inside `describe('init command', ...)`:

```typescript
  it('copies skills by default in --embedded mode too', async () => {
    const fs = makeFs({
      '/pkg/package.json': '{"name":"tuberosa"}',
      '/pkg/.claude/skills/bundled-skills.json': '{"skills":[{"name":"tuberosa-guide","files":["SKILL.md"]}]}',
      '/pkg/.claude/skills/tuberosa-guide/SKILL.md': '# guide',
    });
    const harness = makeIo({ fs, env: { TUBEROSA_SKILLS_SRC: '/pkg/.claude/skills' } });
    const result = await initCommand({ command: 'init', options: { embedded: true }, positional: [] }, harness.io);
    assert.equal(result.exitCode, 0);
    assert.equal(await fs.exists('/work/proj/.claude/skills/tuberosa-guide/SKILL.md'), true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/cli.test.ts`
Expected: FAIL — default options no longer copy skills

- [ ] **Step 3: Flip the default in init**

In `bin/commands/init.ts`, replace:

```typescript
  if (invocation.options['with-skills'] === true) {
    await copyBundledSkills(io, fs, context.root);
  }
```

with:

```typescript
  if (invocation.options['no-skills'] !== true) {
    await copyBundledSkills(io, fs, context.root);
  }
```

Also update the `copyBundledSkills` doc comment header (`--with-skills` →) to:

```typescript
/**
 * Default skills install — copy the package's bundled agent skills into
 * `<root>/.claude/skills/`. Runs on every `init` unless `--no-skills`.
 * ...
 */
```

and replace the three `--with-skills:` prefixes in its error messages with `skills:`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/commands/init.ts test/cli.test.ts
git commit -m "feat(cli): init copies bundled skills by default (--no-skills opts out)"
```

---

### Task 8: Help text + docs

**Files:**
- Modify: `bin/commands/parser.ts` (`usage()`, lines ~74–99)
- Modify: `README.md` (MCP config section, ~line 400)
- Modify: `docs/INSTALL.md`

- [ ] **Step 1: Update `usage()`**

In `bin/commands/parser.ts` `usage()`:

1. Replace the `init` line with:
   ```
   '  init      Bootstrap the full local stack: Docker Postgres + Redis, migrations, local embedding model, agent MCP configs, bundled skills. Hard-fails without Docker (use --embedded for volatile trial mode).',
   ```
2. Replace the `mcp` line with:
   ```
   '  mcp       Run the MCP stdio server (full stack by default; --embedded for the volatile trial stack). `mcp install` writes agent configs: .mcp.json, .cursor/mcp.json, ~/.codex/config.toml.',
   ```
3. Replace the `--with-skills` option line with:
   ```
   '  --no-skills         Skip copying bundled agent skills into <root>/.claude/skills/ (init).',
   '  --no-mcp-config     Skip writing agent MCP config files (init).',
   '  --target <list>     Comma-separated targets for `mcp install`: claude, cursor, codex.',
   '  --force             Overwrite an existing tuberosa entry (`mcp install`, JSON targets only).',
   ```
4. Add one example line: `'  npx tuberosa mcp install'`.

- [ ] **Step 2: Verify the existing usage test still passes**

Run: `PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH TUBEROSA_DISABLE_LOCAL_MODELS=true node --test --import tsx test/cli.test.ts`
Expected: PASS (the help test only asserts `Usage: tuberosa` is present)

- [ ] **Step 3: Update README.md and docs/INSTALL.md**

In `README.md`'s MCP configuration section (~line 400, where the `.mcp.json` / `~/.codex/config.toml` snippets are): keep the snippets as reference, but lead with the zero-touch path. Insert before the first snippet:

```markdown
> **Zero-touch:** `npx tuberosa init` writes these files for you (and `npx tuberosa mcp install`
> re-writes them on demand — merge-only, it never clobbers other servers in an existing config).
> The snippets below are the manual fallback.
```

In `docs/INSTALL.md`, find the section describing post-init manual MCP setup and replace the manual instruction with the same zero-touch paragraph, plus a one-line note: `init` also copies the bundled agent skills into `.claude/skills/` (`--no-skills` to skip; existing files are never overwritten).

- [ ] **Step 4: Commit**

```bash
git add bin/commands/parser.ts README.md docs/INSTALL.md
git commit -m "docs(cli): document mcp install and default skills/config behavior"
```

---

### Task 9: Full gates

- [ ] **Step 1: Run every gate**

```bash
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run build
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm test
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:retrieval
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run eval:agent-context
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run verify:bundled-skills
docker compose up -d postgres redis && PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH pnpm run test:integration
```

Expected: build clean; `# fail 0`; both evals pass with zero fixture edits; `Bundled-skills OK: 4 skill(s), 4 file(s) shipped.`; integration 5/5.

- [ ] **Step 2: Live smoke from a foreign directory**

```bash
rm -rf /tmp/tuberosa-smoke-b && mkdir -p /tmp/tuberosa-smoke-b && cd /tmp/tuberosa-smoke-b
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH npx tsx /home/nash/tuberosa/bin/tuberosa.ts init
cat .mcp.json
ls .claude/skills/
PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH npx tsx /home/nash/tuberosa/bin/tuberosa.ts mcp install --target claude
```

Expected: init exits 0 and reports `✓ MCP config: wrote /tmp/tuberosa-smoke-b/.mcp.json` and the skills copy; `.mcp.json` contains the `tuberosa` entry with the explicit env block; `.claude/skills/` lists all four skills; the second `mcp install` reports `already configured (use --force to overwrite)`.

- [ ] **Step 3: Report**

Report each command + outcome verbatim. If anything is red, STOP and fix before claiming done.

---

## Self-review (done at planning time)

- **Spec coverage:** B.2.1 targets/table/flags → Tasks 1–2; written-entry env duplication → Task 1; merge-never-clobber incl. unparseable-JSON refusal and TOML append/skip/`--force` manual-edit → Tasks 1–2; init integration + `--no-mcp-config` → Task 3; B.2.2(1) consumer rewrites → Task 4; B.3 grep gate → Task 5; B.2.2(2) manifest expansion (4 existing skills; `tuberosa-using` is Spec C's) → Task 6; B.2.2(3) copy-by-default/`--no-skills`/`--with-skills` removal → Task 7; help text (spec A.2.6 leftover lines owned by B) + docs → Task 8; B.3 full gates → Task 9.
- **Deviation noted:** spec says unparseable JSON → "exit non-zero" for `mcp install` (Task 2 does this); inside `init` the same refusal is warn-only (Task 3) so a pre-existing broken `.mcp.json` can't fail an otherwise-good install — consistent with init's reembed warn-only philosophy.
- **Type consistency:** `InstallOutcome.status` union matches every switch arm in `mcpInstallCommand` and the init reporter; `installMcpConfigs` signature identical at both call sites; `makeFs`/`makeIo`/`RecordedSpawn` usage matches the existing harness in `test/cli.test.ts`.
- **Ordering constraint:** Task 4 (clean skills) must land before Task 5's gate covers them via Task 6's manifest. Executing in numbered order satisfies this.
