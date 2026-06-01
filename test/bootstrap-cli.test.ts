import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { bootstrapCommand } from '../bin/commands/bootstrap.js';
import type { BootstrapServiceLike } from '../bin/commands/bootstrap.js';
import type { CliInvocation, CommandIo } from '../bin/commands/types.js';
import type { BootstrapReport } from '../src/bootstrap/types.js';

function fakeIo(over: Partial<CommandIo> = {}): CommandIo & { lines: string[] } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(`ERR:${l}`), cwd: process.cwd(), env: {}, ...over };
}

const REPORT: BootstrapReport = {
  project: 'p',
  repoPath: '/repo',
  sync: { planId: 'plan1', summary: { added: 2, changed: 0, renamed: 0, deleted: 0, ignored: 0 }, applied: { ingested: 2, reingested: 0, repointed: 0, archived: 0, skipped: [], deferredDeletions: [] } },
  atlas: { inputHash: 'sha256:abc', files: [{ name: 'project-map.md', bytes: 10 }] },
  health: { sourceCounts: { tracked: 2, changed: 0, missing: 0, archived: 0, ignored: 0 }, tombstones: 0, openImportConflicts: 0, maintenanceItems: 0, gaps: 0 },
  warnings: [],
  nextActions: ['Bootstrap complete.'],
};

test('bootstrapCommand: --json prints the report', async () => {
  const io = fakeIo();
  const inv: CliInvocation = { command: 'bootstrap', options: { project: 'p', json: true }, positional: [] };
  const service: BootstrapServiceLike = { run: async () => REPORT };
  const code = await bootstrapCommand(inv, io, { makeService: async () => service });
  assert.equal(code.exitCode, 0);
  const out = JSON.parse(io.lines.join('\n')) as BootstrapReport;
  assert.equal(out.project, 'p');
  assert.equal(out.sync.summary.added, 2);
});

test('bootstrapCommand: requires --project', async () => {
  const io = fakeIo();
  const inv: CliInvocation = { command: 'bootstrap', options: {}, positional: [] };
  const code = await bootstrapCommand(inv, io, { makeService: async () => { throw new Error('should not build'); } });
  assert.equal(code.exitCode, 1);
  assert.ok(io.lines.some((l) => l.includes('--project')));
});

test('bootstrapCommand: passes conventions:true by default', async () => {
  const io = fakeIo();
  const inv: CliInvocation = { command: 'bootstrap', options: { project: 'p' }, positional: [] };
  let captured: { conventions?: boolean } | undefined;
  const service: BootstrapServiceLike = { run: async (a) => { captured = a; return REPORT; } };
  const code = await bootstrapCommand(inv, io, { makeService: async () => service });
  assert.equal(code.exitCode, 0);
  assert.equal(captured?.conventions, true);
});

test('bootstrapCommand: --no-conventions passes conventions:false', async () => {
  const io = fakeIo();
  const inv: CliInvocation = { command: 'bootstrap', options: { project: 'p', 'no-conventions': true }, positional: [] };
  let captured: { conventions?: boolean } | undefined;
  const service: BootstrapServiceLike = { run: async (a) => { captured = a; return REPORT; } };
  const code = await bootstrapCommand(inv, io, { makeService: async () => service });
  assert.equal(code.exitCode, 0);
  assert.equal(captured?.conventions, false);
});

test('bootstrapCommand: prose render names deferred deletions next action', async () => {
  const io = fakeIo();
  const withDefer: BootstrapReport = { ...REPORT, nextActions: ['Review 1 deferred deletion(s) in /repo/.tuberosa/pending-sync.json, then archive with `tuberosa sync --apply --yes`.'] };
  const inv: CliInvocation = { command: 'bootstrap', options: { project: 'p' }, positional: [] };
  const code = await bootstrapCommand(inv, io, { makeService: async () => ({ run: async () => withDefer }) });
  assert.equal(code.exitCode, 0);
  assert.ok(io.lines.some((l) => l.includes('pending-sync.json')));
});
