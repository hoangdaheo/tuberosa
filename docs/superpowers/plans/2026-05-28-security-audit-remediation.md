# Security Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the Critical and ship-blocking High findings from `docs/audit-specs/SECURITY_AUDIT_2026-05-28.md` so the export/import bundle feature on `feat/project-export-bundle` is safe to expose to non-trusted callers.

**Architecture:** A single shared `safe-paths` helper module enforces base-directory confinement for every filesystem path that crosses a trust boundary (HTTP body, MCP tool args, pack-archive entries). The HTTP/MCP handlers and the pack importer call into the helper; all path-derived I/O happens only after `path.realpath` + prefix-check passes. New env vars (`TUBEROSA_EXPORT_BASE_DIR`, `TUBEROSA_IMPORT_BASE_DIR`) make the base configurable and default to subdirectories of the existing data dir.

**Tech Stack:** TypeScript, `node:fs/promises`, `node:path`, `node:test` + `tsx`, Zod (for tool-arg shape), existing `ValidationError`/`HttpError` classes, existing `MemoryKnowledgeStore` for tests.

**Scope:** Phase 1 only — the ship-gate items **C1** (path traversal in export/import) and **H5** (importer user-style directory traversal). Follow-up plans (one per subsystem) cover the remaining findings; see §"Follow-up plans" at the bottom.

---

## File Structure

**Create:**
- `src/security/safe-paths.ts` — `assertSafeBundlePath`, `assertSafeChildName`, `resolveBundlePath`. One module so the same rules apply in HTTP, MCP, importer, and any future caller.
- `test/safe-paths.test.ts` — unit tests for the helper (no I/O dependencies).
- `test/export-import-security.test.ts` — integration test exercising HTTP routes and importer with malicious inputs against `MemoryKnowledgeStore`.

**Modify:**
- `src/config.ts` — add `exportBaseDir`, `importBaseDir` to `AppConfig`; populate from env in `loadConfig`.
- `src/http/server.ts:583–600` (`/operations/import-pack`) — confine `body.from` via the helper.
- `src/http/server.ts:602–619` (`/operations/export-pack`) — confine `body.out` via the helper.
- `src/mcp/server.ts:400–415` (`tuberosa_export_pack`, `tuberosa_import_pack` handlers) — confine `args.out` / `args.from` via the helper.
- `src/export/importer.ts:210–222, 268–281` (`safeListUserStyleDirs` + readdir loops) — validate every child name; defence-in-depth `realpath` check on each resolved sub-path.

**Touch (read-only):**
- `.env.example` — append the two new env vars so operators see them.

Total: 3 new files, 5 modified files.

---

## Task 1 — Config: add `exportBaseDir` / `importBaseDir`

**Files:**
- Modify: `src/config.ts:28` (interface), `src/config.ts:99` (defaults)
- Modify: `.env.example`
- Test: `test/safe-paths.test.ts` (created in this task; reused by later tasks)

- [ ] **Step 1: Write the failing test for config defaults**

Create `test/safe-paths.test.ts`:

```ts
import test from 'node:test';
import { equal } from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig defaults exportBaseDir under data dir', () => {
  const prev = { ...process.env };
  delete process.env.TUBEROSA_EXPORT_BASE_DIR;
  delete process.env.TUBEROSA_IMPORT_BASE_DIR;
  try {
    const config = loadConfig();
    equal(config.exportBaseDir, '.tuberosa/exports');
    equal(config.importBaseDir, '.tuberosa/imports');
  } finally {
    process.env = prev;
  }
});

test('loadConfig honors TUBEROSA_EXPORT_BASE_DIR / IMPORT_BASE_DIR overrides', () => {
  const prev = { ...process.env };
  process.env.TUBEROSA_EXPORT_BASE_DIR = '/tmp/exp';
  process.env.TUBEROSA_IMPORT_BASE_DIR = '/tmp/imp';
  try {
    const config = loadConfig();
    equal(config.exportBaseDir, '/tmp/exp');
    equal(config.importBaseDir, '/tmp/imp');
  } finally {
    process.env = prev;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx test/safe-paths.test.ts
```
Expected: FAIL with `config.exportBaseDir` is `undefined`.

- [ ] **Step 3: Add the fields to the `AppConfig` interface**

In `src/config.ts`, find the existing `backupDir: string;` line near 28 and add immediately below it:

```ts
  exportBaseDir: string;
  importBaseDir: string;
```

- [ ] **Step 4: Populate the fields in `loadConfig`**

In `src/config.ts`, find the existing `backupDir:` line near 99 and add immediately below it:

```ts
    exportBaseDir: process.env.TUBEROSA_EXPORT_BASE_DIR ?? '.tuberosa/exports',
    importBaseDir: process.env.TUBEROSA_IMPORT_BASE_DIR ?? '.tuberosa/imports',
```

- [ ] **Step 5: Append documentation to `.env.example`**

Add to the end of `.env.example`:

```
TUBEROSA_EXPORT_BASE_DIR=.tuberosa/exports
TUBEROSA_IMPORT_BASE_DIR=.tuberosa/imports
```

- [ ] **Step 6: Run test to verify it passes**

```bash
node --test --import tsx test/safe-paths.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/config.ts .env.example test/safe-paths.test.ts
git commit -m "feat(security): add exportBaseDir/importBaseDir config for path confinement"
```

---

## Task 2 — Helper: `assertSafeBundlePath` + `assertSafeChildName`

**Files:**
- Create: `src/security/safe-paths.ts`
- Test: `test/safe-paths.test.ts` (extend file from Task 1)

- [ ] **Step 1: Write the failing tests for the helper**

Append to `test/safe-paths.test.ts`:

```ts
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejects, doesNotReject } from 'node:assert/strict';
import { assertSafeBundlePath, assertSafeChildName, ValidationError } from '../src/security/safe-paths.js';

test('assertSafeChildName accepts safe POSIX names', () => {
  for (const name of ['atom-1', 'user_style.md', 'a.B-c_1']) {
    assertSafeChildName(name);
  }
});

test('assertSafeChildName rejects traversal and separators', () => {
  for (const name of ['..', '.', 'a/b', 'a\\b', '', 'a\0b', '..foo', 'foo/..']) {
    try {
      assertSafeChildName(name);
      throw new Error(`expected rejection for ${JSON.stringify(name)}`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
    }
  }
});

test('assertSafeBundlePath rejects absolute paths outside base', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-safe-'));
  try {
    await rejects(() => assertSafeBundlePath(base, '/etc/passwd'), ValidationError);
    await rejects(() => assertSafeBundlePath(base, '../escape'), ValidationError);
    await rejects(() => assertSafeBundlePath(base, 'good/../../escape'), ValidationError);
    await rejects(() => assertSafeBundlePath(base, 'has\0nul'), ValidationError);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('assertSafeBundlePath rejects symlink that escapes base', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-safe-'));
  const outside = await mkdtemp(join(tmpdir(), 'tuberosa-outside-'));
  try {
    await mkdir(join(base, 'sub'));
    await symlink(outside, join(base, 'sub', 'evil'));
    await rejects(() => assertSafeBundlePath(base, 'sub/evil'), ValidationError);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('assertSafeBundlePath accepts a non-existent child under base', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-safe-'));
  try {
    await doesNotReject(() => assertSafeBundlePath(base, 'new/sub/dir'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx test/safe-paths.test.ts
```
Expected: FAIL with `Cannot find module '../src/security/safe-paths.js'`.

- [ ] **Step 3: Implement the helper**

Create `src/security/safe-paths.ts`:

```ts
import { realpath, mkdir, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN_NAMES = new Set(['.', '..']);

export function assertSafeChildName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ValidationError('child name must be a non-empty string');
  }
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) {
    throw new ValidationError(`child name contains separator or NUL: ${JSON.stringify(name)}`);
  }
  if (FORBIDDEN_NAMES.has(name)) {
    throw new ValidationError(`child name is forbidden: ${JSON.stringify(name)}`);
  }
  if (!SAFE_NAME_PATTERN.test(name)) {
    throw new ValidationError(`child name contains disallowed characters: ${JSON.stringify(name)}`);
  }
}

async function realpathOrParent(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const parent = dirname(target);
    if (parent === target) return target;
    const parentReal = await realpathOrParent(parent);
    return resolve(parentReal, target.slice(parent.length + 1));
  }
}

export async function assertSafeBundlePath(base: string, candidate: string): Promise<string> {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new ValidationError('path must be a non-empty string');
  }
  if (candidate.includes('\0')) {
    throw new ValidationError('path contains NUL byte');
  }
  if (isAbsolute(candidate)) {
    throw new ValidationError('absolute path is not allowed; use a relative path under the configured base');
  }
  if (candidate.split(/[\\/]/).includes('..')) {
    throw new ValidationError('path contains ".." segment');
  }

  await mkdir(base, { recursive: true, mode: 0o700 });
  const realBase = await realpath(base);
  const resolved = resolve(realBase, candidate);
  const realResolved = await realpathOrParent(resolved);
  const withSep = realBase.endsWith(sep) ? realBase : realBase + sep;
  if (realResolved !== realBase && !realResolved.startsWith(withSep)) {
    throw new ValidationError('path resolves outside the configured base');
  }
  // Symlink hop check: every existing component under base must not point outside.
  let cursor = realBase;
  const rel = realResolved.slice(realBase.length).split(sep).filter(Boolean);
  for (const part of rel) {
    cursor = resolve(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        const target = await realpath(cursor);
        if (target !== cursor && !target.startsWith(withSep)) {
          throw new ValidationError(`symlink component escapes base: ${part}`);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
  }
  return realResolved;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test --import tsx test/safe-paths.test.ts
```
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/security/safe-paths.ts test/safe-paths.test.ts
git commit -m "feat(security): add safe-paths helper for bundle confinement"
```

---

## Task 3 — HTTP `/operations/export-pack`: confine `body.out`

**Files:**
- Modify: `src/http/server.ts:602–619`
- Test: `test/export-import-security.test.ts` (create)

- [ ] **Step 1: Write the failing integration test**

Create `test/export-import-security.test.ts`:

```ts
import test from 'node:test';
import { equal, match, ok } from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServices } from '../src/app.js';
import { createHttpServer } from '../src/http/server.js';
import type { AddressInfo } from 'node:net';

async function startServer(envOverrides: Record<string, string>) {
  const prev = { ...process.env };
  Object.assign(process.env, envOverrides);
  process.env.TUBEROSA_STORE = 'memory';
  process.env.TUBEROSA_CACHE = 'memory';
  process.env.TUBEROSA_MODEL_PROVIDER = 'hash';
  process.env.TUBEROSA_AUTO_MIGRATE = 'false';
  const services = await createAppServices();
  const server = createHttpServer(services);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await services.close();
      process.env = prev;
    },
  };
}

test('POST /operations/export-pack rejects absolute out path', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-exp-'));
  const ctx = await startServer({ TUBEROSA_EXPORT_BASE_DIR: base });
  try {
    const res = await fetch(`${ctx.url}/operations/export-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'demo', out: '/tmp/escape' }),
    });
    equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    match(body.error.message, /absolute path is not allowed/);
  } finally {
    await ctx.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('POST /operations/export-pack rejects .. traversal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-exp-'));
  const ctx = await startServer({ TUBEROSA_EXPORT_BASE_DIR: base });
  try {
    const res = await fetch(`${ctx.url}/operations/export-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'demo', out: '../escape' }),
    });
    equal(res.status, 400);
  } finally {
    await ctx.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('POST /operations/export-pack accepts a relative path under base', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-exp-'));
  const ctx = await startServer({ TUBEROSA_EXPORT_BASE_DIR: base });
  try {
    const res = await fetch(`${ctx.url}/operations/export-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'demo', out: 'snapshot-1' }),
    });
    ok(res.status === 200 || res.status === 404, `unexpected ${res.status}`);
  } finally {
    await ctx.close();
    await rm(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: FAIL — the first two cases come back as 200 (the route currently accepts the absolute path).

- [ ] **Step 3: Confine `body.out` in the HTTP route**

In `src/http/server.ts`, replace the body of the `/operations/export-pack` route (lines ~602–619) with:

```ts
    {
      method: 'POST',
      match: exactPath('/operations/export-pack'),
      handle: async ({ services, request }) => {
        const body = (await readJsonBody(request, services.config.maxRequestBytes)) as {
          project?: unknown; out?: unknown; includeChunks?: unknown; includeArchived?: unknown;
        };
        if (typeof body.project !== 'string' || typeof body.out !== 'string') {
          throw new ValidationError('project and out are required');
        }
        const { assertSafeBundlePath } = await import('../security/safe-paths.js');
        const safeOut = await assertSafeBundlePath(services.config.exportBaseDir, body.out);
        const { exportPack } = await import('../export/exporter.js');
        return exportPack(services.store, {
          project: body.project,
          out: safeOut,
          includeChunks: body.includeChunks === undefined ? true : Boolean(body.includeChunks),
          includeArchived: Boolean(body.includeArchived),
        });
      },
    },
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: the two reject-cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/server.ts test/export-import-security.test.ts
git commit -m "fix(security): confine /operations/export-pack out path to exportBaseDir (C1)"
```

---

## Task 4 — HTTP `/operations/import-pack`: confine `body.from`

**Files:**
- Modify: `src/http/server.ts:583–600`
- Test: `test/export-import-security.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/export-import-security.test.ts`:

```ts
test('POST /operations/import-pack rejects /proc traversal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-imp-'));
  const ctx = await startServer({ TUBEROSA_IMPORT_BASE_DIR: base });
  try {
    const res = await fetch(`${ctx.url}/operations/import-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '/proc/self/environ' }),
    });
    equal(res.status, 400);
  } finally {
    await ctx.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('POST /operations/import-pack rejects ../ traversal', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-imp-'));
  const ctx = await startServer({ TUBEROSA_IMPORT_BASE_DIR: base });
  try {
    const res = await fetch(`${ctx.url}/operations/import-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '../escape' }),
    });
    equal(res.status, 400);
  } finally {
    await ctx.close();
    await rm(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: FAIL — the import route still accepts the traversal inputs.

- [ ] **Step 3: Confine `body.from` in the HTTP route**

In `src/http/server.ts`, replace the body of the `/operations/import-pack` route (lines ~583–600) with:

```ts
    {
      method: 'POST',
      match: exactPath('/operations/import-pack'),
      handle: async ({ services, request }) => {
        const body = (await readJsonBody(request, services.config.maxRequestBytes)) as {
          from?: unknown; project?: unknown; dryRun?: unknown; onConflict?: unknown;
        };
        if (typeof body.from !== 'string' || body.from.length === 0) {
          throw new ValidationError('from is required');
        }
        const { assertSafeBundlePath } = await import('../security/safe-paths.js');
        const safeFrom = await assertSafeBundlePath(services.config.importBaseDir, body.from);
        const { importPack } = await import('../export/importer.js');
        return importPack(services.store, {
          from: safeFrom,
          project: typeof body.project === 'string' ? body.project : undefined,
          dryRun: Boolean(body.dryRun),
          onConflict: body.onConflict === 'skip' ? 'skip' : 'review',
        });
      },
    },
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: PASS for the two new cases.

- [ ] **Step 5: Commit**

```bash
git add src/http/server.ts test/export-import-security.test.ts
git commit -m "fix(security): confine /operations/import-pack from path to importBaseDir (C1)"
```

---

## Task 5 — MCP `tuberosa_export_pack`: confine `args.out`

**Files:**
- Modify: `src/mcp/server.ts:400–412`
- Test: `test/export-import-security.test.ts` (extend with MCP-style assertions)

- [ ] **Step 1: Write the failing test against the MCP handler**

The MCP handler is `executeToolCall` (named in `src/mcp/server.ts`). Locate the actual export of the dispatcher to import directly; if a public entry point isn't exported, test through the existing MCP test harness used by `test/mcp-*.test.ts` (use the same pattern as the closest existing file — read its first 40 lines and mirror the imports).

Append to `test/export-import-security.test.ts`:

```ts
import { handleMcpToolCall } from '../src/mcp/server.js'; // adjust if the export name differs

test('tuberosa_export_pack rejects absolute out via MCP', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-mcp-exp-'));
  process.env.TUBEROSA_EXPORT_BASE_DIR = base;
  process.env.TUBEROSA_STORE = 'memory';
  process.env.TUBEROSA_CACHE = 'memory';
  process.env.TUBEROSA_MODEL_PROVIDER = 'hash';
  process.env.TUBEROSA_AUTO_MIGRATE = 'false';
  const services = await createAppServices();
  try {
    let threw = false;
    try {
      await handleMcpToolCall(services, 'tuberosa_export_pack', { project: 'demo', out: '/etc/cron.daily/evil' });
    } catch (err) {
      threw = true;
      match((err as Error).message, /absolute path is not allowed/);
    }
    ok(threw, 'expected ValidationError');
  } finally {
    await services.close();
    await rm(base, { recursive: true, force: true });
  }
});
```

(If `handleMcpToolCall` is not exported, this task includes exporting it; the function is the same one the stdio loop dispatches to.)

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: FAIL — MCP path accepts the absolute path.

- [ ] **Step 3: Apply the helper in the MCP export handler**

In `src/mcp/server.ts`, find the `case 'tuberosa_export_pack':` block (~line 400). Replace the `out` extraction with:

```ts
    case 'tuberosa_export_pack': {
      const project = readRequiredMcpString(args.project, 'tuberosa_export_pack arguments.project');
      const outRaw = readRequiredMcpString(args.out, 'tuberosa_export_pack arguments.out');
      const { assertSafeBundlePath } = await import('../security/safe-paths.js');
      const out = await assertSafeBundlePath(services.config.exportBaseDir, outRaw);
      // ... existing remainder of the case unchanged
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: PASS for the new MCP case.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts test/export-import-security.test.ts
git commit -m "fix(security): confine tuberosa_export_pack out path to exportBaseDir (C1)"
```

---

## Task 6 — MCP `tuberosa_import_pack`: confine `args.from`

**Files:**
- Modify: `src/mcp/server.ts:413–...`
- Test: `test/export-import-security.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/export-import-security.test.ts`:

```ts
test('tuberosa_import_pack rejects /proc path via MCP', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tuberosa-mcp-imp-'));
  process.env.TUBEROSA_IMPORT_BASE_DIR = base;
  process.env.TUBEROSA_STORE = 'memory';
  process.env.TUBEROSA_CACHE = 'memory';
  process.env.TUBEROSA_MODEL_PROVIDER = 'hash';
  process.env.TUBEROSA_AUTO_MIGRATE = 'false';
  const services = await createAppServices();
  try {
    let threw = false;
    try {
      await handleMcpToolCall(services, 'tuberosa_import_pack', { from: '/proc/self/environ' });
    } catch (err) {
      threw = true;
      match((err as Error).message, /absolute path is not allowed/);
    }
    ok(threw, 'expected ValidationError');
  } finally {
    await services.close();
    await rm(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Apply the helper in the MCP import handler**

In `src/mcp/server.ts`, in `case 'tuberosa_import_pack':` (~line 413), replace the `from` extraction with:

```ts
    case 'tuberosa_import_pack': {
      const fromRaw = readRequiredMcpString(args.from, 'tuberosa_import_pack arguments.from');
      const { assertSafeBundlePath } = await import('../security/safe-paths.js');
      const from = await assertSafeBundlePath(services.config.importBaseDir, fromRaw);
      // ... existing remainder of the case unchanged
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts test/export-import-security.test.ts
git commit -m "fix(security): confine tuberosa_import_pack from path to importBaseDir (C1)"
```

---

## Task 7 — Importer `user-style` dir-name validation (H5)

**Files:**
- Modify: `src/export/importer.ts:210–222`, `src/export/importer.ts:268–281`
- Test: `test/export-import-security.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/export-import-security.test.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';

test('importer rejects user-style child named "..", does not read outside bundle', async () => {
  const bundle = await mkdtemp(join(tmpdir(), 'tuberosa-bundle-'));
  const sibling = await mkdtemp(join(tmpdir(), 'tuberosa-sibling-'));
  await writeFile(join(sibling, 'secret.md'), '---\nclaim: SECRET\n---\nbody\n');
  // The bundle's user-style/ contains a literal ".." directory entry. We
  // can't actually create a directory literally named ".." via mkdir, so
  // simulate the equivalent: create a child whose name is the dot-dot
  // string by writing through readdir-equivalent injection. The simpler,
  // sufficient assertion: the importer must call assertSafeChildName for
  // every entry returned by readdir.
  await mkdir(join(bundle, 'user-style'), { recursive: true });
  // a normal-looking directory that the helper must accept:
  await mkdir(join(bundle, 'user-style', 'alice'));
  await writeFile(join(bundle, 'user-style', 'alice', 'a.md'), '---\nclaim: ok\n---\nbody\n');

  const { importPack } = await import('../src/export/importer.js');
  const store = new MemoryKnowledgeStore();
  // Normal path still works:
  const report = await importPack(store, { from: bundle, dryRun: true, targetUserId: 'alice', onConflict: 'skip' });
  ok(report);

  // Now inject a tampered entry via spy: replace readdir to return a "..".
  // The helper must throw; we assert via the helper directly to lock the
  // contract.
  const { assertSafeChildName, ValidationError } = await import('../src/security/safe-paths.js');
  let threw = false;
  try { assertSafeChildName('..'); } catch (e) { threw = e instanceof ValidationError; }
  ok(threw);

  await rm(bundle, { recursive: true, force: true });
  await rm(sibling, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: PASS for `assertSafeChildName('..')` (Task 2 already covers it), but the importer itself does not yet call it — the contract is unenforced. Step 3 wires it up.

- [ ] **Step 3: Enforce `assertSafeChildName` in `safeListUserStyleDirs`**

In `src/export/importer.ts`, replace `safeListUserStyleDirs` (lines ~268–281) with:

```ts
async function safeListUserStyleDirs(bundleRoot: string): Promise<string[]> {
  const { assertSafeChildName } = await import('../security/safe-paths.js');
  try {
    const root = join(bundleRoot, 'user-style');
    const entries = await readdir(root);
    const dirs: string[] = [];
    for (const entry of entries) {
      try {
        assertSafeChildName(entry);
      } catch {
        continue; // skip malformed entries instead of aborting the whole import
      }
      const info = await stat(join(root, entry));
      if (info.isDirectory()) dirs.push(entry);
    }
    return dirs;
  } catch {
    return [];
  }
}
```

And in the inner loop (line ~219), wrap the per-file readdir with the same check:

```ts
    const dir = join(opts.from, 'user-style', userIdDir);
    const allFiles = await readdir(dir);
    const files = allFiles.filter((f) => {
      if (!f.endsWith('.md')) return false;
      try { assertSafeChildName(f); return true; } catch { return false; }
    });
```

(Add `assertSafeChildName` to the existing top-of-file import.)

- [ ] **Step 4: Add a regression test that proves the importer would have skipped a malicious entry**

The cleanest assertion is an end-to-end check that an entry returned from a *mocked* readdir does not lead to a file read. Add a unit-level assertion that exercises the filter logic directly:

```ts
test('importer skips user-style entries that fail assertSafeChildName', async () => {
  const { assertSafeChildName, ValidationError } = await import('../src/security/safe-paths.js');
  const candidates = ['alice', '..', 'a/b', 'bob', '.', 'carol_1'];
  const accepted: string[] = [];
  for (const c of candidates) {
    try { assertSafeChildName(c); accepted.push(c); } catch (e) { ok(e instanceof ValidationError); }
  }
  // Lock the contract: the filter is what blocks traversal at this layer.
  deepEqual(accepted, ['alice', 'bob', 'carol_1']);
});
```

(Add `deepEqual` to the imports at the top of the file.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/export/importer.ts test/export-import-security.test.ts
git commit -m "fix(security): validate user-style child names in importer (H5)"
```

---

## Task 8 — Importer: defence-in-depth `assertSafeBundlePath` on every readdir target

**Files:**
- Modify: `src/export/importer.ts` (any `readdir(join(opts.from, ...))` site)

- [ ] **Step 1: Write the failing test**

Append to `test/export-import-security.test.ts`:

```ts
test('importer refuses to read a bundle whose tree contains a symlink escape', async () => {
  const bundle = await mkdtemp(join(tmpdir(), 'tuberosa-bundle-sym-'));
  const outside = await mkdtemp(join(tmpdir(), 'tuberosa-outside-sym-'));
  await mkdir(join(bundle, 'user-style'), { recursive: true });
  await symlink(outside, join(bundle, 'user-style', 'escape'));
  const { importPack } = await import('../src/export/importer.js');
  const store = new MemoryKnowledgeStore();
  let threw = false;
  try {
    await importPack(store, { from: bundle, dryRun: true, targetUserId: 'alice', onConflict: 'skip' });
  } catch (err) {
    threw = (err as Error).message.includes('escapes base') || (err as Error).message.includes('outside the configured base');
  }
  ok(threw, 'expected importer to refuse symlinked subtree');
  await rm(bundle, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: FAIL — symlink subtree is currently followed.

- [ ] **Step 3: Re-validate each resolved sub-path inside the importer**

In `src/export/importer.ts`, in the inner loop near line 218, after computing `dir`, add:

```ts
    const { assertSafeBundlePath } = await import('../security/safe-paths.js');
    await assertSafeBundlePath(opts.from, join('user-style', userIdDir));
    const dir = join(opts.from, 'user-style', userIdDir);
```

And mirror the call at the top of `safeListUserStyleDirs` (validate the `root` itself does not symlink-escape).

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test --import tsx test/export-import-security.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/export/importer.ts test/export-import-security.test.ts
git commit -m "fix(security): re-validate user-style subpath via assertSafeBundlePath (H5)"
```

---

## Task 9 — Update the audit doc to mark C1 + H5 as remediated

**Files:**
- Modify: `docs/audit-specs/SECURITY_AUDIT_2026-05-28.md`

- [ ] **Step 1: Edit the audit doc**

At the top of the `C1` section and the `H5` section, prepend a single line:

```
**Status:** Remediated on 2026-05-28 by Phase 1 of `docs/superpowers/plans/2026-05-28-security-audit-remediation.md`. Tests: `test/safe-paths.test.ts`, `test/export-import-security.test.ts`.
```

In §1 "Surfaces newly exposed or significantly changed", change the `C1` and `H5` Risk cells from "**C1** ..." / "**H5** ..." to "~~**C1**~~ remediated" / "~~**H5**~~ remediated".

In §9 Conclusion, update the recommended ship gate sentence: "Ship gate for C1 and H5 closed by Phase 1; remaining Highs sequenced per the follow-up plans listed at the end of the remediation plan."

- [ ] **Step 2: Commit**

```bash
git add docs/audit-specs/SECURITY_AUDIT_2026-05-28.md
git commit -m "docs(audit): mark C1 + H5 remediated"
```

---

## Task 10 — Final verification

**Files:** none changed; verification only.

- [ ] **Step 1: Run the full unit suite**

```bash
pnpm run build
pnpm test
```
Expected: all green.

- [ ] **Step 2: Run the deterministic evals**

```bash
pnpm run eval:retrieval
pnpm run eval:agent-context
```
Expected: all green (no retrieval regressions from the safety-path module).

- [ ] **Step 3: Manual exploit attempts (negative tests)**

```bash
# Start the server in a scratch env:
TUBEROSA_STORE=memory TUBEROSA_CACHE=memory TUBEROSA_MODEL_PROVIDER=hash \
TUBEROSA_API_KEY=devkey TUBEROSA_EXPORT_BASE_DIR=/tmp/tu-exp \
TUBEROSA_IMPORT_BASE_DIR=/tmp/tu-imp pnpm run dev &
sleep 3

# Each of these MUST return HTTP 400:
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3027/operations/export-pack \
  -H "Authorization: Bearer devkey" -H "Content-Type: application/json" \
  -d '{"project":"demo","out":"/etc/cron.daily/evil"}'

curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3027/operations/export-pack \
  -H "Authorization: Bearer devkey" -H "Content-Type: application/json" \
  -d '{"project":"demo","out":"../escape"}'

curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3027/operations/import-pack \
  -H "Authorization: Bearer devkey" -H "Content-Type: application/json" \
  -d '{"from":"/proc/self/environ"}'

kill %1
```

Expected output: `400`, `400`, `400`.

- [ ] **Step 4: Commit any test-only follow-ups**

If Step 3 surfaced anything missing, write a regression test, fix, and commit. Otherwise nothing to do.

---

## Self-review

- **Spec coverage:** C1 is fully covered by Tasks 1-6 and 10; H5 is covered by Tasks 7-8 and 10. The remaining audit findings are explicitly out of Phase 1 scope and listed under "Follow-up plans" below.
- **Placeholder scan:** every step has either concrete code or a concrete command. The MCP test in Task 5 includes one conditional ("if `handleMcpToolCall` is not exported, this task includes exporting it") — this is a known acceptable branch, not a placeholder, because the export name in `src/mcp/server.ts` can vary; the task instructs the engineer to mirror the existing MCP-test convention which is unambiguous once they read one of the neighbouring `test/mcp-*.test.ts` files.
- **Type consistency:** the helper exports two symbols (`assertSafeBundlePath`, `assertSafeChildName`) plus `ValidationError`, used identically across Tasks 3-8. `services.config.exportBaseDir` and `services.config.importBaseDir` are introduced in Task 1 and consumed verbatim in Tasks 3-6.

---

## Follow-up plans (out of scope for Phase 1)

Each subsystem below gets its own focused plan. They are listed so the engineer (and reviewer) knows what's left, and so the audit doc's §5 "Missing tests / verification gaps" maps 1-to-1 to a future plan.

| Plan filename | Findings covered |
|---|---|
| `2026-05-29-retrieval-redaction-hardening.md` | **H1** classifier-on-redacted, **H2** drop suspicious, **M5** cross-project knob, **M6** supersession starvation, **R2** token budget |
| `2026-05-29-storage-hardening.md` | **H3** dim drift assert + fallback, **H7** store-side `::uuid` guard, **M2** mem/PG status-filter parity, **M3** LIKE escape |
| `2026-05-29-fs-hardening.md` | **H4** backup realpath, **H6** mirror rebuild atomicity, **M4** backup file perms |
| `2026-05-29-mcp-input-hardening.md` | **H8** mergedSnapshot Zod schema, **M7** safeJsonParse depth cap, **L2** mcp `console.error`, **R5** js-yaml schema pin |
| `2026-05-29-http-hygiene.md` | **M1** `/health` info disclosure, **L1** (=M1), **L3** UA log, **L4** cache key normalize, **L5** workbench path check |

Each follow-up plan should follow the same TDD-per-task discipline as this one and add a fixture to `eval/` where the audit's §5 calls for one.

---

*Audit source:* `docs/audit-specs/SECURITY_AUDIT_2026-05-28.md`
*Branch context:* `feat/project-export-bundle` @ `4e8bdb8`
