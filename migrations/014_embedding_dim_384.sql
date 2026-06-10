-- Spec A: standardize embeddings at 384 dimensions (Xenova/bge-small-en-v1.5;
-- OpenAI text-embedding-3-small with dimensions=384).
-- Fresh installs already get vector(384) from 001/005; this migration upgrades
-- legacy databases. vector(1536) values cannot be cast down, so existing
-- embeddings are cleared. `pnpm run reembed` backfills them (tuberosa init
-- runs it automatically).

DROP INDEX IF EXISTS idx_chunks_embedding_hnsw;
DROP INDEX IF EXISTS idx_atoms_embedding;

-- ALTER TYPE takes ACCESS EXCLUSIVE and rewrites the table; acceptable for local-first DB sizes.
-- The USING NULL wipe is intentional even for columns already at 384: embeddings are rebuilt by reembed.
ALTER TABLE knowledge_chunks ALTER COLUMN embedding TYPE vector(384) USING NULL::vector(384);
ALTER TABLE knowledge_atoms  ALTER COLUMN embedding TYPE vector(384) USING NULL::vector(384);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_atoms_embedding   ON knowledge_atoms USING hnsw (embedding vector_cosine_ops);
