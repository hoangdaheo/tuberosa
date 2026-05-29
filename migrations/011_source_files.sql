-- P0 Source Lifecycle Sync: per-path ledger + sync audit.

CREATE TABLE IF NOT EXISTS source_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path text NOT NULL,
  content_hash text,
  status text NOT NULL DEFAULT 'tracked',
  last_synced_sha text,
  prior_paths text[] NOT NULL DEFAULT '{}',
  knowledge_count integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (project_id, path),
  CHECK (status IN ('tracked','changed','missing','archived','ignored'))
);

CREATE INDEX IF NOT EXISTS idx_source_files_project_status
  ON source_files (project_id, status);

CREATE TABLE IF NOT EXISTS sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode text NOT NULL,
  from_sha text,
  to_sha text,
  plan jsonb NOT NULL,
  applied boolean NOT NULL DEFAULT false,
  trigger text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CHECK (mode IN ('git','fs')),
  CHECK (trigger IN ('cli','mcp','git_hook'))
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_project
  ON sync_runs (project_id, created_at DESC);

-- Tombstone lookups: find archived knowledge for a dead source path quickly.
CREATE INDEX IF NOT EXISTS idx_knowledge_items_archived
  ON knowledge_items (project_id) WHERE status = 'archived';
