CREATE TABLE IF NOT EXISTS knowledge_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  from_knowledge_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  relation_type text NOT NULL,
  target_kind text NOT NULL,
  target_knowledge_id uuid REFERENCES knowledge_items(id) ON DELETE CASCADE,
  target_value text,
  confidence real NOT NULL DEFAULT 0.7,
  inferred boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (target_knowledge_id IS NOT NULL OR target_value IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_relations_project_type ON knowledge_relations(project_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_from ON knowledge_relations(from_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_target_knowledge ON knowledge_relations(target_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_target_value ON knowledge_relations(target_kind, lower(target_value));
