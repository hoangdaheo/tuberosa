-- Concern D: extend atom status to include 'archived' (inactive but preserved)
ALTER TABLE knowledge_atoms
  DROP CONSTRAINT IF EXISTS knowledge_atoms_status_check;

ALTER TABLE knowledge_atoms
  ADD CONSTRAINT knowledge_atoms_status_check
    CHECK (status IN ('active','legacy_archived','superseded','archived'));

CREATE INDEX IF NOT EXISTS idx_atoms_archival_scan
  ON knowledge_atoms (tier, last_reused_at) WHERE status = 'active';
