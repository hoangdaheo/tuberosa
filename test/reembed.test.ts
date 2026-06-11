import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reembedMissing } from '../src/storage/reembed.js';

interface Call { text: string; params?: unknown[] }

function stubDb(rowsByTable: Record<string, Array<{ id: string; text: string }>>) {
  const calls: Call[] = [];
  const remaining = new Map(Object.entries(rowsByTable).map(([k, v]) => [k, [...v]]));
  return {
    calls,
    db: {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params });
        if (text.startsWith('SELECT')) {
          const table = /FROM (\w+)/.exec(text)![1]!;
          const limit = Number(params?.[0] ?? 50);
          const rows = (remaining.get(table) ?? []).splice(0, limit);
          return { rows };
        }
        return { rows: [] };
      },
    },
  };
}

describe('reembedMissing', () => {
  it('embeds and updates every null-embedding row in both tables', async () => {
    const { db, calls } = stubDb({
      knowledge_chunks: [
        { id: 'c1', text: 'chunk one' },
        { id: 'c2', text: 'chunk two' },
      ],
      knowledge_atoms: [{ id: 'a1', text: 'claim one' }],
    });
    const embedded: string[] = [];
    const result = await reembedMissing(db, async (text) => {
      embedded.push(text);
      return [0.1, 0.2];
    });
    assert.equal(result.knowledge_chunks, 2);
    assert.equal(result.knowledge_atoms, 1);
    assert.deepEqual(embedded, ['chunk one', 'chunk two', 'claim one']);
    const updates = calls.filter((call) => call.text.startsWith('UPDATE'));
    assert.equal(updates.length, 3);
    assert.equal(updates[0]!.params?.[0], '[0.1,0.2]');
    assert.equal(updates[0]!.params?.[1], 'c1');
  });

  it('returns zeros when nothing is missing', async () => {
    const { db } = stubDb({ knowledge_chunks: [], knowledge_atoms: [] });
    const result = await reembedMissing(db, async () => [1]);
    assert.equal(result.knowledge_chunks, 0);
    assert.equal(result.knowledge_atoms, 0);
  });
});
