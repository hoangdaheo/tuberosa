CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  prompt text NOT NULL,
  cwd text,
  agent_name text,
  agent_tool text,
  status text NOT NULL DEFAULT 'active',
  initial_context_pack_id uuid REFERENCES context_packs(id) ON DELETE SET NULL,
  outcome text,
  summary text,
  reflection_draft_ids uuid[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS agent_context_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES agent_sessions(id) ON DELETE CASCADE,
  context_pack_id uuid REFERENCES context_packs(id) ON DELETE SET NULL,
  decision text NOT NULL,
  reason text,
  rejected_knowledge_ids uuid[] NOT NULL DEFAULT '{}',
  retry_context_pack_id uuid REFERENCES context_packs(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_status ON agent_sessions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_session ON agent_context_decisions(session_id);
