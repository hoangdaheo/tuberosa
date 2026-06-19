import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupModelsCommand } from '../bin/commands/setup-models.js';
import type { CommandIo } from '../bin/commands/types.js';

function fakeIo(): CommandIo & { lines: string[]; errs: string[] } {
  const lines: string[] = []; const errs: string[] = [];
  return { lines, errs, cwd: '/tmp', env: {}, out: (l: string) => lines.push(l), err: (l: string) => errs.push(l) } as any;
}

test('exits 0 and reports success when both models load', async () => {
  const io = fakeIo();
  const result = await setupModelsCommand({ command: 'setup-models', options: {}, positional: [] }, io, {
    makeProbe: () => ({ verifyReady: async () => ({ embedder: true, reranker: true, dims: 384 }) }),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(io.lines.join('\n').includes('384'));
});

test('exits 1 when a model fails to load', async () => {
  const io = fakeIo();
  const result = await setupModelsCommand({ command: 'setup-models', options: {}, positional: [] }, io, {
    makeProbe: () => ({ verifyReady: async () => ({ embedder: false, reranker: true, dims: null }) }),
  });
  assert.equal(result.exitCode, 1);
  assert.ok(io.errs.join('\n').toLowerCase().includes('embedding'));
});
