-- Concern D: per-stage gate-decision telemetry for observability
CREATE TABLE IF NOT EXISTS atom_gate_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  atom_id         uuid REFERENCES knowledge_atoms(id) ON DELETE SET NULL,
  candidate_claim text NOT NULL,
  candidate_type  text NOT NULL,
  stage           text NOT NULL CHECK (stage IN ('triviality','floor','dedup','llm_critic')),
  outcome         text NOT NULL CHECK (outcome IN ('accepted','rejected','pending','queue_legacy_migration')),
  reasons         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atom_gate_events_project_outcome
  ON atom_gate_events (project_id, outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_atom_gate_events_stage
  ON atom_gate_events (stage, created_at DESC);
