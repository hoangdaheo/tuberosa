import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { syncCommand } from '../bin/commands/sync.js';
import type { CliInvocation, CommandIo } from '../bin/commands/types.js';
import type { SyncPlan } from '../src/source-sync/types.js';

function fakeIo(): { io: CommandIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: CommandIo = {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    cwd: '/repo',
    env: {},
  };
  return { io, out, err };
}

function invocation(options: Record<string, string | boolean>): CliInvocation {
  return { command: 'sync', options, positional: [] };
}

const emptyPlan: SyncPlan = {
  project: 'p', repoPath: '/repo', mode: 'git',
  added: [{ path: 'a.ts', sizeBytes: 1, willIngestAs: 'code_ref' }], changed: [], renamed: [],
  deleted: [], ignored: [], summary: { added: 1, changed: 0, renamed: 0, deleted: 0, ignored: 0 }, destructive: false,
};

test('tuberosa sync (dry-run) prints the plan and does not apply', async () => {
  const { io, out } = fakeIo();
  let applied = false;
  const result = await syncCommand(invocation({ project: 'p' }), io, {
    makeService: async () => ({
      sync: async () => ({ planId: 'PID', plan: emptyPlan }),
      apply: async () => { applied = true; return { ingested: 0, reingested: 0, repointed: 0, archived: 0, skipped: [] }; },
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(applied, false, 'dry-run must not apply');
  assert.ok(out.join('\n').includes('added: 1'));
});

test('tuberosa sync --apply applies non-destructive plan', async () => {
  const { io } = fakeIo();
  let applyArgs: { planId: string; allowDestructive: boolean } | null = null;
  await syncCommand(invocation({ project: 'p', apply: true }), io, {
    makeService: async () => ({
      sync: async () => ({ planId: 'PID', plan: emptyPlan }),
      apply: async (a) => { applyArgs = a; return { ingested: 1, reingested: 0, repointed: 0, archived: 0, skipped: [] }; },
    }),
  });
  assert.equal(applyArgs!.planId, 'PID');
  assert.equal(applyArgs!.allowDestructive, false);
});

test('tuberosa sync --apply on destructive plan requires --yes', async () => {
  const { io, err } = fakeIo();
  const destructive: SyncPlan = {
    ...emptyPlan,
    deleted: [{ path: 'gone.ts', knowledgeIds: [], atomIds: [], chunkCount: 0 }],
    destructive: true,
    summary: { ...emptyPlan.summary, deleted: 1 },
  };
  const result = await syncCommand(invocation({ project: 'p', apply: true }), io, {
    makeService: async () => ({
      sync: async () => ({ planId: 'PID', plan: destructive }),
      apply: async () => { throw new Error('should not apply'); },
    }),
  });
  assert.equal(result.exitCode, 1);
  assert.ok(err.join('\n').toLowerCase().includes('--yes'));
});
