# Bundled Skills — Single Source of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one manifest file the single authoritative list of the agent skills Tuberosa bundles, so `tuberosa init --with-skills` and the npm package's `files` allowlist can never silently drift apart.

**Architecture:** A JSON manifest at `.claude/skills/bundled-skills.json` lists which skill folders ship. A new pure module (`bin/commands/bundled-skills.ts`) parses/validates it and computes drift. `init --with-skills` reads the manifest at runtime to decide what to copy (replacing today's hardcoded `BUNDLED_SKILLS` array). A `prepack` lifecycle script (`scripts/verify-bundled-skills.ts`) fails the pack/publish if the manifest, the on-disk skill files, and `package.json` `files` disagree. The shipped skill *content* stays exactly as today (`tuberosa-onboard-project` only) — this change is about the *mechanism*, not about shipping more skills. Adding a skill later becomes a one-line manifest edit; the gate tells you exactly which `files` entry to add.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), `tsx` for running `.ts` scripts, `node:test` + `node:assert/strict` for tests, the existing injectable `CommandIo`/`FsAdapter` CLI pattern (`bin/commands/`).

---

## Why a manifest + gate (not just an array)

Today `init.ts` hardcodes `const BUNDLED_SKILLS = ['tuberosa-onboard-project/SKILL.md']` AND `package.json` `files` separately lists `.claude/skills/tuberosa-onboard-project/`. Two lists, hand-kept in sync. Add a second skill and you must remember to edit both, or the package ships a skill `init` won't copy (or vice versa). The manifest makes the list authoritative in one place; the `prepack` gate makes drift a hard failure at publish time instead of a silent bug a consumer hits.

## File Structure

| File | Create / Modify | Responsibility |
| --- | --- | --- |
| `bin/commands/bundled-skills.ts` | **Create** | Pure functions: parse/validate the manifest, flatten to file paths, list skill dirs, compute `files`↔manifest drift. No I/O. |
| `.claude/skills/bundled-skills.json` | **Create** | The single source of truth: which skill folders + files ship. |
| `bin/commands/init.ts` | **Modify** | Replace the hardcoded `BUNDLED_SKILLS` array with a runtime read of the manifest. |
| `scripts/verify-bundled-skills.ts` | **Create** | Publish-time gate: assert manifest ↔ on-disk files ↔ `package.json` `files` all agree. Exits 1 on drift. |
| `package.json` | **Modify** | Add the manifest to `files`; add `verify:bundled-skills` script + `prepack` lifecycle hook. |
| `test/bundled-skills.test.ts` | **Create** | Unit tests for the pure module (parse, flatten, drift detection). |
| `test/cli.test.ts` | **Modify** | Update the two existing `--with-skills` tests for the manifest; add a multi-skill copy test and a missing-manifest test. |
| `docs/INSTALL.md` | **Modify** | Document the gate and the one-edit "add a skill" workflow. |

All commands below assume Node 22.21.1. If your shell uses an older Node, prefix every command with:
`PATH=/home/nash/.nvm/versions/node/v22.21.1/bin:$PATH`

---

## Task 1: Pure manifest module + unit tests

**Files:**
- Create: `test/bundled-skills.test.ts`
- Create: `bin/commands/bundled-skills.ts`

- [ ] **Step 1: Write the failing test**

Create `test/bundled-skills.test.ts` with this exact content:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseManifest,
  manifestSkillFilePaths,
  manifestSkillDirs,
  findFilesDrift,
} from '../bin/commands/bundled-skills.js';

describe('bundled-skills manifest', () => {
  it('parses a valid manifest', () => {
    const m = parseManifest('{"skills":[{"name":"a","files":["SKILL.md"]}]}');
    assert.deepEqual(m, { skills: [{ name: 'a', files: ['SKILL.md'] }] });
  });

  it('throws when skills is not an array', () => {
    assert.throws(() => parseManifest('{"skills":{}}'), /skills/);
  });

  it('throws when a skill name is empty', () => {
    assert.throws(() => parseManifest('{"skills":[{"name":"","files":["SKILL.md"]}]}'), /name/);
  });

  it('throws when files is not a string array', () => {
    assert.throws(() => parseManifest('{"skills":[{"name":"a","files":[1]}]}'), /files/);
  });

  it('flattens skill file paths', () => {
    const m = {
      skills: [
        { name: 'a', files: ['SKILL.md'] },
        { name: 'b', files: ['SKILL.md', 'references/x.md'] },
      ],
    };
    assert.deepEqual(manifestSkillFilePaths(m), ['a/SKILL.md', 'b/SKILL.md', 'b/references/x.md']);
  });

  it('lists skill dirs with a trailing slash (matching package.json files entries)', () => {
    const m = { skills: [{ name: 'a', files: ['SKILL.md'] }] };
    assert.deepEqual(manifestSkillDirs(m), ['.claude/skills/a/']);
  });

  it('reports no drift when files match the manifest (manifest json entry ignored)', () => {
    const report = findFilesDrift(
      ['.claude/skills/a/'],
      ['dist/', '.claude/skills/bundled-skills.json', '.claude/skills/a/'],
    );
    assert.deepEqual(report, { missingFromFiles: [], extraInFiles: [] });
  });

  it('detects a manifest skill missing from files', () => {
    const report = findFilesDrift(['.claude/skills/a/', '.claude/skills/b/'], ['.claude/skills/a/']);
    assert.deepEqual(report.missingFromFiles, ['.claude/skills/b/']);
    assert.deepEqual(report.extraInFiles, []);
  });

  it('detects a shipped skill the manifest does not list', () => {
    const report = findFilesDrift(['.claude/skills/a/'], ['.claude/skills/a/', '.claude/skills/b/']);
    assert.deepEqual(report.missingFromFiles, []);
    assert.deepEqual(report.extraInFiles, ['.claude/skills/b/']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --import tsx test/bundled-skills.test.ts`
Expected: FAIL — module not found / `Cannot find module '../bin/commands/bundled-skills.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `bin/commands/bundled-skills.ts` with this exact content:

```ts
/**
 * Single source of truth for which agent skills Tuberosa bundles and ships.
 *
 * The manifest (`.claude/skills/bundled-skills.json`) is authoritative. Both the
 * runtime copier (`init --with-skills`) and the publish-time gate
 * (`scripts/verify-bundled-skills.ts`) derive their behaviour from it, so the
 * package's `files` allowlist can never silently drift from what `init` copies.
 *
 * This module is PURE (no I/O) so it is trivially unit-testable.
 */

export interface BundledSkill {
  /** Skill folder name under `.claude/skills/`, e.g. `tuberosa-onboard-project`. */
  name: string;
  /** Files within the skill folder to ship/copy, e.g. `['SKILL.md']`. */
  files: string[];
}

export interface BundledSkillManifest {
  skills: BundledSkill[];
}

/** The manifest file name, resolved relative to the skills root at runtime. */
export const BUNDLED_SKILLS_MANIFEST = 'bundled-skills.json';

/** Parse + validate the manifest JSON. Throws a descriptive Error on a bad shape. */
export function parseManifest(json: string): BundledSkillManifest {
  const data: unknown = JSON.parse(json);
  if (!data || typeof data !== 'object' || !Array.isArray((data as { skills?: unknown }).skills)) {
    throw new Error('bundled-skills manifest must be an object with a "skills" array');
  }
  const skills = (data as { skills: unknown[] }).skills.map((entry, index) => {
    const skill = entry as { name?: unknown; files?: unknown };
    if (typeof skill.name !== 'string' || skill.name.length === 0) {
      throw new Error(`bundled-skills manifest skills[${index}].name must be a non-empty string`);
    }
    if (!Array.isArray(skill.files) || skill.files.some((f) => typeof f !== 'string' || f.length === 0)) {
      throw new Error(`bundled-skills manifest skills[${index}].files must be an array of non-empty strings`);
    }
    return { name: skill.name, files: skill.files as string[] };
  });
  return { skills };
}

/** Flatten to `<name>/<file>` paths relative to the skills root. */
export function manifestSkillFilePaths(manifest: BundledSkillManifest): string[] {
  return manifest.skills.flatMap((skill) => skill.files.map((file) => `${skill.name}/${file}`));
}

/** The `package.json` "files" directory entries (trailing slash) the manifest implies. */
export function manifestSkillDirs(manifest: BundledSkillManifest): string[] {
  return manifest.skills.map((skill) => `.claude/skills/${skill.name}/`);
}

export interface DriftReport {
  /** Manifest skill dirs that `package.json` "files" does not ship. */
  missingFromFiles: string[];
  /** Skill dirs `package.json` "files" ships that the manifest does not list. */
  extraInFiles: string[];
}

/**
 * Compare the manifest's skill dirs against the `package.json` "files" entries.
 * The manifest JSON file's own entry (`.claude/skills/bundled-skills.json`) is
 * ignored here — the gate script checks for it separately.
 */
export function findFilesDrift(manifestDirs: string[], filesEntries: string[]): DriftReport {
  const shippedSkillDirs = filesEntries.filter(
    (entry) => entry.startsWith('.claude/skills/') && entry !== `.claude/skills/${BUNDLED_SKILLS_MANIFEST}`,
  );
  const expected = new Set(manifestDirs);
  const actual = new Set(shippedSkillDirs);
  return {
    missingFromFiles: manifestDirs.filter((dir) => !actual.has(dir)),
    extraInFiles: [...actual].filter((entry) => !expected.has(entry)),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --import tsx test/bundled-skills.test.ts`
Expected: PASS — all 9 subtests ok, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add bin/commands/bundled-skills.ts test/bundled-skills.test.ts
git commit -m "feat(cli): add pure bundled-skills manifest module"
```

---

## Task 2: Create the manifest file + ship it in the package

**Files:**
- Create: `.claude/skills/bundled-skills.json`
- Modify: `package.json` (the `files` array)

This task has no unit test of its own — the on-disk manifest is exercised by the gate (Task 4) and final verification (Task 5). Keep the shipped set identical to today: only `tuberosa-onboard-project`.

- [ ] **Step 1: Create the manifest**

Create `.claude/skills/bundled-skills.json` with this exact content:

```json
{
  "skills": [
    { "name": "tuberosa-onboard-project", "files": ["SKILL.md"] }
  ]
}
```

- [ ] **Step 2: Add the manifest to the package `files` allowlist**

In `package.json`, change the `files` array from:

```json
  "files": [
    "dist/",
    "bin/",
    ".env.example",
    "migrations/",
    ".claude/skills/tuberosa-onboard-project/"
  ],
```

to (adds the manifest json line):

```json
  "files": [
    "dist/",
    "bin/",
    ".env.example",
    "migrations/",
    ".claude/skills/bundled-skills.json",
    ".claude/skills/tuberosa-onboard-project/"
  ],
```

- [ ] **Step 3: Verify the manifest parses with the real module**

Run:
```bash
node --import tsx -e "import('./bin/commands/bundled-skills.js').then(async m => { const fs = await import('node:fs/promises'); const man = m.parseManifest(await fs.readFile('.claude/skills/bundled-skills.json','utf8')); console.log(JSON.stringify(m.manifestSkillFilePaths(man))); })"
```
Expected output: `["tuberosa-onboard-project/SKILL.md"]`

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/bundled-skills.json package.json
git commit -m "feat(cli): add bundled-skills manifest as single source of truth"
```

---

## Task 3: Rewire `init --with-skills` to read the manifest

**Files:**
- Modify: `bin/commands/init.ts`
- Modify: `test/cli.test.ts`

### 3a. Update the existing CLI tests to expect manifest-driven copying (fail first)

- [ ] **Step 1: Update the two existing `--with-skills` tests**

In `test/cli.test.ts`, the two existing tests seed only the skill file. They must also seed the manifest, because `resolveSkillsSource` will now probe for `bundled-skills.json`.

Replace this existing test:

```ts
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
```

with this version (adds the manifest file to the in-memory fs):

```ts
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
```

Then replace this existing test:

```ts
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
```

with this version (adds the manifest file):

```ts
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
```

- [ ] **Step 2: Add a multi-skill test and a missing-manifest test**

In `test/cli.test.ts`, immediately after the `'does not overwrite an existing skill file when --with-skills is passed'` test (still inside the `describe('init command', …)` block), add these two new tests:

```ts
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
```

- [ ] **Step 3: Run the CLI tests to verify the new expectations fail**

Run: `node --test --import tsx test/cli.test.ts`
Expected: FAIL — the multi-skill test fails (today's code only copies the hardcoded `tuberosa-onboard-project`), and the missing-manifest test fails (today's `resolveSkillsSource` probes the skill file, not the manifest, so it reports a different message). `# fail` ≥ 1.

### 3b. Implement the manifest-driven copier (make it pass)

- [ ] **Step 4: Update the imports in `init.ts`**

In `bin/commands/init.ts`, replace this import block + the `BUNDLED_SKILLS` constant:

```ts
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliInvocation, CommandIo, CommandResult, SpawnFn, FsAdapter } from './types.js';
import { DEFAULT_MCP_PORT } from './types.js';
import { composeTemplate } from './compose-template.js';

/**
 * Consumer-facing skills the published package bundles and `--with-skills` copies
 * into the user's `.claude/skills/`. Paths are relative to the bundled skills root.
 * Kept as an explicit manifest (not a directory walk) so the copy works through the
 * minimal FsAdapter surface and stays trivially testable.
 */
const BUNDLED_SKILLS = ['tuberosa-onboard-project/SKILL.md'] as const;
```

with this (drops the hardcoded array, imports the manifest module):

```ts
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliInvocation, CommandIo, CommandResult, SpawnFn, FsAdapter } from './types.js';
import { DEFAULT_MCP_PORT } from './types.js';
import { composeTemplate } from './compose-template.js';
import { BUNDLED_SKILLS_MANIFEST, parseManifest, manifestSkillFilePaths } from './bundled-skills.js';
```

- [ ] **Step 5: Replace `copyBundledSkills` with a manifest-driven version**

In `bin/commands/init.ts`, replace the entire existing `copyBundledSkills` function:

```ts
async function copyBundledSkills(io: CommandIo, fs: FsAdapter, root: string): Promise<void> {
  const srcRoot = await resolveSkillsSource(io, fs);
  if (!srcRoot) {
    io.err('--with-skills: could not locate bundled skills. Set TUBEROSA_SKILLS_SRC to the skills root.');
    return;
  }
  let copied = 0;
  for (const rel of BUNDLED_SKILLS) {
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
```

with this version (reads the manifest at runtime):

```ts
async function copyBundledSkills(io: CommandIo, fs: FsAdapter, root: string): Promise<void> {
  const srcRoot = await resolveSkillsSource(io, fs);
  if (!srcRoot) {
    io.err('--with-skills: could not locate bundled skills. Set TUBEROSA_SKILLS_SRC to the skills root.');
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
```

- [ ] **Step 6: Update `resolveSkillsSource` to probe for the manifest**

In `bin/commands/init.ts`, replace the existing `resolveSkillsSource` function:

```ts
async function resolveSkillsSource(io: CommandIo, fs: FsAdapter): Promise<string | undefined> {
  const override = io.env.TUBEROSA_SKILLS_SRC;
  const candidates = override
    ? [override]
    : skillsSourceCandidates();
  for (const candidate of candidates) {
    if (await fs.exists(`${candidate}/${BUNDLED_SKILLS[0]}`)) return candidate;
  }
  return undefined;
}
```

with this version (probes the manifest instead of a skill file):

```ts
async function resolveSkillsSource(io: CommandIo, fs: FsAdapter): Promise<string | undefined> {
  const override = io.env.TUBEROSA_SKILLS_SRC;
  const candidates = override ? [override] : skillsSourceCandidates();
  for (const candidate of candidates) {
    if (await fs.exists(`${candidate}/${BUNDLED_SKILLS_MANIFEST}`)) return candidate;
  }
  return undefined;
}
```

> Note: the missing-manifest test points `TUBEROSA_SKILLS_SRC` at `/pkg/.claude/skills` but never creates the manifest there, so `resolveSkillsSource` returns `undefined` and the copier prints the "could not locate bundled skills" message — which also matches `/manifest/i`. Both the "could not locate" and "manifest missing" branches satisfy the test's `/manifest/i` assertion.

- [ ] **Step 7: Run the CLI tests to verify they pass**

Run: `node --test --import tsx test/cli.test.ts`
Expected: PASS — `# fail 0` (the two updated tests, the new multi-skill test, the new missing-manifest test, plus all pre-existing parser/doctor/mcp/dispatch tests).

- [ ] **Step 8: Commit**

```bash
git add bin/commands/init.ts test/cli.test.ts
git commit -m "feat(cli): drive init --with-skills from the bundled-skills manifest"
```

---

## Task 4: Publish-time drift gate (`prepack`)

**Files:**
- Create: `scripts/verify-bundled-skills.ts`
- Modify: `package.json` (add `verify:bundled-skills` script + `prepack` hook)

The drift *logic* is already unit-tested (Task 1). This task adds the thin script that wires that logic to the real repo files and fails the pack/publish on drift. Verify it by running it and by simulating drift.

- [ ] **Step 1: Create the gate script**

Create `scripts/verify-bundled-skills.ts` with this exact content:

```ts
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUNDLED_SKILLS_MANIFEST,
  parseManifest,
  manifestSkillFilePaths,
  manifestSkillDirs,
  findFilesDrift,
} from '../bin/commands/bundled-skills.js';

/**
 * prepack gate: the bundled-skills manifest is the single source of truth. Fail the
 * pack/publish if the manifest, the on-disk skill files, and package.json "files"
 * disagree — so the package can never ship a skill `init --with-skills` won't copy,
 * or promise a skill it doesn't ship.
 */
async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifestRel = `.claude/skills/${BUNDLED_SKILLS_MANIFEST}`;
  const errors: string[] = [];

  const manifest = parseManifest(await readFile(resolve(repoRoot, manifestRel), 'utf8'));
  const pkg = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')) as { files?: string[] };
  const files = pkg.files ?? [];

  // 1. The manifest file itself must ship, or the consumer's `init` can't read it.
  if (!files.includes(manifestRel)) {
    errors.push(`package.json "files" must include "${manifestRel}"`);
  }

  // 2. package.json "files" skill dirs must match the manifest exactly.
  const { missingFromFiles, extraInFiles } = findFilesDrift(manifestSkillDirs(manifest), files);
  for (const dir of missingFromFiles) {
    errors.push(`manifest lists "${dir}" but package.json "files" does not ship it`);
  }
  for (const entry of extraInFiles) {
    errors.push(`package.json "files" ships "${entry}" but the manifest does not list it`);
  }

  // 3. Every file the manifest references must exist on disk.
  for (const rel of manifestSkillFilePaths(manifest)) {
    if (!existsSync(resolve(repoRoot, '.claude/skills', rel))) {
      errors.push(`manifest references a missing file: .claude/skills/${rel}`);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(
      'Bundled-skills verification FAILED:\n' + errors.map((e) => `  - ${e}`).join('\n') + '\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `Bundled-skills OK: ${manifest.skills.length} skill(s), ${manifestSkillFilePaths(manifest).length} file(s) shipped.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`verify-bundled-skills: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Run the gate against the real repo — expect PASS**

Run: `node --import tsx scripts/verify-bundled-skills.ts`
Expected output: `Bundled-skills OK: 1 skill(s), 1 file(s) shipped.` and exit 0.

- [ ] **Step 3: Simulate drift to prove the gate fails**

Temporarily add a phantom skill to the manifest and confirm the gate catches it:

```bash
node --import tsx -e "const fs=require('node:fs'); const p='.claude/skills/bundled-skills.json'; const m=JSON.parse(fs.readFileSync(p,'utf8')); m.skills.push({name:'phantom',files:['SKILL.md']}); fs.writeFileSync(p, JSON.stringify(m,null,2));"
node --import tsx scripts/verify-bundled-skills.ts; echo "exit: $?"
```
Expected: prints `Bundled-skills verification FAILED:` with both `manifest lists ".claude/skills/phantom/" but package.json "files" does not ship it` and `manifest references a missing file: .claude/skills/phantom/SKILL.md`, and `exit: 1`.

Now restore the manifest:

```bash
git checkout .claude/skills/bundled-skills.json
node --import tsx scripts/verify-bundled-skills.ts; echo "exit: $?"
```
Expected: `Bundled-skills OK: 1 skill(s), 1 file(s) shipped.` and `exit: 0`.

- [ ] **Step 4: Wire the script + prepack hook into `package.json`**

In `package.json`, in the `scripts` block, add a `verify:bundled-skills` entry and a `prepack` hook. Locate the existing line:

```json
    "test": "node --test --import tsx test/*.test.ts"
```

and change it to (adds two lines — note the comma after the `test` entry):

```json
    "test": "node --test --import tsx test/*.test.ts",
    "verify:bundled-skills": "node --import tsx scripts/verify-bundled-skills.ts",
    "prepack": "pnpm run build && pnpm run verify:bundled-skills"
```

> `prepack` runs automatically on `npm pack` and `npm publish` (and their pnpm equivalents). It builds `dist/` and then runs the gate, so a stale build or a drifted manifest blocks the release.

- [ ] **Step 5: Verify the new scripts run via pnpm**

Run: `pnpm run verify:bundled-skills`
Expected: `Bundled-skills OK: 1 skill(s), 1 file(s) shipped.` and exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-bundled-skills.ts package.json
git commit -m "feat(release): add prepack gate enforcing bundled-skills/files parity"
```

---

## Task 5: Final verification + docs

**Files:**
- Modify: `docs/INSTALL.md`

- [ ] **Step 1: Document the gate and the one-edit workflow**

In `docs/INSTALL.md`, find the "### A1. Build & package sanity" section. Immediately **after** its closing table row line:

```
| `LICENSE`, `README.md`, `package.json` | npm always includes these |
```

insert this new block (a blank line, then the content):

```markdown

> **Bundled skills are gated.** `.claude/skills/bundled-skills.json` is the single
> source of truth for which skills ship and which `init --with-skills` copies. The
> `prepack` hook runs `verify:bundled-skills`, which fails the pack/publish if the
> manifest, the on-disk skill files, and the `package.json` `files` allowlist
> disagree. To add a skill to the package: (1) add its folder under
> `.claude/skills/`, (2) add one entry to `bundled-skills.json`, (3) run
> `pnpm run verify:bundled-skills` — it tells you the exact `files` line to add.
```

- [ ] **Step 2: Run the full verification suite**

Run each command; all must pass:

```bash
pnpm run build
pnpm run verify:bundled-skills
node --test --import tsx test/bundled-skills.test.ts
node --test --import tsx test/cli.test.ts
pnpm test
pnpm run eval:retrieval
```

Expected:
- `pnpm run build` — completes, no TypeScript errors.
- `pnpm run verify:bundled-skills` — `Bundled-skills OK: 1 skill(s), 1 file(s) shipped.`
- `test/bundled-skills.test.ts` — `# fail 0`.
- `test/cli.test.ts` — `# fail 0`.
- `pnpm test` — `# fail 0` (full suite; was 798 pass before this work, now higher with the new module + cli tests).
- `pnpm run eval:retrieval` — exit 0, all `PASS` (this change touches no retrieval logic, so it must stay green).

- [ ] **Step 3: Confirm the packaged tarball still contains the manifest + skill, and prepack ran**

Run: `npm pack --dry-run 2>&1 | grep -E "bundled-skills.json|tuberosa-onboard-project|Bundled-skills OK"`
Expected: lines showing `.claude/skills/bundled-skills.json`, `.claude/skills/tuberosa-onboard-project/SKILL.md`, and the `Bundled-skills OK:` line (proof the `prepack` gate ran during pack).

- [ ] **Step 4: Commit**

```bash
git add docs/INSTALL.md
git commit -m "docs(install): document the bundled-skills gate and add-a-skill workflow"
```

---

## Self-Review (completed during planning)

**1. Spec coverage** — The chosen scope ("single source of truth so the package ships all consumer-relevant skills from one source, no drift, and `init --with-skills` copies the whole set") maps to: the manifest (Task 2) = single source; manifest-driven copier (Task 3) = `init` copies the whole set from that source; `findFilesDrift` + gate (Tasks 1 & 4) = no drift, enforced at publish. The "all consumer-relevant skills" capability is delivered as an N-skill *mechanism* (proved by the multi-skill cli test and the `findFilesDrift` unit tests); the seeded content stays at `tuberosa-onboard-project` to avoid shipping skills whose repo-internal cross-references would dangle in a consumer checkout — expanding is a one-line manifest edit the gate guards.

**2. Placeholder scan** — No TBD/TODO/"handle errors"/"similar to". Every code step shows full file content or exact old→new replacements; every command shows expected output.

**3. Type consistency** — `parseManifest`, `manifestSkillFilePaths`, `manifestSkillDirs`, `findFilesDrift`, `BUNDLED_SKILLS_MANIFEST`, and the `BundledSkillManifest`/`BundledSkill`/`DriftReport` types are defined once in `bin/commands/bundled-skills.ts` (Task 1) and consumed with identical signatures in `init.ts` (Task 3) and `scripts/verify-bundled-skills.ts` (Task 4). The manifest JSON shape (`{ skills: [{ name, files }] }`) is identical across the on-disk file, the in-memory test fixtures, and the parser.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-09-bundled-skills-single-source.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
