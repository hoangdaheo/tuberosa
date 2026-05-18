CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open',
  source_feedback_id uuid REFERENCES feedback_events(id) ON DELETE SET NULL,
  source_session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  context_pack_id uuid REFERENCES context_packs(id) ON DELETE SET NULL,
  prompt text NOT NULL,
  classified jsonb,
  missing_signals text[] NOT NULL DEFAULT '{}',
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_gaps_feedback_unique
  ON knowledge_gaps(source_feedback_id)
  WHERE source_feedback_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_project_status
  ON knowledge_gaps(project_id, status);

CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_session
  ON knowledge_gaps(source_session_id);

CREATE TABLE IF NOT EXISTS learning_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  proposal_type text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  source_feedback_id uuid REFERENCES feedback_events(id) ON DELETE SET NULL,
  source_session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  context_pack_id uuid REFERENCES context_packs(id) ON DELETE SET NULL,
  affected_knowledge_id uuid REFERENCES knowledge_items(id) ON DELETE SET NULL,
  candidate_knowledge_id uuid REFERENCES knowledge_items(id) ON DELETE SET NULL,
  reason text NOT NULL DEFAULT '',
  evidence text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_proposals_feedback_unique
  ON learning_proposals(source_feedback_id, proposal_type, affected_knowledge_id)
  WHERE source_feedback_id IS NOT NULL AND affected_knowledge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_learning_proposals_project_status
  ON learning_proposals(project_id, status);

CREATE INDEX IF NOT EXISTS idx_learning_proposals_context
  ON learning_proposals(context_pack_id);

CREATE INDEX IF NOT EXISTS idx_learning_proposals_affected
  ON learning_proposals(affected_knowledge_id);
