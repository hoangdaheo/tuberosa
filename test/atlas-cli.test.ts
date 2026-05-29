import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryKnowledgeStore } from '../src/storage/memory-store.js';
import { AtlasService } from '../src/atlas/service.js';
import { atlasCommand } from '../bin/commands/atlas.js';
import type { CliInvocation, CommandIo } from '../bin/commands/types.js';

function fakeIo(over: Partial<CommandIo> = {}): CommandIo & { lines: string[] } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(`ERR:${l}`), cwd: process.cwd(), env: {}, ...over };
}

test('atlasCommand: --json prints regenerate result', async () => {
  const store = new MemoryKnowledgeStore();
  const dir = await mkdtemp(join(tmpdir(), 'atlas-cli-'));
  const io = fakeIo();
  const inv: CliInvocation = { command: 'atlas', options: { project: 'p', json: true }, positional: [] };
  const code = await atlasCommand(inv, io, { makeService: async () => new AtlasService(store, { atlasDir: dir }) });
  assert.equal(code.exitCode, 0);
  const out = JSON.parse(io.lines.join('\n'));
  assert.equal(out.files.length, 5);
});

test('atlasCommand: requires --project', async () => {
  const io = fakeIo();
  const inv: CliInvocation = { command: 'atlas', options: {}, positional: [] };
  const code = await atlasCommand(inv, io, {
    makeService: async () => {
      throw new Error('should not build');
    },
  });
  assert.equal(code.exitCode, 1);
  assert.ok(io.lines.some((l) => l.includes('--project')));
});
