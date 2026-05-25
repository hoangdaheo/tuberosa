-- 003_cleanup_dup_002s.sql
--
-- The three migration files
--
--   002_agent_sessions.sql
--   002_knowledge_relations.sql
--   002_knowledge_conflicts.sql
--
-- were all CREATE-TABLE-IF-NOT-EXISTS duplicates of objects already
-- defined in 001_init.sql. On a fresh database they applied as no-ops.
-- On an existing database they were already recorded in schema_migrations.
--
-- Once the redundant files are removed from the migrations/ directory,
-- the schema_migrations table still keeps the historical rows referring
-- to the now-deleted filenames. This migration prunes those orphan rows
-- so the runtime tracking table matches the on-disk migration set.
--
-- Safe to re-run; idempotent on fresh databases (deletes nothing).

DELETE FROM schema_migrations
WHERE filename IN (
  '002_agent_sessions.sql',
  '002_knowledge_relations.sql',
  '002_knowledge_conflicts.sql'
);
