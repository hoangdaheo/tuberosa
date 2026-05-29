CREATE TABLE IF NOT EXISTS atlas_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  input_hash   text NOT NULL,
  files        jsonb NOT NULL DEFAULT '[]',
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atlas_runs_project ON atlas_runs(project_id, generated_at DESC);
