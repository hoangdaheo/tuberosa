-- migrations/013_team_scope.sql
-- Knowledge-Book Phase 1: add a 'team' scope between 'user' and 'project'.
--   scope='team' atoms have project_id NULL, user_id NULL, and a non-null team_id.
-- Mirrors migration 010 (user-style layer).

ALTER TABLE knowledge_atoms
  DROP CONSTRAINT IF EXISTS knowledge_atoms_scope_check;

ALTER TABLE knowledge_atoms
  ADD CONSTRAINT knowledge_atoms_scope_check CHECK (scope IN ('project','user','team'));

ALTER TABLE knowledge_atoms
  ADD COLUMN IF NOT EXISTS team_id text;

CREATE INDEX IF NOT EXISTS idx_atoms_scope_team
  ON knowledge_atoms (scope, team_id, tier) WHERE status='active';
