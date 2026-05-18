CREATE TABLE IF NOT EXISTS knowledge_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  left_knowledge_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  right_knowledge_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  conflict_type text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  shared_evidence text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (left_knowledge_id <> right_knowledge_id),
  UNIQUE (left_knowledge_id, right_knowledge_id, conflict_type)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_conflicts_project_status ON knowledge_conflicts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_conflicts_left ON knowledge_conflicts(left_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_conflicts_right ON knowledge_conflicts(right_knowledge_id);
