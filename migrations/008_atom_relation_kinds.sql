-- Concern C1: atom edges live alongside knowledge edges in knowledge_relations.
-- Each row has exactly one source side (knowledge or atom) and one target side
-- (knowledge, atom, or freeform target_value). Application code enforces the
-- "exactly one source side" invariant; the schema relaxes the legacy NOT NULL
-- and CHECK constraints to make atom-only rows representable.

ALTER TABLE knowledge_relations
  ADD COLUMN IF NOT EXISTS from_atom_id     uuid REFERENCES knowledge_atoms(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS target_atom_id   uuid REFERENCES knowledge_atoms(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS inference_source text
    CHECK (inference_source IN ('migration','semantic','co_change','refines_detector','manual'));

ALTER TABLE knowledge_relations
  ALTER COLUMN from_knowledge_id DROP NOT NULL;

-- Drop the legacy CHECK that required a knowledge_id or freeform target_value;
-- with atom edges we also accept target_atom_id. The new CHECK keeps "must have
-- at least one target" while permitting any of the three.
DO $$
DECLARE
  conname text;
BEGIN
  SELECT con.conname
    INTO conname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'knowledge_relations'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%target_knowledge_id IS NOT NULL OR target_value IS NOT NULL%';
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE knowledge_relations DROP CONSTRAINT %I', conname);
  END IF;
END$$;

ALTER TABLE knowledge_relations
  ADD CONSTRAINT knowledge_relations_target_present
  CHECK (
    target_knowledge_id IS NOT NULL
      OR target_atom_id IS NOT NULL
      OR target_value IS NOT NULL
  );

ALTER TABLE knowledge_relations
  ADD CONSTRAINT knowledge_relations_source_present
  CHECK (from_knowledge_id IS NOT NULL OR from_atom_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_relations_from_atom    ON knowledge_relations(from_atom_id);
CREATE INDEX IF NOT EXISTS idx_relations_target_atom  ON knowledge_relations(target_atom_id);
CREATE INDEX IF NOT EXISTS idx_relations_inference    ON knowledge_relations(inference_source);

COMMENT ON COLUMN knowledge_relations.from_atom_id IS 'Set instead of from_knowledge_id when the source is a knowledge atom.';
COMMENT ON COLUMN knowledge_relations.target_atom_id IS 'Set instead of target_knowledge_id when the target is a knowledge atom.';
COMMENT ON COLUMN knowledge_relations.inference_source IS 'Provenance of an inferred edge (migration/semantic/co_change/refines_detector/manual).';
