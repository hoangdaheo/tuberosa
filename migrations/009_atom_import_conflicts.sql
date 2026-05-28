-- Concern E: Project Export Bundle
-- Queue of atom import conflicts surfaced when a bundle's atom diverges from
-- an existing local atom with the same id. Resolution mutates the local atom
-- (or keeps it) in the same transaction in the postgres store.

CREATE TABLE IF NOT EXISTS atom_import_conflicts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid REFERENCES projects(id) ON DELETE CASCADE,
  atom_id           uuid REFERENCES knowledge_atoms(id) ON DELETE CASCADE,
  local_snapshot    jsonb NOT NULL,
  imported_snapshot jsonb NOT NULL,
  bundle_source     text NOT NULL,
  status            text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved_keep_local','resolved_take_imported','resolved_merged','dismissed')),
  resolution_notes  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_atom_import_conflicts_status
  ON atom_import_conflicts(project_id, status, created_at DESC);
