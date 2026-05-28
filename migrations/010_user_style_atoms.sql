-- Concern F: User-style preference layer
-- Adds scope/user_id/priority columns to knowledge_atoms so a single user can
-- carry cross-project style preferences alongside per-project atoms.
--   scope='user' atoms have project_id NULL and a non-null user_id + priority.
--   scope='project' atoms keep current behaviour.

ALTER TABLE knowledge_atoms
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'project'
    CHECK (scope IN ('project','user')),
  ADD COLUMN IF NOT EXISTS user_id text,
  ADD COLUMN IF NOT EXISTS priority text
    CHECK (priority IN ('personal_workflow','coding_preference'));

-- Free-form metadata bag — currently used by user-style atoms to flag
-- low_evidence inputs (no evidence + no source session) so the workbench can
-- surface them for review. Kept generic so other atom features can opt in.
ALTER TABLE knowledge_atoms
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_atoms_scope_user
  ON knowledge_atoms (scope, user_id, tier) WHERE status='active';
