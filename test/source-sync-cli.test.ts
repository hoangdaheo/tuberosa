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
      apply: async () => { applied = true; return { ingested: 0, reingested: 0, repointed: 0, archived: 0, skipped: [], deferredDeletions: [] }; },
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
      apply: async (a) => { applyArgs = a; return { ingested: 1, reingested: 0, repointed: 0, archived: 0, skipped: [], deferredDeletions: [] }; },
    }),
  });
  assert.equal(applyArgs!.planId, 'PID');
  assert.equal(applyArgs!.allowDestructive, false);
});

test('tuberosa sync --apply (no --yes) on a mixed plan applies additions and defers deletions', async () => {
  const { io, out } = fakeIo();
  // A commit that both adds a file AND deletes one — the regression case: additions must NOT
  // be dropped just because the plan is destructive.
  const mixed: SyncPlan = {
    ...emptyPlan,
    deleted: [{ path: 'gone.ts', knowledgeIds: ['k1'], atomIds: [], chunkCount: 0 }],
    destructive: true,
    summary: { ...emptyPlan.summary, deleted: 1 },
  };
  let applyArgs: { planId: string; allowDestructive: boolean } | null = null;
  const result = await syncCommand(invocation({ project: 'p', apply: true }), io, {
    makeService: async () => ({
      sync: async () => ({ planId: 'PID', plan: mixed }),
      apply: async (a) => {
        applyArgs = a;
        // additive applied (ingested 1), nothing archived, deletion deferred
        return { ingested: 1, reingested: 0, repointed: 0, archived: 0, skipped: [], deferredDeletions: [{ path: 'gone.ts', knowledgeIds: ['k1'] }] };
      },
    }),
  });
  assert.equal(result.exitCode, 0, 'mixed plan applies (does not abort)');
  assert.equal(applyArgs!.allowDestructive, false, 'archives not allowed without --yes');
  const text = out.join('\n');
  assert.ok(text.includes('ingested 1'), 'additions were applied');
  assert.ok(text.includes('gone.ts'), 'deferred deletion surfaced to the user');
  assert.ok(text.includes('--yes'), 'tells the user how to archive');
});

test('tuberosa sync --apply --yes on a destructive plan allows archiving', async () => {
  const { io } = fakeIo();
  const destructive: SyncPlan = {
    ...emptyPlan,
    deleted: [{ path: 'gone.ts', knowledgeIds: [], atomIds: [], chunkCount: 0 }],
    destructive: true,
    summary: { ...emptyPlan.summary, deleted: 1 },
  };
  let allow: boolean | null = null;
  const result = await syncCommand(invocation({ project: 'p', apply: true, yes: true }), io, {
    makeService: async () => ({
      sync: async () => ({ planId: 'PID', plan: destructive }),
      apply: async (a) => { allow = a.allowDestructive; return { ingested: 0, reingested: 0, repointed: 0, archived: 1, skipped: [], deferredDeletions: [] }; },
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(allow, true, '--yes authorizes archiving');
});
