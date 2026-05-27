-- Concern B: Knowledge Atom Schema
-- Adds a new knowledge_atoms table for actionable, schema-floored memory units.
-- Adds legacy_status and migrated_at columns to knowledge_items for the
-- one-shot migration of vague memories.

CREATE TABLE IF NOT EXISTS knowledge_atoms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid REFERENCES projects(id) ON DELETE CASCADE,
  parent_knowledge_id  uuid REFERENCES knowledge_items(id) ON DELETE SET NULL,

  claim                text NOT NULL,
  type                 text NOT NULL CHECK (type IN ('fact','procedure','decision','gotcha','convention')),
  evidence             jsonb NOT NULL DEFAULT '[]'::jsonb,
  trigger              jsonb NOT NULL DEFAULT '{}'::jsonb,

  verification         jsonb,
  pitfalls             jsonb,
  links                jsonb,

  tier                 text NOT NULL DEFAULT 'draft' CHECK (tier IN ('draft','verified','canonical')),
  reuse_count          integer NOT NULL DEFAULT 0,
  last_reused_at       timestamptz,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','legacy_archived','superseded')),

  produced_by          text NOT NULL CHECK (produced_by IN ('agent_session','user','migration_llm')),
  produced_session_id  uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  embedding            vector(1536),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atoms_project_tier ON knowledge_atoms(project_id, tier);
CREATE INDEX IF NOT EXISTS idx_atoms_status      ON knowledge_atoms(status);
CREATE INDEX IF NOT EXISTS idx_atoms_parent      ON knowledge_atoms(parent_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_atoms_embedding   ON knowledge_atoms USING hnsw (embedding vector_cosine_ops);

-- Legacy migration tracking on existing knowledge_items
ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS migrated_at  timestamptz,
  ADD COLUMN IF NOT EXISTS legacy_status text CHECK (legacy_status IN ('legacy_replaced','legacy_archived'));

CREATE INDEX IF NOT EXISTS idx_knowledge_items_legacy_status ON knowledge_items(legacy_status);
