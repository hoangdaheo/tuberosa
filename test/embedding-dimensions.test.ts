import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseVectorDimension, validateEmbeddingDimensions } from '../src/storage/embedding-dimensions.js';

function stubDb(typeByTable: Record<string, string | undefined>) {
  return {
    async query(_text: string, params?: unknown[]) {
      const table = String(params?.[0]);
      const type = typeByTable[table];
      return { rows: type ? [{ type }] : [] };
    },
  };
}

describe('parseVectorDimension', () => {
  it('parses vector(384)', () => {
    assert.equal(parseVectorDimension('vector(384)'), 384);
  });
  it('returns null for non-vector types', () => {
    assert.equal(parseVectorDimension('text'), null);
  });
});

describe('validateEmbeddingDimensions', () => {
  it('passes when both tables match', async () => {
    const db = stubDb({ knowledge_chunks: 'vector(384)', knowledge_atoms: 'vector(384)' });
    await validateEmbeddingDimensions(db, 384);
  });

  it('throws a guided error on mismatch', async () => {
    const db = stubDb({ knowledge_chunks: 'vector(1536)', knowledge_atoms: 'vector(1536)' });
    await assert.rejects(
      () => validateEmbeddingDimensions(db, 384),
      /vector\(1536\).*EMBEDDING_DIMENSIONS=384.*tuberosa init/s,
    );
  });

  it('skips tables that do not exist yet', async () => {
    const db = stubDb({});
    await validateEmbeddingDimensions(db, 384);
  });
});
